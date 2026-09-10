import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cacheKey, TranslationCache, type CacheContext, type TranslationCacheOptions
} from '../src/core/cache';

const WASM_PATH = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
const KEY_INPUT: CacheContext = {
  text: 'Return the current value.',
  languageId: 'typescript',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  targetLanguage: 'zh-CN',
  promptVersion: '1',
  prompt: 'Translate code comments.'
};
const DIRECTORIES: string[] = [];
const CACHES: TranslationCache[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'comment-translator-cache-'));
  DIRECTORIES.push(directory);
  return join(directory, 'translations.sqlite');
}

async function openCache(
  options: Partial<TranslationCacheOptions> = {}
): Promise<TranslationCache> {
  const cache = await TranslationCache.open({
    databasePath: options.databasePath ?? await databasePath(),
    wasmPath: WASM_PATH,
    ...options
  });
  CACHES.push(cache);
  return cache;
}

afterEach(async () => {
  await Promise.all(CACHES.splice(0).map((cache) => cache.close()));
  await Promise.all(DIRECTORIES.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('cacheKey', () => {
  it('is deterministic and includes every translation-affecting field', () => {
    const key = cacheKey(KEY_INPUT);
    expect(cacheKey({ ...KEY_INPUT })).toBe(key);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    for (const field of Object.keys(KEY_INPUT) as Array<keyof CacheContext>) {
      expect(cacheKey({ ...KEY_INPUT, [field]: `${KEY_INPUT[field]} changed` })).not.toBe(key);
    }
  });

  it('separates delimiter-containing fields without collisions', () => {
    expect(cacheKey({ ...KEY_INPUT, text: 'a|b', languageId: 'c' })).not.toBe(
      cacheKey({ ...KEY_INPUT, text: 'a', languageId: 'b|c' })
    );
  });

  it('treats an absent custom prompt as an empty prompt', () => {
    const { prompt: _prompt, ...withoutPrompt } = KEY_INPUT;
    expect(cacheKey(withoutPrompt)).toBe(cacheKey({ ...withoutPrompt, prompt: '' }));
  });
});

describe('TranslationCache', () => {
  it('writes, reads, and reuses matching content across files', async () => {
    const cache = await openCache();
    const key = cacheKey(KEY_INPUT);
    cache.set('file:a', key, '返回当前值。', KEY_INPUT);
    expect(cache.get('file:a', key)).toBe('返回当前值。');
    expect(cache.get('file:b', key)).toBe('返回当前值。');
    expect(cache.get('file:a', 'unknown')).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('persists translations across close and reopen without default expiry', async () => {
    const path = await databasePath();
    let now = 0;
    const cache = await openCache({ databasePath: path, now: () => now });
    const key = cacheKey(KEY_INPUT);
    cache.set('file:a', key, '返回当前值。', KEY_INPUT);
    await cache.close();
    now = 10 * 365 * 24 * 60 * 60 * 1_000;
    const reopened = await openCache({ databasePath: path, now: () => now });
    expect(reopened.get('file:different', key)).toBe('返回当前值。');
    expect(reopened.size).toBe(1);
  });

  it('automatically persists pending translations after the debounce interval', async () => {
    const path = await databasePath();
    const cache = await openCache({ databasePath: path });
    cache.set('file:a', 'automatic', '自动保存');
    await vi.waitFor(async () => {
      expect((await readFile(path)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
    }, { timeout: 2_000, interval: 25 });
    const reopened = await openCache({ databasePath: path });
    expect(reopened.get('file:a', 'automatic')).toBe('自动保存');
  });

  it('stores actual source, translation and metadata in a valid SQLite database without API keys', async () => {
    const path = await databasePath();
    const cache = await openCache({ databasePath: path, now: () => 123 });
    const key = cacheKey(KEY_INPUT);
    cache.set('file:a', key, '返回当前值。', KEY_INPUT);
    await cache.flush();
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 16).toString()).toBe('SQLite format 3\0');
    const sql = await initSqlJs({ locateFile: () => WASM_PATH });
    const database = new sql.Database(bytes);
    try {
      expect(database.exec(`SELECT cache_key, original_text, translated_text, language, model,
        provider, target, prompt_version, created_at, last_accessed FROM translations`)[0]?.values).toEqual([
        [key, KEY_INPUT.text, '返回当前值。', 'typescript', 'test-model', 'https://example.test/v1',
          'zh-CN', '1', 123, 123]
      ]);
      const schema = database.exec('PRAGMA table_info(translations)')[0]?.values.map((row) => row[1]);
      expect(schema).not.toContain('api_key');
      expect(schema).toContain('prompt_hash');
      expect(bytes.includes(Buffer.from(KEY_INPUT.prompt!))).toBe(false);
      expect(database.exec('PRAGMA quick_check')[0]?.values[0]?.[0]).toBe('ok');
    } finally {
      database.close();
    }
  });

  it('releases file references without deleting durable translations', async () => {
    const path = await databasePath();
    const cache = await openCache({ databasePath: path });
    cache.set('file:a', 'one', '一');
    cache.deleteFile('file:missing');
    cache.deleteFile('file:a');
    expect(cache.size).toBe(1);
    expect(cache.get('file:b', 'one')).toBe('一');
    await cache.close();
    const reopened = await openCache({ databasePath: path });
    expect(reopened.get('file:a', 'one')).toBe('一');
  });

  it('clears data both immediately and after reopening the database', async () => {
    const path = await databasePath();
    const cache = await openCache({ databasePath: path });
    cache.set('file:a', 'one', '一');
    await cache.flush();
    cache.clear();
    expect(cache.size).toBe(0);
    await cache.close();
    const reopened = await openCache({ databasePath: path });
    expect(reopened.size).toBe(0);
    expect(reopened.get('file:a', 'one')).toBeUndefined();
  });

  it('expires entries at the TTL boundary without extending TTL on read', async () => {
    let now = 0;
    const cache = await openCache({ ttlMs: 100, now: () => now });
    cache.set('file:a', 'key', '译文');
    now = 99;
    expect(cache.get('file:a', 'key')).toBe('译文');
    now = 100;
    expect(cache.get('file:a', 'key')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('prunes expired entries persistently and preserves newer entries', async () => {
    const path = await databasePath();
    let now = 0;
    const cache = await openCache({ databasePath: path, ttlMs: 100, now: () => now });
    cache.set('file:a', 'old', '旧译文');
    now = 50;
    cache.set('file:b', 'new', '新译文');
    await cache.flush();
    now = 100;
    cache.prune();
    expect(cache.size).toBe(1);
    expect(cache.get('file:a', 'old')).toBeUndefined();
    await cache.close();
    const reopened = await openCache({ databasePath: path, ttlMs: 100, now: () => now });
    expect(reopened.get('file:b', 'new')).toBe('新译文');
    now = 150;
    expect(reopened.size).toBe(0);
  });

  it('evicts globally by true access order even when timestamps tie', async () => {
    const path = await databasePath();
    const cache = await openCache({ databasePath: path, maxEntries: 2, now: () => 0 });
    cache.set('file:a', 'a', '甲');
    cache.set('file:b', 'b', '乙');
    expect(cache.get('file:a', 'a')).toBe('甲');
    cache.set('file:c', 'c', '丙');
    expect(cache.size).toBe(2);
    expect(cache.get('file:b', 'b')).toBeUndefined();
    await cache.close();
    const reopened = await openCache({ databasePath: path, maxEntries: 2 });
    expect(reopened.get('file:a', 'a')).toBe('甲');
    expect(reopened.get('file:c', 'c')).toBe('丙');
    expect(reopened.get('file:b', 'b')).toBeUndefined();
  });

  it('updates an entry and refreshes its TTL without consuming another row', async () => {
    let now = 0;
    const cache = await openCache({ ttlMs: 100, maxEntries: 1, now: () => now });
    cache.set('file:a', 'key', '旧译文');
    now = 50;
    cache.set('file:a', 'key', '新译文');
    now = 100;
    expect(cache.size).toBe(1);
    expect(cache.get('file:a', 'key')).toBe('新译文');
    now = 150;
    expect(cache.get('file:a', 'key')).toBeUndefined();
  });

  it('does not cache empty responses or overwrite a success with an empty response', async () => {
    const cache = await openCache();
    cache.set('file:a', 'empty', '');
    cache.set('file:a', 'whitespace', ' \n\t ');
    cache.set('file:a', 'success', '  保留格式。\n');
    cache.set('file:a', 'success', ' ');
    expect(cache.size).toBe(1);
    expect(cache.get('file:a', 'success')).toBe('  保留格式。\n');
  });

  it('merges two stale instances instead of replacing another window\'s saved rows', async () => {
    const path = await databasePath();
    const first = await openCache({ databasePath: path });
    const second = await openCache({ databasePath: path });
    first.set('file:a', 'a', '甲');
    await first.flush();
    second.set('file:b', 'b', '乙');
    await second.flush();
    first.set('file:c', 'c', '丙');
    second.set('file:d', 'd', '丁');
    await Promise.all([first.flush(), second.flush()]);
    await Promise.all([first.close(), second.close()]);
    const reopened = await openCache({ databasePath: path });
    expect(reopened.size).toBe(4);
    expect(['a', 'b', 'c', 'd'].map((key) => reopened.get('file:any', key))).toEqual(['甲', '乙', '丙', '丁']);
  });

  it('refreshes an idle instance after another window saves or clears translations', async () => {
    const path = await databasePath();
    const first = await openCache({ databasePath: path });
    await first.flush();
    const second = await openCache({ databasePath: path });
    first.set('file:a', 'shared', '窗口间复用');
    await first.flush();
    expect(second.get('file:b', 'shared')).toBeUndefined();
    const savedBytes = await readFile(path);
    await second.flush();
    expect(await readFile(path)).toEqual(savedBytes);
    expect(second.get('file:b', 'shared')).toBe('窗口间复用');
    await second.flush();

    first.clear();
    await first.flush();
    const clearedBytes = await readFile(path);
    await second.flush();
    expect(await readFile(path)).toEqual(clearedBytes);
    expect(second.get('file:b', 'shared')).toBeUndefined();
    expect(second.size).toBe(0);

    const refreshing = second.flush();
    await Promise.resolve();
    second.set('file:b', 'during-read', '同步期间新增');
    await refreshing;
    expect(second.get('file:b', 'during-read')).toBe('同步期间新增');
    await second.flush();
    await first.flush();
    expect(first.get('file:a', 'during-read')).toBe('同步期间新增');
  });

  it('does not resurrect cleared rows when a stale instance flushes an access update', async () => {
    const path = await databasePath();
    const first = await openCache({ databasePath: path });
    first.set('file:a', 'old', '旧译文');
    await first.flush();
    const stale = await openCache({ databasePath: path });
    first.clear();
    await first.flush();
    expect(stale.get('file:a', 'old')).toBe('旧译文');
    stale.set('file:a', 'new', '新译文');
    await stale.flush();
    expect(stale.get('file:a', 'old')).toBeUndefined();
    const reopened = await openCache({ databasePath: path });
    expect(reopened.size).toBe(1);
    expect(reopened.get('file:a', 'new')).toBe('新译文');
  });

  it('serializes overlapping flush and close calls without losing newer writes', async () => {
    const path = await databasePath();
    const cache = await openCache({ databasePath: path });
    cache.set('file:a', 'one', '一');
    const firstFlush = cache.flush();
    cache.set('file:a', 'two', '二');
    const secondFlush = cache.flush();
    const closing = cache.close();
    await Promise.all([firstFlush, secondFlush, closing, cache.close()]);
    const reopened = await openCache({ databasePath: path });
    expect(reopened.size).toBe(2);
    expect(reopened.get('file:a', 'two')).toBe('二');
    expect(() => cache.set('file:a', 'three', '三')).toThrow('closed');
    await cache.flush();
  });

  it('rejects corrupt databases without modifying the original bytes', async () => {
    const path = await databasePath();
    const original = Buffer.from('not a SQLite database');
    await writeFile(path, original);
    await expect(openCache({ databasePath: path })).rejects.toThrow('Cannot open translation cache');
    expect(await readFile(path)).toEqual(original);
  });

  it('rejects empty databases rather than silently replacing them', async () => {
    const path = await databasePath();
    await writeFile(path, '');
    await expect(openCache({ databasePath: path })).rejects.toThrow('database file is empty');
    expect(await readFile(path)).toEqual(Buffer.alloc(0));
  });

  it('does not overwrite disk corruption during flush and retains pending changes for retry', async () => {
    const path = await databasePath();
    const cache = await openCache({ databasePath: path });
    cache.set('file:a', 'old', '已保存');
    await cache.flush();
    const validBytes = await readFile(path);
    const corruptBytes = Buffer.from('externally corrupted database');
    await writeFile(path, corruptBytes);
    cache.set('file:a', 'new', '待保存');
    await expect(cache.flush()).rejects.toThrow('Cannot open translation cache');
    expect(await readFile(path)).toEqual(corruptBytes);
    await writeFile(path, validBytes);
    await cache.flush();
    const reopened = await openCache({ databasePath: path });
    expect(reopened.get('file:a', 'old')).toBe('已保存');
    expect(reopened.get('file:a', 'new')).toBe('待保存');
  });

  it('retains pending writes after a filesystem error and allows close to be retried', async () => {
    const path = await databasePath();
    const cache = await openCache({ databasePath: path });
    cache.set('file:a', 'one', '一');
    await mkdir(path);
    await expect(cache.close()).rejects.toThrow();
    await rm(path, { recursive: true });
    await cache.close();
    const reopened = await openCache({ databasePath: path });
    expect(reopened.get('file:a', 'one')).toBe('一');
    const files = await readdir(join(path, '..'));
    expect(files).toEqual(['translations.sqlite']);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid TTL %s', async (ttlMs) => {
    await expect(openCache({ ttlMs })).rejects.toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid capacity %s', async (maxEntries) => {
      await expect(openCache({ maxEntries })).rejects.toThrow(RangeError);
    }
  );
});
