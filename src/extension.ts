import * as vscode from 'vscode';
import { join } from 'node:path';
import { clearProviderApiKey } from './config';
import { TranslationCache } from './core/cache';
import { CommentParser } from './parser/commentParser';
import { TranslationController } from './controller';

let controller: TranslationController | undefined;
let cache: TranslationCache | undefined;

/** Activates commands and restores automatic translation when provider settings are ready. */
export async function activate(context: vscode.ExtensionContext): Promise<{ getSnapshot: TranslationController['getSnapshot'] }> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  cache = await TranslationCache.open({
    databasePath: join(context.globalStorageUri.fsPath, 'translations.sqlite'),
    wasmPath: context.asAbsolutePath('dist/sql-wasm.wasm'),
  });
  controller = new TranslationController(context, new CommentParser(context.asAbsolutePath('dist/onig.wasm')), cache);
  const active = controller;
  const commands: Record<string, () => unknown> = {
    'commentTranslator.configure': () => active.configure(),
    'commentTranslator.openSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    'commentTranslator.openReader': () => active.openReader(),
    'commentTranslator.toggle': () => active.toggle(),
    'commentTranslator.toggleAutomatic': () => active.toggleAutomatic(),
    'commentTranslator.refresh': () => active.refresh(),
    'commentTranslator.translateRemaining': () => active.translateRemaining(),
    'commentTranslator.clearCache': () => active.clearCache(),
    'commentTranslator.showStatus': () => active.showStatus(),
    'commentTranslator.demo': () => active.demo(),
    'commentTranslator.removeApiKey': async () => {
      await active.pauseAutomatic();
      await clearProviderApiKey(context);
      void vscode.window.showInformationMessage('当前服务的 API Key 已删除。');
    },
  };
  for (const [command, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      try { return await handler(); }
      catch (error) { void vscode.window.showErrorMessage(`注释译读：${error instanceof Error ? error.message : '操作失败。'}`); }
    }));
  }
  context.subscriptions.push(active);
  active.start();
  return { getSnapshot: (uri: string) => active.getSnapshot(uri) };
}

/** Cancels outstanding work and flushes SQLite before the extension host exits. */
export async function deactivate(): Promise<void> {
  controller?.dispose();
  await cache?.close();
  controller = undefined;
  cache = undefined;
}
