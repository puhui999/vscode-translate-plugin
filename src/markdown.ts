import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

/** A complete Markdown block with UTF-16 offsets and zero-based, end-exclusive line bounds. */
export interface MarkdownChunk {
  id: string;
  text: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

interface MarkdownEnvironment {
  references?: Record<string, { href: string; title: string }>;
  referenceUses?: Array<[string, string, boolean]>;
}

interface ParsedMarkdown {
  tokens: Token[];
  environment: MarkdownEnvironment;
  lineStarts: number[];
  frontmatterEnd: number;
}

/** Version included in Markdown cache keys whenever the translation contract changes. */
export const MARKDOWN_PROMPT_VERSION = 'markdown-1';

const LINE_BREAK = /\r\n|\r|\n/g;
const PROTECTED_BLOCK_TYPES = new Set(['fence', 'code_block', 'html_block', 'hr']);
const PROTECTED_TOKEN_TYPES = new Set(['code_inline', 'fence', 'code_block', 'html_inline', 'html_block']);
const MARKDOWN = new MarkdownIt({ html: true, linkify: true, typographer: false });

// Unresolved references become ordinary text in isolated blocks. Record reference
// identifiers before the normal link rule so cross-block targets remain protected.
MARKDOWN.inline.ruler.before('link', 'translation_reference_guard', (state, silent) => {
  if (silent) return false;
  const image = state.src[state.pos] === '!' && state.src[state.pos + 1] === '[';
  const start = state.pos + (image ? 1 : 0);
  if (state.src[start] !== '[') return false;
  const labelEnd = state.md.helpers.parseLinkLabel(state, start, !image);
  if (labelEnd < 0 || state.src[labelEnd + 1] === '(') return false;
  const visibleLabel = state.src.slice(start + 1, labelEnd);
  let label = visibleLabel;
  let mode = 'shortcut';
  if (state.src[labelEnd + 1] === '[') {
    const referenceEnd = state.md.helpers.parseLinkLabel(state, labelEnd + 1);
    if (referenceEnd >= 0) {
      const explicitLabel = state.src.slice(labelEnd + 2, referenceEnd);
      label = explicitLabel || visibleLabel;
      mode = explicitLabel ? 'full' : 'collapsed';
    }
  }
  const environment = state.env as MarkdownEnvironment;
  (environment.referenceUses ??= []).push([mode, state.md.utils.normalizeReference(label), image]);
  return false;
});

/** Splits natural-language Markdown into complete blocks that fit one serialized request item. */
export function parseMarkdown(source: string, maxBatchChars: number): MarkdownChunk[] {
  if (!Number.isSafeInteger(maxBatchChars) || maxBatchChars < 64) {
    throw new RangeError('Markdown 批次字符上限必须是不小于 64 的整数。');
  }
  const parsed = parseSource(source);
  const chunks: MarkdownChunk[] = [];
  for (let index = 0; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index];
    if (!token.map || token.level !== 0 || token.nesting < 0 || PROTECTED_BLOCK_TYPES.has(token.type)) {
      continue;
    }
    let endIndex = index + 1;
    if (token.nesting === 1) {
      while (endIndex < parsed.tokens.length && !(parsed.tokens[endIndex].level === 0 && parsed.tokens[endIndex].nesting === -1)) {
        endIndex += 1;
      }
    }
    if (!hasNaturalLanguage(parsed.tokens.slice(index, endIndex + 1))) {
      continue;
    }
    const startLine = token.map[0];
    let endLine = token.map[1];
    while (endLine > startLine + 1 && !source.slice(
      parsed.lineStarts[endLine - 1], parsed.lineStarts[endLine] ?? source.length
    ).trim()) endLine -= 1;
    const start = parsed.lineStarts[startLine] ?? source.length;
    let end = parsed.lineStarts[endLine] ?? source.length;
    // Separating whitespace belongs to the source, never to an AI response.
    while (end > start && /[\r\n]/.test(source[end - 1])) end -= 1;
    if (end <= start || start < parsed.frontmatterEnd) continue;
    const text = source.slice(start, end);
    const id = `md_${createHash('sha256').update(`${start}:${text}`).digest('hex').slice(0, 24)}`;
    if (JSON.stringify({ comments: [{ id, text }] }).length > maxBatchChars) {
      throw new Error(`Markdown 第 ${startLine + 1}–${endLine} 行的完整段落、列表或表格超过 maxBatchChars=${maxBatchChars} 的请求限制。请提高批次字符上限后重试；为保留文档结构，该内容不会被截断。`);
    }
    chunks.push({ id, text, start, end, startLine, endLine });
  }
  return chunks;
}

/** Applies valid cached or fresh translations by source offsets, preserving all untouched bytes. */
export function applyMarkdownTranslations(
  source: string,
  chunks: readonly MarkdownChunk[],
  translations: ReadonlyMap<string, string>
): string {
  let cursor = 0;
  let result = '';
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end) || chunk.start < cursor ||
      chunk.end <= chunk.start || chunk.end > source.length || seen.has(chunk.id) ||
      source.slice(chunk.start, chunk.end) !== chunk.text) {
      throw new Error('Markdown 原文已变化或分块范围无效，请重新扫描文档后重试。');
    }
    seen.add(chunk.id);
    const translation = translations.get(chunk.id);
    let replacement = chunk.text;
    if (translation !== undefined) {
      const originalSuffix = chunk.text.match(/[\t ]+$/)?.[0] ?? '';
      const normalized = translation.trimEnd() + originalSuffix;
      if (!normalized.trim() || !preservesMarkdownStructure(chunk.text, normalized)) {
        throw new Error(`Markdown 第 ${chunk.startLine + 1} 行的译文改变了文档结构、代码或链接，已拒绝应用。`);
      }
      replacement = restoreLineEndings(chunk.text, normalized);
    }
    result += source.slice(cursor, chunk.start) + replacement;
    cursor = chunk.end;
  }
  result += source.slice(cursor);
  if (!preservesMarkdownStructure(source, result)) {
    throw new Error('合并后的 Markdown 结构或引用链接与原文不一致，已拒绝应用。');
  }
  return result;
}

