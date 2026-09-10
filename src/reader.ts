import { createHash, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { renderReaderHtml, type ReaderModel } from './readerContent';

/** Host actions available to a reader; source URIs are bound by the host, never by messages. */
export interface TranslationReaderOptions {
  onReveal: (uri: string, line: number) => Promise<void> | void;
  onRefresh: (uri: string) => void;
  onSettings: () => void;
  onFocus?: (uri: string) => void;
}

/** Readiness and rendering diagnostics for one source file's reader. */
export interface ReaderSnapshot {
  open: boolean;
  ready: boolean;
  translated: number;
  sourceLines: number;
}

interface ReaderEntry {
  uri: string;
  panel: vscode.WebviewPanel;
  subscriptions: vscode.Disposable[];
  model: ReaderModel | undefined;
  fingerprint: string;
  nonce: string;
  ready: boolean;
  renderedTranslations: number | undefined;
  sourceLines: number;
  closed: boolean;
}

const READER_VIEW_TYPE = 'commentTranslator.reader';
const READY_FIELDS = new Set(['type', 'nonce', 'renderedTranslations', 'sourceRows', 'translationRows']);
const ACTION_FIELDS = new Set(['type', 'nonce']);
const REVEAL_FIELDS = new Set(['type', 'nonce', 'line']);

/** Owns read-only source readers and validates all webview-to-host messages. */
export class TranslationReader implements vscode.Disposable {
  private readonly entries = new Map<string, ReaderEntry>();
  private disposed = false;

  /** Creates a reader manager without opening a panel or making a translation request. */
  public constructor(private readonly options: TranslationReaderOptions) {}

  /** Opens or focuses this source file's reader and supplies its latest display model. */
  public open(uri: string, model: ReaderModel): void {
    if (this.disposed) {
      return;
    }
    const existing = this.entries.get(uri);
    if (existing) {
      this.update(uri, model);
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      this.notifyFocus(existing);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      READER_VIEW_TYPE,
      panelTitle(model.title),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );
    const entry: ReaderEntry = {
      uri, panel, subscriptions: [], model: undefined, fingerprint: '', nonce: '',
      ready: false, renderedTranslations: undefined, sourceLines: 0, closed: false
    };
    this.entries.set(uri, entry);
    entry.subscriptions.push(
      panel.webview.onDidReceiveMessage((message: unknown) => this.receiveMessage(entry, message)),
      panel.onDidDispose(() => this.forgetEntry(entry)),
      panel.onDidChangeViewState(() => this.notifyFocus(entry))
    );
    try {
      this.update(uri, model);
      this.notifyFocus(entry);
    } catch (error) {
      this.closeFile(uri);
      throw error;
    }
  }

  /** Updates an existing reader only when its displayed model changed. */
  public update(uri: string, model: ReaderModel): void {
    const entry = this.entries.get(uri);
    if (!entry || !this.isCurrent(entry)) {
      return;
    }
    const fingerprint = fingerprintModel(model);
    if (entry.fingerprint === fingerprint) {
      return;
    }
    const snapshot = copyModel(model);
    const nonce = randomBytes(18).toString('hex');
    const html = renderReaderHtml(snapshot, nonce);
    entry.model = snapshot;
    entry.fingerprint = fingerprint;
    entry.nonce = nonce;
    entry.sourceLines = snapshot.source.split(/\r\n|\r|\n/).length;
    entry.ready = false;
    entry.renderedTranslations = undefined;
    entry.panel.title = panelTitle(snapshot.title);
    entry.panel.webview.html = html;
  }

  /** Removes translations from an open reader while retaining its source and disabling status. */
  public clearFile(uri: string): void {
    const model = this.entries.get(uri)?.model;
    if (model) {
      this.update(uri, { ...model, phase: 'off', translated: 0, translations: new Map(), markdown: model.mode === 'markdown' ? model.source : undefined, error: undefined });
    }
  }

  /** Closes the reader of a closed source file and invalidates its old message handlers. */
  public closeFile(uri: string): void {
    const entry = this.entries.get(uri);
    if (!entry) {
      return;
    }
    this.forgetEntry(entry);
    entry.panel.dispose();
  }

  /** Returns the source URI of the currently focused reader, if there is one. */
  public activeUri(): string | undefined {
    for (const entry of this.entries.values()) {
      if (this.isCurrent(entry) && entry.panel.active) {
        return entry.uri;
      }
    }
    return undefined;
  }

  /** Returns display diagnostics without exposing source content or creating a reader. */
  public snapshot(uri: string): ReaderSnapshot {
    const entry = this.entries.get(uri);
    return entry && this.isCurrent(entry) ? {
      open: true,
      ready: entry.ready,
      translated: entry.ready ? entry.renderedTranslations ?? 0 : entry.model?.translated ?? 0,
      sourceLines: entry.sourceLines
    } : { open: false, ready: false, translated: 0, sourceLines: 0 };
  }

  /** Closes all readers and permanently ignores subsequent opens and old events. */
  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const uri of [...this.entries.keys()]) {
      this.closeFile(uri);
    }
  }

  private receiveMessage(entry: ReaderEntry, message: unknown): void {
    if (!this.isCurrent(entry) || !entry.model || !message || typeof message !== 'object' || Array.isArray(message)) {
      return;
    }
    const data = message as Record<string, unknown>;
    if (data.nonce !== entry.nonce) {
      return;
    }
    const fields = data.type === 'ready' ? READY_FIELDS : data.type === 'reveal' ? REVEAL_FIELDS : ACTION_FIELDS;
    if (Object.keys(data).some((key) => !fields.has(key))) {
      return;
    }
    switch (data.type) {
      case 'ready':
        if (['renderedTranslations', 'sourceRows', 'translationRows'].some((key) =>
          !Number.isSafeInteger(data[key]) || Number(data[key]) < 0
        ) || data.sourceRows !== entry.sourceLines) {
          return;
        }
        entry.renderedTranslations = data.renderedTranslations as number;
        entry.ready = true;
        break;
      case 'reveal':
        if (typeof data.line === 'number' && Number.isSafeInteger(data.line) && data.line >= 0 && data.line < entry.sourceLines) {
          this.invoke(() => this.options.onReveal(entry.uri, data.line as number));
        }
        break;
      case 'refresh':
        this.invoke(() => this.options.onRefresh(entry.uri));
        break;
      case 'settings':
        this.invoke(() => this.options.onSettings());
        break;
    }
  }

  private notifyFocus(entry: ReaderEntry): void {
    if (this.isCurrent(entry) && this.options.onFocus) {
      this.invoke(() => this.options.onFocus?.(entry.uri));
    }
  }

  private invoke(action: () => void | Promise<void>): void {
    try {
      void Promise.resolve(action()).catch((error: unknown) => this.reportError(error));
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    void Promise.resolve(vscode.window.showErrorMessage(`译读操作失败：${message}`)).catch(() => undefined);
  }

  private isCurrent(entry: ReaderEntry): boolean {
    return !this.disposed && !entry.closed && this.entries.get(entry.uri) === entry;
  }

  private forgetEntry(entry: ReaderEntry): void {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    entry.ready = false;
    if (this.entries.get(entry.uri) === entry) {
      this.entries.delete(entry.uri);
    }
    for (const subscription of entry.subscriptions.splice(0)) {
      subscription.dispose();
    }
    if (!this.disposed && this.options.onFocus) {
      this.invoke(() => this.options.onFocus?.(entry.uri));
    }
  }
}

function panelTitle(title: string): string {
  return `译读 · ${title.split(/[\\/]/).at(-1) || '未命名'}`;
}

function copyModel(model: ReaderModel): ReaderModel {
  return {
    ...model,
    blocks: model.blocks.map((block) => ({ ...block, start: { ...block.start }, end: { ...block.end } })),
    translations: new Map(model.translations)
  };
}

function fingerprintModel(model: ReaderModel): string {
  return createHash('sha256').update(JSON.stringify({
    mode: model.mode ?? 'comments',
    markdown: model.markdown,
    source: model.source,
    languageId: model.languageId,
    title: model.title,
    phase: model.phase,
    translated: model.translated,
    total: model.total,
    error: model.error ?? '',
    blocks: model.blocks.map((block) => [
      block.id, block.text, block.rawText, block.languageId, block.kind,
      block.start.line, block.start.character, block.end.line, block.end.character
    ]),
    translations: [...model.translations].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  })).digest('hex');
}
