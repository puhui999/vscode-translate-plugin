import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdownReaderHtml } from '../src/markdownReaderContent';
import { renderReaderHtml, type ReaderModel } from '../src/readerContent';

const NONCE = 'markdown-test_nonce123';

function model(overrides: Partial<ReaderModel> = {}): ReaderModel {
  return {
    mode: 'markdown', source: '# Original\n\nOriginal text.', markdown: '# 译文\n\n翻译内容。',
    languageId: 'markdown', title: 'README.md', phase: 'ready', translated: 2, total: 2,
    blocks: [], translations: new Map(), ...overrides,
  };
}

function article(html: string, id: 'translated' | 'original'): string {
  return html.match(new RegExp(`<article id="${id}"[^>]*>([\\s\\S]*?)</article>`))![1];
}

function script(html: string): string {
  return html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
}

function boot(html: string, saved?: unknown) {
  const messages: unknown[] = [];
  const documentEvents = new Map<string, (event: { target: unknown }) => void>();
  const windowEvents = new Map<string, () => void>();
  const frames: Array<() => void> = [];
  const setState = vi.fn();
  const scrollTo = vi.fn();
  const fetch = vi.fn();
  class Element {
    textContent = '';
    readonly attributes = new Map<string, string>();
    constructor(readonly dataset: Record<string, string> = {}, private readonly isButton = true) {}
    closest(): Element | null { return this.isButton ? this : null; }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  }
  const button = new Element({ action: 'original' });
  const views = { original: { hidden: true }, translated: { hidden: false } };
  const sourceRows = html.match(/data-source-rows="(\d+)"/)![1];
  const translated = html.match(/data-translated="(\d+)"/)![1];
  const viewport = { scrollX: 12, scrollY: 240, scrollTo, addEventListener: (name: string, callback: () => void) => windowEvents.set(name, callback) };
  runInNewContext(script(html), {
    acquireVsCodeApi: () => ({ getState: () => saved, setState, postMessage: (message: unknown) => messages.push(message) }),
    document: {
      currentScript: { nonce: NONCE }, body: { dataset: { sourceRows, translated } },
      querySelector: () => button,
      getElementById: (id: keyof typeof views) => views[id],
      addEventListener: (name: string, callback: (event: { target: unknown }) => void) => documentEvents.set(name, callback),
    },
    window: viewport, Element, fetch,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  const flushFrames = () => { while (frames.length) frames.shift()!(); };
  const click = (action: string, attributes: Record<string, string> = {}) => {
    documentEvents.get('click')!({ target: new Element({ action, ...attributes }) });
  };
  return { messages, views, button, setState, scrollTo, fetch, frames, windowEvents, documentEvents, Element, flushFrames, click };
}

describe('Markdown reader content', () => {
  it('routes Markdown mode to a semantic document with headings, lists, tables and code', () => {
    const markdown = '# 项目说明\n\n## 使用方法\n\n- 安装\n- **启动**\n\n1. 打开文件\n2. 查看结果\n\n> 保留原文件。\n\n| 名称 | 数量 |\n| --- | ---: |\n| 注释 | 2 |\n\n```ts\nconst value = "<source>";\n```\n\n运行 `loadProfile()`。';
    const rendered = article(renderReaderHtml(model({ markdown }), NONCE), 'translated');
    expect(rendered).toContain('<h1>项目说明</h1>');
    expect(rendered).toContain('<h2>使用方法</h2>');
    expect(rendered).toContain('<ul>\n<li>安装</li>\n<li><strong>启动</strong></li>\n</ul>');
    expect(rendered).toContain('<ol>\n<li>打开文件</li>\n<li>查看结果</li>\n</ol>');
    expect(rendered).toContain('<blockquote>');
    expect(rendered).toContain('<table>');
    expect(rendered).toContain('<th>名称</th>');
    expect(rendered).toContain('<td>注释</td>');
    expect(rendered).toContain('<pre><code class="language-ts">const value = &quot;&lt;source&gt;&quot;;\n</code></pre>');
    expect(rendered).toContain('<code>loadProfile()</code>');
  });

  it('renders independent original and translated documents without changing the supplied model', () => {
    const value = model();
    const before = structuredClone(value);
    const html = renderMarkdownReaderHtml(value, NONCE);
    expect(article(html, 'translated')).toContain('<h1>译文</h1>');
    expect(article(html, 'translated')).not.toContain('Original text.');
    expect(article(html, 'original')).toContain('<h1>Original</h1>');
    expect(article(html, 'original')).not.toContain('翻译内容。');
    expect(html).toContain('id="original" class="document" aria-label="Markdown 原文" hidden');
    expect(value).toEqual(before);
  });

  it.each(['---', '+++'])('keeps %s frontmatter literal instead of rendering metadata as prose', (delimiter) => {
    const metadata = `${delimiter}\ntitle: "<unsafe>"\nauthor: Original\n${delimiter}\n`;
    const html = renderMarkdownReaderHtml(model({ source: metadata + '# Heading', markdown: metadata + '# 标题' }), NONCE);
    const rendered = article(html, 'translated');
    expect(rendered).toContain('<details class="metadata"><summary>文档元数据</summary><pre><code>');
    expect(rendered).toContain('title: &quot;&lt;unsafe&gt;&quot;');
    expect(rendered).toContain('<h1>标题</h1>');
    expect(rendered).not.toContain('<h2>');
    expect(rendered).not.toContain('<unsafe>');
  });

  it('supports BOM and CRLF frontmatter, preserving the body and source line count', () => {
    const source = '\uFEFF---\r\ntitle: Original\r\n---\r\n# Heading\r\n';
    const html = renderMarkdownReaderHtml(model({ source, markdown: undefined }), NONCE);
    expect(article(html, 'translated')).toContain('<h1>Heading</h1>');
    expect(html).toContain('data-source-rows="5"');
  });

  it('uses source text until translated Markdown is available and permits an explicitly empty result', () => {
    expect(article(renderMarkdownReaderHtml(model({ markdown: undefined }), NONCE), 'translated')).toContain('<h1>Original</h1>');
    expect(article(renderMarkdownReaderHtml(model({ markdown: '' }), NONCE), 'translated')).toBe('');
  });

  it.each(['scanning', 'translating'])('shows partial progress and the original-content explanation while %s', (phase) => {
    const html = renderMarkdownReaderHtml(model({ phase, translated: 1, total: 8 }), NONCE);
    expect(html).toContain('1/8</span>');
    expect(html).toContain('已完成的段落会逐批显示，其余部分暂时保留原文。');
    expect(html).toContain('role="status" aria-live="polite"');
  });

  it('shows escaped errors, stale and disabled states without the active-progress hint', () => {
    const html = renderMarkdownReaderHtml(model({ phase: 'error', error: 'Mock <failure>\nTry again.', translated: 1, total: 2 }), NONCE);
    expect(html).toContain('翻译未完成 · 已保留成功段落 · 1/2');
    expect(html).toContain('role="alert">Mock &lt;failure&gt;\nTry again.</p>');
    expect(html).not.toContain('<p class="hint">');
    expect(renderMarkdownReaderHtml(model({ phase: 'stale' }), NONCE)).toContain('内容或设置已更改，请重新翻译');
    expect(renderMarkdownReaderHtml(model({ phase: 'off' }), NONCE)).toContain('翻译已关闭 · 显示原文');
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('normalizes invalid progress %s before passing values to the webview', (value) => {
    const html = renderMarkdownReaderHtml(model({ translated: value, total: value }), NONCE);
    expect(html).toContain('data-translated="0"');
    expect(html).toContain('全文翻译完成 · 0/0');
  });

  it('keeps HTML, active tags, model titles and errors inert, with a nonce-restricted script', () => {
    const malicious = '</article><script>globalThis.pwned = true</script><img src="https://tracker.test/pixel" onerror="alert(1)"><iframe src="https://tracker.test"></iframe>';
    const html = renderMarkdownReaderHtml(model({ source: malicious, markdown: malicious, title: malicious, error: malicious, phase: '<unsafe-phase>' }), NONCE);
    for (const id of ['original', 'translated'] as const) {
      const rendered = article(html, id);
      expect(rendered).not.toMatch(/<(?:script|img|iframe|form|object|embed)\b/i);
      expect(rendered).toContain('&lt;script&gt;globalThis.pwned = true&lt;/script&gt;');
    }
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(script(html)).not.toContain('pwned');
    expect(html).toContain('&lt;unsafe-phase&gt;');
    expect(html).toContain(`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${NONCE}';`);
    expect(() => renderMarkdownReaderHtml(model(), '')).toThrow(TypeError);
    expect(() => renderMarkdownReaderHtml(model(), '" onload="alert(1)')).toThrow(TypeError);
  });

  it('renders links and images as passive labels and addresses without external resources or navigation', () => {
    const markdown = '[Documentation](https://example.test/docs)\n\n![Logo](https://tracker.test/pixel.png)\n\n<https://example.test/auto>\n\n[Run](command:workbench.action.closeWindow)\n\n[Script](javascript:alert%281%29)\n\n![Inline](data:image/png;base64,aGVsbG8=)';
    const rendered = article(renderMarkdownReaderHtml(model({ markdown }), NONCE), 'translated');
    expect(rendered).not.toMatch(/<(?:a|img|link|iframe|object|embed)\b/i);
    expect(rendered).toContain('<span class="document-link" title="https://example.test/docs">Documentation</span>');
    expect(rendered).toContain('class="document-image">[Logo]');
    expect(rendered).toContain('class="image-address">https://tracker.test/pixel.png</span>');
    expect(rendered).not.toMatch(/\s(?:href|src|onerror|onclick)=/i);
  });

  it('escapes code fence language text and image alt text that resemble active HTML attributes', () => {
    const markdown = '```html" onmouseover="attack\n<script>attack()</script>\n```\n\n![<img src=x onerror=attack()>](https://example.test/a.png)';
    const rendered = article(renderMarkdownReaderHtml(model({ markdown }), NONCE), 'translated');
    expect(rendered).not.toMatch(/<(?:script|img)\b/i);
    expect(rendered).not.toContain('onmouseover="attack');
    expect(rendered).toContain('&lt;script&gt;attack()&lt;/script&gt;');
    expect(rendered).toContain('&lt;img src=x onerror=attack()&gt;');
  });

  it('switches original and translation locally without sending a refresh or network request', () => {
    const runtime = boot(renderMarkdownReaderHtml(model(), NONCE));
    runtime.flushFrames();
    const ready = [...runtime.messages];
    expect(runtime.views).toEqual({ original: { hidden: true }, translated: { hidden: false } });
    runtime.click('original');
    expect(runtime.views).toEqual({ original: { hidden: false }, translated: { hidden: true } });
    expect(runtime.button.textContent).toBe('查看译文');
    expect(runtime.button.attributes.get('aria-pressed')).toBe('true');
    expect(runtime.setState).toHaveBeenLastCalledWith({ original: true, scrollTop: 240, scrollLeft: 12 });
    runtime.click('original');
    expect(runtime.views.translated.hidden).toBe(false);
    expect(runtime.button.textContent).toBe('查看原文');
    expect(runtime.messages).toEqual(ready);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it('posts only nonce-bound ready and explicit toolbar actions with the fixed source entry point', () => {
    const runtime = boot(renderMarkdownReaderHtml(model({ source: '# Heading\r\nBody\rLast', translated: 1 }), NONCE));
    runtime.flushFrames();
    expect(runtime.messages).toEqual([{ type: 'ready', sourceRows: 3, renderedTranslations: 1, translationRows: 1, nonce: NONCE }]);
    runtime.click('refresh');
    runtime.click('settings');
    runtime.click('reveal', { line: '99', uri: 'file:///not-the-source' });
    runtime.click('execute-command');
    runtime.documentEvents.get('click')!({ target: null });
    runtime.documentEvents.get('click')!({ target: new runtime.Element({ action: 'refresh' }, false) });
    expect(runtime.messages.slice(1)).toEqual([
      { type: 'refresh', nonce: NONCE }, { type: 'settings', nonce: NONCE }, { type: 'reveal', line: 0, nonce: NONCE },
    ]);
    expect(runtime.fetch).not.toHaveBeenCalled();
  });

  it('restores local view and scroll state, throttles scroll saves and records pagehide', () => {
    const runtime = boot(renderMarkdownReaderHtml(model(), NONCE), { original: true, scrollTop: 320, scrollLeft: 8 });
    expect(runtime.views.original.hidden).toBe(false);
    runtime.flushFrames();
    expect(runtime.scrollTo).toHaveBeenCalledExactlyOnceWith(8, 320);
    runtime.windowEvents.get('scroll')!();
    runtime.windowEvents.get('scroll')!();
    expect(runtime.frames).toHaveLength(1);
    runtime.flushFrames();
    runtime.windowEvents.get('pagehide')!();
    expect(runtime.setState).toHaveBeenCalledTimes(2);
    expect(runtime.setState).toHaveBeenLastCalledWith({ original: true, scrollTop: 240, scrollLeft: 12 });
  });

  it('ignores invalid saved scroll coordinates and bounds negative values', () => {
    const invalid = boot(renderMarkdownReaderHtml(model(), NONCE), { original: 'true', scrollTop: NaN, scrollLeft: Infinity });
    invalid.flushFrames();
    expect(invalid.scrollTo).not.toHaveBeenCalled();
    expect(invalid.views.original.hidden).toBe(true);
    const negative = boot(renderMarkdownReaderHtml(model(), NONCE), { scrollTop: -10, scrollLeft: -20 });
    negative.flushFrames();
    expect(negative.scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
  });
});
