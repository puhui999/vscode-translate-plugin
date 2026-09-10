import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { formatSourceTranslation, formatTranslation } from '../src/commentFormat';
import { CommentParser, type CommentBlock } from '../src/parser/commentParser';

function comment(rawText: string, character = 0): CommentBlock {
  return { id: 'comment', rawText, text: '', kind: 'documentation', languageId: 'typescript', start: { line: 0, character }, end: { line: rawText.split('\n').length - 1, character: 0 } };
}

describe('comment translation formatting', () => {
  it('restores JSDoc framing, tags and parameter names without changing text', () => {
    const original = comment('/**\n * Load profile.\n * @param userId User identifier.\n */');
    expect(formatTranslation(original, '加载资料。\n@param userId 用户标识。')).toBe('/**\n * 加载资料。\n * @param userId 用户标识。\n */');
  });

  it.each(['//', '///', '//!', '#', '--'])('restores %s lines, blank lines and body indentation', (marker) => {
    const original = comment(`${marker} First.\n    ${marker}\n    ${marker}   @param {User} user User.`, 4);
    expect(formatTranslation(original, '第一行。\n@param {User} user 用户。')).toBe(`${marker} 第一行。\n${marker}\n${marker}   @param {User} user 用户。`);
  });

  it('preserves compact spacing and does not duplicate a line-comment wrapper', () => {
    expect(formatTranslation(comment('//Hello'), '//你好')).toBe('//你好');
    expect(formatTranslation(comment('/// Hello\n/// Again'), '/// 你好\n/// 再次')).toBe('/// 你好\n/// 再次');
  });

  it('restores each marker in a merged PHP block and uses the first content marker for extra lines', () => {
    const original = comment('# First.\n// Second.');
    expect(formatTranslation(original, '第一行。\n第二行。')).toBe('# 第一行。\n// 第二行。');
    expect(formatTranslation(original, '第一行。\n第二行。\n更多说明。')).toBe('# 第一行。\n# 第二行。\n# 更多说明。');
  });

  it('restores mixed Rust doc markers without treating a Markdown heading as a slash wrapper', () => {
    const original = comment('/// First.\n//! Second.');
    expect(formatTranslation(original, '第一行。\n第二行。')).toBe('/// 第一行。\n//! 第二行。');
    expect(formatTranslation(original, '/// 第一行。\n//! 第二行。')).toBe('/// 第一行。\n//! 第二行。');
    expect(formatTranslation(comment('// # Heading'), '# 标题')).toBe('// # 标题');
  });

  it.each(['/*', '/**', '/*!'])('restores %s multiline shells with stars and avoids a second wrapper', (opener) => {
    const original = comment(`${opener}\n * First.\n * Second.\n */`);
    const formatted = `${opener}\n * 第一行。\n * 第二行。\n */`;
    expect(formatTranslation(original, formatted)).toBe(formatted);
  });

  it('removes external spaces or tabs while retaining the star column', () => {
    expect(formatTranslation(comment('/**\n     * Hello.\n     */', 4), '你好。')).toBe('/**\n * 你好。\n */');
    expect(formatTranslation(comment('/**\n\t * Hello.\n\t */', 1), '你好。')).toBe('/**\n * 你好。\n */');
    expect(formatTranslation(comment('/*\n * Hello.\n */', 20), '你好。')).toBe('/*\n * 你好。\n */');
  });

  it('preserves unstarred body indentation, empty rows and code identifiers', () => {
    const original = comment('/*\n    Description.\n\n      cache.get(userId)\n    */', 4);
    expect(formatTranslation(original, '描述。\ncache.get(userId)')).toBe('/*\n描述。\n\n  cache.get(userId)\n*/');
  });

  it('keeps extra translated rows and blank rows without semantic line matching', () => {
    const original = comment('/**\n * First.\n * Second.\n */');
    expect(formatTranslation(original, '第一行。\n\n解释。\n第二行。\n新增。')).toBe('/**\n * 第一行。\n *\n * 解释。\n * 第二行。\n * 新增。\n */');
    expect(formatTranslation(original, '合并后的完整译文。')).toBe('/**\n * 合并后的完整译文。\n */');
  });

  it('preserves the larger blank-line gap without doubling matching gaps', () => {
    const original = comment('/**\n * One.\n *\n * Two.\n */');
    expect(formatTranslation(original, '一。\n\n二。')).toBe('/**\n * 一。\n *\n * 二。\n */');
    expect(formatTranslation(original, '一。\n\n\n二。')).toBe('/**\n * 一。\n *\n *\n * 二。\n */');
  });

  it('keeps an opening-line description and inline closing marker', () => {
    expect(formatTranslation(comment('/** First.\n * Second. */'), '第一行。\n第二行。')).toBe('/** 第一行。\n * 第二行。 */');
    expect(formatTranslation(comment('/* first */'), '第一行。\n第二行。')).toBe('/* 第一行。\n第二行。 */');
    expect(formatTranslation(comment('/*first*/'), '/*第一行*/')).toBe('/*第一行*/');
  });

  it('does not invent a closing marker for an unfinished source comment', () => {
    expect(formatTranslation(comment('/**\n * unfinished'), '未完成')).toBe('/**\n * 未完成');
  });

  it('retains Ruby and PowerShell block delimiters without changing parser support', () => {
    expect(formatTranslation(comment('=begin\nFirst.\n  code()\n=end'), '第一行。\ncode()')).toBe('=begin\n第一行。\n  code()\n=end');
    expect(formatTranslation(comment('<#\nFirst.\n#>'), '<#\n第一行。\n#>')).toBe('<#\n第一行。\n#>');
  });

  it('normalizes CRLF, leaves unsupported bodies untouched and does not mutate inputs', () => {
    const original = comment('/**\r\n * Hello.\r\n */');
    const rawText = original.rawText;
    expect(formatTranslation(original, '你好。\r\n更多内容。')).toBe('/**\n * 你好。\n * 更多内容。\n */');
    expect(original.rawText).toBe(rawText);
    expect(formatTranslation(comment('unknown syntax'), '原样\n  `code`')).toBe('原样\n  `code`');
    expect(formatTranslation(original, ' \n ')).toBe('');
  });

  it('formats empty compact source shells without losing their ending delimiter', () => {
    expect(formatTranslation(comment('/**/'), '译文')).toBe('/*译文*/');
    expect(formatTranslation(comment('/* */'), '译文')).toBe('/* 译文*/');
  });
});

