import * as vscode from 'vscode';
import { CONFIG_SECTION, boundedNumber, configureProvider, readApiKey, readSettings } from './config';
import { TranslationCache, cacheKey } from './core/cache';
import { FileScheduler } from './core/scheduler';
import { CommentParser, type CommentBlock } from './parser/commentParser';
import { TranslationService, PROMPT_VERSION, normalizeEndpoint, preservesCommentStructure, type TranslationConfig } from './translation';
import { TranslationRenderer } from './renderer';
import { TranslationReader } from './reader';
import type { ReaderModel } from './readerContent';
import { applyMarkdownTranslations, MARKDOWN_PROMPT_VERSION, parseMarkdown, preservesMarkdownStructure, type MarkdownChunk } from './markdown';

const AUTOMATIC_COMMENT_LIMIT = 500;
type Phase = 'scanning' | 'translating' | 'ready' | 'error' | 'demo' | 'stale';

interface FileState {
  mode: 'comments' | 'markdown';
  markdownChunks: MarkdownChunk[];
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
  readerOffered: boolean;
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

/** Coordinates scanning, persistent cache lookup, concurrent translation and editor display. */
export class TranslationController implements vscode.Disposable {
  private readonly states = new Map<string, FileState>();
  private readonly excluded = new Set<string>();
  private readonly scheduler = new FileScheduler();
  private readonly service: TranslationService;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  private readonly disposables: vscode.Disposable[] = [];
  private automatic = false;
  private started = false;
  private suspended = false;
  private disposed = false;
  private configurationTimer?: ReturnType<typeof setTimeout>;
  private viewportTimer?: ReturnType<typeof setTimeout>;
  private lastSourceDocument?: vscode.TextDocument;

