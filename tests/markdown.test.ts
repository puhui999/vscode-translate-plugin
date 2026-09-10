import { describe, expect, it } from 'vitest';
import {
  applyMarkdownTranslations, MARKDOWN_PROMPT_VERSION, parseMarkdown, preservesMarkdownStructure
} from '../src/markdown';

describe('parseMarkdown', () => {
  it('extracts complete natural-language headings, paragraphs, lists, tables and blockquotes', () => {
    const source = [
      '---', 'title: Keep metadata', '---', '',
      '# Heading', '',
      'Read **this guide** with `constant` and [a link](https://example.test/docs).', '',
      '- First item', '  - Nested item', '- Second item', '',
      '| Name | Description |', '| :--- | ---: |', '| Item | Details |', '',
      '> A quotation', '>', '> Another paragraph', '',
      '```typescript', '// Do not translate executable examples', 'const answer = 42;', '```', '',
      '    const indented = "keep";', '',
      '<div>Keep HTML</div>', '',
      '[docs]: https://example.test/reference "Keep title"', '',
      '***', '', '12345', '', 'https://example.test/', ''
    ].join('\n');
    const chunks = parseMarkdown(source, 16_000);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      '# Heading',
      'Read **this guide** with `constant` and [a link](https://example.test/docs).',
      '- First item\n  - Nested item\n- Second item',
      '| Name | Description |\n| :--- | ---: |\n| Item | Details |',
      '> A quotation\n>\n> Another paragraph'
    ]);
    for (const chunk of chunks) expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
    expect(MARKDOWN_PROMPT_VERSION).toMatch(/^markdown-/);
  });

  it('uses UTF-16 offsets and preserves CRLF and blank separators', () => {
    const source = '# 😀 Heading\r\n \t\r\nParagraph line one.\r\nLine two.\r\n';
    const chunks = parseMarkdown(source, 1_000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ start: 0, end: '# 😀 Heading'.length, startLine: 0, endLine: 1 });
    expect(chunks[1]).toMatchObject({
      start: source.indexOf('Paragraph'), end: source.length - 2, startLine: 2, endLine: 4,
      text: 'Paragraph line one.\r\nLine two.'
    });
    expect(applyMarkdownTranslations(source, chunks, new Map())).toBe(source);
  });

  it('assigns distinct stable IDs to repeated paragraphs', () => {
    const source = 'Repeated paragraph.\n\nRepeated paragraph.';
    const chunks = parseMarkdown(source, 1_000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].id).not.toBe(chunks[1].id);
    expect(parseMarkdown(source, 1_000)).toEqual(chunks);
    expect(applyMarkdownTranslations(source, chunks, new Map([
      [chunks[0].id, '第一处译文。'], [chunks[1].id, '第二处译文。']
    ]))).toBe('第一处译文。\n\n第二处译文。');
  });

  it('checks the exact serialized comments item budget including escaping and ID overhead', () => {
    const source = 'A paragraph with "quoted text" and \\ backslashes.';
    const [chunk] = parseMarkdown(source, 1_000);
    const required = JSON.stringify({ comments: [{ id: chunk.id, text: chunk.text }] }).length;
    expect(parseMarkdown(source, required)).toHaveLength(1);
    expect(() => parseMarkdown(source, required - 1)).toThrow('maxBatchChars');
    expect(required).toBeGreaterThan(source.length);
  });

  it('reports oversized blocks without truncating or splitting a list or table', () => {
    const source = `- ${'Large item '.repeat(100)}\n- Another item`;
    expect(() => parseMarkdown(source, 100)).toThrow(/第 1–2 行.*不会被截断/);
    expect(() => parseMarkdown('Long paragraph '.repeat(100), 100)).toThrow('完整段落');
    expect(parseMarkdown(`\`\`\`txt\n${'Huge code '.repeat(1_000)}\n\`\`\``, 100)).toEqual([]);
  });

  it('leaves frontmatter, reference definitions, code-only and symbol-only input untranslated', () => {
    for (const source of [
      '', '***', '---\n', '12345', '`const answer = 42`',
      '+++\ntitle = "Keep me"\n+++\n', '\uFEFF---\ntitle: Keep me\n...\n',
      '[guide]: <https://example.test/path>\n  "A multiline reference title"\n',
      '- `code_only()`\n- `more_code()`', '<!-- Keep this comment -->'
    ]) expect(parseMarkdown(source, 1_000)).toEqual([]);
  });

  it.each([0, -1, 63, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid request budget %s', (budget) => {
    expect(() => parseMarkdown('Text', budget)).toThrow(RangeError);
  });
});

