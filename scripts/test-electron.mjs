import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

const root = resolve(import.meta.dirname, '..');
const expectedVersion = '1.85.2';
const executable = await downloadAndUnzipVSCode({
  version: expectedVersion,
  cachePath: resolve(root, '.vscode-test', 'verified-host'),
});
// The download helper trusts its directory name even if that installation was later updated.
const hostManifest = resolve(dirname(executable), process.platform === 'darwin'
  ? '../Resources/app/package.json' : 'resources/app/package.json');
const actualVersion = JSON.parse(await readFile(hostManifest, 'utf8')).version;
if (actualVersion !== expectedVersion) {
  throw new Error(`Expected VS Code ${expectedVersion}, found ${actualVersion} at ${hostManifest}. Replace this test cache before retrying.`);
}
await mkdir(resolve(root, '.vscode-test'), { recursive: true });
for (const name of ['capture-ready', 'capture-done', 'capture-inline-ready', 'capture-inline-done', 'capture-markdown-ready', 'capture-markdown-done', 'capture-single-doc-ready', 'capture-single-doc-done']) await rm(resolve(root, '.vscode-test', name), { force: true });
// Keep Electron's Unix socket path under the macOS length limit.
const profile = await mkdtemp(process.platform === 'darwin' ? '/tmp/ct-smoke-' : resolve(tmpdir(), 'ct-smoke-'));
await mkdir(resolve(profile, 'User'), { recursive: true });
await writeFile(resolve(profile, 'User/settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'workbench.startupEditor': 'none',
  'comments.openView': 'never',
}));
try {
await runTests({
  version: expectedVersion,
  vscodeExecutablePath: executable,
  extensionTestsEnv: { COMMENT_TRANSLATOR_TEST_VSCODE_VERSION: expectedVersion },
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(root, 'scripts/electron-suite.cjs'),
  launchArgs: [
    '--user-data-dir', profile,
    '--extensions-dir', resolve(root, '.vscode-test', 'smoke-extensions'),
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates',
  ],
});
} finally {
  await rm(profile, { recursive: true, force: true });
}
