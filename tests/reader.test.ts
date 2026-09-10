import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderModel } from '../src/readerContent';

const HOST = vi.hoisted(() => {
  const makePanel = (title: string) => {
    const messages = new Set<(message: unknown) => void>();
    const oldMessageHandlers: Array<(message: unknown) => void> = [];
    const disposals = new Set<() => void>();
    const viewChanges = new Set<() => void>();
    const state = { html: '', writes: 0 };
    const panel = {
      title,
      active: true,
      state,
      oldMessageHandlers,
      webview: {
        get html(): string { return state.html; },
        set html(value: string) { state.html = value; state.writes += 1; },
        onDidReceiveMessage: (handler: (message: unknown) => void) => {
          messages.add(handler);
          oldMessageHandlers.push(handler);
          return { dispose: () => messages.delete(handler) };
        }
      },
      onDidDispose: (handler: () => void) => {
        disposals.add(handler);
        return { dispose: () => disposals.delete(handler) };
      },
      onDidChangeViewState: (handler: () => void) => {
        viewChanges.add(handler);
        return { dispose: () => viewChanges.delete(handler) };
      },
      reveal: vi.fn(),
      dispose: vi.fn(),
      emit: (message: unknown) => { for (const handler of messages) handler(message); },
      emitViewChange: () => { for (const handler of viewChanges) handler(); }
    };
    panel.dispose.mockImplementation(() => {
      for (const handler of disposals) handler();
      messages.clear();
      disposals.clear();
      viewChanges.clear();
    });
    return panel;
  };
  const panels: ReturnType<typeof makePanel>[] = [];
  const createWebviewPanel = vi.fn((_type: string, title: string, _position: unknown, _options: unknown) => {
    for (const existing of panels) existing.active = false;
    const panel = makePanel(title);
    panel.reveal.mockImplementation(() => {
      for (const existing of panels) existing.active = false;
      panel.active = true;
      panel.emitViewChange();
    });
    panels.push(panel);
    return panel;
  });
  return {
    panels,
    createWebviewPanel,
    showErrorMessage: vi.fn(async (_message: string) => undefined),
    render: vi.fn((model: unknown, nonce: string) => JSON.stringify({ model, nonce }))
  };
});

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1 },
  window: { createWebviewPanel: HOST.createWebviewPanel, showErrorMessage: HOST.showErrorMessage }
}));
vi.mock('../src/readerContent', () => ({ renderReaderHtml: HOST.render }));

import { TranslationReader, type TranslationReaderOptions } from '../src/reader';

const READERS: TranslationReader[] = [];
const URI = 'file:///test/example.ts';

function model(overrides: Partial<ReaderModel> = {}): ReaderModel {
  return {
    source: '// Header\nconst answer = 42; // Answer\n',
    languageId: 'typescript',
    title: 'example.ts',
    phase: 'complete',
    translated: 1,
    total: 1,
    blocks: [{
      id: 'header', text: 'Header', rawText: '// Header', languageId: 'typescript',
      kind: 'standalone', start: { line: 0, character: 0 }, end: { line: 0, character: 9 }
    }],
    translations: new Map([['header', '说明']]),
    ...overrides
  };
}

function createReader(overrides: Partial<TranslationReaderOptions> = {}) {
  const options = {
    onReveal: vi.fn(async (_uri: string, _line: number) => undefined),
    onRefresh: vi.fn((_uri: string) => undefined),
    onSettings: vi.fn(() => undefined),
    onFocus: vi.fn((_uri: string) => undefined),
    ...overrides
  };
  const reader = new TranslationReader(options);
  READERS.push(reader);
  return { reader, options };
}

function nonce(): string {
  return HOST.render.mock.calls.at(-1)![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  HOST.panels.length = 0;
});

afterEach(() => {
  for (const reader of READERS.splice(0)) reader.dispose();
});

