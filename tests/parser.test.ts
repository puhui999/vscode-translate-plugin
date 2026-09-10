import { createRequire } from 'node:module';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL, Registry, type IGrammar, type StateStack } from 'vscode-textmate';
import { CommentParser } from '../src/parser/commentParser';
import { getGrammar, getLanguageScope, getSupportedLanguageIds } from '../src/parser/grammars';

const WASM_PATH = createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm');
const PARSER = new CommentParser(WASM_PATH);

afterAll(() => PARSER.dispose());
afterEach(() => vi.restoreAllMocks());

describe('bundled language coverage', () => {
  it.each(['javascript', 'typescript', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'kotlin', 'swift', 'dart'])(
    'recognizes line and block comments in %s',
    async (languageId) => {
      expect(PARSER.supportsLanguage(languageId)).toBe(true);
      const blocks = await PARSER.parse('// A line comment\n\n/* A block comment */', languageId);
      expect(blocks.map((block) => block.text)).toEqual(['A line comment', 'A block comment']);
      expect(blocks.every((block) => block.kind === 'standalone')).toBe(true);
    },
  );

  it.each(['python', 'html', 'xml', 'markdown', 'plaintext', 'unknown'])(
    'excludes %s without loading WASM or translating any text',
    async (languageId) => {
      const parser = new CommentParser('/does/not/exist.wasm');
      expect(parser.supportsLanguage(languageId)).toBe(false);
      expect(await parser.parse('# comment\n<!-- comment -->\n"""docstring"""\n// comment', languageId)).toEqual([]);
      parser.dispose();
    },
  );

  it('accepts standard aliases and resolves grammar dependencies', () => {
    expect(getLanguageScope('JS')).toBe(getLanguageScope('javascript'));
    expect(getLanguageScope('tsx')).toBe(getLanguageScope('typescriptreact'));
    expect(getSupportedLanguageIds()).toHaveLength(20);
    expect(getGrammar('source.js')).not.toBeNull();
    expect(getGrammar('not-a-bundled-scope')).toBeNull();
  });

  it.each(['javascriptreact', 'typescriptreact'])('recognizes JSX comments in %s', async (languageId) => {
    const [comment] = await PARSER.parse('const View = () => <div>{/* Accessible label */}</div>;', languageId);
    expect(comment.text).toBe('Accessible label');
    expect(comment.kind).toBe('inline');
  });

  it('recognizes PHP comments without translating HTML comments', async () => {
    const blocks = await PARSER.parse('<!-- Excluded -->\n<?php\n// PHP comment\n$x = "// literal"; # Hash comment\n?>', 'php');
    expect(blocks.map((block) => block.text)).toEqual(['PHP comment', 'Hash comment']);
    expect(blocks.map((block) => block.kind)).toEqual(['standalone', 'trailing']);
  });

  it('recognizes SQL line and block comments without translating quoted SQL', async () => {
    const blocks = await PARSER.parse("-- Query users\nSELECT '-- not a comment' /* Keep literals */;", 'sql');
    expect(blocks.map((block) => block.text)).toEqual(['Query users', 'Keep literals']);
    expect(blocks[1].kind).toBe('inline');
  });

  it('recognizes Shell hash comments and skips the shebang and strings', async () => {
    const blocks = await PARSER.parse('#!/usr/bin/env bash\n# Load settings\necho "# literal" # Print values', 'shellscript');
    expect(blocks.map((block) => block.text)).toEqual(['Load settings', 'Print values']);
  });

  it('recognizes Ruby line and block comments', async () => {
    const blocks = await PARSER.parse('# Ruby comment\nputs "# literal"\n=begin\nMulti line\n  indented example\n=end', 'ruby');
    expect(blocks.map((block) => block.text)).toEqual(['Ruby comment', 'Multi line\n  indented example']);
  });

  it.each(['css', 'scss'])('recognizes %s block comments and preserves content strings', async (languageId) => {
    const blocks = await PARSER.parse('/* Theme tokens */\na::after { content: "/* literal */"; }', languageId);
    expect(blocks.map((block) => block.text)).toEqual(['Theme tokens']);
  });

  it('recognizes SCSS line comments', async () => {
    expect((await PARSER.parse('// Brand color\n$brand: red;', 'scss'))[0].text).toBe('Brand color');
  });

  it('recognizes Vue script/style comments and excludes its HTML comments', async () => {
    const source = '<template>\n<!-- Excluded HTML comment -->\n<div>Hi</div>\n</template>\n<script lang="ts">\n// Vue script\nconst name = "// literal";\n</script>\n<style>\n/* Vue style */\n</style>';
    expect((await PARSER.parse(source, 'vue')).map((block) => block.text)).toEqual(['Vue script', 'Vue style']);
  });
});

