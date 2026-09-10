import type { CommentBlock } from './parser/commentParser';
import { formatTranslation } from './commentFormat';
import { renderMarkdownReaderHtml } from './markdownReaderContent';

/** Source and completed translations displayed in the separate, read-only reader. */
export interface ReaderModel {
  mode?: 'comments' | 'markdown';
  markdown?: string;
  source: string;
  languageId: string;
  title: string;
  phase: string;
  translated: number;
  total: number;
  blocks: readonly CommentBlock[];
  translations: ReadonlyMap<string, string>;
  error?: string;
}

interface Translation {
  id: string;
  text: string;
  character: number;
  indentation: string;
}

interface SourceRow {
  text: string;
  comments: { start: number; end: number }[];
  inline: Translation[];
  below: Translation[];
}

const PHASE_LABELS: Readonly<Record<string, string>> = {
  scanning: '正在识别注释',
  translating: '正在翻译',
  ready: '翻译完成',
  error: '翻译未完成',
  demo: '离线示例',
  off: '翻译已关闭',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function makeRows(model: ReaderModel): SourceRow[] {
  const rows: SourceRow[] = model.source.split(/\r\n|\n|\r/).map((text) => ({
    text, comments: [], inline: [], below: [],
  }));
  const rowOffsets = [0];
  for (const match of model.source.matchAll(/\r\n|\n|\r/g)) {
    rowOffsets.push(match.index + match[0].length);
  }
  const blocks = [...model.blocks].sort((left, right) =>
    left.start.line - right.start.line || left.start.character - right.start.character);

  for (const block of blocks) {
    const { start, end } = block;
    if (
      !Number.isInteger(start.line) || !Number.isInteger(end.line) ||
      !Number.isInteger(start.character) || !Number.isInteger(end.character) ||
      start.line < 0 || end.line >= rows.length || end.line < start.line ||
      start.character < 0 || end.character < 0 ||
      start.character > rows[start.line].text.length || end.character > rows[end.line].text.length ||
      (start.line === end.line && start.character >= end.character)
    ) {
      continue;
    }
    if (model.source.slice(rowOffsets[start.line] + start.character, rowOffsets[end.line] + end.character) !== block.rawText) {
      continue;
    }
    for (let line = start.line; line <= end.line; line += 1) {
      const from = line === start.line ? start.character : 0;
      const to = line === end.line ? end.character : rows[line].text.length;
      if (to > from) rows[line].comments.push({ start: from, end: to });
    }
    const text = model.translations.get(block.id);
    if (!text?.trim()) continue;
    // An exclusive endpoint at column zero belongs to the previous visual row.
    const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
    const translation: Translation = {
      id: block.id,
      text: formatTranslation(block, text),
      // Keep every source token together, including code after an inline comment.
      character: rows[lastLine].text.length,
      indentation: rows[start.line].text.slice(0, start.character).match(/^[\t ]*/)?.[0] ?? '',
    };
    if (block.kind === 'standalone' || block.kind === 'documentation') {
      rows[lastLine].below.push(translation);
    } else {
      rows[lastLine].inline.push(translation);
    }
  }
  return rows;
}

function renderSource(row: SourceRow): string {
  const boundaries = [...new Set([
    0, row.text.length,
    ...row.comments.flatMap(({ start, end }) => [start, end]),
    ...row.inline.map(({ character }) => character),
  ])].sort((left, right) => left - right);
  return boundaries.map((position, index) => {
    const translations = row.inline.filter(({ character }) => character === position).map((translation) =>
      `<span class="translation-inline" data-translation-id="${escapeHtml(translation.id)}"><span class="translation-separator" aria-hidden="true">  → </span>${escapeHtml(translation.text)}</span>`).join('');
    const next = boundaries[index + 1];
    if (next === undefined) return translations;
    const text = escapeHtml(row.text.slice(position, next));
    const isComment = row.comments.some(({ start, end }) => start <= position && end >= next);
    return translations + (isComment ? `<span class="source-comment">${text}</span>` : text);
  }).join('');
}

function renderRow(row: SourceRow, line: number): string {
  const source = `<div class="source-row" data-line="${line}"><button class="line-number" type="button" data-action="reveal" data-line="${line}" title="返回源码第 ${line + 1} 行" aria-label="返回源码第 ${line + 1} 行">${line + 1}</button><code class="source-code">${renderSource(row)}</code></div>`;
  const below = row.below.map((translation) =>
    `<div class="translation-row" data-line="${line}" data-translation-id="${escapeHtml(translation.id)}"><span class="translation-gutter" aria-hidden="true"></span><div class="translation-block"><span class="translation-indent" aria-hidden="true">${escapeHtml(translation.indentation)}</span><span class="translation-text">${escapeHtml(translation.text)}</span></div></div>`).join('');
  return source + below;
}

/** Renders an offline, themed HTML reader; all model content remains plain text. */
export function renderReaderHtml(model: ReaderModel, nonce: string): string {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(nonce)) throw new TypeError('A valid webview nonce is required.');
  if (model.mode === 'markdown') return renderMarkdownReaderHtml(model, nonce);
  const rows = makeRows(model);
  const title = escapeHtml(model.title);
  const phase = escapeHtml(PHASE_LABELS[model.phase] ?? model.phase);
  const translated = Number.isFinite(model.translated) ? Math.max(0, Math.floor(model.translated)) : 0;
  const total = Number.isFinite(model.total) ? Math.max(0, Math.floor(model.total)) : 0;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${title} · 注释译读</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body.reader { margin: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size, 13px) var(--vscode-font-family, sans-serif); }
