import c from '@shikijs/langs/c';
import cpp from '@shikijs/langs/cpp';
import csharp from '@shikijs/langs/csharp';
import css from '@shikijs/langs/css';
import dart from '@shikijs/langs/dart';
import go from '@shikijs/langs/go';
import java from '@shikijs/langs/java';
import javascript from '@shikijs/langs/javascript';
import jsx from '@shikijs/langs/jsx';
import kotlin from '@shikijs/langs/kotlin';
import php from '@shikijs/langs/php';
import ruby from '@shikijs/langs/ruby';
import rust from '@shikijs/langs/rust';
import scss from '@shikijs/langs/scss';
import shell from '@shikijs/langs/shellscript';
import sql from '@shikijs/langs/sql';
import swift from '@shikijs/langs/swift';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';
import vue from '@shikijs/langs/vue';
import type { IRawGrammar } from 'vscode-textmate';

// Each Shiki language entry includes the grammars that it references. Keep this
// list explicit so esbuild bundles only the supported languages and dependencies.
const LANGUAGE_ENTRIES = {
  c,
  cpp,
  csharp,
  css,
  dart,
  go,
  java,
  javascript,
  javascriptreact: jsx,
  kotlin,
  php,
  ruby,
  rust,
  scss,
  shellscript: shell,
  sql,
  swift,
  typescript,
  typescriptreact: tsx,
  vue,
} as const;

const LANGUAGE_ALIASES: Readonly<Record<string, keyof typeof LANGUAGE_ENTRIES>> = {
  js: 'javascript',
  jsx: 'javascriptreact',
  ts: 'typescript',
  tsx: 'typescriptreact',
  cs: 'csharp',
  'c++': 'cpp',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
};

const GRAMMARS = new Map<string, IRawGrammar>();
const SCOPES = new Map<string, string>();

for (const [languageId, entries] of Object.entries(LANGUAGE_ENTRIES)) {
  const primary = entries.at(-1);
  if (primary) {
    SCOPES.set(languageId, primary.scopeName);
  }
  for (const grammar of entries) {
    // Shiki's LanguageRegistration extends a compatible TextMate grammar shape.
    // Its type comes from a separate TextMate package, hence the boundary cast.
    GRAMMARS.set(grammar.scopeName, grammar as unknown as IRawGrammar);
  }
}

/** Returns the bundled grammar scope for a supported VS Code language ID. */
export function getLanguageScope(languageId: string): string | undefined {
  const normalized = languageId.toLowerCase();
  return SCOPES.get(LANGUAGE_ALIASES[normalized] ?? normalized);
}

/** Resolves a bundled TextMate grammar, including embedded-language dependencies. */
export function getGrammar(scopeName: string): IRawGrammar | null {
  return GRAMMARS.get(scopeName) ?? null;
}

/** Lists VS Code language IDs supported by the bundled parser. */
export function getSupportedLanguageIds(): readonly string[] {
  return [...SCOPES.keys()];
}
