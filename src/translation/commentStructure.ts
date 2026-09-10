const PARAMETER_TAGS = new Set(['param', 'arg', 'argument', 'property', 'prop', 'tparam', 'typeparam']);
const REFERENCE_TAGS = new Set(['throws', 'exception', 'see', 'link', 'augments', 'extends', 'implements', 'memberof', 'mixes', 'mixin', 'lends', 'requires', 'this']);
const NAMED_TYPE_TAGS = new Set(['typedef', 'callback']);
const RETURN_TYPE_TAGS = new Set(['return', 'returns', 'yield', 'yields', 'type', 'enum', 'var']);
const TYPE_EXPRESSION_TAGS = new Set([...PARAMETER_TAGS, ...NAMED_TYPE_TAGS, ...RETURN_TYPE_TAGS, 'throws', 'exception', 'template', 'augments', 'extends', 'implements', 'this']);
const INLINE_TAGS = new Set(['link', 'linkplain', 'linkcode', 'code', 'literal', 'value', 'inheritdoc']);
const SIMPLE_TYPES = /^(?:any|array|bigint|bool|boolean|byte|callable|char|double|float|int|integer|iterable|long|mixed|never|null|number|object|resource|self|short|static|string|symbol|unknown|void)$/i;

interface Token {
  text: string;
  end: number;
}

/** Checks recognizable documentation structure without aligning translated prose or lines. */
export function preservesCommentStructure(source: string, translation: string): boolean {
  return JSON.stringify(documentSignatures(source)) === JSON.stringify(documentSignatures(translation)) &&
    JSON.stringify(inlineSignatures(source)) === JSON.stringify(inlineSignatures(translation)) &&
    JSON.stringify(markupSignatures(source)) === JSON.stringify(markupSignatures(translation));
}

function documentSignatures(text: string): string[][] {
  const signatures: string[][] = [];
  // Only line-leading tags with a whitespace/direction boundary qualify; email addresses do not.
  const tags = /^[\t ]*@([A-Za-z][A-Za-z0-9_-]*)(?=[\t \[]|$)([^\r\n]*)/gm;
  for (const match of text.matchAll(tags)) {
    const originalTag = match[1];
    const tag = originalTag.toLowerCase();
    // Unknown custom documentation tags retain their names without guessing their operand grammar.
    const signature = [`@${originalTag}`];
    let rest = match[2].trim();
    if (PARAMETER_TAGS.has(tag)) {
      const direction = rest.match(/^\[(?:in|out)(?:[\t ]*,[\t ]*(?:in|out))?\](?=\s|$)/);
      if (direction) { signature.push(direction[0]); rest = rest.slice(direction[0].length).trimStart(); }
    }
    const type = TYPE_EXPRESSION_TAGS.has(tag) && rest.startsWith('{') ? delimitedToken(rest, 0, '{', '}') : undefined;
    if (type) {
      signature.push(type.text);
      rest = rest.slice(type.end).trimStart();
    }

    if (PARAMETER_TAGS.has(tag)) {
      const first = atom(rest);
      if (first) {
        signature.push(first.text);
        const second = atom(rest.slice(first.end).trimStart());
        // PHPDoc places an unbraced type before a $parameter name.
        if (!type && second && /^(?:\.\.\.)?\$[A-Za-z_]/.test(second.text)) signature.push(second.text);
      }
    } else if (tag === 'template') {
      const parameters = rest.match(/^[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*/);
      if (parameters) signature.push(parameters[0].replace(/\s/g, ''));
    } else if (NAMED_TYPE_TAGS.has(tag)) {
      const name = atom(rest);
      if (name) signature.push(name.text);
    } else if (REFERENCE_TAGS.has(tag) && !type) {
      // A @see quoted label or HTML link is prose/markup, not a Java-style symbol target.
      if (!/^["'<]/.test(rest) && !rest.startsWith('{@')) {
        const target = atom(rest);
        if (target) signature.push(target.text);
      }
    } else if (RETURN_TYPE_TAGS.has(tag) && !type) {
      const candidate = atom(rest);
      // Unbraced return prose is ambiguous; protect only recognizable type syntax.
      if (candidate && (SIMPLE_TYPES.test(candidate.text) || /[\\<>[\]|]/.test(candidate.text))) {
        signature.push(candidate.text);
      }
    }
    signatures.push(signature);
  }
  return signatures;
}

function markupSignatures(text: string): string[] {
  // Preserve markup in HTML/XML comment bodies and C#/Java documentation alike.
  // Requiring the tag name directly after '<' avoids interpreting ordinary "a < b" comparisons as markup.
  return [...text.matchAll(/<\/?[A-Za-z][A-Za-z0-9_.:-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g)]
    .map((match) => match[0]);
}

function inlineSignatures(text: string): string[][] {
  const signatures: string[][] = [];
  const tags = /\{@([A-Za-z][A-Za-z0-9_-]*)(?=\s|\})/g;
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    const originalTag = match[1];
    const tag = originalTag.toLowerCase();
    if (!INLINE_TAGS.has(tag)) continue;
    const token = delimitedToken(text, match.index, '{', '}', tag === 'code');
    if (!token) {
      signatures.push([`{@${originalTag}`, 'unclosed', text.slice(tags.lastIndex)]);
      break;
    }
    const body = text.slice(tags.lastIndex, token.end - 1).trim();
    if (tag === 'code' || tag === 'literal') {
      signatures.push([`{@${originalTag}`, body, '}']);
    } else {
      const target = atom(body, true);
      const remainder = target ? body.slice(target.end).trimStart() : '';
      signatures.push([`{@${originalTag}`, target?.text ?? '', remainder.startsWith('|') ? '|' : '', '}']);
    }
    tags.lastIndex = token.end;
  }
  return signatures;
}

function delimitedToken(text: string, start: number, opening: string, closing: string, respectQuotes = true): Token | undefined {
  let depth = 0;
  let quote = '';
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = '';
      continue;
    }
    if (respectQuotes && (character === '"' || character === "'" || character === '`')) quote = character;
    else if (character === opening) depth++;
    else if (character === closing && --depth === 0) return { text: text.slice(start, index + 1), end: index + 1 };
  }
  return undefined;
}

function atom(text: string, stopAtPipe = false): Token | undefined {
  if (!text) return undefined;
  const closing = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);
  const stack: string[] = [];
  let quote = '';
  let index = 0;
  for (; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = '';
      continue;
    }
    if (!stack.length && (/\s/.test(character) || (stopAtPipe && character === '|'))) break;
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (closing.has(character)) stack.push(closing.get(character)!);
    else if (character === stack.at(-1)) stack.pop();
  }
  return index ? { text: text.slice(0, index), end: index } : undefined;
}
