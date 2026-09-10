import * as vscode from 'vscode';
import type { CommentBlock } from './parser/commentParser';
import { formatTranslation } from './commentFormat';

/** Adds unobtrusive single-line previews to the original, editable source document. */
export class TranslationRenderer implements vscode.Disposable {
  private readonly files = new Set<string>();
  private readonly decoration: vscode.TextEditorDecorationType;

  /** Creates borderless decorations without any native comment widgets. */
  constructor() {
    this.decoration = vscode.window.createTextEditorDecorationType({
      after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 1.5em', fontStyle: 'normal' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  /** Synchronizes visible previews and exposes complete multiline translations on hover. */
  render(document: vscode.TextDocument, blocks: readonly CommentBlock[], translations: ReadonlyMap<string, string>, bufferLines: number, previewLength: number): void {
    const uri = document.uri.toString();
    const editors = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === uri);
    const ranges = editors.flatMap((editor) => editor.visibleRanges);
    const inline = new Map<number, { entries: { block: CommentBlock; translation: string }[]; ranges: vscode.Range[] }>();
    for (const block of blocks) {
      const translation = translations.get(block.id);
      if (!translation || !ranges.some((range) => block.end.line >= range.start.line - bufferLines && block.start.line <= range.end.line + bufferLines)) continue;
      const range = new vscode.Range(block.start.line, block.start.character, block.end.line, block.end.character);
      // Never attach a translation to source text that changed while a request was running.
      if (document.getText(range) !== block.rawText) continue;
      const line = block.end.line;
      const item = inline.get(line) ?? { entries: [], ranges: [] };
      item.entries.push({ block, translation });
      item.ranges.push(range);
      inline.set(line, item);
    }
    this.files.add(uri);
    const decorations: vscode.DecorationOptions[] = [];
    for (const [line, item] of inline) {
      const fullText = item.entries.map(({ block, translation }) => formatTranslation(block, translation)).join('\n\n');
      const contentBudget = Math.max(1, Math.floor(previewLength / item.entries.length));
      const preview = item.entries.map(({ block, translation }) => {
        const characters = Array.from(translation.replace(/\s+/g, ' ').trim());
        const text = characters.length > contentBudget ? `${characters.slice(0, contentBudget).join('')}…` : characters.join('');
        // Shorten the content first so the comment's closing delimiter is retained.
        return formatTranslation(block, text).replace(/\s+/g, ' ').trim();
      }).join(' · ');
      const end = document.lineAt(line).range.end;
      decorations.push({ range: new vscode.Range(end, end), hoverMessage: plainMarkdown(fullText), renderOptions: { after: { contentText: `译：${preview}` } } });
      // Hover over the original comment too; appended text has no editable document range.
      for (const range of item.ranges) decorations.push({ range, hoverMessage: plainMarkdown(fullText) });
    }
    for (const editor of editors) editor.setDecorations(this.decoration, decorations);
  }

  /** Removes decorations for one document without changing its text. */
  clearFile(uri: string): void {
    this.files.delete(uri);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri) editor.setDecorations(this.decoration, []);
    }
  }

  /** Retains the diagnostic contract: this renderer never creates comment widgets. */
  widgetCount(_uri: string): number { return 0; }

  /** Releases every native editor resource owned by this renderer. */
  dispose(): void {
    for (const uri of this.files) this.clearFile(uri);
    this.decoration.dispose();
  }
}

function plainMarkdown(text: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  // A fence longer than any run in the text prevents model content from escaping
  // the code block. Monospace rendering retains markers, spaces and blank lines.
  let fenceLength = 3;
  for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  markdown.appendMarkdown(`${fence}\n${text}\n${fence}`);
  return markdown;
}
