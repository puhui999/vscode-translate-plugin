import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { CommentBlock } from '../src/parser/commentParser';
import { renderReaderHtml, type ReaderModel } from '../src/readerContent';

const NONCE = 'test-safe-nonce_123';

function block(id: string, kind: CommentBlock['kind'], startLine: number, startCharacter: number, endLine: number, endCharacter: number, rawText: string): CommentBlock {
  return { id, kind, start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter }, text: '', rawText, languageId: 'typescript' };
}

function model(overrides: Partial<ReaderModel> = {}): ReaderModel {
  return { source: '', languageId: 'typescript', title: 'example.ts', phase: 'ready', translated: 0, total: 0, blocks: [], translations: new Map(), ...overrides };
}

function main(html: string): string {
  return html.match(/<main[^>]*>([\s\S]*?)<\/main>/)![1];
}

function codeLines(html: string): string[] {
  return [...main(html).matchAll(/<code class="source-code">([\s\S]*?)<\/code>/g)].map((match) => match[1]);
}

describe('read-only reader content', () => {
  it('places complete multiline block translations after the original ending line with original indentation', () => {
    const html = renderReaderHtml(model({
      source: '\t/**\n\t * Preserve the cache.\n\t */\n\tconst cache = new Map();',
      blocks: [block('doc', 'documentation', 0, 1, 2, 4, '/**\n\t * Preserve the cache.\n\t */')],
      translations: new Map([['doc', '保留缓存。\n@param key 缓存键\n示例：cache.get(key)']]),
    }), NONCE);
    const content = main(html);
    expect(codeLines(html)).toHaveLength(4);
    expect(content.indexOf('data-translation-id="doc"')).toBeGreaterThan(content.indexOf('class="source-row" data-line="2"'));
    expect(content.indexOf('data-translation-id="doc"')).toBeLessThan(content.indexOf('class="source-row" data-line="3"'));
    expect(content).toContain('<span class="translation-indent" aria-hidden="true">\t</span>');
    expect(content).toContain('/**\n * 保留缓存。\n * @param key 缓存键\n * 示例：cache.get(key)\n */');
    expect(content.match(/class="line-number"/g)).toHaveLength(4);
    expect(html).toContain('white-space: pre-wrap; overflow-wrap: anywhere;');
    expect(html).not.toMatch(/max-height:|line-clamp|text-overflow:|overflow:\s*hidden|position:\s*absolute/);
  });

  it('appends inline and trailing translations after all source tokens without losing code or a second comment', () => {
    const source = 'const n = /* first */ 1; // second';
    const firstEnd = source.indexOf('*/') + 2;
    const html = renderReaderHtml(model({
      source,
      blocks: [block('tail', 'trailing', 0, source.indexOf('//'), 0, source.length, '// second'), block('middle', 'inline', 0, source.indexOf('/*'), 0, firstEnd, '/* first */')],
      translations: new Map([['middle', '第一个'], ['tail', '第二个\n补充说明']]),
    }), NONCE);
    const content = codeLines(html)[0];
    expect(content).toContain('<span class="source-comment">/* first */</span> 1; <span class="source-comment">// second</span><span class="translation-inline"');
    expect(content.indexOf('第一个')).toBeGreaterThan(content.indexOf('// second'));
    expect(content.indexOf('第二个')).toBeGreaterThan(content.indexOf('// second'));
    expect(content).toContain('// 第二个\n// 补充说明');
    expect(main(html)).not.toContain('class="translation-row"');
    expect(main(html).match(/data-translation-id=/g)).toHaveLength(2);
  });

  it('preserves empty lines, CRLF, lone CR, source indentation and UTF-16 comment coordinates', () => {
    const html = renderReaderHtml(model({
      source: '\r\n\tlet emoji = "😀"; // ok\r\n\r',
      blocks: [block('emoji', 'trailing', 1, 19, 1, 24, '// ok')],
    }), NONCE);
    expect(codeLines(html)).toEqual(['', '\tlet emoji = &quot;😀&quot;; <span class="source-comment">// ok</span>', '', '']);
    expect(main(html)).toContain('data-line="3" title="返回源码第 4 行"');
    expect(main(renderReaderHtml(model(), NONCE))).toContain('<code class="source-code"></code>');
  });

  it('handles unclosed blocks and exclusive zero-column endpoints', () => {
    const html = renderReaderHtml(model({
      source: '/* unfinished\n * second line\n',
      blocks: [block('open', 'standalone', 0, 0, 2, 0, '/* unfinished\n * second line\n')],
      translations: new Map([['open', '未闭合注释\n第二行']]),
    }), NONCE);
    const content = main(html);
    expect(content.indexOf('class="translation-row" data-line="1"')).toBeGreaterThan(content.indexOf('class="source-row" data-line="1"'));
    expect(content.indexOf('class="translation-row"')).toBeLessThan(content.indexOf('class="source-row" data-line="2"'));
  });

  it('leaves untranslated comments highlighted and excludes missing, empty and stale translations', () => {
    const html = renderReaderHtml(model({
      source: '// one\n// two',
      blocks: [block('one', 'standalone', 0, 0, 0, 6, '// one'), block('two', 'standalone', 1, 0, 1, 6, '// two'), block('stale', 'standalone', 8, 0, 8, 3, '// old')],
      translations: new Map([['two', ' \n '], ['stale', '旧译文'], ['unmatched', '另一文件']]),
    }), NONCE);
    expect(main(html).match(/class="source-comment"/g)).toHaveLength(2);
    expect(main(html)).not.toContain('data-translation-id');
    expect(main(html)).not.toContain('旧译文');
  });

  it('renders all untrusted text literally without executable HTML, links or model text in scripts', () => {
    const malicious = '<img src=x onerror="alert(1)"></script><script>alert(2)</script>&\'';
    const html = renderReaderHtml(model({
      title: malicious, languageId: malicious, phase: malicious, error: malicious,
      source: malicious,
      blocks: [block(malicious, 'standalone', 0, 0, 0, malicious.length, malicious)],
      translations: new Map([[malicious, malicious]]),
    }), NONCE);
    expect(html).not.toContain(malicious);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(html.match(/<script /g)).toHaveLength(1);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('data-translation-id="&lt;img');
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    expect(script).not.toContain('alert(1)');
    expect(html).toContain(`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${NONCE}';`);
    expect(() => renderReaderHtml(model(), "x'; script-src *")).toThrow(TypeError);
    expect(() => renderReaderHtml(model(), '')).toThrow(TypeError);
  });

  it('rejects stale source ranges and compares multiline rawText with exact CRLF offsets', () => {
    const html = renderReaderHtml(model({
      source: 'changed\r\n/* new\r\n * body */\r\n// new',
      blocks: [
        block('valid', 'standalone', 1, 0, 2, 10, '/* new\r\n * body */'),
        block('wrong-newlines', 'standalone', 1, 0, 2, 10, '/* new\n * body */'),
        block('old', 'standalone', 3, 0, 3, 6, '// old'),
      ],
      translations: new Map([['valid', '完整译文'], ['wrong-newlines', '换行已变化'], ['old', '过期译文']]),
    }), NONCE);
    expect(main(html).match(/data-translation-id=/g)).toHaveLength(1);
    expect(main(html)).toContain('data-translation-id="valid"');
    expect(codeLines(html)[3]).toBe('// new');
    expect(main(html)).not.toContain('过期译文');
    expect(main(html)).not.toContain('换行已变化');
  });

  it('uses readable phase and progress labels with a safe error message', () => {
    const html = renderReaderHtml(model({ phase: 'error', translated: 2.8, total: 6, error: '服务暂不可用\n请检查 <地址>' }), NONCE);
    expect(html).toContain('翻译未完成 · 2/6');
    expect(html).toContain('role="alert">服务暂不可用\n请检查 &lt;地址&gt;');
    expect(html).toContain('data-action="refresh">重试');
    expect(html).toContain('data-action="settings">设置');
    expect(html).toContain('button:focus-visible');
    expect(renderReaderHtml(model({ translated: NaN, total: -1 }), NONCE)).toContain('翻译完成 · 0/0');
    expect(renderReaderHtml(model({ phase: 'off' }), NONCE)).toContain('翻译已关闭 · 0/0');
  });

  it('reports only render counts and nonce, restores scrolling and sends keyboard-accessible button actions', () => {
    const html = renderReaderHtml(model({ source: '// one\nconst x = 1;' }), NONCE);
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    const messages: unknown[] = [];
    const documentEvents = new Map<string, (event: { target: unknown }) => void>();
    const windowEvents = new Map<string, () => void>();
    const frames: (() => void)[] = [];
    const setState = vi.fn();
    const scrollTo = vi.fn();
    const rows = [{ dataset: { line: '0' }, getBoundingClientRect: () => ({ bottom: 10 }) }, { dataset: { line: '1' }, getBoundingClientRect: () => ({ bottom: 70 }) }];
    class Button {
      constructor(readonly dataset: Record<string, string>) {}
      closest(): Button { return this; }
    }
    runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => ({ scrollTop: 240, scrollLeft: 20 }), setState }),
      document: {
        currentScript: { nonce: NONCE },
        querySelectorAll: (selector: string) => selector === '.source-row' ? rows : selector === '.translation-row' ? [{}] : [{}, {}],
        querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 40 }) }),
        addEventListener: (name: string, listener: (event: { target: unknown }) => void) => documentEvents.set(name, listener),
      },
      window: { scrollX: 20, scrollY: 240, scrollTo, addEventListener: (name: string, listener: () => void) => windowEvents.set(name, listener) },
      Element: Button,
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
    });
    while (frames.length) frames.shift()!();
    expect(scrollTo).toHaveBeenCalledWith(20, 240);
    expect(messages).toEqual([{ type: 'ready', nonce: NONCE, renderedTranslations: 2, sourceRows: 2, translationRows: 1 }]);
    for (const dataset of [{ action: 'reveal', line: '0' }, { action: 'reveal' }, { action: 'refresh' }, { action: 'settings' }, { action: 'unexpected' }]) {
      documentEvents.get('click')!({ target: new Button(dataset as Record<string, string>) });
    }
    documentEvents.get('click')!({ target: null });
    expect(messages.slice(1)).toEqual([{ type: 'reveal', line: 0, nonce: NONCE }, { type: 'reveal', line: 1, nonce: NONCE }, { type: 'refresh', nonce: NONCE }, { type: 'settings', nonce: NONCE }]);
    windowEvents.get('scroll')!();
    windowEvents.get('scroll')!();
    expect(frames).toHaveLength(1);
    frames.shift()!();
    windowEvents.get('pagehide')!();
    expect(setState).toHaveBeenLastCalledWith({ scrollTop: 240, scrollLeft: 20 });
    expect(main(html)).toContain('type="button" data-action="reveal" data-line="1"');
  });
});
