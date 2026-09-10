import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { TranslationRenderer } from '../src/renderer';
import type { CommentBlock } from '../src/parser/commentParser';
import { MarkdownString, Range, comments, createDocument, createEditor, events, resetVscodeMock, window } from './vscodeMock';

vi.mock('vscode', () => import('./vscodeMock'));

function setup(rawText = '// First comment', kind: CommentBlock['kind'] = 'standalone', prefix = '', suffix = '') {
  const document = createDocument(prefix + rawText + suffix);
  const editor = createEditor(document);
  window.activeTextEditor = editor;
  window.visibleTextEditors = [editor];
  const lines = rawText.split('\n');
  const block: CommentBlock = { id: 'a', text: 'First comment', rawText, languageId: 'typescript', kind,
    start: { line: 0, character: prefix.length }, end: { line: lines.length - 1, character: lines.at(-1)!.length + (lines.length === 1 ? prefix.length : 0) } };
  return { document, editor, block };
}

function decorations(editor: vscode.TextEditor, type: 'hidden' | 'replacement' | 'hover'): vscode.DecorationOptions[] {
  const index = { hidden: 0, replacement: 1, hover: 2 }[type];
  const decorationType = window.createTextEditorDecorationType.mock.results[index]!.value;
  return (vi.mocked(editor.setDecorations).mock.calls.filter(([item]) => item === decorationType).at(-1)?.[1] ?? []) as vscode.DecorationOptions[];
}

