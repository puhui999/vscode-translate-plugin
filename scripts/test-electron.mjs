import { runTests } from '@vscode/test-electron';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, '.vscode-test'), { recursive: true });
for (const name of ['capture-ready', 'capture-done']) await rm(resolve(root, '.vscode-test', name), { force: true });
// Keep Electron's Unix socket path under the macOS length limit.
const profile = await mkdtemp(process.platform === 'darwin' ? '/tmp/ct-smoke-' : resolve(tmpdir(), 'ct-smoke-'));
await mkdir(resolve(profile, 'User'), { recursive: true });
await writeFile(resolve(profile, 'User/settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none',
  'comments.openView': 'never',
}));
try {
await runTests({
  version: '1.85.2',
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
