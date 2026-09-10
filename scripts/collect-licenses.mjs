import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REQUIRE = createRequire(import.meta.url);
const NOTICE_ROOT = join(PROJECT_ROOT, 'third-party', 'tm-grammars', '1.32.3');
const OUTPUT_ROOT = join(PROJECT_ROOT, 'dist', 'licenses');
const PACKAGE_FILES = [
  { name: '@shikijs/langs', files: [['LICENSE', 'shikijs-langs-LICENSE.txt']] },
  { name: 'vscode-textmate', files: [['LICENSE.md', 'vscode-textmate-LICENSE.txt']] },
  {
    name: 'vscode-oniguruma',
    files: [['LICENSE.txt', 'vscode-oniguruma-LICENSE.txt'], ['NOTICES.txt', 'vscode-oniguruma-NOTICES.txt']],
  },
  { name: 'sql.js', files: [['LICENSE', 'sql.js-LICENSE.txt']] },
  { name: 'markdown-it', files: [['LICENSE', 'markdown-it-LICENSE.txt']] },
  { name: 'entities', files: [['LICENSE', 'entities-LICENSE.txt']] },
  { name: 'linkify-it', files: [['LICENSE', 'linkify-it-LICENSE.txt']] },
  { name: 'mdurl', files: [['LICENSE', 'mdurl-LICENSE.txt']] },
  { name: 'punycode.js', files: [['LICENSE-MIT.txt', 'punycode-LICENSE.txt']] },
  { name: 'uc.micro', files: [['LICENSE.txt', 'uc-micro-LICENSE.txt']] },
];

async function findPackage(name) {
  let directory = dirname(REQUIRE.resolve(name));
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) {
        return { directory, metadata };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Unable to locate the installed ${name} package for license collection.`);
    }
    directory = parent;
  }
}

async function listBundledGrammars() {
  const parserSource = await readFile(join(PROJECT_ROOT, 'src', 'parser', 'grammars.ts'), 'utf8');
  const imports = [...parserSource.matchAll(/from\s+['"](@shikijs\/langs\/[^'"]+)['"]/g)]
    .map((match) => match[1]);
  if (imports.length === 0) {
    throw new Error('No explicit Shiki grammar imports were found; update the license collector.');
  }
  const grammars = new Map();
  for (const moduleName of imports) {
    const entries = (await import(moduleName)).default;
    for (const grammar of entries) {
      const key = `${grammar.name}\0${grammar.scopeName}`;
      const entry = grammars.get(key) ?? {
        name: grammar.name,
        scopeName: grammar.scopeName,
        importedBy: [],
      };
      if (!entry.importedBy.includes(moduleName)) {
        entry.importedBy.push(moduleName);
      }
      grammars.set(key, entry);
    }
  }
  return [...grammars.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Copies pinned upstream notices and installed runtime licenses into dist/licenses. */
export async function collectLicenses() {
  const source = JSON.parse(await readFile(join(NOTICE_ROOT, 'SOURCE.json'), 'utf8'));
  const packages = await Promise.all(PACKAGE_FILES.map(async (entry) => ({
    ...entry,
    ...await findPackage(entry.name),
  })));
  const shikiPackage = packages.find((entry) => entry.name === '@shikijs/langs');
  if (shikiPackage.metadata.version !== source.shikiLanguagePackage.version) {
    throw new Error(
      `Grammar NOTICE is verified for @shikijs/langs ${source.shikiLanguagePackage.version}, ` +
      `but ${shikiPackage.metadata.version} is installed. Refresh third-party/tm-grammars before packaging.`,
    );
  }

  // Builds remain offline; reject accidentally modified or incomplete vendored notices.
  for (const entry of source.files) {
    const contents = await readFile(join(NOTICE_ROOT, entry.file));
    if (createHash('sha256').update(contents).digest('hex') !== entry.sha256) {
      throw new Error(`The vendored tm-grammars ${entry.file} does not match its recorded SHA-256.`);
    }
  }

  const grammars = await listBundledGrammars();
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const copies = packages.flatMap((entry) => entry.files.map(([name, outputName]) => ({
    source: join(entry.directory, name),
    target: join(OUTPUT_ROOT, outputName),
  })));
  copies.push(
    { source: join(NOTICE_ROOT, 'LICENSE'), target: join(OUTPUT_ROOT, 'tm-grammars-LICENSE.txt') },
    { source: join(NOTICE_ROOT, 'NOTICE'), target: join(OUTPUT_ROOT, 'tm-grammars-NOTICE.txt') },
    { source: join(NOTICE_ROOT, 'SOURCE.json'), target: join(OUTPUT_ROOT, 'tm-grammars-SOURCE.json') },
  );
  await Promise.all(copies.map(({ source: input, target }) => copyFile(input, target)));

  const manifest = packages.map((entry) => ({
    name: entry.name,
    version: entry.metadata.version,
    declaredLicense: entry.metadata.license,
    repository: entry.metadata.repository,
    files: entry.files.map(([, outputName]) => outputName),
  }));
  manifest.push({
    name: source.name,
    version: source.version,
    declaredLicense: 'MIT; individual grammars retain their upstream license terms',
    repository: source.upstreamRepository,
    files: ['tm-grammars-LICENSE.txt', 'tm-grammars-NOTICE.txt', 'tm-grammars-SOURCE.json'],
  });
  const generatedFiles = ['THIRD-PARTY.json', 'bundled-grammars.json', 'README.md'];
  await Promise.all([
    writeFile(join(OUTPUT_ROOT, generatedFiles[0]), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(OUTPUT_ROOT, generatedFiles[1]), `${JSON.stringify(grammars, null, 2)}\n`),
    writeFile(join(OUTPUT_ROOT, generatedFiles[2]), `# Third-party software notices

This directory accompanies the JavaScript bundle and WASM binaries. The extension's own license does not replace these upstream terms.

- THIRD-PARTY.json records the installed runtime package versions and their license files.
- bundled-grammars.json lists the grammars imported by the parser, including dependency grammars used by Ruby, PHP, Vue, and other languages.
- tm-grammars-NOTICE.txt is the complete, unmodified notice from tm-grammars ${source.version}. It also lists grammars that are **not** bundled in this extension; those entries do not imply that their code is included.
- tm-grammars-SOURCE.json records the npm release tarball, integrity value, file hashes, and the Shiki release lockfile establishing the matching grammar version.
- vscode-oniguruma-NOTICES.txt includes the underlying Oniguruma engine's notices.

@shikijs/langs ${source.shikiLanguagePackage.version} does not include the grammar NOTICE in its npm package. The matching NOTICE and LICENSE were copied from the integrity-verified tm-grammars ${source.version} npm tarball, not from the repository's moving main branch. License collection during builds requires no network access.
`),
  ]);
  return [...copies.map((entry) => entry.target), ...generatedFiles.map((name) => join(OUTPUT_ROOT, name))];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await collectLicenses();
  console.log(`Collected ${files.length} license and provenance files in dist/licenses.`);
}
