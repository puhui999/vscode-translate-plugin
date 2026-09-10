import { describe, expect, it } from 'vitest';
import { formatTranslation } from '../src/commentFormat';
import type { CommentBlock } from '../src/parser/commentParser';

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
