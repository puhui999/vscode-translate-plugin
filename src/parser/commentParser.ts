import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { INITIAL, Registry, type IToken, type StateStack } from 'vscode-textmate';
import { getGrammar, getLanguageScope } from './grammars';

/** A source position using VS Code's zero-based UTF-16 coordinates. */
export interface CommentPosition {
  line: number;
  character: number;
}

/** One logical comment; end is exclusive and rawText retains source formatting. */
export interface CommentBlock {
  id: string;
  text: string;
  rawText: string;
  languageId: string;
  kind: 'standalone' | 'trailing' | 'documentation' | 'inline';
  start: CommentPosition;
  end: CommentPosition;
}

interface CommentScope {
  name: string;
  depth: number;
  documentation: boolean;
}

interface Candidate {
  start: CommentPosition;
  end: CommentPosition;
  startOffset: number;
  endOffset: number;
  lineStyle: boolean;
  documentation: boolean;
}

interface CodeExtent {
  first: number;
  last: number;
}

interface ParsedCandidate extends CommentBlock {
  lineStyle: boolean;
  startOffset: number;
  endOffset: number;
}

const TOKENIZATION_LIMIT_MS = 50;
const TOKENIZATION_RETRY_LIMIT_MS = 500;
const YIELD_EVERY_LINES = 100;
const DOCUMENTATION_PREFIX = /^(?:\/\*\*(?!\/)|\/\*!|\/\/\/(?!\/)|\/\/!)/;
let onigurumaReady: Promise<void> | undefined;