/** Checks Markdown structure, line layout, protected code, HTML and link destinations. */
export function preservesMarkdownStructure(source: string, translation: string): boolean {
  try {
    const before = parseSource(source);
    const after = parseSource(translation);
    if (countLineBreaks(source) !== countLineBreaks(translation)) return false;
    if (normalizeLineEndings(source.slice(0, before.frontmatterEnd)) !==
      normalizeLineEndings(translation.slice(0, after.frontmatterEnd))) return false;
    return JSON.stringify(structureSignature(source, before)) === JSON.stringify(structureSignature(translation, after));
  } catch {
    return false;
  }
}

function parseSource(source: string): ParsedMarkdown {
  const lineStarts = [0];
  for (const match of source.matchAll(LINE_BREAK)) {
    lineStarts.push(match.index + match[0].length);
  }
  const frontmatterEnd = findFrontmatterEnd(source, lineStarts);
  const masked = source.slice(0, frontmatterEnd).replace(/[^\r\n]/g, ' ') + source.slice(frontmatterEnd);
  const environment: MarkdownEnvironment = {};
  return { tokens: MARKDOWN.parse(masked, environment), environment, lineStarts, frontmatterEnd };
}

function findFrontmatterEnd(source: string, lineStarts: readonly number[]): number {
  const first = source.slice(0, lineStarts[1] ?? source.length).replace(/^\uFEFF/, '').trimEnd();
  if (first !== '---' && first !== '+++') return 0;
  for (let index = 1; index < lineStarts.length; index += 1) {
    const line = source.slice(lineStarts[index], lineStarts[index + 1] ?? source.length).trimEnd();
    if (line === first || (first === '---' && line === '...')) {
      return lineStarts[index + 1] ?? source.length;
    }
  }
  return 0;
}

function hasNaturalLanguage(tokens: readonly Token[]): boolean {
  let automaticLinkDepth = 0;
  for (const token of tokens) {
    if (token.type === 'link_open' && token.info === 'auto') automaticLinkDepth += 1;
    if (token.type === 'link_close' && token.info === 'auto') automaticLinkDepth -= 1;
    if (token.type === 'text' && automaticLinkDepth === 0 && /\p{L}/u.test(token.content)) return true;
    if (token.children && hasNaturalLanguage(token.children)) return true;
  }
  return false;
}

function structureSignature(source: string, parsed: ParsedMarkdown): unknown {
  const signature = (tokens: readonly Token[]): unknown[] => {
    let automaticLinkDepth = 0;
    return tokens.map((token) => {
      if (token.type === 'link_open' && token.info === 'auto') automaticLinkDepth += 1;
      const protectedContent = PROTECTED_TOKEN_TYPES.has(token.type) || (token.type === 'text' && automaticLinkDepth > 0);
      const protectedSource = token.map && PROTECTED_BLOCK_TYPES.has(token.type)
        ? source.slice(parsed.lineStarts[token.map[0]], parsed.lineStarts[token.map[1]] ?? source.length) : undefined;
      const item = [
        token.type, token.tag, token.nesting, token.level, token.hidden, token.markup, token.info,
        token.map,
        token.attrs?.map(([name, value]) => [name, name === 'alt' || name === 'title' ? Boolean(value) : value]),
        protectedContent ? token.content : undefined,
        protectedSource === undefined ? undefined : normalizeLineEndings(protectedSource),
        token.children ? signature(token.children) : undefined
      ];
      if (token.type === 'link_close' && token.info === 'auto') automaticLinkDepth -= 1;
      return item;
    });
  };
  return {
    tokens: signature(parsed.tokens),
    references: Object.entries(parsed.environment.references ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    referenceUses: parsed.environment.referenceUses ?? [],
    // markdown-it silently discards excess body cells. Preserve raw delimiters too.
    tableDelimiters: parsed.tokens.filter((token) => token.type === 'table_open' && token.map).map((token) =>
      Array.from({ length: token.map![1] - token.map![0] }, (_, index) => {
        const line = token.map![0] + index;
        return (source.slice(parsed.lineStarts[line], parsed.lineStarts[line + 1] ?? source.length)
          .match(/(?<!\\)\|/g) ?? []).length;
      })
    ),
    definitions: [...source.matchAll(/^(?:[\t ]*>[\t ]*)*[\t ]*(?:[-+*][\t ]+|\d+[.)][\t ]+)?\[[^\]\r\n]+\]:[^\r\n]*/gm)].map((match) => match[0])
  };
}

function countLineBreaks(value: string): number {
  return [...value.matchAll(LINE_BREAK)].length;
}

function normalizeLineEndings(value: string): string {
  return value.replace(LINE_BREAK, '\n');
}

function restoreLineEndings(source: string, translation: string): string {
  const endings = [...source.matchAll(LINE_BREAK)].map((match) => match[0]);
  let index = 0;
  return translation.replace(LINE_BREAK, () => endings[index++] ?? '\n');
}
