import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { TranslationRenderer } from '../src/renderer';
import type { CommentBlock } from '../src/parser/commentParser';
import { MarkdownString, Range, comments, createDocument, createEditor, resetVscodeMock, window } from './vscodeMock';

vi.mock('vscode', () => import('./vscodeMock'));

function setup(kind: CommentBlock['kind'] = 'standalone') {
  const text = kind === 'trailing' ? 'const x = 1; // First comment' : '// First comment';
  const document = createDocument(text);
  const editor = createEditor(document);
  window.activeTextEditor = editor;
  window.visibleTextEditors = [editor];
  const block: CommentBlock = {
    id: 'a', text: 'First comment', rawText: '// First comment', languageId: 'typescript', kind,
    start: { line: 0, character: text.indexOf('//') }, end: { line: 0, character: text.length },
  };
  return { document, editor, block };
}

function decorations(editor: vscode.TextEditor): vscode.DecorationOptions[] {
  return vi.mocked(editor.setDecorations).mock.calls.at(-1)![1] as vscode.DecorationOptions[];
}

describe('TranslationRenderer integration', () => {
  let renderer: TranslationRenderer | undefined;
  beforeEach(() => resetVscodeMock());
  afterEach(() => { renderer?.dispose(); renderer = undefined; });

  it.each(['documentation', 'standalone', 'trailing', 'inline'] as const)('shows %s comments as borderless source previews without modifying text or creating comment widgets', (kind) => {
    const { document, editor, block } = setup(kind);
    const source = document.getText();
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '第一行\n第二行译文']]), 10, 80);
    expect(decorations(editor)[0]!.renderOptions?.after?.contentText).toBe('译：// 第一行 第二行译文');
    expect(comments.createCommentController).not.toHaveBeenCalled();
    expect(renderer.widgetCount(document.uri.toString())).toBe(0);
    expect(document.getText()).toBe(source);
    expect(document.version).toBe(1);
  });

  it('replaces previews instead of accumulating duplicate translations when rerendered', () => {
    const { document, editor, block } = setup();
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 10, 80);
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '更新译文']]), 10, 80);
    const previews = decorations(editor).filter((item) => item.renderOptions?.after?.contentText);
    expect(previews).toHaveLength(1);
    expect(previews[0]!.renderOptions?.after?.contentText).toBe('译：// 更新译文');
  });

  it('removes an outdated preview when the source no longer matches the parsed range', () => {
    const { document, editor, block } = setup();
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 10, 80);
    document.replaceText('// Changed comment');
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '过期译文']]), 10, 80);
    expect(decorations(editor)).toEqual([]);
  });

  it('treats malicious Markdown as inert plain text on every hover target', () => {
    const { document, editor, block } = setup();
    const malicious = '[run](command:evil) ![track](https://tracker.test/pixel) <img src="https://tracker.test">';
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', malicious]]), 10, 80);
    for (const decoration of decorations(editor)) {
      const markdown = decoration.hoverMessage as unknown as MarkdownString;
      expect(markdown.appendMarkdown).toHaveBeenCalledWith(`\`\`\`\n// ${malicious}\n\`\`\``);
      expect(markdown.isTrusted).toBe(false);
      expect(markdown.supportHtml).toBe(false);
    }
  });

  it('appends a shortened preview at the source line end and preserves full multiline hover text', () => {
    const { document, editor, block } = setup('trailing');
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '第一行\n第二行完整译文']]), 10, 4);
    const preview = decorations(editor)[0]!;
    expect(preview.renderOptions?.after?.contentText).toBe('译：// 第一行 …');
    expect(preview.range.start.character).toBe(document.getText().length);
    expect(preview.range.end.character).toBe(document.getText().length);
    expect((preview.hoverMessage as unknown as MarkdownString).appendMarkdown).toHaveBeenCalledWith('```\n// 第一行\n// 第二行完整译文\n```');
  });

  it('anchors multiline documentation previews at the ending line of the original block', () => {
    const { document, editor, block } = setup('documentation');
    document.replaceText('/**\n * First comment\n */\nconst x = 1;');
    block.rawText = '/**\n * First comment\n */';
    block.end = { line: 2, character: 3 };
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '完整译文']]), 10, 80);
    expect(decorations(editor)[0]!.range.start).toEqual({ line: 2, character: 3 });
    expect(decorations(editor)[1]!.range.start.line).toBe(0);
    expect(decorations(editor)[1]!.range.end.line).toBe(2);
    expect((decorations(editor)[0]!.hoverMessage as unknown as MarkdownString).value).toBe('```\n/**\n * 完整译文\n */\n```');
  });

  it('retains a closing delimiter when a documentation preview is shortened', () => {
    const { document, editor, block } = setup('documentation');
    document.replaceText('/** First comment */');
    block.rawText = document.getText();
    block.end.character = document.getText().length;
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '很长的完整译文']]), 10, 3);
    expect(decorations(editor)[0]!.renderOptions?.after?.contentText).toBe('译：/** 很长的… */');
  });

  it('prevents embedded backtick fences from escaping the literal comment hover', () => {
    const { document, editor, block } = setup();
    const text = '```\n![track](https://tracker.test/pixel)\n````';
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', text]]), 10, 80);
    const markdown = decorations(editor)[0]!.hoverMessage as unknown as MarkdownString;
    expect(markdown.value).toBe('`````\n// ```\n// ![track](https://tracker.test/pixel)\n// ````\n`````');
    expect(markdown.isTrusted).toBe(false);
    expect(markdown.supportHtml).toBe(false);
  });

  it('removes offscreen previews and clears the source decorations when disabled', () => {
    const { document, editor, block } = setup();
    renderer = new TranslationRenderer();
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 0, 80);
    Object.assign(editor, { visibleRanges: [new Range(50, 0, 100, 0)] });
    renderer.render(document as unknown as vscode.TextDocument, [block], new Map([['a', '译文']]), 0, 80);
    expect(decorations(editor)).toEqual([]);
    renderer.clearFile(document.uri.toString());
    expect(decorations(editor)).toEqual([]);
  });
});
