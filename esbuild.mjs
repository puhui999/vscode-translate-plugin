import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { collectLicenses } from './scripts/collect-licenses.mjs';

const require = createRequire(import.meta.url);
await mkdir('dist', { recursive: true });
await mkdir('artifacts', { recursive: true });
await copyFile(require.resolve('vscode-oniguruma/release/onig.wasm'), 'dist/onig.wasm');
await copyFile(require.resolve('sql.js/dist/sql-wasm.wasm'), 'dist/sql-wasm.wasm');
await collectLicenses();
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