describe('preservesMarkdownStructure', () => {
  it.each([
    ['# Heading', '# 标题'],
    ['Heading\n=======', '标题\n======='],
    ['Read **important** and *emphasized* text.', '阅读**重要**和*强调*内容。'],
    ['1. First item\n2. Second item', '1. 第一项\n2. 第二项'],
    ['- First\n  - Nested\n- Last', '- 第一项\n  - 嵌套项\n- 最后一项'],
    ['> First paragraph\n>\n> Second paragraph', '> 第一段\n>\n> 第二段'],
    ['| Name | Value |\n| :--- | ---: |\n| Item | Text |', '| 名称 | 值 |\n| :--- | ---: |\n| 条目 | 文本 |'],
    ['Read [guide](https://example.test/a "Helpful title").', '阅读[指南](https://example.test/a "帮助标题")。'],
    ['![Example image](images/example.png)', '![示例图片](images/example.png)'],
    ['Use `const value = 1` in code.', '在代码中使用 `const value = 1`。'],
    ['A <span class="label">label</span>.', '一个<span class="label">标签</span>。'],
    ['Visit https://example.test/path for help.', '访问 https://example.test/path 获取帮助。'],
    ['First line.\r\nSecond line.', '第一行。\n第二行。']
  ])('allows natural-language changes while preserving %s', (source, translated) => {
    expect(preservesMarkdownStructure(source, translated)).toBe(true);
  });

  it.each([
    ['# Heading', '## 标题'],
    ['- First\n- Second', '第一项\n第二项'],
    ['1. First\n2. Second', '2. 第一项\n3. 第二项'],
    ['- First\n  - Nested', '- 第一项\n- 嵌套项'],
    ['| A | B |\n| --- | --- |\n| C | D |', '| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 | 戊 |'],
    ['Use `secure()`.', '使用 `unsafe()`。'],
    ['```js\nconst x = 1;\n```', '```js\nconst x = 2;\n```'],
    ['```js\nconst x = 1;\n```', '```js\nconst x = 1;\n````'],
    ['[Guide](https://example.test/)', '[指南](https://evil.test/)'],
    ['![Image](image.png)', '![图片](tracking.png)'],
    ['Visit https://example.test/', '访问 https://evil.test/'],
    ['Safe text', '安全文本<script>alert(1)</script>'],
    ['<span>Text</span>', '<img src="https://evil.test/pixel">'],
    ['A <span class="safe">label</span>.', '一个<span onclick="steal()">标签</span>。'],
    ['Plain text.', '[点击](command:workbench.action.closeWindow)'],
    ['First line.\nSecond line.', '合并为一行。'],
    ['- [ ] Todo', '- [x] 已完成'],
    ['---\ntitle: Original\n---\n\n# Heading', '---\ntitle: Changed\n---\n\n# 标题']
  ])('rejects structural, executable or target changes in %s', (source, translated) => {
    expect(preservesMarkdownStructure(source, translated)).toBe(false);
  });

  it('protects reference identifiers even when their definitions are outside the current chunk', () => {
    expect(preservesMarkdownStructure('Read [the guide][docs].', '阅读[指南][docs]。')).toBe(true);
    expect(preservesMarkdownStructure('Read [the guide][docs].', '阅读[指南][other]。')).toBe(false);
    expect(preservesMarkdownStructure('![Example][image]', '![示例][image]')).toBe(true);
    expect(preservesMarkdownStructure('![Example][image]', '![示例][tracker]')).toBe(false);
    expect(preservesMarkdownStructure('Use [Guide][].', '使用[指南][]。')).toBe(false);
    expect(preservesMarkdownStructure('Use [Guide].', '使用[指南]。')).toBe(false);
  });

  it('retains reference definitions, including otherwise ignored duplicate destinations', () => {
    const source = 'Read [guide][docs].\n\n[docs]: https://example.test/ "Title"\n[docs]: https://backup.test/';
    expect(preservesMarkdownStructure(source, source.replace('Read [guide]', '阅读[指南]'))).toBe(true);
    expect(preservesMarkdownStructure(source, source.replace('https://example.test/', 'https://evil.test/'))).toBe(false);
    expect(preservesMarkdownStructure(source, source.replace('https://backup.test/', 'https://evil.test/'))).toBe(false);
  });
});

