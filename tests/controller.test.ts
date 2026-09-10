import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { TranslationController } from '../src/controller';
import { cacheKey, type TranslationCache } from '../src/core/cache';
import { type CommentBlock, type CommentParser } from '../src/parser/commentParser';
import { type TranslationRenderer } from '../src/renderer';
import type { TranslationReader } from '../src/reader';
import type { ReaderModel } from '../src/readerContent';
import { PROMPT_VERSION, type TranslationConfig, type TranslationItem, type TranslationService } from '../src/translation';
import { createDocument, createEditor, events, resetVscodeMock, settings, window, workspace } from './vscodeMock';

vi.mock('vscode', () => import('./vscodeMock'));

function block(id: string, text: string, line = 0): CommentBlock {
  return { id, text, rawText: `// ${text}`, languageId: 'typescript', kind: 'standalone', start: { line, character: 0 }, end: { line, character: text.length + 3 } };
}

function translationKey(text: string, promptVersion: string = PROMPT_VERSION): string {
  return cacheKey({ text, languageId: 'typescript', baseUrl: 'https://example.test/v1/chat/completions', model: 'test-model', targetLanguage: '简体中文', promptVersion, prompt: '' });
}

async function settle(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function changeSetting(key: string, value: unknown): void {
  settings.set(key, value);
  events.configuration.fire({ affectsConfiguration: (section: string) => section === 'commentTranslator' || section === `commentTranslator.${key}` } as vscode.ConfigurationChangeEvent);
}

type Translate = (items: readonly TranslationItem[], config: TranslationConfig, signal: AbortSignal, onBatch?: (translations: Map<string, string>) => void) => Promise<Map<string, string>>;

function fixture(blocks: CommentBlock[] = [block('a', 'First comment')], document = createDocument()) {
  const persistent = new Map<string, string>();
  const cache = {
    get: vi.fn((_uri: string, key: string) => persistent.get(key)),
    set: vi.fn((_uri: string, key: string, text: string, ..._context: unknown[]) => { persistent.set(key, text); }),
    deleteFile: vi.fn((_uri: string) => {}),
    clear: vi.fn(() => persistent.clear()),
    flush: vi.fn(async () => {}),
  };
  const parser = { parse: vi.fn(async (..._args: unknown[]) => blocks), supportsLanguage: vi.fn((languageId: string) => ['typescript', 'java'].includes(languageId)), dispose: vi.fn() };
  const service = { translate: vi.fn<Translate>(async (items, _config, _signal, onBatch) => {
    const result = new Map(items.map(({ id }) => [id, `译文 ${id}`]));
    onBatch?.(result);
    return result;
  }) };
  const rendered: Map<string, string>[] = [];
  const renderer = {
    render: vi.fn((_document: vscode.TextDocument, _blocks: readonly CommentBlock[], translations: ReadonlyMap<string, string>, ..._options: number[]) => {
      rendered.push(new Map(translations));
    }),
    clearFile: vi.fn(),
    dispose: vi.fn(),
    widgetCount: vi.fn(() => 0),
  };
  const context = { secrets: { get: vi.fn(async () => 'test-key') } } as unknown as vscode.ExtensionContext;
  const readerModels = new Map<string, ReaderModel>();
  const readerFocus = { uri: undefined as string | undefined };
  const reader = {
    open: vi.fn((uri: string, model: ReaderModel) => { readerModels.set(uri, model); }),
    update: vi.fn((uri: string, model: ReaderModel) => { if (readerModels.has(uri)) readerModels.set(uri, model); }),
    clearFile: vi.fn((uri: string) => {
      const model = readerModels.get(uri);
      if (model) readerModels.set(uri, { ...model, translated: 0, translations: new Map() });
    }),
    closeFile: vi.fn((uri: string) => { readerModels.delete(uri); if (readerFocus.uri === uri) readerFocus.uri = undefined; }),
    activeUri: vi.fn(() => readerFocus.uri),
    snapshot: vi.fn((uri: string) => {
      const model = readerModels.get(uri);
      return { open: !!model, ready: !!model, translated: model?.translated ?? 0, sourceLines: model?.source.split(/\r\n|\r|\n/).length ?? 0 };
    }),
    dispose: vi.fn(() => { readerModels.clear(); readerFocus.uri = undefined; }),
  };
  const editor = createEditor(document);
  window.activeTextEditor = editor;
  window.visibleTextEditors = [editor];
  const controller = new TranslationController(context, parser as unknown as CommentParser, cache as unknown as TranslationCache, service as unknown as TranslationService, renderer as unknown as TranslationRenderer, reader as unknown as TranslationReader);
  return { controller, parser, cache, service, renderer, rendered, persistent, document, editor, reader, readerModels, readerFocus };
}

function lateService(mock: ReturnType<typeof fixture>['service']) {
  let callback: ((translations: Map<string, string>) => void) | undefined;
  let ids: string[] = [];
  let resolve: (translations: Map<string, string>) => void = () => {};
  mock.translate.mockImplementation((items, _config, _signal, onBatch) => {
    ids = items.map(({ id }) => id);
    callback = onBatch;
    return new Promise((complete) => { resolve = complete; });
  });
  return {
    complete: (): void => {
      const translations = new Map(ids.map((id) => [id, '迟到译文']));
      callback?.(translations);
      resolve(translations);
    },
  };
}

describe('TranslationController integration', () => {
  let controller: TranslationController | undefined;
  beforeEach(() => { vi.useFakeTimers(); resetVscodeMock(); });
  afterEach(() => { controller?.dispose(); controller = undefined; vi.useRealTimers(); });

  it('remains disabled when the automatic preference is off until explicitly enabled', async () => {
    settings.set('automatic', false);
    const setup = fixture();
    controller = setup.controller;
    controller.start();
    events.active.fire(setup.editor);
    events.visible.fire([setup.editor]);
    events.change.fire({ document: setup.document, contentChanges: [{}] } as unknown as vscode.TextDocumentChangeEvent);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.service.translate).not.toHaveBeenCalled();
    expect(setup.parser.parse).not.toHaveBeenCalled();
    expect(controller.getSnapshot(setup.document.uri.toString()).enabled).toBe(false);
    await controller.toggle();
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
  });

  it('automatically translates an already visible Java file once after activation', async () => {
    const document = createDocument('// First comment', 'file:///test/Example.java');
    Object.assign(document, { languageId: 'java' });
    const setup = fixture(undefined, document);
    controller = setup.controller;
    controller.start();
    controller.start();
    events.active.fire(setup.editor);
    events.visible.fire([setup.editor]);
    await settle();
    expect(setup.parser.parse).toHaveBeenCalledWith(document.getText(), 'java', expect.any(AbortSignal));
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(setup.reader.open).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot(document.uri.toString())).toMatchObject({ automatic: true, phase: 'ready', translated: 1 });
  });

  it.each(['missing-model', 'invalid-url', 'untrusted'] as const)('makes no automatic requests when %s', async (reason) => {
    if (reason === 'missing-model') settings.delete('model');
    if (reason === 'invalid-url') settings.set('baseUrl', 'invalid');
    if (reason === 'untrusted') workspace.isTrusted = false;
    const setup = fixture();
    controller = setup.controller;
    controller.start();
    events.active.fire(setup.editor);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.service.translate).not.toHaveBeenCalled();
    expect(setup.parser.parse).not.toHaveBeenCalled();
    expect(setup.reader.open).not.toHaveBeenCalled();
    const status = window.createStatusBarItem.mock.results[0]!.value;
    expect(status.text).toContain(reason === 'untrusted' ? '信任工作区' : '请配置服务');
  });

  it('starts for the current file when the final setting is supplied without changing editors', async () => {
    settings.delete('model');
    const setup = fixture();
    controller = setup.controller;
    controller.start();
    changeSetting('model', 'configured-model');
    await vi.advanceTimersByTimeAsync(599);
    expect(setup.service.translate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(setup.service.translate.mock.calls[0]![1].model).toBe('configured-model');
  });

  it('persists disabling automatic translation and restores that preference in a new controller', async () => {
    const setup = fixture();
    controller = setup.controller;
    controller.start();
    await settle();
    await controller.toggleAutomatic();
    expect(settings.get('automatic')).toBe(false);
    events.active.fire(setup.editor);
    await settle();
    expect(controller.getSnapshot(setup.document.uri.toString()).enabled).toBe(false);
    controller.dispose();
    const reopened = fixture();
    controller = reopened.controller;
    controller.start();
    await settle();
    expect(reopened.service.translate).not.toHaveBeenCalled();
    await controller.toggleAutomatic();
    await settle();
    expect(settings.get('automatic')).toBe(true);
    expect(reopened.service.translate).toHaveBeenCalledTimes(1);
  });

  it('cancels in-flight automatic translation when the persisted setting is disabled', async () => {
    const setup = fixture();
    controller = setup.controller;
    const pending = lateService(setup.service);
    controller.start();
    await settle();
    const signal = setup.service.translate.mock.calls[0]![2];
    changeSetting('automatic', false);
    expect(signal.aborted).toBe(true);
    pending.complete();
    await settle();
    expect(setup.cache.set).not.toHaveBeenCalled();
    expect(controller.getSnapshot(setup.document.uri.toString())).toMatchObject({ automatic: false, enabled: false });
  });

  it('aborts stale requests immediately when configuration becomes invalid', async () => {
    const setup = fixture();
    controller = setup.controller;
    const pending = lateService(setup.service);
    controller.start();
    await settle();
    const signal = setup.service.translate.mock.calls[0]![2];
    changeSetting('model', '');
    expect(signal.aborted).toBe(true);
    pending.complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.cache.set).not.toHaveBeenCalled();
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot(setup.document.uri.toString()).phase).toBe('error');
  });

  it('keeps the whole provider wizard paused until the final endpoint and model are ready', async () => {
    const setup = fixture();
    controller = setup.controller;
    controller.start();
    await settle();
    setup.service.translate.mockClear();
    window.showInputBox.mockResolvedValueOnce('https://next.example.test/v1')
      .mockImplementationOnce(async () => {
        events.active.fire(setup.editor);
        await vi.advanceTimersByTimeAsync(1000);
        expect(setup.service.translate).not.toHaveBeenCalled();
        return 'next-model';
      }).mockResolvedValueOnce('');
    await controller.configure();
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(setup.service.translate.mock.calls[0]![1]).toMatchObject({ baseUrl: 'https://next.example.test/v1', model: 'next-model' });
  });

  it('keeps explicitly excluded files paused through provider setting changes', async () => {
    const setup = fixture();
    controller = setup.controller;
    controller.start();
    await settle();
    await controller.toggle();
    changeSetting('model', 'another-model');
    await vi.advanceTimersByTimeAsync(1000);
    events.active.fire(setup.editor);
    await settle();
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot(setup.document.uri.toString()).enabled).toBe(false);
  });

  it('offers a background file reader once when focused without reopening a dismissed reader', async () => {
    const setup = fixture();
    controller = setup.controller;
    const background = createDocument('// Other comment', 'file:///test/other.ts');
    const editor = createEditor(background);
    window.visibleTextEditors = [setup.editor, editor];
    controller.start();
    await settle();
    expect(setup.reader.open).toHaveBeenCalledTimes(1);
    window.activeTextEditor = editor;
    events.active.fire(editor);
    expect(setup.reader.open).toHaveBeenCalledTimes(2);
    expect(setup.reader.open).toHaveBeenLastCalledWith(background.uri.toString(), expect.anything());
    setup.readerModels.delete(background.uri.toString());
    events.active.fire(editor);
    expect(setup.reader.open).toHaveBeenCalledTimes(2);
  });

  it('keeps automatic translation disabled after cache clearing, including a later configuration event', async () => {
    const setup = fixture();
    controller = setup.controller;
    controller.start();
    await settle();
    await controller.clearCache();
    expect(settings.get('automatic')).toBe(false);
    changeSetting('model', 'another-model');
    events.active.fire(setup.editor);
    await vi.advanceTimersByTimeAsync(1000);
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot(setup.document.uri.toString()).enabled).toBe(false);
  });

  it('restores the source behind a focused reader after switching automatic translation off and on', async () => {
    const setup = fixture();
    controller = setup.controller;
    controller.start();
    await settle();
    const uri = setup.document.uri.toString();
    setup.readerFocus.uri = uri;
    window.activeTextEditor = undefined;
    window.visibleTextEditors = [];
    changeSetting('automatic', false);
    expect(controller.getSnapshot(uri)).toMatchObject({ enabled: false, reader: { translated: 0 } });
    changeSetting('automatic', true);
    await settle();
    expect(controller.getSnapshot(uri)).toMatchObject({ enabled: true, cacheHits: 1, reader: { translated: 1 } });
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(setup.reader.open).toHaveBeenCalledTimes(1);
    window.activeTextEditor = setup.editor;
    events.active.fire(setup.editor);
    expect(setup.reader.open).toHaveBeenCalledTimes(1);
  });

  it('renders cache hits before translation finishes and sends only misses', async () => {
    const setup = fixture([block('a', 'Cached'), block('b', 'Missing', 1)]);
    controller = setup.controller;
    setup.persistent.set(translationKey('Cached'), '缓存译文');
    const pending = lateService(setup.service);
    const enabling = controller.toggle();
    await settle();
    expect(setup.rendered).toContainEqual(new Map([['a', '缓存译文']]));
    expect(setup.service.translate.mock.calls[0]![0]).toEqual([{ id: 'b', text: 'Missing' }]);
    expect(controller.getSnapshot(setup.document.uri.toString()).cacheHits).toBe(1);
    pending.complete();
    await enabling;
    expect(setup.rendered.at(-1)).toEqual(new Map([['a', '缓存译文'], ['b', '迟到译文']]));
  });

  it('deduplicates identical comments by cache key and maps one result to every occurrence', async () => {
    const setup = fixture([block('a', 'Repeated'), block('b', 'Repeated', 2)]);
    controller = setup.controller;
    await controller.toggle();
    expect(setup.service.translate.mock.calls[0]![0]).toEqual([{ id: 'a', text: 'Repeated' }]);
    expect(setup.cache.set).toHaveBeenCalledTimes(1);
    expect(setup.rendered.at(-1)).toEqual(new Map([['a', '译文 a'], ['b', '译文 a']]));
  });

  it('reuses and upgrades a legacy cached translation whose documentation tags remain intact', async () => {
    const original = '@param userId The user identifier.';
    const setup = fixture([block('a', original)]);
    controller = setup.controller;
    setup.persistent.set(translationKey(original, '1'), '@param userId 用户标识。');
    await controller.toggle();
    expect(setup.service.translate).not.toHaveBeenCalled();
    expect(setup.persistent.get(translationKey(original))).toBe('@param userId 用户标识。');
    expect(controller.getSnapshot(setup.document.uri.toString()).cacheHits).toBe(1);
  });

  it('retranslates a legacy cache entry with a missing or rewritten documentation tag', async () => {
    const original = '@param userId The user identifier.';
    const setup = fixture([block('a', original)]);
    controller = setup.controller;
    setup.persistent.set(translationKey(original, '1'), '@参数 用户编号 用户标识。');
    await controller.toggle();
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(setup.service.translate.mock.calls[0]![0]).toEqual([{ id: 'a', text: original }]);
    expect(controller.getSnapshot(setup.document.uri.toString()).cacheHits).toBe(0);
  });

  it.each(['edit', 'close', 'disable', 'clearCache'] as const)('ignores late callbacks after %s', async (action) => {
    const setup = fixture();
    controller = setup.controller;
    const pending = lateService(setup.service);
    const enabling = controller.toggle();
    await settle();
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    if (action === 'edit') {
      setup.document.replaceText('// Changed comment');
      events.change.fire({ document: setup.document, contentChanges: [{}] } as unknown as vscode.TextDocumentChangeEvent);
    } else if (action === 'close') {
      setup.document.isClosed = true;
      events.close.fire(setup.document as unknown as vscode.TextDocument);
    } else if (action === 'disable') {
      await controller.toggle();
    } else {
      await controller.clearCache();
    }
    const rendersBefore = setup.renderer.render.mock.calls.length;
    const readerUpdatesBefore = setup.reader.update.mock.calls.length;
    pending.complete();
    await enabling;
    await settle();
    expect(setup.service.translate.mock.calls[0]![2].aborted).toBe(true);
    expect(setup.cache.set).not.toHaveBeenCalled();
    expect(setup.renderer.render).toHaveBeenCalledTimes(rendersBefore);
    expect(setup.reader.update).toHaveBeenCalledTimes(readerUpdatesBefore);
  });

  it('reuses persisted translations when a file is reopened, without deleting durable entries on close', async () => {
    const setup = fixture();
    controller = setup.controller;
    await controller.toggle();
    const uri = setup.document.uri.toString();
    setup.document.isClosed = true;
    events.close.fire(setup.document as unknown as vscode.TextDocument);
    expect(setup.cache.deleteFile).toHaveBeenCalledWith(uri);
    expect(setup.cache.clear).not.toHaveBeenCalled();
    const reopened = createDocument(setup.document.getText(), uri);
    const editor = createEditor(reopened);
    window.activeTextEditor = editor;
    window.visibleTextEditors = [editor];
    await controller.toggle();
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot(uri)).toMatchObject({ enabled: true, translated: 1, cacheHits: 1 });
    expect(setup.rendered.at(-1)).toEqual(new Map([['a', '译文 a']]));
  });

  it('keeps an offline demo off the network even while window automatic mode is active', async () => {
    const setup = fixture();
    controller = setup.controller;
    window.activeTextEditor = undefined;
    window.visibleTextEditors = [];
    await controller.toggleAutomatic();
    await controller.demo();
    await vi.advanceTimersByTimeAsync(200);
    expect(setup.service.translate).not.toHaveBeenCalled();
    expect(setup.cache.set).not.toHaveBeenCalled();
    expect(controller.getSnapshot(window.activeTextEditor!.document.uri.toString())).toMatchObject({ enabled: true, automatic: true, phase: 'demo' });
  });

  it.each(['disable', 'edit', 'close'] as const)('does not recreate a demo widget after %s while parsing is still pending', async (action) => {
    const setup = fixture();
    controller = setup.controller;
    let finishParse: (blocks: CommentBlock[]) => void = () => {};
    setup.parser.parse.mockImplementation(() => new Promise((resolve) => { finishParse = resolve; }));
    const demo = controller.demo();
    await settle();
    const document = window.activeTextEditor!.document;
    if (action === 'disable') {
      await controller.toggle();
    } else if (action === 'edit') {
      events.change.fire({ document, contentChanges: [{}] } as unknown as vscode.TextDocumentChangeEvent);
    } else {
      events.close.fire(document);
    }
    const rendersBefore = setup.renderer.render.mock.calls.length;
    finishParse([block('a', 'First comment')]);
    await demo;
    expect(setup.renderer.render).toHaveBeenCalledTimes(rendersBefore);
    expect(setup.service.translate).not.toHaveBeenCalled();
  });

  it('does not automatically re-enable a file explicitly disabled by the user', async () => {
    const setup = fixture();
    controller = setup.controller;
    await controller.toggleAutomatic();
    await settle();
    await controller.toggle();
    events.active.fire(setup.editor);
    events.visible.fire([setup.editor]);
    await vi.advanceTimersByTimeAsync(200);
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot(setup.document.uri.toString()).enabled).toBe(false);
  });

  it('keeps source status and disables the source file when a native comment editor takes focus', async () => {
    const setup = fixture();
    controller = setup.controller;
    await controller.toggle();
    const internalDocument = createDocument('Internal comment input', 'comment://commenttranslator/commentinput-test.md?input');
    Object.assign(internalDocument, { languageId: 'markdown' });
    const internalEditor = createEditor(internalDocument);
    const status = window.createStatusBarItem.mock.results[0]!.value;
    status.hide.mockClear();
    status.show.mockClear();
    window.activeTextEditor = internalEditor;
    events.active.fire(internalEditor);

    expect(status.hide).not.toHaveBeenCalled();
    expect(status.show).toHaveBeenCalled();
    expect(status.text).toContain('1/1');
    controller.showStatus();
    expect(window.showInformationMessage).toHaveBeenLastCalledWith(expect.stringContaining('已有译文 1 条'));

    await controller.toggle();
    expect(controller.getSnapshot(setup.document.uri.toString()).enabled).toBe(false);
    expect(controller.getSnapshot(internalDocument.uri.toString()).enabled).toBe(false);
    expect(setup.renderer.clearFile).toHaveBeenCalledWith(setup.document.uri.toString());
    expect(setup.cache.deleteFile).toHaveBeenCalledWith(setup.document.uri.toString());
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
  });

  it('refreshes the remembered source cache and its missing comments while a native comment editor is active', async () => {
    const setup = fixture();
    controller = setup.controller;
    await controller.toggle();
    const internalDocument = createDocument('Internal comment input', 'comment://commenttranslator/commentinput-test.md?input');
    Object.assign(internalDocument, { languageId: 'markdown' });
    const internalEditor = createEditor(internalDocument);
    window.activeTextEditor = internalEditor;
    events.active.fire(internalEditor);
    setup.parser.parse.mockClear();
    setup.cache.get.mockClear();
    setup.service.translate.mockClear();

    await controller.refresh();
    expect(setup.parser.parse).toHaveBeenLastCalledWith(setup.document.getText(), 'typescript', expect.any(AbortSignal));
    expect(setup.cache.get).toHaveBeenLastCalledWith(setup.document.uri.toString(), translationKey('First comment'));
    expect(setup.service.translate).not.toHaveBeenCalled();
    expect(controller.getSnapshot(setup.document.uri.toString())).toMatchObject({ enabled: true, cacheHits: 1, translated: 1 });

    setup.persistent.clear();
    await controller.refresh();
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    expect(setup.service.translate.mock.calls[0]![0]).toEqual([{ id: 'a', text: 'First comment' }]);
    expect(controller.getSnapshot(internalDocument.uri.toString()).enabled).toBe(false);
    expect(setup.renderer.render.mock.calls.every(([document]) => document.uri.toString() === setup.document.uri.toString())).toBe(true);
  });

  it('does not operate on the remembered file when no text editor is active', async () => {
    const setup = fixture();
    controller = setup.controller;
    await controller.toggle();
    setup.parser.parse.mockClear();
    window.activeTextEditor = undefined;
    events.active.fire(undefined);
    await controller.toggle();
    await controller.refresh();
    expect(controller.getSnapshot(setup.document.uri.toString()).enabled).toBe(true);
    expect(setup.parser.parse).not.toHaveBeenCalled();
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
  });

  it('opens and reopens a translated reading view without repeating parsing or API calls', async () => {
    const setup = fixture();
    controller = setup.controller;
    const source = setup.document.getText();
    await controller.toggle();
    const parserCalls = setup.parser.parse.mock.calls.length;
    const requestCalls = setup.service.translate.mock.calls.length;
    await controller.openReader();
    await controller.openReader();
    const uri = setup.document.uri.toString();
    expect(setup.readerModels.get(uri)).toMatchObject({ source, title: 'sample.ts', languageId: 'typescript', translated: 1, total: 1, phase: 'ready' });
    expect(setup.readerModels.get(uri)?.translations).toEqual(new Map([['a', '译文 a']]));
    expect(setup.parser.parse).toHaveBeenCalledTimes(parserCalls);
    expect(setup.service.translate).toHaveBeenCalledTimes(requestCalls);
    expect(controller.getSnapshot(uri).reader).toMatchObject({ open: true, translated: 1, sourceLines: 2 });
    expect(setup.document.getText()).toBe(source);
  });

  it('uses the focused reading view source for refresh, status and toggle even after another source was active', async () => {
    const setup = fixture();
    controller = setup.controller;
    await controller.toggle();
    const otherDocument = createDocument('// Other file', 'file:///test/other.ts');
    const otherEditor = createEditor(otherDocument);
    window.activeTextEditor = otherEditor;
    events.active.fire(otherEditor);

    const uri = setup.document.uri.toString();
    setup.readerFocus.uri = uri;
    window.activeTextEditor = undefined;
    events.active.fire(undefined);
    setup.parser.parse.mockClear();
    await controller.refresh();
    expect(setup.parser.parse).toHaveBeenLastCalledWith(setup.document.getText(), 'typescript', expect.any(AbortSignal));
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
    controller.showStatus();
    expect(window.showInformationMessage).toHaveBeenLastCalledWith(expect.stringContaining('已有译文 1 条'));

    await controller.toggle();
    expect(setup.reader.clearFile).toHaveBeenCalledWith(uri);
    expect(setup.renderer.clearFile).toHaveBeenCalledWith(uri);
    expect(setup.reader.clearFile).not.toHaveBeenCalledWith(otherDocument.uri.toString());
    expect(controller.getSnapshot(uri)).toMatchObject({ enabled: false, reader: { open: true, translated: 0 } });

    await controller.toggle();
    expect(controller.getSnapshot(uri)).toMatchObject({ enabled: true, cacheHits: 1 });
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
  });

  it('closes a source reading view when its document closes and releases it on disposal', async () => {
    const setup = fixture();
    controller = setup.controller;
    await controller.toggle();
    const uri = setup.document.uri.toString();
    setup.document.isClosed = true;
    events.close.fire(setup.document as unknown as vscode.TextDocument);
    expect(setup.reader.closeFile).toHaveBeenCalledWith(uri);
    expect(controller.getSnapshot(uri)).toMatchObject({ enabled: false, reader: { open: false } });
    controller.dispose();
    expect(setup.reader.dispose).toHaveBeenCalledTimes(1);
  });

  it('allows explicit reading view access in the source preview display mode without retranslating', async () => {
    const setup = fixture();
    controller = setup.controller;
    settings.set('displayMode', 'inline');
    await controller.toggle();
    expect(setup.reader.open).not.toHaveBeenCalled();
    expect(setup.renderer.render).toHaveBeenCalled();
    await controller.openReader();
    expect(setup.reader.open).toHaveBeenCalledTimes(1);
    expect(setup.service.translate).toHaveBeenCalledTimes(1);
  });
});