describe('comment boundaries and locations', () => {
  it('merges adjacent standalone lines and separates blank/code boundaries', async () => {
    const source = '  // First sentence\n  // Second sentence\n\n// Another block\nconst value = 1;\n// Last block';
    const blocks = await PARSER.parse(source, 'typescript');
    expect(blocks.map((block) => block.text)).toEqual(['First sentence\nSecond sentence', 'Another block', 'Last block']);
    expect(blocks[0].rawText).toBe('// First sentence\n  // Second sentence');
    expect(blocks[0].start).toEqual({ line: 0, character: 2 });
    expect(blocks[0].end).toEqual({ line: 1, character: 20 });
  });

  it('distinguishes standalone, trailing and inline comments', async () => {
    const source = '// standalone\nconst a = 1; // trailing\ncall(/* inline */ value);\n/* before code */ call();';
    const blocks = await PARSER.parse(source, 'javascript');
    expect(blocks.map((block) => block.kind)).toEqual(['standalone', 'trailing', 'inline', 'inline']);
    expect(blocks[1].start).toEqual({ line: 1, character: 13 });
    expect(blocks[1].end).toEqual({ line: 1, character: 24 });
  });

  it('does not merge adjacent trailing comments or standalone/doc groups', async () => {
    const blocks = await PARSER.parse('a(); // First\nb(); // Second\n// ordinary\n/// documentation', 'typescript');
    expect(blocks.map((block) => block.kind)).toEqual(['trailing', 'trailing', 'standalone', 'documentation']);
    expect(blocks).toHaveLength(4);
  });

  it('keeps multiple touching block comments separate and classifies comment-only lines', async () => {
    const blocks = await PARSER.parse('/* First *//* Second */ // Third', 'javascript');
    expect(blocks.map((block) => block.text)).toEqual(['First', 'Second', 'Third']);
    expect(blocks.map((block) => block.kind)).toEqual(['standalone', 'standalone', 'standalone']);
    expect(blocks[1].start).toEqual({ line: 0, character: 11 });
    expect(blocks[1].end).toEqual({ line: 0, character: 23 });
  });

  it('keeps a multi-line block intact across blank lines', async () => {
    const source = '/* First\n\n * Second\n */';
    const [block] = await PARSER.parse(source, 'javascript');
    expect(block.rawText).toBe(source);
    expect(block.text).toBe('First\n\nSecond');
    expect(block.end).toEqual({ line: 3, character: 3 });
  });

  it('retains nested Rust block comments as one block', async () => {
    const source = '/* Outer\n/* Inner */\nOuter continuation */';
    const blocks = await PARSER.parse(source, 'rust');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].rawText).toBe(source);
    expect(blocks[0].text).toBe('Outer\n/* Inner */\nOuter continuation');
  });

  it('does not invent nesting in JavaScript comments', async () => {
    const blocks = await PARSER.parse('/* Outer /* literal opener */\nconst next = 1;', 'javascript');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].rawText).toBe('/* Outer /* literal opener */');
  });

  it('recognizes unterminated block comments up to EOF', async () => {
    const source = 'const value = 1;\n/* Open\n\n Still open';
    const [block] = await PARSER.parse(source, 'typescript');
    expect(block.rawText).toBe('/* Open\n\n Still open');
    expect(block.end).toEqual({ line: 3, character: 11 });
  });

  it('handles CRLF and lone CR with exact exclusive positions', async () => {
    const source = '// First\r\n// Second\r\n\r\n/* Third\rFourth */';
    const blocks = await PARSER.parse(source, 'typescript');
    expect(blocks.map((block) => block.text)).toEqual(['First\nSecond', 'Third\nFourth']);
    expect(blocks[0].rawText).toBe('// First\r\n// Second');
    expect(blocks[0].end).toEqual({ line: 1, character: 9 });
    expect(blocks[1].start).toEqual({ line: 3, character: 0 });
    expect(blocks[1].end).toEqual({ line: 4, character: 9 });
  });

  it('returns no blocks for empty files, comment delimiters or code-only documents', async () => {
    expect(await PARSER.parse('', 'typescript')).toEqual([]);
    expect(await PARSER.parse('//\n//   \n\n/**/\n/*\n *\n */', 'typescript')).toEqual([]);
    expect(await PARSER.parse('const value = 1;\n\nvalue++;', 'typescript')).toEqual([]);
  });

  it('uses UTF-16 character offsets and retains Unicode comment content', async () => {
    const source = 'const emoji = "😀"; // 日本語と中文';
    const [block] = await PARSER.parse(source, 'javascript');
    expect(block.start.character).toBe(source.indexOf('//'));
    expect(block.end.character).toBe(source.length);
    expect(block.text).toBe('日本語と中文');
  });

  it('keeps IDs stable when unrelated code changes line positions', async () => {
    const source = '// Same text\nconst value = 1;\n// Same text';
    const initial = await PARSER.parse(source, 'typescript');
    const shifted = await PARSER.parse(`const inserted = 0;\n${source}`, 'typescript');
    expect(initial.map((block) => block.id)).toEqual(shifted.map((block) => block.id));
    expect(initial[0].id).not.toBe(initial[1].id);
    expect((await PARSER.parse('// Changed text', 'typescript'))[0].id).not.toBe(initial[0].id);
  });
});