describe('source-position translation formatting', () => {
  it('maps corresponding bodies without changing external indentation, empty lines or delimiters', () => {
    const block = comment('/**\n\t * Load profile.\n\t *\n\t *   @param {User} user User identifier.\n\t */', 1);
    expect(formatSourceTranslation(block, '加载资料。\n@param {User} user 用户标识。')).toEqual([
      '/**', '\t * 加载资料。', '\t *', '\t *   @param {User} user 用户标识。', '\t */',
    ]);
  });

  it.each(['//', '///', '//!', '#', '--'])('retains each %s physical row and its exact spaces', (marker) => {
    const block = comment(`${marker} First.  \n\t${marker}\t\n  ${marker}\tSecond.`, 2);
    expect(formatSourceTranslation(block, '第一行。\n\n\n第二行。')).toEqual([
      `${marker} 第一行。  `, `\t${marker}\t`, `  ${marker}\t第二行。`,
    ]);
  });

  it('preserves mixed line markers and prevents double-wrapping', () => {
    expect(formatSourceTranslation(comment('# First.\n  // Second.', 2), '# 第一行。\n// 第二行。'))
      .toEqual(['# 第一行。', '  // 第二行。']);
    expect(formatSourceTranslation(comment('/// First.\n//! Second.'), '/// 第一行。\n//! 第二行。'))
      .toEqual(['/// 第一行。', '//! 第二行。']);
    expect(formatSourceTranslation(comment('// # Heading'), '# 标题')).toEqual(['// # 标题']);
  });

  it.each(['/*', '/**', '/*!'])('retains a %s opening and closing line that also contain prose', (marker) => {
    const block = comment(`${marker}\tFirst.\n\t * Second.\n\t * Last.  */  `, 4);
    expect(formatSourceTranslation(block, '第一行。\n第二行。\n最后一行。')).toEqual([
      `${marker}\t第一行。`, '\t * 第二行。', '\t * 最后一行。  */  ',
    ]);
  });

  it('retains unstarred indentation, code indentation and truly blank rows', () => {
    const block = comment('/*\n\t  Description.\n\n\t    cache.get(userId)\n\t*/', 1);
    expect(formatSourceTranslation(block, '说明。\ncache.get(userId)')).toEqual([
      '/*', '\t  说明。', '', '\t    cache.get(userId)', '\t*/',
    ]);
  });

  it('strips a wrapped block translation while preserving the original shell', () => {
    const block = comment('/**\n     * First.\n     * Second.\n     */', 4);
    expect(formatSourceTranslation(block, '  /**\r\n * 第一行。\r\n * 第二行。\r\n */  ')).toEqual([
      '/**', '     * 第一行。', '     * 第二行。', '     */',
    ]);
  });

  it('keeps compact and trailing block translations on their existing single line', () => {
    expect(formatSourceTranslation(comment('/*first*/', 20), '/*第一行。\n第二行。*/')).toEqual(['/*第一行。 第二行。*/']);
    expect(formatSourceTranslation(comment('// First.', 24), '第一行。\n\n第二行。')).toEqual(['// 第一行。 第二行。']);
    expect(formatSourceTranslation(comment('/* First. */', 20), '第一行。')).toEqual(['/* 第一行。 */']);
  });

  it('spreads merged prose through available bodies, preserving words and all content', () => {
    const text = 'Read the cached profile. Request the latest version. Return the current value.';
    const result = formatSourceTranslation(comment('// First.\n// Second.\n// Third.'), text);
    const bodies = result.map((line) => line.slice(3));
    expect(bodies).toHaveLength(3);
    expect(bodies.every((body) => body.trim().length > 0)).toBe(true);
    expect(bodies.join(' ')).toBe(text);
    expect(bodies.every((body) => !/^\s|\s$/.test(body))).toBe(true);
  });

  it('uses sentence boundaries when a single CJK paragraph fills multiple source bodies', () => {
    const text = '首先读取本地缓存。然后请求用户资料。最后返回完整结果。';
    const result = formatSourceTranslation(comment('// First.\n// Second.\n// Third.'), text);
    expect(result).toEqual(['// 首先读取本地缓存。', '// 然后请求用户资料。', '// 最后返回完整结果。']);
  });

  it('keeps excess translated lines in the existing bodies and leaves blank source rows alone', () => {
    const result = formatSourceTranslation(comment('/*\n * First.\n *\n * Last.\n */'), '一。\n二。\n三。\n四。');
    expect(result).toHaveLength(5);
    expect(result[0]).toBe('/*');
    expect(result[2]).toBe(' *');
    expect(result[4]).toBe(' */');
    expect(result[1].slice(3)).not.toBe('');
    expect(result[3].slice(3)).not.toBe('');
    expect((result[1].slice(3) + result[3].slice(3)).replace(/\s/g, '')).toBe('一。二。三。四。');
  });

  it('does not split emoji sequences, accents, code spans or XML attributes', () => {
    const text = '使用 👨‍👩‍👧‍👦 家庭资料和 cafe\u0301 标签，调用 `cache.get(userId)`，参见 <see cref="User.Find"/>。';
    const result = formatSourceTranslation(comment('// First.\n// Second.\n// Third.\n// Fourth.'), text);
    const body = result.map((line) => line.slice(3)).join(' ');
    expect(body).toContain('👨‍👩‍👧‍👦');
    expect(body).toContain('cafe\u0301');
    expect(body).toContain('`cache.get(userId)`');
    expect(body).toContain('<see cref="User.Find"/>');
    expect(body.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    expect(result).toHaveLength(4);
  });

  it('keeps documentation declarations and parameter names intact during reflow', () => {
    const result = formatSourceTranslation(comment('/**\n * One.\n * Two.\n * Three.\n */'), '@param {Map<string, User>} users 用户对照表。\n@returns {User[]} 全部用户。');
    const body = result.join('\n');
    expect(body).toContain('@param {Map<string, User>} users 用户对照表。');
    expect(body).toContain('@returns {User[]} 全部用户。');
    expect(result).toHaveLength(5);
    expect(result[1]).toContain('@param');
  });

  it('does not invent delimiters or split an indivisible word just to fill empty output rows', () => {
    const result = formatSourceTranslation(comment('/**\n * unfinished\n * detail'), 'Supercalifragilisticexpialidocious');
    expect(result).toEqual(['/**', ' * Supercalifragilisticexpialidocious', ' * ']);
  });

  it('supports Ruby and PowerShell block shells without changing their line count', () => {
    expect(formatSourceTranslation(comment('=begin\nFirst.\n  Second.\n=end'), '=begin\n第一行。\n第二行。\n=end'))
      .toEqual(['=begin', '第一行。', '  第二行。', '=end']);
    expect(formatSourceTranslation(comment('<#\n\tFirst.\n#>'), '<#\n第一行。\n#>'))
      .toEqual(['<#', '\t第一行。', '#>']);
  });

  it('normalizes CRLF without changing the source object', () => {
    const block = comment('/**\r\n\t * Hello.\r\n\t */', 1);
    const before = structuredClone(block);
    expect(formatSourceTranslation(block, '你好。\r\n更多说明。')).toEqual(['/**', '\t * 你好。 更多说明。', '\t */']);
    expect(block).toEqual(before);
  });

  it.each(['unknown syntax', '/**/', '/* */', '//\n// ', '/**\n *\n */'])('leaves unknown or bodyless %s comments unchanged', (raw) => {
    expect(formatSourceTranslation(comment(raw), '译文。')).toEqual([]);
  });

  it('leaves the source visible for empty or only-wrapped-empty translations', () => {
    expect(formatSourceTranslation(comment('/**\n * Hello.\n */'), ' \r\n\t')).toEqual([]);
    expect(formatSourceTranslation(comment('/**\n * Hello.\n */'), '/**\n *\n */')).toEqual([]);
    expect(formatSourceTranslation(comment('// Hello.'), '//')).toEqual([]);
  });

  it.each([
    '/* Outer /* Inner */ Remaining */',
    '/* Outer comment.\n   /* Inner comment. */\n   Remaining description. */',
    '/* Outer description.\n   /* Inner /* Deeper */ comment. */\n   Remaining description.\n */',
  ])('keeps the original shell for nested Rust comments parsed from source: %s', async (rawText) => {
    const parser = new CommentParser(createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm'));
    try {
      const blocks = await parser.parse(`${rawText}\nfn main() {}`, 'rust');
      expect(blocks).toHaveLength(1);
      expect(blocks[0].rawText).toBe(rawText);
      expect(formatSourceTranslation(blocks[0], '外层注释。\n内部注释。\n其余说明。')).toEqual([]);
      expect(blocks[0].rawText).toBe(rawText);
    } finally { parser.dispose(); }
  });

  it.each([
    ['/* Description. */', '说明。', ['/* 说明。 */']],
    ['/**\n * Description.\n * Remaining details.\n */', '说明。\n其余信息。', ['/**', ' * 说明。', ' * 其余信息。', ' */']],
  ] as const)('still replaces ordinary Rust block comments parsed from source: %s', async (rawText, translated, expected) => {
    const parser = new CommentParser(createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm'));
    try {
      const blocks = await parser.parse(`${rawText}\nfn main() {}`, 'rust');
      expect(blocks).toHaveLength(1);
      expect(formatSourceTranslation(blocks[0], translated)).toEqual(expected);
    } finally { parser.dispose(); }
  });
});
