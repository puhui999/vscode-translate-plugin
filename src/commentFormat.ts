import type { CommentBlock } from './parser/commentParser';

interface BodyLine {
  prefix: string;
  text: string;
}

interface CommentLayout {
  family: string;
  before: string[];
  after: string[];
  opening: string;
  closing: string;
  rows: BodyLine[];
  defaultPrefix: string;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function removeOuterIndent(rawText: string, character: number): string {
  const lines = normalizeNewlines(rawText).split('\n');
  const continuation = lines.slice(1).filter((line) => line.trim());
  if (!continuation.length || character <= 0) return lines.join('\n');
  const common = Math.min(...continuation.map((line) => line.match(/^[\t ]*/)![0].length));
  // A star's customary leading space belongs to the comment, not its container.
  const reserve = continuation.every((line) => /^[\t ]+\*/.test(line)) ? 1 : 0;
  const external = common >= character ? character : Math.max(0, common - reserve);
  return lines.map((line, index) => index === 0 ? line : line.slice(Math.min(external, line.match(/^[\t ]*/)![0].length))).join('\n');
}

function parseLayout(rawText: string): CommentLayout | undefined {
  const lines = rawText.split('\n');
  const lineMarker = rawText.match(/^(\/\/[/!]?|#|--)/)?.[0];
  if (lineMarker) {
    const rows: BodyLine[] = [];
    for (const line of lines) {
      const match = line.match(/^([\t ]*)(\/\/[/!]?|#|--)([\t ]?)(.*)$/);
      if (!match) return undefined;
      rows.push({ prefix: match[1] + match[2] + match[3], text: match[4] });
    }
    return { family: lineMarker, before: [], after: [], opening: '', closing: '', rows, defaultPrefix: rows.find((row) => row.text.trim())?.prefix ?? rows[0].prefix };
  }

  const opener = rawText.startsWith('/*')
    ? rawText.startsWith('/*!') ? '/*!' : rawText.startsWith('/**') && rawText[3] !== '/' ? '/**' : '/*'
    : /^=begin\b/.test(rawText) ? '=begin' : rawText.startsWith('<#') ? '<#' : rawText.startsWith('<!--') ? '<!--' : undefined;
  if (!opener) return undefined;
  const closer = opener === '=begin' ? '=end' : opener === '<#' ? '#>' : opener === '<!--' ? '-->' : '*/';
  const family = opener === '=begin' ? 'ruby' : opener === '<#' ? 'powershell' : opener === '<!--' ? 'markup' : 'block';
  const layout: CommentLayout = { family, before: [], after: [], opening: '', closing: '', rows: [], defaultPrefix: '' };
  const body = [...lines];
  body[0] = body[0].slice(opener.length);
  if (body.length > 1 && !body[0].trim()) {
    layout.before.push(lines[0]);
    body.shift();
  } else {
    const gap = body[0].match(/^[\t ]?/)![0];
    layout.opening = opener + gap;
    body[0] = body[0].slice(gap.length);
  }
  const last = body.length - 1;
  const closingMatch = body[last]?.match(family === 'ruby' ? /^([\t ]*)=end[\t ]*$/ : /^(.*?)([\t ]*)(\*\/|#>|-->)[\t ]*$/);
  if (closingMatch && (family === 'ruby' || closingMatch[3] === closer)) {
    if (family === 'ruby' || !closingMatch[1].trim()) {
      layout.after.push(body[last]);
      body.pop();
    } else {
      layout.closing = closingMatch[2] + closer;
      body[last] = closingMatch[1];
    }
  }
  // Empty compact blocks (/**/, /* */) still keep their closing marker inline.
  if (!body.length && !layout.before.length && layout.after.length) {
    layout.closing = layout.after.pop()!;
    body.push('');
  }
  for (const [index, text] of body.entries()) {
    const star = family === 'block' && !(index === 0 && layout.opening) ? text.match(/^([\t ]*\*[\t ]?)(.*)$/) : undefined;
    layout.rows.push(star ? { prefix: star[1], text: star[2] } : { prefix: '', text });
  }
  layout.defaultPrefix = layout.rows.find((row) => row.prefix && row.text.trim())?.prefix
    ?? layout.rows.find((row) => row.prefix)?.prefix ?? '';
  return layout;
}

function retainIndent(text: string, source: string): string {
  return /^[\t ]/.test(text) ? text : source.match(/^[\t ]*/)![0] + text;
}

function renderBody(layout: CommentLayout, translated: string[]): string[] {
  const originals = layout.rows.filter((row) => row.text.trim());
  const meaningful = translated.filter((line) => line.trim());
  if (originals.length !== meaningful.length) {
    const commonIndent = originals.length
      ? Math.min(...originals.map((row) => row.text.match(/^[\t ]*/)![0].length)) : 0;
    const indentation = originals[0]?.text.slice(0, commonIndent) ?? '';
    return translated.map((line, index) => {
      const prefix = index === 0 && layout.opening ? layout.rows[0]?.prefix ?? '' : layout.defaultPrefix;
      return line.trim() ? prefix + retainIndent(line, indentation) : prefix.trimEnd() + line;
    });
  }

  // Equal body counts permit positional formatting, without interpreting prose.
  // Keep the larger blank-line gap so neither source spacing nor new lines vanish.
  const rendered: string[] = [];
  let originalIndex = 0;
  let translatedIndex = 0;
  while (originalIndex < layout.rows.length || translatedIndex < translated.length) {
    const blanks: BodyLine[] = [];
    while (originalIndex < layout.rows.length && !layout.rows[originalIndex].text.trim()) {
      blanks.push(layout.rows[originalIndex++]);
    }
    const extraBlanks: string[] = [];
    while (translatedIndex < translated.length && !translated[translatedIndex].trim()) {
      extraBlanks.push(translated[translatedIndex++]);
    }
    for (let index = 0; index < Math.max(blanks.length, extraBlanks.length); index += 1) {
      const original = blanks[index];
      rendered.push(original ? original.prefix + original.text : layout.defaultPrefix.trimEnd() + extraBlanks[index]);
    }
    const original = layout.rows[originalIndex++];
    const translation = translated[translatedIndex++];
    if (original && translation !== undefined) rendered.push(original.prefix + retainIndent(translation, original.text));
  }
  return rendered;
}

/** Restores the original comment shell around translated body text without editing either input. */
export function formatTranslation(block: CommentBlock, translation: string): string {
  const normalized = normalizeNewlines(translation);
  if (!normalized.trim()) return '';
  const layout = parseLayout(removeOuterIndent(block.rawText, block.start.character));
  if (!layout) return normalized;
  const wrapped = parseLayout(removeOuterIndent(normalized.trim(), block.start.character));
  const body = wrapped?.family === layout.family
    ? wrapped.rows.map((row) => row.text).join('\n') : normalized;
  const rendered = renderBody(layout, body.split('\n'));
  if (!rendered.length) rendered.push('');
  rendered[0] = layout.opening + rendered[0];
  rendered[rendered.length - 1] += layout.closing;
  return [...layout.before, ...rendered, ...layout.after].join('\n');
}

function translationBreaks(text: string): number[] {
  // Keep documentation declarations and inline syntax intact when redistributing prose.
  // A long declaration may occupy one long source line rather than lose its operands.
  const protectedRanges = [...text.matchAll(/^[\t ]*@[A-Za-z][\w-]*[^\n]*|<\/?[A-Za-z][^>]*>|\{@[^\n]*?\}|`+[^`\n]*`+/gm)]
    .map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const boundaries = new Set<number>();
  for (const segment of segmenter.segment(text)) {
    const end = segment.index + segment.segment.length;
    if (protectedRanges.some((range) => end > range.start && end < range.end)) continue;
    // Attach closing punctuation to its word, including CJK sentence punctuation.
    if (/^[,.;:!?，。；：！？、)\]}>”’]/u.test(text.slice(end))) continue;
    boundaries.add(end);
  }
  boundaries.add(text.length);
  return [...boundaries].sort((left, right) => left - right);
}

function distributeSourceBody(translated: string[], count: number): string[] {
  const meaningful = translated.map((line) => line.trim()).filter(Boolean);
  if (meaningful.length === count) return meaningful;
  if (count === 1) return [meaningful.join(' ')];
  const text = meaningful.join('\n');
  const boundaries = translationBreaks(text);
  const result: string[] = [];
  let start = 0;
  for (let row = 0; row < count; row += 1) {
    while (/\s/u.test(text[start] ?? '') && start < text.length) start += 1;
    if (start >= text.length) { result.push(''); continue; }
    if (row === count - 1) { result.push(text.slice(start).replace(/\n/g, ' ')); break; }
    const remaining = count - row;
    const available = boundaries.filter((end) => end > start && text.slice(start, end).trim());
    // Leave one segment for each later line when enough word boundaries exist.
    const limit = Math.max(1, available.length - remaining + 1);
    const choices = available.slice(0, limit);
    const desiredLength = (text.length - start) / remaining;
    const score = (end: number): number => {
      const sentenceEnd = /[.!?。！？；;]\s*$/u.test(text.slice(start, end));
      const lineEnd = text[end] === '\n' || text[end - 1] === '\n';
      return Math.abs(end - start - desiredLength) - desiredLength * (lineEnd ? 0.3 : sentenceEnd ? 0.2 : 0);
    };
    const end = choices.reduce((best, candidate) => score(candidate) < score(best) ? candidate : best);
    result.push(text.slice(start, end).trim().replace(/\n/g, ' '));
    start = end;
  }
  return result;
}

/** Fits translated prose into the source comment's existing physical lines, preserving its exact shell. */
export function formatSourceTranslation(block: CommentBlock, translation: string): readonly string[] {
  const normalized = normalizeNewlines(translation);
  if (!normalized.trim()) return [];
  // rawText starts at the comment marker; continuation lines retain the source's outer indentation.
  const originalLines = normalizeNewlines(block.rawText).split('\n');
  const layout = parseLayout(originalLines.join('\n'));
  if (!layout) return [];
  // The outer layout does not describe nested delimiters. Keep their source
  // visible rather than replacing an inner comment shell as ordinary prose.
  if (layout.family === 'block' && layout.rows.some((row) => /\/\*|\*\//.test(row.text))) return [];
  const slots = layout.rows.flatMap((row, index) => {
    if (!row.text.trim()) return [];
    const leading = row.text.match(/^[\t ]*/)![0].length;
    return [{
      line: layout.before.length + index,
      start: (index === 0 ? layout.opening.length : 0) + row.prefix.length + leading,
      length: row.text.trimEnd().length - leading,
    }];
  });
  if (!slots.length) return [];
  const wrapped = parseLayout(normalized.trim());
  const translated = wrapped?.family === layout.family ? wrapped.rows.map((row) => row.text) : normalized.split('\n');
  if (!translated.some((line) => line.trim())) return [];
  const assigned = distributeSourceBody(translated, slots.length);
  const result = [...originalLines];
  for (const [index, slot] of slots.entries()) {
    const original = originalLines[slot.line];
    result[slot.line] = original.slice(0, slot.start) + assigned[index] + original.slice(slot.start + slot.length);
  }
  return result;
}
