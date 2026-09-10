import * as vscode from 'vscode';
import { CONFIG_SECTION, boundedNumber, configureProvider, readApiKey, readSettings } from './config';
import { TranslationCache, cacheKey } from './core/cache';
import { FileScheduler } from './core/scheduler';
import { CommentParser, type CommentBlock } from './parser/commentParser';
import { TranslationService, PROMPT_VERSION, normalizeEndpoint, preservesCommentStructure, type TranslationConfig } from './translation';
import { TranslationRenderer } from './renderer';
import { TranslationReader } from './reader';
import type { ReaderModel } from './readerContent';

const AUTOMATIC_COMMENT_LIMIT = 500;
type Phase = 'scanning' | 'translating' | 'ready' | 'error' | 'demo';

interface FileState {
  document: vscode.TextDocument;
  generation: number;
  abort?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  blocks: CommentBlock[];
  translations: Map<string, string>;
  admitted: Set<string>;
  remainingBudget: number;
  phase: Phase;
  cacheHits: number;
  remaining: number;
  error?: string;
}

export interface FileSnapshot {
  enabled: boolean;
  automatic: boolean;
  phase?: Phase;
  total: number;
  translated: number;
  cacheHits: number;
  remaining: number;
  widgets: number;
  reader: ReturnType<TranslationReader['snapshot']>;
  error?: string;
}

/** Coordinates scanning, persistent cache lookup, batched translation and editor display. */
export class TranslationController implements vscode.Disposable {
  private readonly states = new Map<string, FileState>();
  private readonly excluded = new Set<string>();
  private readonly scheduler = new FileScheduler(3);
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  private readonly disposables: vscode.Disposable[] = [];
  private automatic = false;
  private disposed = false;
  private viewportTimer?: ReturnType<typeof setTimeout>;
  private lastSourceDocument?: vscode.TextDocument;