.toolbar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 8px 16px; background: var(--vscode-editor-background); }
.file-title { margin: 0; font-size: inherit; font-weight: 500; overflow-wrap: anywhere; }
.file-meta, .progress { color: var(--vscode-descriptionForeground); font-size: 12px; }
.progress { margin-right: auto; }
.toolbar-actions { display: flex; flex-wrap: wrap; gap: 2px; }
button { font: inherit; cursor: pointer; }
.toolbar button { color: var(--vscode-foreground); background: transparent; border: 0; border-radius: 3px; padding: 4px 7px; }
.toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.reader-error { flex-basis: 100%; margin: 0; color: var(--vscode-errorForeground); white-space: pre-wrap; overflow-wrap: anywhere; }
#source { padding: 12px 16px 40px 0; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 14px); font-weight: var(--vscode-editor-font-weight, normal); line-height: 1.6; tab-size: 4; }
.source-row, .translation-row { display: grid; grid-template-columns: ${Math.max(4, String(rows.length).length + 2)}ch minmax(0, 1fr); align-items: start; }
.line-number { align-self: stretch; min-height: 1.6em; margin: 0; padding: 0 1ch 0 0; text-align: right; font: inherit; color: var(--vscode-editorLineNumber-foreground); background: transparent; border: 0; user-select: none; }
.line-number:hover, .line-number:focus-visible { color: var(--vscode-editorLineNumber-activeForeground); }
.line-number:focus-visible { outline-offset: -2px; }
.source-code { display: block; min-width: 0; min-height: 1.6em; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.source-comment { color: var(--vscode-descriptionForeground); }
.translation-row { padding-bottom: 3px; }
.translation-block { display: flex; min-width: 0; }
.translation-indent { white-space: pre; flex-shrink: 0; }
.translation-text, .translation-inline { color: var(--vscode-terminal-ansiGreen, var(--vscode-editor-foreground)); white-space: pre-wrap; overflow-wrap: anywhere; }
.translation-text { min-width: 0; }
.translation-separator { color: var(--vscode-descriptionForeground); }
::selection { background: var(--vscode-editor-selectionBackground); }
@media (max-width: 520px) { .toolbar { padding: 7px 10px; gap: 5px 10px; } #source { padding-right: 10px; } }
</style>
</head>
<body class="reader">
<header class="toolbar">
<h1 class="file-title">${title}</h1><span class="file-meta">只读对照 · ${escapeHtml(model.languageId)}</span>
<span class="progress" role="status" aria-live="polite">${phase} · ${translated}/${total}</span>
<nav class="toolbar-actions" aria-label="阅读操作"><button type="button" data-action="refresh">重试</button><button type="button" data-action="settings">设置</button><button type="button" data-action="reveal">返回源码</button></nav>
${model.error ? `<p class="reader-error" role="alert">${escapeHtml(model.error)}</p>` : ''}
</header>
<main id="source" aria-label="源码与注释译文">${rows.map(renderRow).join('\n')}</main>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const nonce = document.currentScript.nonce;
  const sourceRows = Array.from(document.querySelectorAll('.source-row'));
  const post = (message) => vscode.postMessage({ ...message, nonce });
  const saveScroll = () => vscode.setState({ scrollTop: window.scrollY, scrollLeft: window.scrollX });
  let scrollPending = false;
  window.addEventListener('scroll', () => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => { scrollPending = false; saveScroll(); });
  }, { passive: true });
  window.addEventListener('pagehide', saveScroll);
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'reveal') {
      const top = document.querySelector('.toolbar').getBoundingClientRect().bottom;
      const visible = sourceRows.find((row) => row.getBoundingClientRect().bottom > top) || sourceRows[sourceRows.length - 1];
      const line = Number(button.dataset.line ?? visible?.dataset.line ?? 0);
      post({ type: 'reveal', line });
    } else if (action === 'refresh' || action === 'settings') {
      post({ type: action });
    }
  });
  const saved = vscode.getState();
  requestAnimationFrame(() => {
    if (saved && Number.isFinite(saved.scrollTop) && Number.isFinite(saved.scrollLeft)) {
      window.scrollTo(Math.max(0, saved.scrollLeft), Math.max(0, saved.scrollTop));
    }
    requestAnimationFrame(() => post({
      type: 'ready',
      renderedTranslations: document.querySelectorAll('[data-translation-id]').length,
      sourceRows: sourceRows.length,
      translationRows: document.querySelectorAll('.translation-row').length,
    }));
  });
})();
</script>
</body>
</html>`;
}