function initializeOniguruma(wasmPath: string): Promise<void> {
  onigurumaReady ??= readFile(wasmPath)
    .then((wasm) => loadWASM(wasm))
    .catch((error: unknown) => {
      onigurumaReady = undefined;
      throw error;
    });
  return onigurumaReady;
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Comment parsing was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function getCommentScope(token: IToken): CommentScope | undefined {
  let insideString = false;
  for (const [index, scope] of token.scopes.entries()) {
    if (/^string(?:\.|$)/.test(scope)) {
      insideString = true;
    }
    // Ruby's typed heredocs replace the string scope with an embedded-language
    // scope, even though their SQL/JS/etc. contents remain string literals.
    if (token.scopes[0] === 'source.ruby' && /^meta\.embedded\.block\./.test(scope)) {
      insideString = true;
    }
    // JavaScript template interpolations contain executable source code.
    if (/^meta\.(?:template\.expression|interpolation)(?:\.|$)/.test(scope)) {
      insideString = false;
    }
    if (!/^comment(?:\.|$)/.test(scope)) {
      continue;
    }
    if (insideString || /(?:^|\.)(?:html|xml|shebang)(?:\.|$)/.test(scope)) {
      return undefined;
    }
    return {
      name: scope,
      depth: token.scopes.slice(index).filter((item) => item === scope).length,
      documentation: token.scopes.some((item) => /(?:documentation|jsdoc|javadoc)/.test(item)),
    };
  }
  return undefined;
}

function recordCode(extent: CodeExtent, tokenText: string, start: number): void {
  const first = tokenText.search(/\S/);
  if (first >= 0) {
    extent.first = Math.min(extent.first, start + first);
    extent.last = Math.max(extent.last, start + tokenText.trimEnd().length - 1);
  }
}

function normalizeComment(rawText: string, lineStyle: boolean): string {
  let content = rawText.replace(/\r\n?/g, '\n');
  if (lineStyle) {
    content = content.replace(/^[\t ]*(?:\/\/[/!]?|--|#)[\t ]?/gm, '');
  } else if (content.startsWith('/*')) {
    content = content.slice(2, content.length >= 4 && content.endsWith('*/') ? -2 : undefined);
    content = content.replace(/^\**!?[\t ]?/, '');
    content = content.replace(/^[\t ]*\*(?:[\t ]|$)/gm, '');
  } else if (content.startsWith('=begin')) {
    content = content.replace(/^=begin\b[\t ]?/, '').replace(/(?:^|\n)=end\b[^\n]*$/, '');
  }
  const lines = content.split('\n');
  while (lines.length > 0 && lines[0].trim().length === 0) {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const indentation = Math.min(...nonEmpty.map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0));
  return lines.map((line) => line.slice(indentation)).join('\n').trim();
}

function classify(candidate: Candidate, code: readonly CodeExtent[]): CommentBlock['kind'] {
  const before = code[candidate.start.line].first < candidate.start.character;
  const after = code[candidate.end.line].last >= candidate.end.character;
  if (after) {
    return 'inline';
  }
  if (before) {
    return 'trailing';
  }
  return candidate.documentation ? 'documentation' : 'standalone';
}

function mergeLineComments(candidates: ParsedCandidate[], source: string): ParsedCandidate[] {
  const merged: ParsedCandidate[] = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (
      previous?.lineStyle && candidate.lineStyle &&
      (candidate.kind === 'standalone' || candidate.kind === 'documentation') &&
      candidate.kind === previous.kind &&
      candidate.start.line === previous.end.line + 1 &&
      /^\s*$/.test(source.slice(previous.endOffset, candidate.startOffset))
    ) {
      previous.end = candidate.end;
      previous.endOffset = candidate.endOffset;
      previous.rawText = source.slice(previous.startOffset, previous.endOffset);
      previous.text = normalizeComment(previous.rawText, true);
    } else {
      merged.push(candidate);
    }
  }
  return merged;
}

/** Extracts comments with bundled TextMate grammars without loading VS Code APIs. */
export class CommentParser {
  private registry: Registry | undefined;

  /** Creates a parser using the packaged vscode-oniguruma WASM file. */
  constructor(private readonly wasmPath: string) {}

  /** Reports whether this language has a bundled, enabled comment grammar. */
  supportsLanguage(languageId: string): boolean {
    return getLanguageScope(languageId) !== undefined;
  }

  /** Parses the complete source while preserving TextMate state between lines. */
  async parse(text: string, languageId: string, signal?: AbortSignal): Promise<CommentBlock[]> {
    checkCancellation(signal);
    const scopeName = getLanguageScope(languageId);
    if (!scopeName || text.length === 0) {
      return [];
    }
    const grammar = await this.getRegistry().loadGrammar(scopeName);
    checkCancellation(signal);
    if (!grammar) {
      throw new Error(`The bundled grammar for ${languageId} could not be loaded.`);
    }

    const lines = text.split(/\r\n|\n|\r/);
    const lineBreaks = text.match(/\r\n|\n|\r/g) ?? [];
    const candidates: Candidate[] = [];
    const code: CodeExtent[] = [];
    let offset = 0;
    let state: StateStack = INITIAL;
    let current: Candidate | undefined;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (lineIndex % YIELD_EVERY_LINES === 0) {
        await setImmediate();
        checkCancellation(signal);
      }
      const line = lines[lineIndex];
      let result = grammar.tokenizeLine(line, state, TOKENIZATION_LIMIT_MS);
      if (result.stoppedEarly) {
        // Cold grammar/regex compilation can exhaust the normal budget on a
        // short line. Discard the partial result and retry from the same input
        // state once; never propagate unfinished tokens or its rule stack.
        await setImmediate();
        checkCancellation(signal);
        result = grammar.tokenizeLine(line, state, TOKENIZATION_RETRY_LIMIT_MS);
      }
      if (result.stoppedEarly) {
        throw new Error(`Comment parsing exceeded the time limit on line ${lineIndex + 1}.`);
      }
      state = result.ruleStack;
      const extent: CodeExtent = { first: Number.POSITIVE_INFINITY, last: -1 };
      code.push(extent);

      for (const token of result.tokens) {
        const start = Math.min(token.startIndex, line.length);
        const end = Math.min(token.endIndex, line.length);
        const tokenText = line.slice(start, end);
        const scope = lineIndex === 0 && line.startsWith('#!') ? undefined : getCommentScope(token);
        if (!scope) {
          if (current) {
            candidates.push(current);
            current = undefined;
          }
          recordCode(extent, tokenText, start);
          continue;
        }
        if (!current && start === end) {
          continue;
        }
        current ??= {
          start: { line: lineIndex, character: start },
          end: { line: lineIndex, character: end },
          startOffset: offset + start,
          endOffset: offset + end,
          lineStyle: /^(?:\/\/|#|--)/.test(tokenText),
          documentation: scope.documentation || DOCUMENTATION_PREFIX.test(line.slice(start)),
        };
        current.end = { line: lineIndex, character: end };
        current.endOffset = offset + end;
        current.documentation ||= scope.documentation;
        // A nested comment's closing delimiter still belongs to its outer block.
        if (!current.lineStyle && scope.depth === 1 && (tokenText.endsWith('*/') || /^=end\b/.test(tokenText))) {
          candidates.push(current);
          current = undefined;
        }
      }
      if (current?.lineStyle) {
        candidates.push(current);
        current = undefined;
      }
      offset += line.length + (lineBreaks[lineIndex]?.length ?? 0);
    }
    if (current) {
      candidates.push(current);
    }

    const parsed: ParsedCandidate[] = candidates.map((candidate) => {
      const rawText = text.slice(candidate.startOffset, candidate.endOffset);
      return {
        ...candidate,
        id: '',
        rawText,
        text: normalizeComment(rawText, candidate.lineStyle),
        languageId,
        kind: classify(candidate, code),
      };
    });
    const occurrences = new Map<string, number>();
    return mergeLineComments(parsed, text).filter((candidate) => candidate.text.length > 0).map((candidate) => {
      const hash = createHash('sha256').update(`${languageId}\0${candidate.text}`).digest('hex').slice(0, 20);
      const occurrence = occurrences.get(hash) ?? 0;
      occurrences.set(hash, occurrence + 1);
      return {
        id: `${hash}-${occurrence}`,
        text: candidate.text,
        rawText: candidate.rawText,
        languageId,
        kind: candidate.kind,
        start: candidate.start,
        end: candidate.end,
      };
    });
  }

  /** Releases grammar resources when the extension shuts down. */
  dispose(): void {
    this.registry?.dispose();
    this.registry = undefined;
  }

  private getRegistry(): Registry {
    this.registry ??= new Registry({
      onigLib: initializeOniguruma(this.wasmPath).then(() => ({
        createOnigScanner: (patterns) => new OnigScanner(patterns),
        createOnigString: (value) => new OnigString(value),
      })),
      loadGrammar: async (scopeName) => getGrammar(scopeName),
    });
    return this.registry;
  }
}