  /** Attaches editor listeners; no document is sent to a service until explicitly enabled. */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parser: CommentParser,
    private readonly cache: TranslationCache,
    private readonly service = new TranslationService(),
    private readonly renderer = new TranslationRenderer(),
    private readonly reader = new TranslationReader({
      onReveal: (uri, line) => this.revealSource(uri, line),
      onRefresh: (uri) => this.refreshReader(uri),
      onSettings: () => { void vscode.commands.executeCommand('commentTranslator.openSettings'); },
      onFocus: () => this.updateStatus(),
    }),
  ) {
    this.rememberSource(vscode.window.activeTextEditor?.document);
    this.status.command = 'commentTranslator.toggle';
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!event.contentChanges.length) return;
        const state = this.states.get(event.document.uri.toString());
        if (!state) return;
        if (state.phase === 'demo') { this.disable(event.document.uri.toString()); return; }
        this.scheduleScan(state);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.disable(document.uri.toString());
        this.reader.closeFile(document.uri.toString());
        this.excluded.delete(document.uri.toString());
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.rememberSource(editor?.document);
        if (editor && this.automatic) this.enableAutomatically(editor.document);
        this.updateStatus();
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (this.automatic) for (const editor of editors) this.enableAutomatically(editor.document);
        this.scheduleRender();
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.scheduleRender()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(CONFIG_SECTION)) return;
        for (const state of this.states.values()) if (state.phase !== 'demo') this.scheduleScan(state);
      }),
    );
    this.updateStatus();
  }

  /** Toggles translation for the active file, with a per-window exclusion when automatic mode is on. */
  async toggle(): Promise<void> {
    const document = this.getActiveDocument();
    if (!document) return;
    const uri = document.uri.toString();
    if (this.states.has(uri)) { this.excluded.add(uri); this.disable(uri); return; }
    if (!this.checkDocument(document, true)) return;
    try { readSettings(document.uri); }
    catch {
      await configureProvider(this.context);
      try { readSettings(document.uri); } catch { return; }
    }
    this.excluded.delete(uri);
    await this.enable(document, true);
  }

  /** Opens a borderless multiline reading view for the current source file. */
  async openReader(): Promise<void> {
    const document = this.getActiveDocument();
    if (!document || !this.checkDocument(document, true)) return;
    let state = this.states.get(document.uri.toString());
    if (!state) { await this.toggle(); state = this.states.get(document.uri.toString()); }
    if (state) this.reader.open(document.uri.toString(), this.readerModel(state));
  }

  /** Enables automatic scanning on file visits for this window session, or cancels all translation. */
  async toggleAutomatic(): Promise<void> {
    if (this.automatic) {
      this.automatic = false;
      for (const uri of [...this.states.keys()]) this.disable(uri);
      this.excluded.clear();
      this.updateStatus();
      return;
    }
    if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('请先信任此工作区，再开启注释翻译。'); return; }
    try { readSettings(); }
    catch {
      await configureProvider(this.context);
      try { readSettings(); } catch { return; }
    }
    this.automatic = true;
    this.excluded.clear();
    for (const editor of vscode.window.visibleTextEditors) this.enableAutomatically(editor.document);
    this.updateStatus();
  }

  /** Retries the active file; existing persistent translations are reused. */
  async refresh(): Promise<void> {
    const document = this.getActiveDocument();
    if (!document) return;
    const state = this.states.get(document.uri.toString());
    if (!state) { await this.toggle(); return; }
    if (state.phase === 'demo') { await this.demo(); return; }
    await this.scan(state);
  }

  /** Explicitly authorizes the next 500 previously unprocessed comments in the active file. */
  async translateRemaining(): Promise<void> {
    const uri = this.getActiveDocument()?.uri.toString();
    const state = uri ? this.states.get(uri) : undefined;
    if (!state) { await this.toggle(); return; }
    if (state.phase === 'demo') return;
    state.remainingBudget += AUTOMATIC_COMMENT_LIMIT;
    await this.scan(state);
  }

  /** Clears persistent translations and stops current tasks so late results cannot refill the cache. */
  async clearCache(): Promise<void> {
    this.stop();
    this.cache.clear();
    await this.cache.flush();
    this.updateStatus();
    void vscode.window.showInformationMessage('本地 SQLite 翻译缓存已清除。再次开启翻译时会重新请求。');
  }

  /** Cancels all active work before credentials or the provider are changed. */
  stop(): void {
    this.automatic = false;
    for (const uri of [...this.states.keys()]) this.disable(uri);
    this.excluded.clear();
    this.updateStatus();
  }

  /** Shows counts and actionable errors without exposing comment text or credentials. */
  showStatus(): void {
    const uri = this.getActiveDocument()?.uri.toString() ?? '';
    const state = this.getSnapshot(uri);
    const message = !state.enabled ? '当前文件未开启注释翻译。' : [
      state.phase === 'demo' ? '离线效果示例（未调用 AI）' : `注释 ${state.total} 条，已有译文 ${state.translated} 条，SQLite 命中 ${state.cacheHits} 条。`,
      state.remaining ? `还有 ${state.remaining} 条待手动继续。` : '',
      state.error ?? '',
    ].filter(Boolean).join(' ');
    void vscode.window.showInformationMessage(message);
  }

  /** Returns non-sensitive diagnostics for the active state and extension integration tests. */
  getSnapshot(uri: string): FileSnapshot {
    const state = this.states.get(uri);
    return {
      enabled: !!state, automatic: this.automatic, phase: state?.phase,
      total: state?.blocks.length ?? 0, translated: state?.translations.size ?? 0,
      cacheHits: state?.cacheHits ?? 0, remaining: state?.remaining ?? 0,
      widgets: this.renderer.widgetCount(uri), reader: this.reader.snapshot(uri), error: state?.error,
    };
  }

  /** Opens deterministic borderless multiline translations without contacting a provider. */
  async demo(): Promise<void> {
    const content = [
      'const cache = new Map<string, object>();',
      '',
      '/**',
      ' * Load the user profile from the local cache.',
      ' *',
      ' * @param userId The unique user identifier.',
      ' * @returns The cached user profile, if available.',
      ' */',
      'async function loadProfile(userId: string) {',
      '  // Return the cached profile when available.',
      '  // This avoids an unnecessary network request.',
      '  const profile = cache.get(userId);',
      '  const timeout = 3000; // Request timeout in milliseconds.',
      '  return profile;',
      '}',
      '',
    ].join('\n');
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
    this.rememberSource(document);
    const uri = document.uri.toString();
    // Register the state before showing the editor to exclude this sample from automatic requests.
    const state = this.createState(document);
    state.phase = 'demo';
    this.states.set(uri, state);
    const version = document.version;
    const current = () => !this.disposed && !document.isClosed && this.states.get(uri) === state && document.version === version;
    await vscode.window.showTextDocument(document, { preview: false });
    if (!current()) return;
    let blocks: CommentBlock[];
    try {
      blocks = await this.parser.parse(content, 'typescript');
    } catch (error) {
      if (current()) {
        state.phase = 'error';
        state.error = error instanceof Error ? error.message : '离线示例加载失败。';
        this.updateStatus();
      }
      throw error;
    }
    if (!current()) return;
    state.blocks = blocks;
    const translations = [
      '从本地缓存加载用户资料。\n\n@param userId 用户的唯一标识符。\n@returns 缓存中已有的用户资料。',
      '存在缓存时直接返回用户资料。\n这样可以避免不必要的网络请求。',
      '请求超时时间，单位为毫秒。',
    ];
    state.blocks.forEach((block, index) => state.translations.set(block.id, translations[index] ?? '示例译文'));
    this.render(state);
    if (this.usesReader(document)) this.reader.open(uri, this.readerModel(state));
    this.updateStatus();
  }

  /** Stops editor work and releases document references; persisted translations are retained. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.viewportTimer);
    for (const uri of [...this.states.keys()]) this.disable(uri);
    this.scheduler.dispose();
    this.renderer.dispose();
    this.reader.dispose();
    this.parser.dispose();
    this.status.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private createState(document: vscode.TextDocument): FileState {
    return { document, generation: 0, blocks: [], translations: new Map(), admitted: new Set(), remainingBudget: AUTOMATIC_COMMENT_LIMIT, phase: 'scanning', cacheHits: 0, remaining: 0 };
  }

  private checkDocument(document: vscode.TextDocument, notify: boolean): boolean {
    const valid = vscode.workspace.isTrusted && ['file', 'untitled'].includes(document.uri.scheme) && this.parser.supportsLanguage(document.languageId);
    if (!valid && notify) void vscode.window.showInformationMessage('当前文件类型暂不支持，或工作区尚未信任。Python、HTML/XML、Markdown 按当前范围排除。');
    return valid;
  }

  private enableAutomatically(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    if (this.disposed || this.excluded.has(uri) || this.states.has(uri) || !this.checkDocument(document, false)) return;
    void this.enable(document, vscode.window.activeTextEditor?.document.uri.toString() === uri);
  }

  private async enable(document: vscode.TextDocument, openReader = false): Promise<void> {
    if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) this.rememberSource(document);
    const state = this.createState(document);
    this.states.set(document.uri.toString(), state);
    if (openReader && this.usesReader(document)) this.reader.open(document.uri.toString(), this.readerModel(state));
    await this.scan(state);
  }

  private disable(uri: string): void {
    const state = this.states.get(uri);
    if (state) {
      state.generation++;
      state.abort?.abort();
      clearTimeout(state.timer);
    }
    this.scheduler.cancel(uri);
    this.states.delete(uri);
    this.renderer.clearFile(uri);
    this.reader.clearFile(uri);
    this.cache.deleteFile(uri);
    if (!this.disposed) this.updateStatus();
  }

  private scheduleScan(state: FileState): void {
    state.generation++;
    state.abort?.abort();
    this.scheduler.cancel(state.document.uri.toString());
    this.renderer.clearFile(state.document.uri.toString());
    state.translations.clear();
    state.phase = 'scanning';
    this.reader.update(state.document.uri.toString(), this.readerModel(state));
    clearTimeout(state.timer);
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, state.document.uri);
    state.timer = setTimeout(() => { void this.scan(state); }, boundedNumber(config, 'debounceMs', 600, 100, 5000));
    this.updateStatus();
  }

  private async scan(state: FileState): Promise<void> {
    const document = state.document;
    const uri = document.uri.toString();
    if (this.disposed || this.states.get(uri) !== state || document.isClosed) return;
    state.abort?.abort();
    this.scheduler.cancel(uri);
    clearTimeout(state.timer);
    const abort = new AbortController();
    state.abort = abort;
    const generation = ++state.generation;
    const version = document.version;
    const current = () => !this.disposed && !abort.signal.aborted && !document.isClosed && document.version === version && this.states.get(uri) === state && state.generation === generation;
    state.phase = 'scanning';
    state.error = undefined;
    state.cacheHits = 0;
    state.remaining = 0;
    state.translations.clear();
    this.reader.update(uri, this.readerModel(state));
    this.updateStatus();
    try {
      const settings = readSettings(document.uri);
      const config: TranslationConfig = { ...settings, apiKey: await readApiKey(this.context, settings.baseUrl, document.uri) };
      await this.cache.flush();
      if (!current()) return;
      const blocks = await this.parser.parse(document.getText(), document.languageId, abort.signal);
      if (!current()) return;
      state.blocks = blocks;
      const groups = new Map<string, { key: string; blocks: CommentBlock[]; context: Parameters<typeof cacheKey>[0] }>();
      for (const block of blocks) {
        const context = { text: block.text, languageId: block.languageId, baseUrl: normalizeEndpoint(config.baseUrl), model: config.model, targetLanguage: config.targetLanguage, promptVersion: PROMPT_VERSION, prompt: config.prompt };
        const key = cacheKey(context);
        let cached = this.cache.get(uri, key);
        if (cached === undefined) {
          const legacy = this.cache.get(uri, cacheKey({ ...context, promptVersion: '1' }));
          if (legacy !== undefined && preservesCommentStructure(block.text, legacy)) {
            cached = legacy;
            this.cache.set(uri, key, legacy, context);
          }
        }
        if (cached !== undefined) {
          state.translations.set(block.id, cached);
          state.cacheHits++;
        } else {
          const group = groups.get(key) ?? { key, blocks: [] as CommentBlock[], context };
          group.blocks.push(block);
          groups.set(key, group);
        }
      }
      this.render(state);
      const requests = new Map<string, { key: string; blocks: CommentBlock[]; context: Parameters<typeof cacheKey>[0] }>();
      for (const group of groups.values()) {
        if (!state.admitted.has(group.key)) {
          if (state.remainingBudget <= 0) { state.remaining += group.blocks.length; continue; }
          state.admitted.add(group.key);
          state.remainingBudget--;
        }
        requests.set(group.blocks[0].id, group);
      }
      if (requests.size) {
        state.phase = 'translating';
        this.reader.update(uri, this.readerModel(state));
        this.updateStatus();
        await this.scheduler.schedule(uri, async (signal) => {
          if (!current()) return;
          await this.service.translate(
            [...requests].map(([id, group]) => ({ id, text: group.blocks[0].text })), config, signal,
            (translations) => {
              if (!current()) return;
              for (const [id, translation] of translations) {
                const group = requests.get(id);
                if (!group) continue;
                this.cache.set(uri, group.key, translation, group.context);
                for (const block of group.blocks) state.translations.set(block.id, translation);
              }
              this.render(state);
              this.updateStatus();
            },
          );
        }, abort.signal);
      }
      if (!current()) return;
      await this.cache.flush();
      if (!current()) return;
      state.phase = 'ready';
      this.render(state);
      if (state.remaining) {
        void vscode.window.showInformationMessage(`本次已达到自动翻译上限，还有 ${state.remaining} 条注释。`, '继续翻译下一批').then((choice) => {
          if (choice && current()) { state.remainingBudget += AUTOMATIC_COMMENT_LIMIT; void this.scan(state); }
        });
      }
    } catch (error) {
      if (!current()) return;
      state.phase = 'error';
      state.error = error instanceof Error ? error.message : '翻译失败，请检查模型配置后重试。';
      this.reader.update(uri, this.readerModel(state));
      // The service sanitizes provider errors; never include response bodies in UI or logs.
      void vscode.window.showWarningMessage(`注释译读：${state.error}`, '重试', '配置服务').then((choice) => {
        if (choice === '重试' && this.states.get(uri) === state) void this.scan(state);
        if (choice === '配置服务') { this.stop(); void configureProvider(this.context); }
      });
    } finally {
      if (current()) this.updateStatus();
    }
  }

  private scheduleRender(): void {
    clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      if (this.disposed) return;
      for (const state of this.states.values()) this.render(state);
    }, 100);
  }

  private render(state: FileState): void {
    if (state.document.isClosed) return;
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, state.document.uri);
    this.renderer.render(state.document, state.blocks, state.translations,
      boundedNumber(config, 'visibleBufferLines', 10, 0, 100),
      boundedNumber(config, 'trailingPreviewLength', 80, 10, 300));
    this.reader.update(state.document.uri.toString(), this.readerModel(state));
  }

  private usesReader(document: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get<string>('displayMode', 'reader') === 'reader';
  }

  private readerModel(state: FileState): ReaderModel {
    return { source: state.document.getText(), languageId: state.document.languageId,
      title: state.document.uri.path?.split('/').pop() || '源码', phase: state.phase,
      translated: state.translations.size, total: state.blocks.length,
      blocks: state.blocks, translations: new Map(state.translations), error: state.error };
  }

  private async revealSource(uri: string, line: number): Promise<void> {
    const document = this.states.get(uri)?.document ?? vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri);
    if (!document || document.isClosed || !Number.isInteger(line) || line < 0 || line >= document.lineCount) return;
    await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
  }

  private refreshReader(uri: string): void {
    const state = this.states.get(uri);
    if (state?.phase === 'demo') { this.reader.update(uri, this.readerModel(state)); return; }
    if (state) { void this.scan(state); return; }
    const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri);
    if (document && !document.isClosed && this.checkDocument(document, true)) {
      this.excluded.delete(uri);
      void this.enable(document);
    }
  }

  private updateStatus(): void {
    const document = this.getActiveDocument();
    if (!document || !this.parser.supportsLanguage(document.languageId)) { this.status.hide(); return; }
    const snapshot = this.getSnapshot(document.uri.toString());
    if (!snapshot.enabled) this.status.text = this.automatic ? '$(globe) 译读：此文件已暂停' : '$(globe) 开启译读';
    else if (snapshot.phase === 'scanning') this.status.text = '$(sync~spin) 译读：扫描 / 查库';
    else if (snapshot.phase === 'translating') this.status.text = `$(sync~spin) 译读 ${snapshot.translated}/${snapshot.total}`;
    else if (snapshot.phase === 'error') this.status.text = '$(warning) 译读：需要处理';
    else if (snapshot.phase === 'demo') this.status.text = '$(globe) 译读：离线示例';
    else this.status.text = `$(globe) 译读 ${snapshot.translated}/${snapshot.total}${snapshot.remaining ? ' · 待继续' : ''}`;
    this.status.tooltip = snapshot.enabled
      ? `点击关闭当前文件翻译。SQLite 命中 ${snapshot.cacheHits} 条。${snapshot.error ?? ''}\n命令面板可查看状态、继续翻译或开启当前窗口自动翻译。`
      : '点击开启当前文件翻译。已缓存译文直接显示，仅未命中注释会发送到你配置的模型服务。';
    this.status.show();
  }

  private rememberSource(document?: vscode.TextDocument): void {
    if (document && ['file', 'untitled'].includes(document.uri.scheme)) this.lastSourceDocument = document;
  }

  private getActiveDocument(): vscode.TextDocument | undefined {
    const readingUri = this.reader.activeUri();
    if (readingUri) return this.states.get(readingUri)?.document ?? vscode.workspace.textDocuments.find((item) => item.uri.toString() === readingUri && !item.isClosed);
    const document = vscode.window.activeTextEditor?.document;
    // Native CommentThread widgets temporarily focus their own virtual text editor.
    if (document?.uri.scheme === 'comment') {
      return this.lastSourceDocument?.isClosed ? undefined : this.lastSourceDocument;
    }
    return document;
  }
}