describe('language context and documentation', () => {
  it('skips URL strings, regex literals, escaped strings and template text', async () => {
    const source = [
      'const url = "https://example.com/a/*path*/";',
      String.raw`const pattern = /https?:\/\/[^/]+/;`,
      String.raw`const quoted = "escaped \" // still string";`,
      'const template = `literal // text /* more */`;',
      '// Real comment',
    ].join('\n');
    expect((await PARSER.parse(source, 'javascript')).map((block) => block.text)).toEqual(['Real comment']);
  });

  it('keeps multi-line string state before an apparent comment', async () => {
    const source = 'const template = `first line\n// not a comment\n/* not a comment */\nlast line`;\n// Actual comment';
    expect((await PARSER.parse(source, 'javascript')).map((block) => block.text)).toEqual(['Actual comment']);
  });

  it('does not translate embedded SQL comments inside a Ruby heredoc string', async () => {
    const source = 'query = <<~SQL\n-- This is string content\nSELECT 1;\nSQL\n# Ruby explanation';
    expect((await PARSER.parse(source, 'ruby')).map((block) => block.text)).toEqual(['Ruby explanation']);
  });

  it('does not mistake Shell parameter expansion for a hash comment', async () => {
    const source = 'echo "${value#prefix}"\n# Shell explanation';
    expect((await PARSER.parse(source, 'shellscript')).map((block) => block.text)).toEqual(['Shell explanation']);
  });

  it('does not translate comment markers in Rust raw strings', async () => {
    const source = 'let raw = r#"/* string content */ // string content"#;\n// Rust explanation';
    expect((await PARSER.parse(source, 'rust')).map((block) => block.text)).toEqual(['Rust explanation']);
  });

  it('recognizes real comments in template interpolation', async () => {
    const source = 'const template = `${/* compute value */ value}`;';
    const [block] = await PARSER.parse(source, 'javascript');
    expect(block.text).toBe('compute value');
    expect(block.kind).toBe('inline');
  });

  it('preserves documentation tags, code fences, identifiers and indentation', async () => {
    const source = '/**\n * Returns userId unchanged.\n * @param userId User identifier\n * @returns Promise<User>\n * ```ts\n * if (userId) {\n *   return loadUser(userId);\n * }\n * ```\n */\nfunction loadUser(userId: string) {}';
    const [block] = await PARSER.parse(source, 'typescript');
    expect(block.kind).toBe('documentation');
    expect(block.text).toBe('Returns userId unchanged.\n@param userId User identifier\n@returns Promise<User>\n```ts\nif (userId) {\n  return loadUser(userId);\n}\n```');
    expect(block.rawText).toBe(source.slice(0, source.indexOf('\nfunction')));
  });

  it('preserves XML tags in C# documentation comments', async () => {
    const source = '/// <summary>Read userId.</summary>\n/// <param name="userId">User identifier</param>\nclass User {}';
    const [block] = await PARSER.parse(source, 'csharp');
    expect(block.kind).toBe('documentation');
    expect(block.text).toBe('<summary>Read userId.</summary>\n<param name="userId">User identifier</param>');
  });

  it('classifies documentation with code around it by placement', async () => {
    const blocks = await PARSER.parse('call(/** argument */ value);\ncall(); /** trailing docs */', 'typescript');
    expect(blocks.map((block) => block.kind)).toEqual(['inline', 'trailing']);
  });

  it('dedents undecorated block text without flattening examples', async () => {
    const [block] = await PARSER.parse('/*\n  Description\n    example();\n*/', 'typescript');
    expect(block.text).toBe('Description\n  example();');
  });
});

