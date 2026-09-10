const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function waitUntil(predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(description);
}

async function settleConfiguration() {
  // Allow the controller's configuration debounce and the host's editor events to settle.
  await new Promise(resolve => setTimeout(resolve, 1200));
}

async function focusDocument(document) {
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && vscode.window.activeTextEditor?.document.uri.toString() !== document.uri.toString()) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const active = vscode.window.activeTextEditor?.document;
  assert.equal(active?.uri.toString(), document.uri.toString());
}

async function waitForReader(api, document, translated) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const reader = api.getSnapshot(document.uri.toString()).reader;
    if (reader.ready && reader.translated === translated) {
      assert.equal(reader.sourceLines, document.lineCount);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Reader did not render: ${JSON.stringify(api.getSnapshot(document.uri.toString()))}`);
}

/** Exercises the actual extension host and native rendering with a local mock endpoint. */
exports.run = async function run() {
  const extension = vscode.extensions.getExtension('local-dev.vscode-translate-plugin');
  assert.ok(extension, 'Extension must be discoverable');
  await waitUntil(() => extension.isActive, 'Extension must activate at startup without running a command', 20000);
  const api = extension.exports;
  assert.equal(typeof api?.getSnapshot, 'function', 'Automatic activation must expose diagnostics');
  const config = vscode.workspace.getConfiguration('commentTranslator');
  assert.equal(config.get('automatic'), true, 'Fresh installations must enable automatic translation by default');
  await config.update('automatic', false, vscode.ConfigurationTarget.Global);
  await settleConfiguration();
  await vscode.commands.executeCommand('commentTranslator.demo');
  const demo = vscode.workspace.textDocuments.find(document => document.isUntitled && document.getText().includes('async function loadProfile'));
  assert.ok(demo, 'Offline demo source must remain open behind the reader');
  const before = demo.getText();
  const snapshot = api.getSnapshot(demo.uri.toString());
  assert.equal(snapshot.phase, 'demo', JSON.stringify(snapshot));
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.translated, 3);
  assert.equal(snapshot.widgets, 0, 'Comment widgets must no longer be created');
  await waitForReader(api, demo, 3);
  assert.equal(demo.getText(), before, 'Rendering must not edit source');

  const project = path.resolve(__dirname, '..');
  if (process.env.CAPTURE_TRANSLATION_DEMO) {
    await fs.writeFile(path.join(project, '.vscode-test', 'capture-ready'), 'ready');
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try { await fs.access(path.join(project, '.vscode-test', 'capture-done')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  // Toggle while the webview itself has focus, rather than an editable source editor.
  await vscode.commands.executeCommand('commentTranslator.toggle');
  assert.equal(api.getSnapshot(demo.uri.toString()).widgets, 0);
  assert.equal(api.getSnapshot(demo.uri.toString()).enabled, false);
  await waitForReader(api, demo, 0);
  await vscode.commands.executeCommand('commentTranslator.clearCache');

  const requests = [];
  const requestOptions = [];
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const comments = JSON.parse(body.messages.find(message => message.role === 'user').content).comments;
      requests.push(comments);
      requestOptions.push({ path: request.url, authorization: request.headers.authorization, model: body.model,
        maxCompletionTokens: body.max_completion_tokens, maxTokens: body.max_tokens });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        translations: [...comments].reverse().map(comment => ({ id: comment.id, text: `测试译文：${comment.text}` }))
      }) } }] }));
    } catch (error) { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await config.update('baseUrl', `http://127.0.0.1:${server.address().port}/v1`, vscode.ConfigurationTarget.Global);
    await config.update('model', 'offline-smoke-model', vscode.ConfigurationTarget.Global);
    await config.update('apiKey', 'offline-test-key', vscode.ConfigurationTarget.Global);
    await config.update('tokenLimitParameter', 'max_completion_tokens', vscode.ConfigurationTarget.Global);
    await settleConfiguration();
    const fixturePath = path.join(project, '.vscode-test', 'smoke-comments.ts');
    const original = '// First uncached comment.\nconst count = 1; // Trailing description.\n/**\n * Document the example.\n *\n * @param userId The user identifier.\n * @returns The cached record.\n */\n';
    await fs.writeFile(fixturePath, original);
    const uri = vscode.Uri.file(fixturePath);
    let document = await vscode.workspace.openTextDocument(uri);
    await focusDocument(document);
    await settleConfiguration();
    assert.equal(requests.length, 0, 'Opening a file while disabled must not request translation');
    await vscode.commands.executeCommand('commentTranslator.toggle');
    assert.equal(requests.length, 1, 'Uncached comments should be combined into one request');
    assert.equal(requests[0].length, 3);
    assert.deepEqual(requestOptions[0], { path: '/v1/chat/completions', authorization: 'Bearer offline-test-key',
      model: 'offline-smoke-model', maxCompletionTokens: 8192, maxTokens: undefined },
    'Custom settings must be reflected in the actual HTTP request');
    assert.equal(api.getSnapshot(uri.toString()).translated, 3);
    await waitForReader(api, document, 3);
    assert.equal(document.getText(), original);
    assert.equal(document.isDirty, false);
    await vscode.commands.executeCommand('commentTranslator.toggle');
    await focusDocument(document);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    document = await vscode.workspace.openTextDocument(uri);
    await focusDocument(document);
    await vscode.commands.executeCommand('commentTranslator.toggle');
    assert.equal(requests.length, 1, 'Reopening the same file must reuse SQLite results');
    assert.equal(api.getSnapshot(uri.toString()).cacheHits, 3);
    await waitForReader(api, document, 3);
    await vscode.commands.executeCommand('commentTranslator.openReader');
    assert.equal(requests.length, 1, 'Opening an existing reader must not repeat translation');

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, 0, document.lineAt(0).text.length), '// A changed comment.');
    await vscode.workspace.applyEdit(edit);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (requests.length < 2 || api.getSnapshot(uri.toString()).phase !== 'ready')) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[1].length, 1, 'Only the changed comment should reach the model');
    assert.equal(requests[1][0].text, 'A changed comment.');
    assert.equal(api.getSnapshot(uri.toString()).cacheHits, 2);
    await waitForReader(api, document, 3);
    await vscode.commands.executeCommand('commentTranslator.toggle');

    // This reproduces installing, configuring, and opening a Java file without a translation command.
    await config.update('automatic', true, vscode.ConfigurationTarget.Global);
    await settleConfiguration();
    const automaticJavaPath = path.join(project, '.vscode-test', 'AutomaticComments.java');
    const automaticJavaSource = [
      'public class AutomaticComments {',
      '  // Keep automatic Java translations beside their source comments.',
      '  private int timeout = 5; // Automatic Java timeout in seconds.',
      '  /**',
      '   * Load the automatic Java profile.',
      '   *',
      '   * @param userId The automatic Java user identifier.',
      '   * @return The automatic Java profile.',
      '   */',
      '  public String loadProfile(String userId) { return userId; }',
      '}',
      '',
    ].join('\n');
    await fs.writeFile(automaticJavaPath, automaticJavaSource);
    const automaticJava = await vscode.workspace.openTextDocument(vscode.Uri.file(automaticJavaPath));
    assert.equal(automaticJava.languageId, 'java', 'The fixture must use the actual Java language mode');
    const beforeAutomatic = requests.length;
    await vscode.window.showTextDocument(automaticJava, { preview: false });
    await waitForReader(api, automaticJava, 3);
    await waitUntil(() => api.getSnapshot(automaticJava.uri.toString()).phase === 'ready', 'Automatic Java translation must finish');
    assert.equal(requests.length, beforeAutomatic + 1, 'Opening Java with automatic enabled must issue one batched request');
    assert.equal(requests.at(-1).length, 3, 'Standalone, trailing, and documentation comments must be translated together');
    assert.ok(requests.at(-1).some(comment => comment.text.includes('@param userId') && comment.text.includes('@return')),
      'Java documentation tags and parameter identifiers must survive parsing');
    assert.equal(automaticJava.getText(), automaticJavaSource, 'Automatic translation must leave Java source unchanged');
    assert.equal(automaticJava.isDirty, false);
    assert.equal(api.getSnapshot(automaticJava.uri.toString()).automatic, true);

    await config.update('automatic', false, vscode.ConfigurationTarget.Global);
    await settleConfiguration();
    assert.equal(api.getSnapshot(automaticJava.uri.toString()).enabled, false, 'Disabling automatic must stop existing translation');
    const beforeReaderResume = requests.length;
    await config.update('automatic', true, vscode.ConfigurationTarget.Global);
    await waitForReader(api, automaticJava, 3);
    await waitUntil(() => api.getSnapshot(automaticJava.uri.toString()).phase === 'ready', 'Restoring automatic while the reader is focused must resume its source');
    assert.equal(requests.length, beforeReaderResume, 'Resuming a focused reader must reuse its cached translations');
    await config.update('automatic', false, vscode.ConfigurationTarget.Global);
    await settleConfiguration();
    const pausedJavaPath = path.join(project, '.vscode-test', 'PausedComments.java');
    const pausedJavaSource = '// Translate this Java comment only after automatic translation is restored.\npublic class PausedComments {}\n';
    await fs.writeFile(pausedJavaPath, pausedJavaSource);
    const pausedJava = await vscode.workspace.openTextDocument(vscode.Uri.file(pausedJavaPath));
    assert.equal(pausedJava.languageId, 'java');
    const beforePaused = requests.length;
    await vscode.window.showTextDocument(pausedJava, { preview: false });
    await settleConfiguration();
    assert.equal(requests.length, beforePaused, 'Opening another Java file while automatic is disabled must make no request');
    assert.equal(api.getSnapshot(pausedJava.uri.toString()).enabled, false);

    // Updating the setting must process the source that is already open; no file switch is needed.
    await config.update('automatic', true, vscode.ConfigurationTarget.Global);
    await waitForReader(api, pausedJava, 1);
    await waitUntil(() => api.getSnapshot(pausedJava.uri.toString()).phase === 'ready', 'Restoring automatic must process the current file');
    assert.equal(requests.length, beforePaused + 1, 'Restoring automatic must translate the already open Java file exactly once');
    assert.equal(pausedJava.getText(), pausedJavaSource);
    assert.equal(pausedJava.isDirty, false);
    await config.update('automatic', false, vscode.ConfigurationTarget.Global);
    await settleConfiguration();
    console.log('ELECTRON_SMOKE_PASSED: startup activation, borderless reader DOM, unchanged source, custom provider settings, batched request, SQLite reuse, changed-comment-only request, automatic Java opening, persisted setting disable and resume');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};