describe('applyMarkdownTranslations', () => {
  it('applies partial cached results while preserving code, frontmatter, references and whitespace gaps', () => {
    const source = '---\r\ntitle: Keep\r\n---\r\n\r\n# Heading\r\n \t\r\nRead [the guide][docs].\r\n\r\n```js\r\nconst x = 1;\r\n```\r\n\r\n[docs]: https://example.test/\r\n';
    const chunks = parseMarkdown(source, 4_000);
    expect(chunks).toHaveLength(2);
    const translated = applyMarkdownTranslations(source, chunks, new Map([[chunks[1].id, '阅读[指南][docs]。']]));
    expect(translated).toBe(source.replace('Read [the guide][docs].', '阅读[指南][docs]。'));
    expect(source).toContain('Read [the guide][docs].');
  });

  it('restores each original line ending when the model returns normalized newlines', () => {
    const source = 'First line.\r\nSecond line.\nThird line.\r\n';
    const chunks = parseMarkdown(source, 1_000);
    expect(applyMarkdownTranslations(source, chunks, new Map([[chunks[0].id, '第一行。\n第二行。\n第三行。']]))).toBe(
      '第一行。\r\n第二行。\n第三行。\r\n'
    );
  });

  it('retains trailing spaces and whitespace-only separators even with cached identity results', () => {
    const source = '# Heading  \r\n \t\r\n- First item  \r\n- Second item \r\n   \r\nParagraph.\r\n';
    const chunks = parseMarkdown(source, 2_000);
    expect(applyMarkdownTranslations(source, chunks, new Map(chunks.map((chunk) => [chunk.id, chunk.text])))).toBe(source);
    expect(applyMarkdownTranslations(source, chunks, new Map([[chunks[0].id, '# 标题']]))).toBe(
      source.replace('# Heading', '# 标题')
    );
  });

  it('rejects invalid cached results and leaves source input untouched', () => {
    const source = '# Heading\n\nA [link](https://example.test/).';
    const chunks = parseMarkdown(source, 1_000);
    expect(() => applyMarkdownTranslations(source, chunks, new Map([[chunks[0].id, '## 错误级别']]))).toThrow('已拒绝应用');
    expect(() => applyMarkdownTranslations(source, chunks, new Map([[chunks[0].id, ' ']]))).toThrow('已拒绝应用');
    expect(source).toBe('# Heading\n\nA [link](https://example.test/).');
  });

  it('rejects stale, overlapping, duplicated or out-of-range source mappings', () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    const chunks = parseMarkdown(source, 1_000);
    expect(() => applyMarkdownTranslations(`${source}!`, [{ ...chunks[1], text: 'stale' }], new Map())).toThrow('原文已变化');
    expect(() => applyMarkdownTranslations(source, [chunks[1], chunks[0]], new Map())).toThrow('分块范围无效');
    expect(() => applyMarkdownTranslations(source, [chunks[0], { ...chunks[1], id: chunks[0].id }], new Map())).toThrow('分块范围无效');
    expect(() => applyMarkdownTranslations(source, [{ ...chunks[0], end: source.length + 1 }], new Map())).toThrow('分块范围无效');
  });
});