describe('TranslationRenderer integration', () => {
  let renderer: TranslationRenderer | undefined;
  beforeEach(() => resetVscodeMock());
  afterEach(() => { renderer?.dispose(); renderer = undefined; });

  it.each(['documentation', 'standalone', 'trailing', 'inline'] as const)('visually replaces %s comments at their original position without changing the source', (kind) => {
    const rawText = kind === 'documentation' || kind === 'inline' ? '/** First comment */' : '// First comment';
    const prefix = kind === 'trailing' || kind === 'inline' ? 'const x = 1; ' : '';
    const { document, editor, block } = setup(rawText, kind, prefix);
    const original = document.getText();
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '第一行译文']]), 10);
    const replacement = decorations(editor, 'replacement')[0]!;
    expect(replacement.range.start.character).toBe(prefix.length);
    expect(replacement.range.end).toEqual(replacement.range.start);
    expect(replacement.renderOptions?.before?.contentText).toContain('第一行译文');
    expect(replacement.renderOptions?.after).toBeUndefined();
    expect(document.getText(decorations(editor, 'hidden')[0]!.range)).toBe(rawText);
    expect(document.getText()).toBe(original);
    expect(document.version).toBe(1);
    expect(comments.createCommentController).not.toHaveBeenCalled();
    expect(renderer.widgetCount(document.uri.toString())).toBe(0);
  });

  it('replaces rather than accumulates painted rows on repeated renders', () => {
    const { document, editor, block } = setup();
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 10);
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '更新译文']]), 10);
    expect(decorations(editor, 'replacement')).toHaveLength(1);
    expect(decorations(editor, 'replacement')[0]!.renderOptions?.before?.contentText).toBe('// 更新译文');
  });

  it('shows the complete original comment on row-wide hover, including following inline code', () => {
    const { document, editor, block } = setup('/* First comment */', 'inline', 'before(); ', ' after();');
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 10);
    const hover = decorations(editor, 'hover')[0]!;
    expect(hover.range).toEqual(document.lineAt(0).range);
    expect((hover.hoverMessage as unknown as MarkdownString).value).toBe('原文\n\n```\n/* First comment */\n```');
    const hidden = decorations(editor, 'hidden')[0]!.range;
    expect(hidden.start.character).toBe('before(); '.length);
    expect(hidden.end.character).toBe(document.getText().length - ' after();'.length);
  });

  it('distributes multiline documentation over its original body rows and retains delimiters', () => {
    const { document, editor, block } = setup('/**\n * First comment\n *\n * @param userId User identifier\n */', 'documentation');
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '第一行译文\n@param userId 用户标识']]), 10);
    const rows = decorations(editor, 'replacement');
    expect(rows.map((row) => row.range.start.line)).toEqual([1, 3]);
    expect(rows.map((row) => row.range.start.character)).toEqual([1, 1]);
    expect(rows.map((row) => row.renderOptions?.before?.contentText)).toEqual(['* 第一行译文', '* @param userId 用户标识']);
    expect(decorations(editor, 'hover')).toHaveLength(5);
    expect(document.getText()).toBe(block.rawText);
  });

  it('never truncates long translations or appends them to the end of the source line', () => {
    const { document, editor, block } = setup('// First comment', 'trailing', 'const count = 1; ');
    const translated = '这是完整译文。'.repeat(40);
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', translated]]), 10);
    expect(decorations(editor, 'replacement')[0]!.renderOptions?.before?.contentText).toBe(`// ${translated}`);
    expect(decorations(editor, 'replacement')[0]!.range.start.character).toBe('const count = 1; '.length);
  });

  it('retains native spaces and tab stops ahead of continuation rows', () => {
    const { document, editor, block } = setup('// First\n\t  // Second');
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '第一\n第二']]), 10);
    const hidden = decorations(editor, 'hidden')[1]!;
    expect(hidden.range.start.character).toBe(3);
    expect(document.getText(hidden.range)).toBe('// Second');
    const replacement = decorations(editor, 'replacement')[1]!;
    expect(replacement.range.start.character).toBe(3);
    expect(replacement.renderOptions?.before?.contentText).toBe('// 第二');
    expect(window.createTextEditorDecorationType.mock.calls[1]![0]?.before?.textDecoration).toBe('none; white-space: pre;');
  });

  it('removes visual replacement when the original range no longer matches parsed text', () => {
    const { document, editor, block } = setup();
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 10);
    document.replaceText('// Changed comment');
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '过期译文']]), 10);
    for (const type of ['hidden', 'replacement', 'hover'] as const) expect(decorations(editor, type)).toEqual([]);
  });

  it('keeps unrecognized comment shells visible instead of hiding them', () => {
    const { document, editor, block } = setup('unknown syntax');
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 10);
    expect(decorations(editor, 'hidden')).toEqual([]);
    expect(decorations(editor, 'replacement')).toEqual([]);
  });

  it('treats original Markdown and translated CSS-looking content as inert text', () => {
    const raw = '// ``` [run](command:evil) ![track](https://tracker.test/pixel) ````';
    const { document, editor, block } = setup(raw);
    const translated = '"; display:none; [run](command:evil) <img src="https://tracker.test">';
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', translated]]), 10);
    const hover = decorations(editor, 'hover')[0]!.hoverMessage as unknown as MarkdownString;
    expect(hover.value).toBe(`原文\n\n\`\`\`\`\`\n${raw}\n\`\`\`\`\``);
    expect(hover.isTrusted).toBe(false);
    expect(hover.supportHtml).toBe(false);
    expect(decorations(editor, 'replacement')[0]!.renderOptions?.before?.contentText).toBe(`// ${translated}`);
    expect(window.createTextEditorDecorationType.mock.calls[0]![0]).toMatchObject({ textDecoration: 'none; display: none;' });
  });

  it('groups original comments sharing one source row without hiding intervening code', () => {
    const { document, editor, block } = setup('/* First */', 'inline', 'const a = ', '1 /* Second */ + 2;');
    const start = document.getText().indexOf('/* Second */');
    const other = { ...block, id: 'b', rawText: '/* Second */', start: { line: 0, character: start }, end: { line: 0, character: start + 12 } };
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block, other], new Map([['a', '第一'], ['b', '第二']]), 10);
    expect(decorations(editor, 'replacement')).toHaveLength(2);
    expect(decorations(editor, 'hidden').map((entry) => document.getText(entry.range))).toEqual(['/* First */', '/* Second */']);
    expect(decorations(editor, 'hover')).toHaveLength(1);
    expect((decorations(editor, 'hover')[0]!.hoverMessage as unknown as MarkdownString).value).toContain('/* First */\n\n/* Second */');
  });

  it('reveals the whole original block when the cursor enters any of its rows and restores translations on exit', () => {
    const { document, editor, block } = setup('/**\n * First\n * Second\n */', 'documentation', '', '\nconst answer = 42;');
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '第一\n第二']]), 10);
    expect(decorations(editor, 'replacement')).toHaveLength(2);
    Object.assign(editor, { selections: [new Range(2, 0, 2, 0)] });
    events.selection.fire({ textEditor: editor } as vscode.TextEditorSelectionChangeEvent);
    expect(decorations(editor, 'hidden')).toEqual([]);
    expect(decorations(editor, 'replacement')).toEqual([]);
    Object.assign(editor, { selections: [new Range(4, 0, 4, 0)] });
    events.selection.fire({ textEditor: editor } as vscode.TextEditorSelectionChangeEvent);
    expect(decorations(editor, 'replacement')).toHaveLength(2);
  });

  it('reveals an inline comment even when the cursor maps to the code beside it', () => {
    const { document, editor, block } = setup('/* First comment */', 'inline', 'before(); ', ' after();');
    Object.assign(editor, { selections: [new Range(0, document.getText().length, 0, document.getText().length)] });
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 10);
    expect(decorations(editor, 'replacement')).toEqual([]);
    expect(decorations(editor, 'hidden')).toEqual([]);
  });

  it('protects every selected row in a multi-cursor edit', () => {
    const { document, editor, block } = setup('// First comment', 'standalone', '', '\nconst answer = 42;');
    Object.assign(editor, { selections: [new Range(1, 0, 1, 0), new Range(0, 0, 0, 1)] });
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 10);
    expect(decorations(editor, 'hidden')).toEqual([]);
    window.activeTextEditor = undefined;
    events.active.fire(undefined);
    expect(decorations(editor, 'replacement')).toHaveLength(1);
  });

  it('renders split editors using their own viewport and editing state', () => {
    const { document, editor, block } = setup();
    const other = createEditor(document);
    Object.assign(other, { visibleRanges: [new Range(50, 0, 100, 0)] });
    window.visibleTextEditors = [editor, other];
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 0);
    expect(decorations(editor, 'replacement')).toHaveLength(1);
    expect(decorations(other, 'replacement')).toEqual([]);
    renderer.clearFile(document.uri.toString());
    for (const type of ['hidden', 'replacement', 'hover'] as const) expect(decorations(editor, type)).toEqual([]);
    const count = vi.mocked(editor.setDecorations).mock.calls.length;
    events.selection.fire({ textEditor: editor } as vscode.TextEditorSelectionChangeEvent);
    expect(editor.setDecorations).toHaveBeenCalledTimes(count);
  });
});
