import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

/** Comment content and nonsecret settings that determine a translation. */
export interface CacheContext {
  text: string;
  languageId: string;
  baseUrl: string;
  model: string;
  targetLanguage: string;
  promptVersion: string;
  prompt?: string;
}

export type TranslationCacheKeyInput = CacheContext;

/** Filesystem locations and limits for a persistent translation cache. */
export interface TranslationCacheOptions {
  databasePath: string;
  wasmPath: string;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

type CacheOperation =
  | { type: 'upsert'; key: string; value: string; context?: CacheContext; timestamp: number }
  | { type: 'touch'; key: string; timestamp: number }
  | { type: 'clear' }
  | { type: 'prune' };

const DEFAULT_MAX_ENTRIES = 10_000;
const FLUSH_DELAY_MS = 500;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;
const SCHEMA_VERSION = 1;

/** Builds a stable SHA-256 key from comment content and all translation settings. */
export function cacheKey(input: CacheContext): string {
  return createHash('sha256').update(JSON.stringify([
    input.text, input.languageId, input.baseUrl, input.model,
    input.targetLanguage, input.promptVersion, input.prompt ?? ''
  ])).digest('hex');
}

/** Persists original comments and translations in a local SQLite database. */
export class TranslationCache {
  private readonly files = new Map<string, Set<string>>();
  private readonly pending: CacheOperation[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closing = false;
  private closed = false;
  private needsInitialization: boolean;

  private constructor(
    private readonly sql: SqlJsStatic,
    private database: Database,
    private readonly databasePath: string,
    private readonly ttlMs: number | undefined,
    private readonly maxEntries: number,
    private readonly now: () => number,
    needsInitialization: boolean
  ) {
    this.needsInitialization = needsInitialization;
  }

  /** Opens an existing database, or creates a new one; corrupt files are never overwritten. */
  public static async open(options: TranslationCacheOptions): Promise<TranslationCache> {
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      throw new RangeError('Cache TTL must be a positive finite number.');
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('Cache capacity must be a positive integer.');
    }
    const sql = await initSqlJs({ locateFile: () => options.wasmPath });
    const { database, existed } = await TranslationCache.readDatabase(sql, options.databasePath);
    const cache = new TranslationCache(
      sql, database, options.databasePath, options.ttlMs, maxEntries,
      options.now ?? Date.now, !existed
    );
    cache.prune();
    if (!existed) {
      cache.scheduleFlush();
    }
    return cache;
  }

  /** Reads a reusable translation across files and records its most recent access. */
  public get(fileUri: string, key: string): string | undefined {
    this.assertOpen();
    const row = this.database.exec(
      'SELECT translated_text, created_at FROM translations WHERE cache_key = ?', [key]
    )[0]?.values[0];
    if (!row) {
      return undefined;
    }
    if (this.ttlMs !== undefined && Number(row[1]) + this.ttlMs <= this.now()) {
      this.prune();
      return undefined;
    }
    this.trackFile(fileUri, key);
    this.record({ type: 'touch', key, timestamp: this.now() });
    return String(row[0]);
  }

  /** Stores a successful translation; pass context to persist the source and settings. */
  public set(fileUri: string, key: string, value: string, context?: CacheContext): void {
    this.assertOpen();
    if (!value.trim()) {
      return;
    }
    this.trackFile(fileUri, key);
    this.record({
      type: 'upsert', key, value, timestamp: this.now(),
      ...(context ? { context: { ...context } } : {})
    });
    this.prune();
  }

  /** Releases a file's in-memory references while preserving its persistent translations. */
  public deleteFile(fileUri: string): void {
    this.files.delete(fileUri);
  }

  /** Clears all translations; the deletion is persisted by the next flush. */
  public clear(): void {
    this.assertOpen();
    this.files.clear();
    this.record({ type: 'clear' });
  }

  /** Removes expired translations and evicts entries beyond the global LRU limit. */
  public prune(): void {
    this.assertOpen();
    if (this.pruneDatabase(this.database)) {
      this.pending.push({ type: 'prune' });
      this.pruneFileReferences();
      this.scheduleFlush();
    }
  }

