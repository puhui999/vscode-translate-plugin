import { vi } from 'vitest';
import type * as vscode from 'vscode';

class MockEvent<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  /** Registers an event listener and returns a disposable subscription. */
  readonly subscribe = (listener: (event: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  /** Delivers an editor event synchronously, like VS Code's event emitter. */
  fire(value: T): void { for (const listener of this.listeners) listener(value); }

  /** Removes subscriptions between tests. */
  reset(): void { this.listeners.clear(); }
}

/** Minimal editor position used to exercise actual rendering logic. */
export class Position {
  /** Creates a zero-based document position. */
  constructor(public line: number, public character: number) {}
}

/** Minimal VS Code range supporting both real constructor forms. */
export class Range {
  start: Position;
  end: Position;

  /** Creates a range from positions or line/character coordinates. */
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: Position | number, second: Position | number, endLine?: number, endCharacter?: number) {
    this.start = typeof start === 'number' ? new Position(start, second as number) : start;
    this.end = typeof start === 'number' ? new Position(endLine!, endCharacter!) : second as Position;
  }
}

/** Tracks safe text insertion separately from Markdown interpretation. */
export class MarkdownString {
  isTrusted: boolean | undefined;
  supportHtml: boolean | undefined;
  value = '';
  readonly appendText = vi.fn((text: string) => { this.value += text; return this; });
  readonly appendMarkdown = vi.fn((text: string) => { this.value += text; return this; });
}

/** Stores a theme token for decoration assertions. */
export class ThemeColor {
  /** Creates a reference to a VS Code theme color. */
  constructor(public id: string) {}
}

export const StatusBarAlignment = { Right: 2 };
export const DecorationRangeBehavior = { ClosedClosed: 1 };
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };
export const CommentMode = { Editing: 0, Preview: 1 };
export const ConfigurationTarget = { Global: 1 };

export const events = {
  change: new MockEvent<vscode.TextDocumentChangeEvent>(),
  close: new MockEvent<vscode.TextDocument>(),
  active: new MockEvent<vscode.TextEditor | undefined>(),
  visible: new MockEvent<readonly vscode.TextEditor[]>(),
  ranges: new MockEvent<vscode.TextEditorVisibleRangesChangeEvent>(),
  selection: new MockEvent<vscode.TextEditorSelectionChangeEvent>(),
  configuration: new MockEvent<vscode.ConfigurationChangeEvent>(),
};

export const settings = new Map<string, unknown>();
const configuration = {
  get: <T>(key: string, fallback: T): T => settings.has(key) ? settings.get(key) as T : fallback,
  update: vi.fn(async (key: string, value: unknown) => {
    settings.set(key, value);
    events.configuration.fire({ affectsConfiguration: (section: string) => section === 'commentTranslator' || section === `commentTranslator.${key}` } as vscode.ConfigurationChangeEvent);
  }),
};

export interface MockDocument extends Pick<vscode.TextDocument, 'uri' | 'languageId' | 'getText' | 'lineAt'> {
  version: number;
  isClosed: boolean;
  readonly lineCount: number;
  replaceText: (content: string) => void;
}

const textDocuments: vscode.TextDocument[] = [];

/** Builds a document whose text can change only through explicit test edits. */
export function createDocument(content = '// First comment\nconst answer = 42;', uri = 'file:///test/sample.ts'): MockDocument {
  let text = content;
  const document: MockDocument = {
    uri: { scheme: uri.split(':')[0], path: new URL(uri).pathname, toString: () => uri } as vscode.Uri,
    languageId: 'typescript',
    version: 1,
    isClosed: false,
    get lineCount(): number { return text.split('\n').length; },
    getText: (range?: vscode.Range): string => {
      if (!range) return text;
      const lines = text.split('\n');
      const offset = (position: vscode.Position): number => lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
      return text.slice(offset(range.start), offset(range.end));
    },
    lineAt: ((lineOrPosition: number | vscode.Position) => {
      const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
      const lineText = text.split('\n')[line] ?? '';
      return { text: lineText, range: new Range(line, 0, line, lineText.length) } as vscode.TextLine;
    }) as vscode.TextDocument['lineAt'],
    replaceText: (content: string): void => { text = content; document.version += 1; },
  };
  textDocuments.push(document as unknown as vscode.TextDocument);
  return document;
}

/** Creates a visible editor with observable decoration calls and no edit API. */
export function createEditor(document: MockDocument): vscode.TextEditor {
  return {
    document,
    visibleRanges: [new Range(0, 0, 100, 0)],
    selections: [],
    setDecorations: vi.fn(),
  } as unknown as vscode.TextEditor;
}

export const window = {
  activeTextEditor: undefined as vscode.TextEditor | undefined,
  visibleTextEditors: [] as readonly vscode.TextEditor[],
  onDidChangeActiveTextEditor: events.active.subscribe,
  onDidChangeVisibleTextEditors: events.visible.subscribe,
  onDidChangeTextEditorVisibleRanges: events.ranges.subscribe,
  onDidChangeTextEditorSelection: events.selection.subscribe,
  createStatusBarItem: vi.fn(() => ({ text: '', tooltip: '', command: '', show: vi.fn(), hide: vi.fn(), dispose: vi.fn() })),
  createTextEditorDecorationType: vi.fn((_options?: vscode.DecorationRenderOptions) => ({ key: 'test-decoration', dispose: vi.fn() })),
  showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined as string | undefined),
  showWarningMessage: vi.fn(async (..._args: unknown[]) => undefined as string | undefined),
  showInputBox: vi.fn(async (..._args: unknown[]) => undefined as string | undefined),
  showTextDocument: vi.fn(async (document: MockDocument, ..._args: unknown[]) => {
    const editor = createEditor(document);
    window.activeTextEditor = editor;
    window.visibleTextEditors = [editor];
    events.active.fire(editor);
    events.visible.fire([editor]);
    return editor;
  }),
};

let documentSequence = 0;
export const workspace = {
  isTrusted: true,
  textDocuments,
  onDidChangeTextDocument: events.change.subscribe,
  onDidCloseTextDocument: events.close.subscribe,
  onDidChangeConfiguration: events.configuration.subscribe,
  getConfiguration: vi.fn((..._args: unknown[]) => configuration),
  openTextDocument: vi.fn(async ({ content }: { language: string; content: string }) => createDocument(content, `untitled:demo-${++documentSequence}`)),
};

export interface MockCommentThread {
  uri: vscode.Uri;
  range: vscode.Range;
  comments: readonly vscode.Comment[];
  canReply: boolean;
  collapsibleState: number;
  label: string;
  dispose: ReturnType<typeof vi.fn>;
}

export const threads: MockCommentThread[] = [];
export const commentController = {
  createCommentThread: vi.fn((uri: vscode.Uri, range: vscode.Range, comments: readonly vscode.Comment[]) => {
    const thread: MockCommentThread = { uri, range, comments, canReply: true, collapsibleState: 0, label: '', dispose: vi.fn() };
    threads.push(thread);
    return thread;
  }),
  dispose: vi.fn(),
};
export const comments = { createCommentController: vi.fn(() => commentController) };

/** Resets the fake host without erasing mock implementations. */
export function resetVscodeMock(): void {
  vi.clearAllMocks();
  for (const event of Object.values(events)) event.reset();
  settings.clear();
  settings.set('baseUrl', 'https://example.test/v1');
  settings.set('model', 'test-model');
  window.activeTextEditor = undefined;
  window.visibleTextEditors = [];
  workspace.isTrusted = true;
  textDocuments.length = 0;
  threads.length = 0;
}