describe('cancellation and parser lifecycle', () => {
  it('parses the offline demo when ordinary generic TypeScript precedes its first comment', async () => {
    const source = [
      'const cache = new Map<string, object>();',
      '',
      '/**',
      ' * Load the user profile from the local cache.',
      ' * @param userId The unique user identifier.',
      ' */',
      'async function loadProfile(userId: string) {',
      '  // Return the cached profile when available.',
      '  // This avoids an unnecessary network request.',
      '  const profile = cache.get(userId);',
      '  const timeout = 3000; // Request timeout in milliseconds.',
      '  return profile;',
      '}',
      '',
    ].join('\n');
    const parser = new CommentParser(WASM_PATH);
    try {
      const blocks = await parser.parse(source, 'typescript');
      expect(blocks.map((block) => block.kind)).toEqual(['documentation', 'standalone', 'trailing']);
      expect(blocks[0].text).toContain('@param userId');
      expect(blocks[1].text).toContain('unnecessary network request');
      expect(blocks[2].text).toBe('Request timeout in milliseconds.');
    } finally {
      parser.dispose();
    }
  });

  it('retries a budget-exhausted line once from its original state and discards partial tokens', async () => {
    const firstLine = 'const cache = new Map<string, object>();';
    const commentLine = '// Actual comment';
    const partialState = { ...INITIAL, depth: 99 } as StateStack;
    const completedState = { ...INITIAL, depth: 1 } as StateStack;
    const tokenizeLine = vi.fn()
      .mockReturnValueOnce({
        stoppedEarly: true,
        ruleStack: partialState,
        tokens: [{ startIndex: 0, endIndex: firstLine.length, scopes: ['source.ts', 'comment.line.ts'] }],
      })
      .mockReturnValueOnce({
        stoppedEarly: false,
        ruleStack: completedState,
        tokens: [{ startIndex: 0, endIndex: firstLine.length, scopes: ['source.ts'] }],
      })
      .mockReturnValueOnce({
        stoppedEarly: false,
        ruleStack: INITIAL,
        tokens: [{ startIndex: 0, endIndex: commentLine.length, scopes: ['source.ts', 'comment.line.ts'] }],
      });
    vi.spyOn(Registry.prototype, 'loadGrammar').mockResolvedValue({ tokenizeLine } as unknown as IGrammar);
    const parser = new CommentParser(WASM_PATH);
    try {
      const blocks = await parser.parse(`${firstLine}\n${commentLine}`, 'typescript');
      expect(blocks.map((block) => block.text)).toEqual(['Actual comment']);
      expect(tokenizeLine.mock.calls).toEqual([
        [firstLine, INITIAL, 50],
        [firstLine, INITIAL, 500],
        [commentLine, completedState, 50],
      ]);
    } finally {
      parser.dispose();
    }
  });

  it('rejects a line that still exceeds the retry budget without continuing to later lines', async () => {
    const tokenizeLine = vi.fn().mockReturnValue({
      stoppedEarly: true,
      ruleStack: INITIAL,
      tokens: [],
    });
    vi.spyOn(Registry.prototype, 'loadGrammar').mockResolvedValue({ tokenizeLine } as unknown as IGrammar);
    const parser = new CommentParser(WASM_PATH);
    try {
      await expect(parser.parse('complex line\n// Must not continue', 'typescript'))
        .rejects.toThrow('Comment parsing exceeded the time limit on line 1.');
      expect(tokenizeLine).toHaveBeenCalledTimes(2);
      expect(tokenizeLine.mock.calls[1]).toEqual(['complex line', INITIAL, 500]);
    } finally {
      parser.dispose();
    }
  });

  it('honors cancellation before retrying a budget-exhausted line', async () => {
    const controller = new AbortController();
    const tokenizeLine = vi.fn().mockImplementation(() => {
      controller.abort();
      return { stoppedEarly: true, ruleStack: INITIAL, tokens: [] };
    });
    vi.spyOn(Registry.prototype, 'loadGrammar').mockResolvedValue({ tokenizeLine } as unknown as IGrammar);
    const parser = new CommentParser(WASM_PATH);
    try {
      await expect(parser.parse('cold line', 'typescript', controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(tokenizeLine).toHaveBeenCalledTimes(1);
    } finally {
      parser.dispose();
    }
  });

  it('honors cancellation before initialization', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(PARSER.parse('// ignored', 'typescript', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('yields during large files so pending parses can be cancelled', async () => {
    const controller = new AbortController();
    const pending = PARSER.parse('const value = 1;\n'.repeat(2000), 'javascript', controller.signal);
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not leak grammar state between independent or concurrent files', async () => {
    const [unclosed, normal] = await Promise.all([
      PARSER.parse('/* Unclosed', 'typescript'),
      PARSER.parse('const value = "// text";\n// Real comment', 'typescript'),
    ]);
    expect(unclosed[0].text).toBe('Unclosed');
    expect(normal.map((block) => block.text)).toEqual(['Real comment']);
  });

  it('can release and recreate its grammar registry', async () => {
    const parser = new CommentParser(WASM_PATH);
    expect((await parser.parse('// first', 'typescript'))[0].text).toBe('first');
    parser.dispose();
    expect((await parser.parse('// second', 'typescript'))[0].text).toBe('second');
    parser.dispose();
  });
});
