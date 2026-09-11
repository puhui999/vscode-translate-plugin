import * as vscode from 'vscode';
import type { CommentBlock } from './parser/commentParser';
import { formatSourceTranslation } from './commentFormat';

interface FileRendering {
  document: vscode.TextDocument;
  blocks: readonly CommentBlock[];
  translations: ReadonlyMap<string, string>;
  bufferLines: number;
}

/** Visually replaces comment rows while retaining the original, editable source text. */
export class TranslationRenderer implements vscode.Disposable {
  private readonly files = new Map<string, FileRendering>();
  private readonly hidden: vscode.TextEditorDecorationType;
  private readonly replacement: vscode.TextEditorDecorationType;
  private readonly originalHover: vscode.TextEditorDecorationType;
  private readonly listeners: vscode.Disposable[];

  /** Creates independent source and attachment decorations, restoring source while editing. */
  constructor() {
    // VS Code has no public replacement-text API. Its decoration CSS currently
    // supports this fixed display rule; translated content never enters CSS.
    // Keep attachments separate so they cannot inherit display:none.
    this.hidden = vscode.window.createTextEditorDecorationType({
      textDecoration: 'none; display: none;',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.replacement = vscode.window.createTextEditorDecorationType({
      before: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'normal', margin: '0',
        textDecoration: 'none; white-space: pre;' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.originalHover = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.listeners = [
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const state = this.files.get(event.textEditor.document.uri.toString());
        if (state) this.apply(state);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        for (const state of this.files.values()) this.apply(state);
      }),
    ];
  }

  /** Replaces visible comment rows and shows complete original comments on hover. */
  render(document: vscode.TextDocument, blocks: readonly CommentBlock[], translations: ReadonlyMap<string, string>, bufferLines: number): void {
    const state = { document, blocks, translations: new Map(translations), bufferLines };
    this.files.set(document.uri.toString(), state);
    this.apply(state);
  }

  /** Removes all visual replacements for a document without changing its text. */
  clearFile(uri: string): void {
    this.files.delete(uri);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== uri) continue;
      editor.setDecorations(this.hidden, []);
      editor.setDecorations(this.replacement, []);
      editor.setDecorations(this.originalHover, []);
    }
  }

  /** Retains the diagnostic contract: source replacements never create comment widgets. */
  widgetCount(_uri: string): number { return 0; }

  /** Restores source text and releases all decorations and editor listeners. */
  dispose(): void {
    for (const uri of this.files.keys()) this.clearFile(uri);
    for (const listener of this.listeners) listener.dispose();
    this.hidden.dispose();
    this.replacement.dispose();
    this.originalHover.dispose();
  }

  private apply(state: FileRendering): void {
    const { document, blocks, translations, bufferLines } = state;
    if (document.isClosed) return;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== document.uri.toString()) continue;
      const hidden: vscode.DecorationOptions[] = [];
      const replacements: vscode.DecorationOptions[] = [];
      const hoverBlocks = new Map<number, Set<CommentBlock>>();
      for (const block of blocks) {
        const translation = translations.get(block.id);
        if (!translation || translation === block.text || !editor.visibleRanges.some((range) => block.end.line >= range.start.line - bufferLines && block.start.line <= range.end.line + bufferLines)) continue;
        const range = new vscode.Range(block.start.line, block.start.character, block.end.line, block.end.character);
        if (document.getText(range) !== block.rawText) continue;
        const rows = formatSourceTranslation(block, translation);
        if (rows.length !== block.end.line - block.start.line + 1) continue;
        const hoverMessage = originalMarkdown(block.rawText);
        // Pseudo-element offsets can map onto following code. A row-wide hover
        // keeps original comments reachable across the whole visual replacement.
        for (let line = block.start.line; line <= block.end.line; line++) {
          const originals = hoverBlocks.get(line) ?? new Set<CommentBlock>();
          originals.add(block);
          hoverBlocks.set(line, originals);
        }
        // Restore the block before editing any of its rows, including adjacent
        // inline code and multi-cursor selections: translations aren't source.
        const editing = editor === vscode.window.activeTextEditor && editor.selections.some((selection) =>
          selection.start.line <= block.end.line && selection.end.line >= block.start.line);
        if (editing) continue;
        for (let index = 0; index < rows.length; index++) {
          const line = block.start.line + index;
          // Keep native indentation in the source layout (especially tabs),
          // instead of asking a CSS attachment to reproduce its tab stops.
          const start = index === 0 ? block.start.character : document.lineAt(line).text.match(/^[\t ]*/)![0].length;
          const end = line === block.end.line ? block.end.character : document.lineAt(line).range.end.character;
          const rowRange = new vscode.Range(line, start, line, end);
          const contentText = index === 0 ? rows[index] : rows[index].slice(start);
          if (document.getText(rowRange) === contentText) continue;
          if (end > start) hidden.push({ range: rowRange });
          replacements.push({ range: new vscode.Range(line, start, line, start), hoverMessage,
            renderOptions: { before: { contentText } } });
        }
      }
      const hovers = [...hoverBlocks].map(([line, originals]) => ({ range: document.lineAt(line).range,
        hoverMessage: originalMarkdown([...originals].map((block) => block.rawText).join('\n\n')) }));
      editor.setDecorations(this.hidden, hidden);
      editor.setDecorations(this.replacement, replacements);
      editor.setDecorations(this.originalHover, hovers);
    }
  }
}

function originalMarkdown(text: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  let fenceLength = 3;
  for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  markdown.appendMarkdown(`原文\n\n${fence}\n${text}\n${fence}`);
  return markdown;
}
