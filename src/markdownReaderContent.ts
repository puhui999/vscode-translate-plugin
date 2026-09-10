import MarkdownIt from 'markdown-it';
import type { ReaderModel } from './readerContent';

const MARKDOWN = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escapeHtml = MARKDOWN.utils.escapeHtml;
// Readers never navigate to model-supplied URLs or fetch embedded images.
MARKDOWN.renderer.rules.link_open = (tokens, index) => `<span class="document-link" title="${escapeHtml(tokens[index].attrGet('href') ?? '')}">`;
MARKDOWN.renderer.rules.link_close = () => '</span>';
MARKDOWN.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  return `<span class="document-image">[${escapeHtml(token.content || '图片')}] <span class="image-address">${escapeHtml(token.attrGet('src') ?? '')}</span></span>`;
};

const PHASE_LABELS: Readonly<Record<string, string>> = {
  scanning: '正在扫描全文 / 查库', translating: '正在翻译全文', ready: '全文翻译完成',
  error: '翻译未完成 · 已保留成功段落', stale: '内容或设置已更改，请重新翻译', off: '翻译已关闭 · 显示原文',
};

function renderDocument(source: string): string {
  // YAML/TOML metadata remains literal metadata rather than a translated heading.
  const metadata = source.match(/^(?:\uFEFF)?(---|\+\+\+)[\t ]*\r?\n[\s\S]*?\r?\n\1[\t ]*(?:\r?\n|$)/);
  return metadata
    ? `<details class="metadata"><summary>文档元数据</summary><pre><code>${escapeHtml(metadata[0])}</code></pre></details>${MARKDOWN.render(source.slice(metadata[0].length))}`
    : MARKDOWN.render(source);
}

/** Renders Markdown prose in a read-only, offline reader with a local original/translation switch. */
export function renderMarkdownReaderHtml(model: ReaderModel, nonce: string): string {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(nonce)) throw new TypeError('A valid webview nonce is required.');
  const count = (value: number): number => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const translated = count(model.translated);
  const total = count(model.total);
  const sourceRows = model.source.split(/\r\n|\r|\n/).length;
  const phase = PHASE_LABELS[model.phase] ?? model.phase;
  const pending = model.phase === 'scanning' || model.phase === 'translating';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${escapeHtml(model.title)} · Markdown 译读</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size, 14px) var(--vscode-font-family, sans-serif); }
.toolbar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 10px 18px; background: var(--vscode-editor-background); }
.file-title { margin: 0; font-size: inherit; font-weight: 500; overflow-wrap: anywhere; }
.meta, .progress, .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
.progress { margin-right: auto; }
.actions { display: flex; flex-wrap: wrap; gap: 2px; }
button { font: inherit; cursor: pointer; color: var(--vscode-foreground); background: transparent; border: 0; border-radius: 3px; padding: 4px 7px; }
button:hover { background: var(--vscode-toolbar-hoverBackground); }
button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.error { flex-basis: 100%; margin: 0; color: var(--vscode-errorForeground); white-space: pre-wrap; overflow-wrap: anywhere; }
.hint { flex-basis: 100%; margin: 0; }
main { max-width: 940px; margin: 0 auto; padding: 14px 28px 60px; }
.document { line-height: 1.75; overflow-wrap: anywhere; }
.document[hidden] { display: none; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 .6em; }
h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
p, ul, ol, blockquote, pre, table { margin: .85em 0; }
li > p { margin: .3em 0; } li { margin: .2em 0; }
blockquote { margin-left: 0; padding: 0 1em; border-left: 3px solid var(--vscode-textBlockQuote-border, #777); color: var(--vscode-descriptionForeground); }
code, pre { font-family: var(--vscode-editor-font-family, monospace); }
code { background: var(--vscode-textCodeBlock-background); padding: .12em .3em; border-radius: 3px; }
pre { overflow-x: auto; padding: 14px 16px; background: var(--vscode-textCodeBlock-background); line-height: 1.5; }
pre code { padding: 0; background: transparent; white-space: pre; }
table { display: block; overflow-x: auto; border-collapse: collapse; }
th, td { border: 1px solid var(--vscode-panel-border, #777); padding: 6px 12px; }
th { text-align: left; } hr { border: 0; border-top: 1px solid var(--vscode-panel-border, #777); }
.document-link { color: var(--vscode-textLink-foreground); text-decoration: underline; text-underline-offset: 2px; }
.document-image, .metadata, .image-address { color: var(--vscode-descriptionForeground); }
.image-address { font-size: .85em; }
::selection { background: var(--vscode-editor-selectionBackground); }
@media(max-width: 520px) { main { padding: 10px 16px 40px; } .toolbar { padding: 8px 12px; } }
</style></head>
<body data-source-rows="${sourceRows}" data-translated="${translated}">
<header class="toolbar"><h1 class="file-title">${escapeHtml(model.title)}</h1><span class="meta">Markdown 全文 · 只读</span>
<span class="progress" role="status" aria-live="polite">${escapeHtml(phase)} · ${translated}/${total}</span>
<nav class="actions" aria-label="阅读操作"><button type="button" data-action="original" aria-pressed="false">查看原文</button><button type="button" data-action="refresh">重新翻译</button><button type="button" data-action="settings">设置</button><button type="button" data-action="reveal">返回源码</button></nav>
${pending ? '<p class="hint">已完成的段落会逐批显示，其余部分暂时保留原文。</p>' : ''}
${model.error ? `<p class="error" role="alert">${escapeHtml(model.error)}</p>` : ''}
</header>
<main><article id="translated" class="document" aria-label="Markdown 译文">${renderDocument(model.markdown ?? model.source)}</article><article id="original" class="document" aria-label="Markdown 原文" hidden>${renderDocument(model.source)}</article></main>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const nonce = document.currentScript.nonce;
  const saved = vscode.getState();
  let original = saved?.original === true;
  const button = document.querySelector('[data-action="original"]');
  const applyView = () => {
    document.getElementById('original').hidden = !original;
    document.getElementById('translated').hidden = original;
    button.textContent = original ? '查看译文' : '查看原文';
    button.setAttribute('aria-pressed', String(original));
  };
  const save = () => vscode.setState({ original, scrollTop: window.scrollY, scrollLeft: window.scrollX });
  const post = (message) => vscode.postMessage({ ...message, nonce });
  let scrolling = false;
  window.addEventListener('scroll', () => {
    if (scrolling) return;
    scrolling = true;
    requestAnimationFrame(() => { scrolling = false; save(); });
  }, { passive: true });
  window.addEventListener('pagehide', save);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'original') { original = !original; applyView(); save(); }
    else if (action === 'refresh' || action === 'settings') post({ type: action });
    else if (action === 'reveal') post({ type: 'reveal', line: 0 });
  });
  applyView();
  requestAnimationFrame(() => {
    if (saved && Number.isFinite(saved.scrollTop) && Number.isFinite(saved.scrollLeft)) window.scrollTo(Math.max(0, saved.scrollLeft), Math.max(0, saved.scrollTop));
    post({ type: 'ready', sourceRows: Number(document.body.dataset.sourceRows), renderedTranslations: Number(document.body.dataset.translated), translationRows: Number(document.body.dataset.translated) });
  });
})();
</script></body></html>`;
}
