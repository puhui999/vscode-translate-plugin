import c from '@shikijs/langs/c';
import cpp from '@shikijs/langs/cpp';
import csharp from '@shikijs/langs/csharp';
import css from '@shikijs/langs/css';
import dart from '@shikijs/langs/dart';
import go from '@shikijs/langs/go';
import html from '@shikijs/langs/html';
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
import xml from '@shikijs/langs/xml';
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
  html,
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
  xml,
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
  xhtml: 'html',
  xsl: 'xml',
};

const GRAMMARS = new Map<string, IRawGrammar>();
const SCOPES = new Map<string, string>();
const INJECTIONS = new Map<string, Set<string>>();

for (const [languageId, entries] of Object.entries(LANGUAGE_ENTRIES)) {
  const primary = entries.at(-1);
  if (primary) {
    SCOPES.set(languageId, primary.scopeName);
  }
  for (const grammar of entries) {
    // Shiki's LanguageRegistration extends a compatible TextMate grammar shape.
    // Its type comes from a separate TextMate package, hence the boundary cast.
    GRAMMARS.set(grammar.scopeName, grammar as unknown as IRawGrammar);
    for (const target of grammar.injectTo ?? []) {
      const injections = INJECTIONS.get(target) ?? new Set<string>();
      injections.add(grammar.scopeName);
      INJECTIONS.set(target, injections);
    }
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

/** Resolves grammar injections, including Vue's upstream source.vue target alias. */
export function getGrammarInjections(scopeName: string): string[] {
  return [...(INJECTIONS.get(scopeName === 'text.html.vue' ? 'source.vue' : scopeName) ?? [])];
}

/** Lists VS Code language IDs supported by the bundled parser. */
export function getSupportedLanguageIds(): readonly string[] {
  return [...SCOPES.keys()];
}
