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
  const expectedVersion = process.env.COMMENT_TRANSLATOR_TEST_VSCODE_VERSION;
  if (expectedVersion) assert.equal(vscode.version, expectedVersion, 'The actual extension host must match the requested test version');
  console.log(`ELECTRON_TEST_HOST: VS Code ${vscode.version}`);
  const extension = vscode.extensions.getExtension('local-dev.vscode-translate-plugin');
  assert.ok(extension, 'Extension must be discoverable');
  await waitUntil(() => extension.isActive, 'Extension must activate at startup without running a command', 20000);
  const api = extension.exports;
  assert.equal(typeof api?.getSnapshot, 'function', 'Automatic activation must expose diagnostics');
  const config = vscode.workspace.getConfiguration('commentTranslator');
  assert.equal(config.get('automatic'), true, 'Fresh installations must enable automatic translation by default');
  assert.equal(config.get('displayMode'), 'inline', 'Fresh installations must show translations in place');
  assert.equal(config.get('responseFormat'), 'json_object');
  assert.equal(config.get('maxConcurrentRequests'), 10);
  assert.equal(config.get('temperature'), 0.2);
  assert.equal(config.get('thinking'), 'provider');
  await config.update('automatic', false, vscode.ConfigurationTarget.Global);
  await config.update('displayMode', 'reader', vscode.ConfigurationTarget.Global);
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
  if (process.env.CAPTURE_TRANSLATION_DEMO || process.env.CAPTURE_TRANSLATION_SOURCE) {
    if (process.env.CAPTURE_TRANSLATION_SOURCE) {
      await focusDocument(demo);
      vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
    }
    await fs.writeFile(path.join(project, '.vscode-test', 'capture-ready'), 'ready');
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try { await fs.access(path.join(project, '.vscode-test', 'capture-done')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(demo.getText(), before, 'Inspecting translated source and original hover must leave source unchanged');
    if (process.env.CAPTURE_TRANSLATION_SOURCE) await vscode.commands.executeCommand('commentTranslator.openReader');
  }
  // Toggle while the webview itself has focus, rather than an editable source editor.
  await vscode.commands.executeCommand('commentTranslator.toggle');
  assert.equal(api.getSnapshot(demo.uri.toString()).widgets, 0);
  assert.equal(api.getSnapshot(demo.uri.toString()).enabled, false);
  await waitForReader(api, demo, 0);
  await vscode.commands.executeCommand('commentTranslator.clearCache');

  const requests = [];
  const requestOptions = [];
  const sameLanguageText = '这条注释已经是简体中文，无需重复翻译。';
  let sameLanguageResponses = 0;
  let parallelActive = 0;
  let parallelPeak = 0;
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const comments = JSON.parse(body.messages.find(message => message.role === 'user').content).comments;
      const markdown = body.messages[0].content.includes('Markdown fragment');
      requests.push(comments);
      requestOptions.push({ path: request.url, authorization: request.headers.authorization, model: body.model,
        maxCompletionTokens: body.max_completion_tokens, maxTokens: body.max_tokens,
        temperature: body.temperature, thinking: body.thinking, responseFormat: body.response_format });
      const parallel = comments.some(comment => comment.text.includes('parallel-fixture'));
      if (parallel) {
        parallelActive += 1;
        parallelPeak = Math.max(parallelPeak, parallelActive);
        await new Promise(resolve => setTimeout(resolve, 50));
        parallelActive -= 1;
      }
      const sameLanguage = comments.length === 1 && comments[0].text === sameLanguageText;
      if (sameLanguage) sameLanguageResponses += 1;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(sameLanguage ? { same: true } : {
        translations: [...comments].reverse().map(comment => ({ id: comment.id, text: markdown
          ? comment.text.replace(/Reading guide/g, '阅读指南').replace(/Getting started/g, '开始使用').replace(/Read the documentation/g, '阅读文档').replace(/First step/g, '第一步').replace(/Second step/g, '第二步').replace(/Feature/g, '功能').replace(/Description/g, '说明').replace(/Cache/g, '缓存').replace(/Reuse translations/g, '复用译文')
          : `测试译文：${comment.text}` }))
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
    assert.equal(requests.length, 3, 'Each uncached logical comment must have its own request');
    assert.ok(requests.every(comments => comments.length === 1));
    assert.deepEqual(requestOptions[0], { path: '/v1/chat/completions', authorization: 'Bearer offline-test-key',
      model: 'offline-smoke-model', maxCompletionTokens: 8192, maxTokens: undefined,
      temperature: 0.2, thinking: undefined, responseFormat: { type: 'json_object' } },
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
    assert.equal(requests.length, 3, 'Reopening the same file must reuse SQLite results');
    assert.equal(api.getSnapshot(uri.toString()).cacheHits, 3);
    await waitForReader(api, document, 3);
    await vscode.commands.executeCommand('commentTranslator.openReader');
    assert.equal(requests.length, 3, 'Opening an existing reader must not repeat translation');

    await config.update('temperature', 0.65, vscode.ConfigurationTarget.Global);
    await config.update('thinking', 'disabled', vscode.ConfigurationTarget.Global);
    await config.update('responseFormat', 'text', vscode.ConfigurationTarget.Global);
    await settleConfiguration();
    assert.equal(requests.length, 3, 'Request tuning must preserve already cached translations');

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, 0, document.lineAt(0).text.length), '// A changed comment.');
    await vscode.workspace.applyEdit(edit);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (requests.length < 4 || api.getSnapshot(uri.toString()).phase !== 'ready')) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(requests.length, 4);
    assert.equal(requests[3].length, 1, 'Only the changed comment should reach the model');
    assert.equal(requests[3][0].text, 'A changed comment.');
    assert.deepEqual(requestOptions[3], { path: '/v1/chat/completions', authorization: 'Bearer offline-test-key',
      model: 'offline-smoke-model', maxCompletionTokens: 8192, maxTokens: undefined,
      temperature: 0.65, thinking: { type: 'disabled' }, responseFormat: undefined },
    'Temperature, thinking, and output mode settings must affect new HTTP requests');
    assert.equal(api.getSnapshot(uri.toString()).cacheHits, 2);
    await waitForReader(api, document, 3);
    await vscode.commands.executeCommand('commentTranslator.toggle');
    await config.update('temperature', 0.2, vscode.ConfigurationTarget.Global);
    await config.update('thinking', 'provider', vscode.ConfigurationTarget.Global);
    await config.update('responseFormat', 'json_object', vscode.ConfigurationTarget.Global);

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
    assert.equal(requests.length, beforeAutomatic + 3, 'Opening Java must request each logical comment independently');
    assert.ok(requests.slice(beforeAutomatic).every(comments => comments.length === 1));
    assert.ok(requests.slice(beforeAutomatic).flat().some(comment => comment.text.includes('@param userId') && comment.text.includes('@return')),
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
    // Markup comments use the same automatic pipeline without translating markup or data.
    await config.update('automatic', true, vscode.ConfigurationTarget.Global);
    await settleConfiguration();
    for (const [name, language, source, count] of [
      ['comments.xml', 'xml', '<?xml version="1.0"?>\n<!-- Explain the project. -->\n<project><![CDATA[<!-- literal data -->]]><name>unchanged</name><!-- End of project. --></project>\n', 2],
      ['comments.html', 'html', '<!-- Explain the page. -->\n<div title="<!-- attribute -->">Unchanged content</div>\n<script>// Explain the script.\nconst text = "<!-- string literal -->";</script>\n<style>/* Explain the style. */ body { color: red; }</style>\n', 3],
    ]) {
      const markupPath = path.join(project, '.vscode-test', name);
      await fs.writeFile(markupPath, source);
      const markup = await vscode.workspace.openTextDocument(vscode.Uri.file(markupPath));
      assert.equal(markup.languageId, language);
      const beforeMarkup = requests.length;
      await vscode.window.showTextDocument(markup, { preview: false });
      await waitForReader(api, markup, count);
      await waitUntil(() => api.getSnapshot(markup.uri.toString()).phase === 'ready', 'Markup translation must complete');
      assert.equal(requests.length, beforeMarkup + count);
      assert.ok(requests.slice(beforeMarkup).every(comments => comments.length === 1));
      assert.ok(requests.slice(beforeMarkup).flat().every(item => !/literal data|attribute|Unchanged content|string literal/.test(item.text)));
      assert.equal(markup.getText(), source);
      assert.equal(markup.isDirty, false);
    }

    for (const [name, language, singleDoc] of [
      ['SingleLineDocs.java', 'java', '/** Description. */'],
      ['SingleLineDocs.cs', 'csharp', '/// <summary>Description.</summary>'],
    ]) {
      const source = `class SingleLineDocs {\n    ${singleDoc}\n    int count;\n\t/**Returns the configured value.*/\n    int GetCount() { return count; }\n}\n`;
      const singleDocPath = path.join(project, '.vscode-test', name);
      await fs.writeFile(singleDocPath, source);
      const singleDocDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(singleDocPath));
      assert.equal(singleDocDocument.languageId, language);
      const beforeSingleDoc = requests.length;
      await vscode.window.showTextDocument(singleDocDocument, { preview: false });
      await waitForReader(api, singleDocDocument, 2);
      await waitUntil(() => api.getSnapshot(singleDocDocument.uri.toString()).phase === 'ready', 'Single-line documentation must finish translating');
      assert.equal(requests.length, beforeSingleDoc + 2);
      assert.ok(requests.slice(beforeSingleDoc).every(comments => comments.length === 1));
      assert.deepEqual(requests.slice(beforeSingleDoc).flat().map(item => item.text).sort(), [
        language === 'java' ? 'Description.' : '<summary>Description.</summary>',
        'Returns the configured value.',
      ].sort(), 'Indentation and documentation wrappers must not leak into normalized requests');
      await focusDocument(singleDocDocument);
      vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
      if (process.env.CAPTURE_TRANSLATION_SINGLE_DOC && language === 'java') {
        await fs.writeFile(path.join(project, '.vscode-test', 'capture-single-doc-ready'), 'ready');
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          try { await fs.access(path.join(project, '.vscode-test', 'capture-single-doc-done')); break; } catch {}
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      assert.equal(singleDocDocument.getText(), source);
      assert.equal(singleDocDocument.isDirty, false);
    }

    const markdownPath = path.join(project, '.vscode-test', 'reading-guide.md');
    const markdownSource = '# Reading guide\n\n## Getting started\n\nRead the documentation at [VS Code](https://code.visualstudio.com/).\n\n- First step\n- Second step\n\n| Feature | Description |\n| --- | --- |\n| Cache | Reuse translations |\n\n```ts\nconst original = "do not translate";\n```\n';
    await fs.writeFile(markdownPath, markdownSource);
    const markdownUri = vscode.Uri.file(markdownPath);
    const markdownDocument = await vscode.workspace.openTextDocument(markdownUri);
    await focusDocument(markdownDocument);
    const beforeMarkdown = requests.length;
    await settleConfiguration();
    assert.equal(requests.length, beforeMarkdown, 'Opening Markdown must not issue an automatic request');
    assert.equal(api.getSnapshot(markdownUri.toString()).enabled, false);
    // Pass the selected resource as explorer/editor context menus do, while another file has focus.
    await focusDocument(pausedJava);
    await vscode.commands.executeCommand('commentTranslator.translateMarkdown', markdownUri);
    await waitForReader(api, markdownDocument, 5);
    assert.equal(requests.length, beforeMarkdown + 1, 'Whole Markdown must be batched into one request');
    assert.equal(requests.at(-1).length, 5);
    assert.ok(requests.at(-1).every(item => !item.text.includes('do not translate')));
    await vscode.commands.executeCommand('commentTranslator.translateMarkdown', markdownUri);
    await waitForReader(api, markdownDocument, 5);
    assert.equal(requests.length, beforeMarkdown + 1, 'Repeated Markdown translation must reuse SQLite');
    assert.equal(api.getSnapshot(markdownUri.toString()).cacheHits, 5);
    assert.equal(markdownDocument.getText(), markdownSource);
    assert.equal(markdownDocument.isDirty, false);
    assert.equal(await fs.readFile(markdownPath, 'utf8'), markdownSource);
    const markdownMenus = extension.packageJSON.contributes.menus;
    assert.ok(markdownMenus['editor/context'].some(item => item.command === 'commentTranslator.translateMarkdown'));
    assert.ok(markdownMenus['explorer/context'].some(item => item.command === 'commentTranslator.translateMarkdown'));
    if (process.env.CAPTURE_TRANSLATION_MARKDOWN) {
      await fs.writeFile(path.join(project, '.vscode-test', 'capture-markdown-ready'), 'ready');
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        try { await fs.access(path.join(project, '.vscode-test', 'capture-markdown-done')); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    await config.update('automatic', false, vscode.ConfigurationTarget.Global);
    await settleConfiguration();

    const sameLanguagePath = path.join(project, '.vscode-test', 'already-translated.ts');
    const sameLanguageSource = `// ${sameLanguageText}\nconst alreadyChinese = true;\n`;
    await fs.writeFile(sameLanguagePath, sameLanguageSource);
    const sameLanguageUri = vscode.Uri.file(sameLanguagePath);
    let sameLanguageDocument = await vscode.workspace.openTextDocument(sameLanguageUri);
    await focusDocument(sameLanguageDocument);
    const beforeSameLanguage = requests.length;
    await vscode.commands.executeCommand('commentTranslator.toggle');
    await waitUntil(() => api.getSnapshot(sameLanguageUri.toString()).phase === 'ready', 'Same-language acknowledgement must finish successfully');
    await waitForReader(api, sameLanguageDocument, 0);
    assert.equal(requests.length, beforeSameLanguage + 1);
    assert.equal(sameLanguageResponses, 1, 'The model must use the compact same-language acknowledgement');
    assert.equal(api.getSnapshot(sameLanguageUri.toString()).translated, 1, 'Same-language text counts as processed');
    assert.equal(api.getSnapshot(sameLanguageUri.toString()).reader.translated, 0, 'The reader must not duplicate text already in the target language');
    assert.equal(sameLanguageDocument.getText(), sameLanguageSource);
    assert.equal(sameLanguageDocument.isDirty, false);
    await vscode.commands.executeCommand('commentTranslator.toggle');
    await focusDocument(sameLanguageDocument);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    sameLanguageDocument = await vscode.workspace.openTextDocument(sameLanguageUri);
    await focusDocument(sameLanguageDocument);
    await vscode.commands.executeCommand('commentTranslator.toggle');
    await waitUntil(() => api.getSnapshot(sameLanguageUri.toString()).phase === 'ready', 'Reopening a same-language file must finish from SQLite');
    await waitForReader(api, sameLanguageDocument, 0);
    assert.equal(requests.length, beforeSameLanguage + 1, 'Same-language acknowledgement must be cached across file reopen');
    assert.equal(api.getSnapshot(sameLanguageUri.toString()).cacheHits, 1);
    assert.equal(api.getSnapshot(sameLanguageUri.toString()).translated, 1);
    assert.equal(sameLanguageDocument.getText(), sameLanguageSource);
    assert.equal(await fs.readFile(sameLanguagePath, 'utf8'), sameLanguageSource);
    await vscode.commands.executeCommand('commentTranslator.toggle');

    const parallelPath = path.join(project, '.vscode-test', 'parallel-comments.ts');
    const parallelSource = Array.from({ length: 12 }, (_, index) =>
      `// parallel-fixture ${index}: Translate this independent description.\nconst parallel${index} = ${index};\n`
    ).join('');
    await fs.writeFile(parallelPath, parallelSource);
    const parallelDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(parallelPath));
    await focusDocument(parallelDocument);
    const beforeParallel = requests.length;
    await vscode.commands.executeCommand('commentTranslator.toggle');
    await waitUntil(() => api.getSnapshot(parallelDocument.uri.toString()).phase === 'ready', 'Concurrent comment requests must finish');
    await waitForReader(api, parallelDocument, 12);
    assert.equal(requests.length, beforeParallel + 12, 'Each independent comment must issue its own HTTP request');
    assert.ok(requests.slice(beforeParallel).every(comments => comments.length === 1));
    assert.equal(parallelPeak, 10, 'The actual controller must use ten simultaneous requests for one file by default');
    assert.equal(parallelActive, 0);
    assert.equal(parallelDocument.getText(), parallelSource);
    assert.equal(parallelDocument.isDirty, false);
    assert.equal(await fs.readFile(parallelPath, 'utf8'), parallelSource);
    await vscode.commands.executeCommand('commentTranslator.toggle');

    if (process.env.CAPTURE_TRANSLATION_SOURCE_INLINE) {
      const inlineSource = 'const origin = 1;\nconst value = /* An inline comment before executable code. */ origin + 1;\n';
      const inlineDocument = await vscode.workspace.openTextDocument({ language: 'typescript', content: inlineSource });
      await focusDocument(inlineDocument);
      await vscode.commands.executeCommand('commentTranslator.toggle');
      await waitForReader(api, inlineDocument, 1);
      await focusDocument(inlineDocument);
      vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
      await fs.writeFile(path.join(project, '.vscode-test', 'capture-inline-ready'), 'ready');
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        try { await fs.access(path.join(project, '.vscode-test', 'capture-inline-done')); break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      assert.equal(inlineDocument.getText(), inlineSource, 'Inline visual replacement and inspection must preserve executable source');
    }
    console.log('ELECTRON_SMOKE_PASSED: startup activation, inline defaults, borderless reader DOM, unchanged source, custom provider/output/temperature/thinking settings, single-comment HTTP requests with concurrency ten, SQLite reuse, cached same-language acknowledgement without duplicate rendering, changed-comment-only requests, automatic Java/HTML/XML, indented Java/C# single-line docs, manual whole Markdown batching, context URI dispatch, disabled background Markdown, persisted disable and resume');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};