  /** Saves pending changes under a lock, or refreshes an idle instance from the latest disk snapshot. */
  public flush(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.clearTimer();
    const next = this.flushTail.then(() => this.performFlush());
    this.flushTail = next.catch(() => undefined);
    return next;
  }

  /** Flushes pending changes and releases SQLite; a failed close may be retried. */
  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closing = true;
    this.clearTimer();
    this.closePromise = this.flush().then(() => {
      this.database.close();
      this.files.clear();
      this.closed = true;
    }).catch((error: unknown) => {
      this.closing = false;
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }

  /** Returns the current number of live persistent translations in this instance. */
  public get size(): number {
    this.prune();
    return Number(this.database.exec('SELECT COUNT(*) FROM translations')[0]?.values[0]?.[0] ?? 0);
  }

  private static async readDatabase(
    sql: SqlJsStatic, databasePath: string
  ): Promise<{ database: Database; existed: boolean }> {
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    let database: Database | undefined;
    try {
      if (bytes && bytes.length === 0) {
        throw new Error('The database file is empty.');
      }
      database = bytes ? new sql.Database(bytes) : new sql.Database();
      if (bytes) {
        const integrity = database.exec('PRAGMA quick_check')[0]?.values[0]?.[0];
        if (integrity !== 'ok') {
          throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
        }
        const version = database.exec('PRAGMA user_version')[0]?.values[0]?.[0];
        if (version !== SCHEMA_VERSION) {
          throw new Error(`Unsupported cache schema version: ${String(version)}`);
        }
        database.exec('SELECT cache_key, original_text, translated_text, language, model, provider, target, prompt_version, prompt_hash, created_at, last_accessed, access_order FROM translations LIMIT 0');
      } else {
        database.run(`CREATE TABLE translations (
          cache_key TEXT PRIMARY KEY,
          original_text TEXT NOT NULL,
          translated_text TEXT NOT NULL,
          language TEXT NOT NULL,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          target TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          prompt_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_accessed INTEGER NOT NULL,
          access_order INTEGER NOT NULL
        )`);
        database.run('CREATE INDEX translations_access_order ON translations(access_order)');
        database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      return { database, existed: bytes !== undefined };
    } catch (error) {
      database?.close();
      throw new Error(`Cannot open translation cache at ${databasePath}: ${(error as Error).message}`, {
        cause: error
      });
    }
  }

  private record(operation: CacheOperation): void {
    this.applyOperation(this.database, operation);
    this.pending.push(operation);
    this.scheduleFlush();
  }

  private applyOperation(database: Database, operation: CacheOperation): void {
    if (operation.type === 'clear') {
      database.run('DELETE FROM translations');
    } else if (operation.type === 'upsert') {
      const context = operation.context;
      database.run(`INSERT INTO translations (
        cache_key, original_text, translated_text, language, model, provider, target,
        prompt_version, prompt_hash, created_at, last_accessed, access_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT COALESCE(MAX(access_order), 0) + 1 FROM translations))
      ON CONFLICT(cache_key) DO UPDATE SET
        original_text = excluded.original_text, translated_text = excluded.translated_text,
        language = excluded.language, model = excluded.model, provider = excluded.provider,
        target = excluded.target, prompt_version = excluded.prompt_version,
        prompt_hash = excluded.prompt_hash, created_at = excluded.created_at,
        last_accessed = excluded.last_accessed, access_order = excluded.access_order`, [
        operation.key, context?.text ?? '', operation.value, context?.languageId ?? '',
        context?.model ?? '', context?.baseUrl ?? '', context?.targetLanguage ?? '',
        context?.promptVersion ?? '',
        createHash('sha256').update(context?.prompt ?? '').digest('hex'),
        operation.timestamp, operation.timestamp
      ]);
    } else if (operation.type === 'touch') {
      database.run(`UPDATE translations SET last_accessed = MAX(last_accessed, ?),
        access_order = (SELECT COALESCE(MAX(access_order), 0) + 1 FROM translations)
        WHERE cache_key = ?`, [operation.timestamp, operation.key]);
    }
  }

  private pruneDatabase(database: Database): boolean {
    let changed = false;
    if (this.ttlMs !== undefined) {
      database.run('DELETE FROM translations WHERE created_at <= ?', [this.now() - this.ttlMs]);
      changed = database.getRowsModified() > 0;
    }
    database.run(`DELETE FROM translations WHERE cache_key IN (
      SELECT cache_key FROM translations ORDER BY access_order DESC LIMIT -1 OFFSET ?
    )`, [this.maxEntries]);
    return database.getRowsModified() > 0 || changed;
  }

  private async performFlush(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.pending.length === 0 && !this.needsInitialization) {
      await this.refreshFromDisk();
      return;
    }
    await mkdir(dirname(this.databasePath), { recursive: true });
    const releaseLock = await this.acquireLock();
    let merged: Database | undefined;
    let temporaryPath: string | undefined;
    try {
      const operations = this.pending.slice();
      merged = (await TranslationCache.readDatabase(this.sql, this.databasePath)).database;
      merged.run('BEGIN TRANSACTION');
      for (const operation of operations) {
        this.applyOperation(merged, operation);
      }
      this.pruneDatabase(merged);
      merged.run('COMMIT');

      temporaryPath = `${this.databasePath}.${process.pid}.${randomUUID()}.tmp`;
      const output = await open(temporaryPath, 'wx', 0o600);
      try {
        await output.writeFile(merged.export());
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporaryPath, this.databasePath);
      temporaryPath = undefined;

      // Mutations arriving during filesystem awaits must remain queued and visible.
      this.pending.splice(0, operations.length);
      for (const operation of this.pending) {
        this.applyOperation(merged, operation);
      }
      this.pruneDatabase(merged);
      this.database.close();
      this.database = merged;
      merged = undefined;
      this.needsInitialization = false;
      this.pruneFileReferences();
    } finally {
      merged?.close();
      if (temporaryPath) {
        await unlink(temporaryPath).catch(() => undefined);
      }
      await releaseLock();
    }
    if (this.pending.length > 0 && !this.closing) {
      this.scheduleFlush();
    }
  }

  private async refreshFromDisk(): Promise<void> {
    let snapshot: Database | undefined = (
      await TranslationCache.readDatabase(this.sql, this.databasePath)
    ).database;
    try {
      // A set/clear can arrive while readFile awaits; preserve these unsaved local changes.
      for (const operation of this.pending) {
        this.applyOperation(snapshot, operation);
      }
      if (this.pending.length > 0) {
        this.pruneDatabase(snapshot);
      }
      this.database.close();
      this.database = snapshot;
      snapshot = undefined;
      this.pruneFileReferences();
    } finally {
      snapshot?.close();
    }
    if (this.pending.length > 0 && !this.closing) {
      this.scheduleFlush();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.databasePath}.lock`;
    const startedAt = Date.now();
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        } catch (error) {
          await handle.close();
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        return async () => {
          try {
            await handle.close();
          } finally {
            await unlink(lockPath);
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new Error(`Translation cache lock is busy: ${lockPath}. Pending translations were retained; retry after the other writer finishes. A lock left by a crashed process requires cleanup.`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  private trackFile(fileUri: string, key: string): void {
    const keys = this.files.get(fileUri) ?? new Set<string>();
    keys.add(key);
    this.files.set(fileUri, keys);
  }

  private pruneFileReferences(): void {
    const knownKeys = new Set(
      (this.database.exec('SELECT cache_key FROM translations')[0]?.values ?? [])
        .map((row) => String(row[0]))
    );
    for (const [fileUri, keys] of this.files) {
      for (const key of keys) {
        if (!knownKeys.has(key)) {
          keys.delete(key);
        }
      }
      if (keys.size === 0) {
        this.files.delete(fileUri);
      }
    }
  }

  private scheduleFlush(): void {
    if (this.timer || this.closed || this.closing) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error: unknown) => {
        // Preserve pending operations so explicit flush/close can retry and report failure.
        console.error('Unable to persist translation cache:', error);
      });
    }, FLUSH_DELAY_MS);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private assertOpen(): void {
    if (this.closed || this.closing) {
      throw new Error('Translation cache is closed.');
    }
  }
}