  /** Attaches editor listeners; start restores the user's automatic translation preference. */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parser: CommentParser,
    private readonly cache: TranslationCache,
    service?: TranslationService,
    private readonly renderer = new TranslationRenderer(),
    private readonly reader = new TranslationReader({
      onReveal: (uri, line) => this.revealSource(uri, line),
      onRefresh: (uri) => this.refreshReader(uri),
      onSettings: () => { void vscode.commands.executeCommand('commentTranslator.openSettings'); },
      onFocus: () => this.updateStatus(),
    }),
  ) {
    this.service = service ?? new TranslationService(undefined, { scheduler: this.scheduler });
    this.updateConcurrency();
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
        // A pool-size change should not discard results or restart paid requests.
        const otherSettings = ['automatic', 'baseUrl', 'model', 'apiKey', 'targetLanguage', 'prompt',
          'responseFormat', 'temperature', 'thinking', 'maxBatchChars', 'maxOutputTokens',
          'tokenLimitParameter', 'timeoutSeconds', 'debounceMs', 'visibleBufferLines',
          'trailingPreviewLength', 'displayMode'];
        if (event.affectsConfiguration(`${CONFIG_SECTION}.maxConcurrentRequests`) &&
          !otherSettings.some((key) => event.affectsConfiguration(`${CONFIG_SECTION}.${key}`))) {
          this.updateConcurrency();
          return;
        }
        // Cancel old provider work before a larger pool can start more of its queued requests.
        if (!this.suspended) {
          for (const state of this.states.values()) if (state.phase !== 'demo') this.scheduleScan(state);
        }
        this.updateConcurrency();
        if (this.started && event.affectsConfiguration(`${CONFIG_SECTION}.automatic`)) {
          this.suspended = false;
          clearTimeout(this.configurationTimer);
          this.synchronizeAutomatic();
          return;
        }
        if (this.suspended) return;
        clearTimeout(this.configurationTimer);
        if (this.started) this.configurationTimer = setTimeout(() => this.synchronizeAutomatic(), 600);
        this.updateStatus();
      }),
    );
    this.updateStatus();
  }

  /** Restores automatic translation for visible source files after commands are registered. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.synchronizeAutomatic();
  }

  /** Pauses requests throughout the configuration wizard and resumes with its final settings. */
  async configure(): Promise<void> {
    this.stop(false);
    try { await configureProvider(this.context); }
    finally {
      this.suspended = false;
      if (this.started) this.synchronizeAutomatic();
    }
  }

  /** Toggles translation for the active file, with a per-window exclusion when automatic mode is on. */
  async toggle(): Promise<void> {
    const document = this.getActiveDocument();
    if (!document) return;
    const uri = document.uri.toString();
    if (this.states.has(uri)) { this.excluded.add(uri); this.disable(uri); return; }
    if (document.languageId === 'markdown') { await this.translateMarkdown(document.uri); return; }
    if (!this.checkDocument(document, true)) return;
    try { readSettings(document.uri); }
    catch {
      await this.configure();
      try { readSettings(document.uri); } catch { return; }
      if (this.states.has(uri)) return;
    }
    this.excluded.delete(uri);
    await this.enable(document, true);
  }

  /** Opens a borderless multiline reading view for the current source file. */
  async openReader(): Promise<void> {
    const document = this.getActiveDocument();
    if (document?.languageId === 'markdown') { await this.translateMarkdown(document.uri); return; }
    if (!document || !this.checkDocument(document, true)) return;
    let state = this.states.get(document.uri.toString());
    if (!state) { await this.toggle(); state = this.states.get(document.uri.toString()); }
    if (state) {
      state.readerOffered = true;
      this.reader.open(document.uri.toString(), this.readerModel(state));
    }
  }

  /** Translates an explicitly selected Markdown file into a read-only reader, never on open. */
  async translateMarkdown(target?: vscode.Uri): Promise<void> {
    if (this.disposed) return;
    if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('请先信任此工作区，再翻译 Markdown。'); return; }
    if (target && !['file', 'untitled'].includes(target.scheme)) return;
    const document = target
      ? vscode.workspace.textDocuments.find((item) => item.uri.toString() === target.toString() && !item.isClosed)
        ?? await vscode.workspace.openTextDocument(target)
      : this.getActiveDocument();
    if (!document || document.isClosed || document.languageId !== 'markdown' || !this.checkDocument(document, true, true)) {
      void vscode.window.showInformationMessage('请在 Markdown 文件上右键选择“翻译整个 Markdown 文件”。');
      return;
    }
    try { readSettings(document.uri); }
    catch {
      await this.configure();
      try { readSettings(document.uri); } catch { return; }
    }
    if (this.disposed || document.isClosed) return;
    const uri = document.uri.toString();
    const existing = this.states.get(uri);
    if (existing?.mode === 'markdown') {
      this.reader.open(uri, this.readerModel(existing));
      // Repeated menu clicks focus the ongoing reader instead of cancelling a paid request.
      if (existing.phase !== 'scanning' && existing.phase !== 'translating') await this.scan(existing);
      return;
    }
    const state = this.createState(document, 'markdown');
    this.states.set(uri, state);
    this.reader.open(uri, this.readerModel(state));
    await this.scan(state);
  }

  /** Persists automatic scanning across VS Code restarts, or cancels all current translation. */
  async toggleAutomatic(): Promise<void> {
    if (this.automatic) {
      await this.pauseAutomatic();
      return;
    }
    if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('请先信任此工作区，再开启注释翻译。'); return; }
    try { readSettings(); }
    catch {
      await this.configure();
      try { readSettings(); } catch { return; }
    }
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update('automatic', true, vscode.ConfigurationTarget.Global);
    this.suspended = false;
    this.excluded.clear();
    this.synchronizeAutomatic();
  }

  /** Cancels all work and persists the disabled preference before removing credentials or cache. */
  async pauseAutomatic(): Promise<void> {
    this.stop();
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update('automatic', false, vscode.ConfigurationTarget.Global);
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
    await this.pauseAutomatic();
    this.cache.clear();
    await this.cache.flush();
    this.updateStatus();
    void vscode.window.showInformationMessage('本地 SQLite 翻译缓存已清除。再次开启翻译时会重新请求。');
  }

  /** Suspends current work, optionally retaining per-file exclusions during provider configuration. */
  stop(clearExclusions = true): void {
    this.suspended = true;
    clearTimeout(this.configurationTimer);
    this.automatic = false;
    for (const uri of [...this.states.keys()]) this.disable(uri);
    if (clearExclusions) this.excluded.clear();
    this.updateStatus();
  }

  /** Shows counts and actionable errors without exposing comment text or credentials. */
  showStatus(): void {
    const uri = this.getActiveDocument()?.uri.toString() ?? '';
    const state = this.getSnapshot(uri);
    const unit = this.states.get(uri)?.mode === 'markdown' ? 'Markdown 片段' : '注释';
    const message = !state.enabled ? '当前文件未开启注释翻译。' : [
      state.phase === 'demo' ? '离线效果示例（未调用 AI）' : `${unit} ${state.total} 条，已有译文 ${state.translated} 条，SQLite 命中 ${state.cacheHits} 条。`,
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
      total: state ? this.unitCount(state) : 0, translated: state?.translations.size ?? 0,
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
    clearTimeout(this.configurationTimer);
    clearTimeout(this.viewportTimer);
    for (const uri of [...this.states.keys()]) this.disable(uri);
    this.scheduler.dispose();
    this.renderer.dispose();
    this.reader.dispose();
    this.parser.dispose();
    this.status.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private createState(document: vscode.TextDocument, mode: FileState['mode'] = 'comments'): FileState {
    return { document, mode, markdownChunks: [], generation: 0, blocks: [], translations: new Map(), admitted: new Set(), remainingBudget: mode === 'markdown' ? Number.POSITIVE_INFINITY : AUTOMATIC_COMMENT_LIMIT, phase: 'scanning', cacheHits: 0, remaining: 0, readerOffered: false };
  }

  private checkDocument(document: vscode.TextDocument, notify: boolean, allowMarkdown = false): boolean {
    const valid = vscode.workspace.isTrusted && ['file', 'untitled'].includes(document.uri.scheme) &&
      (this.parser.supportsLanguage(document.languageId) || (allowMarkdown && document.languageId === 'markdown'));
    if (!valid && notify) void vscode.window.showInformationMessage('当前文件类型暂不支持，或工作区尚未信任。Python 暂不支持；Markdown 请使用右键“翻译整个 Markdown 文件”。');
    return valid;
  }

  private enableAutomatically(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    if (this.disposed || this.suspended || this.excluded.has(uri) || !this.checkDocument(document, false)) return;
    try { readSettings(document.uri); } catch { return; }
    const openReader = vscode.window.activeTextEditor?.document.uri.toString() === uri;
    const state = this.states.get(uri);
    if (state) {
      if (state.phase !== 'demo' && openReader && !state.readerOffered && this.usesReader(document)) {
        state.readerOffered = true;
        this.reader.open(uri, this.readerModel(state));
      }
      return;
    }
    void this.enable(document, openReader);
  }

  private updateConcurrency(): void {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    this.scheduler.setMaxConcurrent(boundedNumber(config, 'maxConcurrentRequests', 10, 1, 64));
  }

  private synchronizeAutomatic(): void {
    if (this.disposed || this.suspended) return;
    const enabled = vscode.workspace.isTrusted && vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>('automatic', true);
    if (!enabled) {
      if (this.automatic) this.stop();
      this.suspended = false;
    }
    this.automatic = enabled;
    if (enabled) {
      const documents = new Map(vscode.window.visibleTextEditors.map((editor) => [editor.document.uri.toString(), editor.document]));
      const activeDocument = this.getActiveDocument();
      if (activeDocument) documents.set(activeDocument.uri.toString(), activeDocument);
      for (const document of documents.values()) this.enableAutomatically(document);
    }
    this.updateStatus();
  }

  private async enable(document: vscode.TextDocument, openReader = false): Promise<void> {
    if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) this.rememberSource(document);
    const state = this.createState(document);
    state.readerOffered = this.reader.snapshot(document.uri.toString()).open;
    this.states.set(document.uri.toString(), state);
    if (openReader && this.usesReader(document)) {
      state.readerOffered = true;
      this.reader.open(document.uri.toString(), this.readerModel(state));
    }
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
    if (state.mode === 'markdown') {
      clearTimeout(state.timer);
      state.markdownChunks = [];
      state.phase = 'stale';
      state.cacheHits = 0;
      state.error = undefined;
      this.reader.update(state.document.uri.toString(), this.readerModel(state));
      this.updateStatus();
      return;
    }
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
      const config: TranslationConfig = { ...settings, ...(state.mode === 'markdown' ? { contentKind: 'markdown' as const } : {}), apiKey: await readApiKey(this.context, settings.baseUrl, document.uri) };
      await this.cache.flush();
      if (!current()) return;
      if (state.mode === 'markdown') state.markdownChunks = parseMarkdown(document.getText(), config.maxBatchChars);
      else state.blocks = await this.parser.parse(document.getText(), document.languageId, abort.signal);
      if (!current()) return;
      const blocks = state.mode === 'markdown' ? state.markdownChunks : state.blocks;
      type Unit = { id: string; text: string };
      const groups = new Map<string, { key: string; blocks: Unit[]; context: Parameters<typeof cacheKey>[0] }>();
      for (const block of blocks) {
        const context = { text: block.text, languageId: state.mode === 'markdown' ? 'markdown-document' : document.languageId, baseUrl: normalizeEndpoint(config.baseUrl), model: config.model, targetLanguage: config.targetLanguage, promptVersion: state.mode === 'markdown' ? MARKDOWN_PROMPT_VERSION : PROMPT_VERSION, prompt: config.prompt };
        const key = cacheKey(context);
        let cached = this.cache.get(uri, key);
        if (cached !== undefined && !(state.mode === 'markdown'
          ? preservesMarkdownStructure(block.text, cached) : preservesCommentStructure(block.text, cached))) cached = undefined;
        if (cached === undefined && state.mode !== 'markdown') {
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
          const group = groups.get(key) ?? { key, blocks: [] as Unit[], context };
          group.blocks.push(block);
          groups.set(key, group);
        }
      }
      this.render(state);
      const requests = new Map<string, { key: string; blocks: Unit[]; context: Parameters<typeof cacheKey>[0] }>();
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
        await this.service.translate(
          [...requests].map(([id, group]) => ({ id, text: group.blocks[0].text })), config, abort.signal,
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
          }, uri,
        );
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
        if (choice === '配置服务') void vscode.commands.executeCommand('commentTranslator.configure');
      });
    } finally {
      if (current()) this.updateStatus();
    }
  }

  private scheduleRender(): void {
    clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      if (this.disposed) return;
      for (const state of this.states.values()) if (state.mode === 'comments') this.render(state);
    }, 100);
  }

  private render(state: FileState): void {
    if (state.document.isClosed) return;
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, state.document.uri);
    if (state.mode === 'comments') this.renderer.render(state.document, state.blocks, state.translations,
      boundedNumber(config, 'visibleBufferLines', 10, 0, 100));
    this.reader.update(state.document.uri.toString(), this.readerModel(state));
  }

  private usesReader(document: vscode.TextDocument): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri).get<string>('displayMode', 'inline') === 'reader';
  }

  private readerModel(state: FileState): ReaderModel {
    return { source: state.document.getText(), languageId: state.document.languageId,
      mode: state.mode,
      ...(state.mode === 'markdown' ? { markdown: applyMarkdownTranslations(state.document.getText(), state.markdownChunks, state.translations) } : {}),
      title: state.document.uri.path?.split('/').pop() || '源码', phase: state.phase,
      translated: state.translations.size, total: this.unitCount(state),
      blocks: state.blocks, translations: new Map(state.translations), error: state.error };
  }

  private unitCount(state: FileState): number {
    return state.mode === 'markdown' ? state.markdownChunks.length : state.blocks.length;
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
    if (document?.languageId === 'markdown') { void this.translateMarkdown(document.uri); return; }
    if (document && !document.isClosed && this.checkDocument(document, true)) {
      this.excluded.delete(uri);
      void this.enable(document);
    }
  }

  private updateStatus(): void {
    const document = this.getActiveDocument();
    if (!document || (!this.parser.supportsLanguage(document.languageId) && document.languageId !== 'markdown')) { this.status.hide(); return; }
    const snapshot = this.getSnapshot(document.uri.toString());
    let configurationError: string | undefined;
    try { readSettings(document.uri); } catch (error) { configurationError = error instanceof Error ? error.message : '请检查翻译设置。'; }
    this.status.command = !snapshot.enabled && configurationError ? 'commentTranslator.openSettings' : 'commentTranslator.toggle';
    if (!snapshot.enabled) this.status.text = !vscode.workspace.isTrusted ? '$(lock) 译读：请信任工作区'
      : configurationError ? '$(settings-gear) 译读：请配置服务'
      : this.automatic ? '$(globe) 译读：此文件已暂停' : '$(globe) 译读：自动翻译已关闭';
    else if (snapshot.phase === 'scanning') this.status.text = '$(sync~spin) 译读：扫描 / 查库';
    else if (snapshot.phase === 'translating') this.status.text = `$(sync~spin) 译读 ${snapshot.translated}/${snapshot.total}`;
    else if (snapshot.phase === 'error') this.status.text = '$(warning) 译读：需要处理';
    else if (snapshot.phase === 'stale') this.status.text = '$(refresh) 译读：内容或设置已更改';
    else if (snapshot.phase === 'demo') this.status.text = '$(globe) 译读：离线示例';
    else this.status.text = `$(globe) 译读 ${snapshot.translated}/${snapshot.total}${snapshot.remaining ? ' · 待继续' : ''}`;
    if (!snapshot.enabled && document.languageId === 'markdown' && !configurationError) {
      this.status.text = '$(book) 译读：翻译 Markdown 全文';
      this.status.command = 'commentTranslator.translateMarkdown';
    }
    this.status.tooltip = snapshot.enabled
      ? `点击关闭当前文件翻译。SQLite 命中 ${snapshot.cacheHits} 条。${snapshot.error ?? ''}\n命令面板可查看状态、继续翻译或切换自动翻译。`
      : configurationError ?? (document.languageId === 'markdown'
        ? '点击手动翻译 Markdown 全文。已有缓存直接显示，仅未命中的片段发送到已配置的模型服务。'
        : '点击开启当前文件翻译。已缓存译文直接显示，仅未命中注释会发送到你配置的模型服务。');
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