describe('TranslationReader', () => {
  it('opens a restricted read-only panel without initiating translation', () => {
    const { reader, options } = createReader();
    reader.update(URI, model());
    expect(HOST.createWebviewPanel).not.toHaveBeenCalled();
    expect(reader.snapshot(URI)).toEqual({ open: false, ready: false, translated: 0, sourceLines: 0 });
    reader.open(URI, model());
    expect(HOST.createWebviewPanel).toHaveBeenCalledWith(
      'commentTranslator.reader', '译读 · example.ts',
      { viewColumn: -1, preserveFocus: false },
      {
        enableScripts: true, enableForms: false, enableCommandUris: false,
        enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: []
      }
    );
    expect(reader.snapshot(URI)).toEqual({ open: true, ready: false, translated: 1, sourceLines: 3 });
    expect(options.onRefresh).not.toHaveBeenCalled();
    expect(options.onSettings).not.toHaveBeenCalled();
    expect(options.onFocus).toHaveBeenCalledWith(URI);
    expect(nonce()).toMatch(/^[a-f0-9]{36}$/);
  });

  it('avoids identical HTML resets and validates readiness against the current nonce', () => {
    const { reader } = createReader();
    const original = model({ translations: new Map([['header', '说明'], ['extra', '附加']]) });
    reader.open(URI, original);
    const panel = HOST.panels[0];
    const oldNonce = nonce();
    panel.emit({ type: 'ready', nonce: oldNonce, renderedTranslations: 1, sourceRows: 3, translationRows: 1 });
    expect(reader.snapshot(URI).ready).toBe(true);
    reader.update(URI, { ...original, translations: new Map([['extra', '附加'], ['header', '说明']]) });
    expect(panel.state.writes).toBe(1);
    expect(reader.snapshot(URI).ready).toBe(true);
    reader.update(URI, { ...original, error: 'Mock service error' });
    expect(panel.state.writes).toBe(2);
    expect(reader.snapshot(URI).ready).toBe(false);
    expect(nonce()).not.toBe(oldNonce);
    panel.emit({ type: 'ready', nonce: oldNonce });
    panel.emit({ type: 'ready', nonce: nonce(), sourceRows: -1 });
    panel.emit({ type: 'ready', nonce: nonce(), command: 'malicious.command' });
    expect(reader.snapshot(URI).ready).toBe(false);
    panel.emit({ type: 'ready', nonce: nonce() });
    panel.emit({ type: 'ready', nonce: nonce(), renderedTranslations: 1, sourceRows: 2, translationRows: 1 });
    expect(reader.snapshot(URI).ready).toBe(false);
    panel.emit({ type: 'ready', nonce: nonce(), renderedTranslations: 0, sourceRows: 3, translationRows: 0 });
    expect(reader.snapshot(URI).ready).toBe(true);
    expect(reader.snapshot(URI).translated).toBe(0);
  });

  it('binds whitelisted actions to the source URI and validates every revealed line', () => {
    const { reader, options } = createReader();
    reader.open(URI, model());
    const panel = HOST.panels[0];
    const currentNonce = nonce();
    panel.emit({ type: 'reveal', nonce: currentNonce, line: 0 });
    panel.emit({ type: 'reveal', nonce: currentNonce, line: 2 });
    expect(options.onReveal).toHaveBeenNthCalledWith(1, URI, 0);
    expect(options.onReveal).toHaveBeenNthCalledWith(2, URI, 2);
    for (const line of [-1, 3, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '1', undefined]) {
      panel.emit({ type: 'reveal', nonce: currentNonce, line });
    }
    for (const message of [
      null, [], 'refresh', {},
      { type: 'reveal', nonce: currentNonce, line: 1, uri: 'file:///other.ts' },
      { type: 'reveal', nonce: 'outdated', line: 1 },
      { type: 'command', nonce: currentNonce },
      { type: 'refresh', nonce: currentNonce, command: 'workbench.action.closeWindow' }
    ]) panel.emit(message);
    expect(options.onReveal).toHaveBeenCalledTimes(2);
    expect(options.onRefresh).not.toHaveBeenCalled();
    panel.emit({ type: 'refresh', nonce: currentNonce });
    panel.emit({ type: 'settings', nonce: currentNonce });
    expect(options.onRefresh).toHaveBeenCalledExactlyOnceWith(URI);
    expect(options.onSettings).toHaveBeenCalledOnce();
  });

  it('keeps independent file panels and reports only the currently active source', () => {
    const { reader, options } = createReader();
    const otherUri = 'file:///test/other.ts';
    reader.open(URI, model());
    reader.open(otherUri, model({ title: '/folder/other.ts' }));
    expect(HOST.panels[1].title).toBe('译读 · other.ts');
    expect(reader.activeUri()).toBe(otherUri);
    reader.open(URI, model());
    expect(HOST.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(HOST.panels[0].reveal).toHaveBeenCalledWith(-1, false);
    expect(HOST.panels[0].state.writes).toBe(1);
    expect(reader.activeUri()).toBe(URI);
    expect(options.onFocus).toHaveBeenLastCalledWith(URI);
    HOST.panels[0].active = false;
    HOST.panels[0].emitViewChange();
    expect(reader.activeUri()).toBeUndefined();
  });

  it('clears translations while retaining an immutable snapshot of the original source model', () => {
    const { reader } = createReader();
    const original = model();
    reader.open(URI, original);
    (original.translations as Map<string, string>).set('header', 'Caller mutation');
    original.blocks[0].start.line = 2;
    reader.clearFile(URI);
    const rendered = HOST.render.mock.calls.at(-1)![0] as ReaderModel;
    expect(rendered.source).toBe(original.source);
    expect(rendered.blocks[0].start.line).toBe(0);
    expect(rendered.translations.size).toBe(0);
    expect(rendered.phase).toBe('off');
    expect(reader.snapshot(URI)).toEqual({ open: true, ready: false, translated: 0, sourceLines: 3 });
    expect(HOST.panels[0].dispose).not.toHaveBeenCalled();
    reader.clearFile('file:///missing.ts');
  });

  it('invalidates old handlers on source close and cannot contaminate a reopened panel', () => {
    const { reader, options } = createReader();
    reader.open(URI, model());
    const oldPanel = HOST.panels[0];
    const oldHandler = oldPanel.oldMessageHandlers[0];
    reader.closeFile(URI);
    expect(oldPanel.dispose).toHaveBeenCalledOnce();
    expect(reader.snapshot(URI).open).toBe(false);
    reader.open(URI, model());
    oldHandler({ type: 'ready', nonce: nonce(), renderedTranslations: 1, sourceRows: 3, translationRows: 1 });
    oldHandler({ type: 'refresh', nonce: nonce() });
    expect(reader.snapshot(URI).ready).toBe(false);
    expect(options.onRefresh).not.toHaveBeenCalled();
    HOST.panels[1].dispose();
    expect(reader.snapshot(URI).open).toBe(false);
    reader.closeFile(URI);
  });

  it('disposes all resources and ignores later opens and retained messages', () => {
    const { reader, options } = createReader();
    reader.open(URI, model());
    reader.open('file:///other.ts', model());
    const oldHandler = HOST.panels[1].oldMessageHandlers[0];
    const oldNonce = nonce();
    reader.dispose();
    reader.dispose();
    oldHandler({ type: 'settings', nonce: oldNonce });
    reader.open(URI, model());
    reader.update(URI, model());
    expect(HOST.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(HOST.panels.every((panel) => panel.dispose.mock.calls.length === 1)).toBe(true);
    expect(options.onSettings).not.toHaveBeenCalled();
    expect(reader.activeUri()).toBeUndefined();
  });

  it('reports synchronous and asynchronous action failures without unhandled rejections', async () => {
    const { reader } = createReader({
      onReveal: async () => { throw new Error('Source unavailable'); },
      onRefresh: () => { throw new Error('Refresh failed'); }
    });
    reader.open(URI, model());
    HOST.panels[0].emit({ type: 'reveal', nonce: nonce(), line: 0 });
    HOST.panels[0].emit({ type: 'refresh', nonce: nonce() });
    await Promise.resolve();
    expect(HOST.showErrorMessage).toHaveBeenCalledWith('译读操作失败：Source unavailable');
    expect(HOST.showErrorMessage).toHaveBeenCalledWith('译读操作失败：Refresh failed');
  });
});
