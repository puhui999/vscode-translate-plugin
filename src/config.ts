import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { normalizeEndpoint, type TranslationConfig } from './translation';

export const CONFIG_SECTION = 'commentTranslator';

/** Creates a credential key scoped to the normalized provider endpoint. */
export function secretKey(baseUrl: string): string {
  return `apiKey:${createHash('sha256').update(normalizeEndpoint(baseUrl)).digest('hex')}`;
}

/** Reads provider settings without including credentials, checking manually edited values. */
export function readSettings(uri?: vscode.Uri): Omit<TranslationConfig, 'apiKey'> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
  const baseUrl = config.get<string>('baseUrl', '').trim();
  const model = config.get<string>('model', '').trim();
  if (!baseUrl || !model) {
    throw new Error('请在设置中填写 commentTranslator.baseUrl 和 model，或运行“注释译读：配置模型服务”。');
  }
  normalizeEndpoint(baseUrl);
  const format = config.get<string>('responseFormat', 'json_object');
  if (!['text', 'json_object', 'json_schema'].includes(format)) {
    throw new Error('responseFormat 必须是 text、json_object 或 json_schema。');
  }
  const tokenLimitParameter = config.get<string>('tokenLimitParameter', 'max_tokens');
  if (!['max_tokens', 'max_completion_tokens', 'omit'].includes(tokenLimitParameter)) {
    throw new Error('tokenLimitParameter 必须是 max_tokens、max_completion_tokens 或 omit。');
  }
  const thinking = config.get<string>('thinking', 'provider');
  if (!['provider', 'enabled', 'disabled'].includes(thinking)) {
    throw new Error('thinking 必须是 provider、enabled 或 disabled。');
  }
  const globalConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    baseUrl,
    model,
    targetLanguage: config.get<string>('targetLanguage', '简体中文').trim() || '简体中文',
    prompt: config.get<string>('prompt', ''),
    responseFormat: format as TranslationConfig['responseFormat'],
    temperature: boundedNumber(config, 'temperature', 0.2, 0, 2, false),
    thinking: thinking as TranslationConfig['thinking'],
    maxConcurrentRequests: boundedNumber(globalConfig, 'maxConcurrentRequests', 10, 1, 64),
    timeoutMs: boundedNumber(config, 'timeoutSeconds', 60, 5, 300) * 1000,
    maxBatchChars: boundedNumber(config, 'maxBatchChars', 16000, 1000, 200000),
    maxOutputTokens: boundedNumber(config, 'maxOutputTokens', 8192, 512, 65536),
    tokenLimitParameter: tokenLimitParameter as TranslationConfig['tokenLimitParameter'],
  };
}

/** Prefers a nonempty user setting, then reads credentials scoped to the selected endpoint. */
export async function readApiKey(context: vscode.ExtensionContext, baseUrl: string, uri?: vscode.Uri): Promise<string> {
  const configured = vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get<string>('apiKey', '').trim();
  if (configured) return configured;
  return await context.secrets.get(secretKey(baseUrl)) ?? '';
}

/** Removes the configured plaintext key and the current provider's stored secret. */
export async function clearProviderApiKey(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const baseUrl = config.get<string>('baseUrl', '').trim();
  await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
  if (!baseUrl) return;
  let keyName: string;
  try { keyName = secretKey(baseUrl); }
  catch { return; }
  await context.secrets.delete(keyName);
}

/** Reads a bounded numeric setting, rounding down integers and rejecting non-finite values. */
export function boundedNumber(config: vscode.WorkspaceConfiguration, key: string, fallback: number, min: number, max: number, integer = true): number {
  const value = config.get<number>(key, fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, integer ? Math.floor(value) : value)) : fallback;
}

/** Configures any compatible provider, keeping an existing settings key synchronized. */
export async function configureProvider(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const baseUrl = await vscode.window.showInputBox({
    title: '注释译读 · 服务地址',
    prompt: '注释将直接发送到此模型服务；支持 /v1 或完整 /chat/completions 地址。',
    value: config.get<string>('baseUrl', ''),
    placeHolder: 'https://your-provider.example/v1',
    ignoreFocusOut: true,
    validateInput(value) {
      try { normalizeEndpoint(value.trim()); return undefined; }
      catch { return '请输入有效的 HTTP/HTTPS 服务地址，不包含账号、密码、查询参数或片段。'; }
    },
  });
  if (baseUrl === undefined) return;
  const model = await vscode.window.showInputBox({
    title: '注释译读 · 模型名称',
    prompt: '填写该服务支持的模型 ID。',
    value: config.get<string>('model', ''),
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : '模型名称不能为空。',
  });
  if (model === undefined) return;
  const keyName = secretKey(baseUrl.trim());
  const configuredKey = config.get<string>('apiKey', '').trim();
  let sameProvider = false;
  try { sameProvider = normalizeEndpoint(config.get<string>('baseUrl', '')) === normalizeEndpoint(baseUrl); }
  catch { /* An unset previous provider has no credentials to reuse from settings. */ }
  const existing = (sameProvider ? configuredKey : '') || await context.secrets.get(keyName);
  const apiKey = await vscode.window.showInputBox({
    title: '注释译读 · API Key',
    prompt: [
      existing ? '输入新 Key，留空则保留此服务已有 Key。' : 'Key 将存入 VS Code 加密存储；无需认证的服务可留空。',
      configuredKey ? '输入新 Key 时也会同步更新已有的用户设置 apiKey。' : '',
    ].filter(Boolean).join(' '),
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) return;
  if (apiKey.trim()) {
    await context.secrets.store(keyName, apiKey.trim());
    if (configuredKey) await config.update('apiKey', apiKey.trim(), vscode.ConfigurationTarget.Global);
  } else if (configuredKey && !sameProvider) {
    // A setting for the previous service must not override the selected service's secret.
    await config.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
  }
  await config.update('baseUrl', baseUrl.trim(), vscode.ConfigurationTarget.Global);
  await config.update('model', model.trim(), vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(config.get<boolean>('automatic', true)
    ? '模型服务已配置。打开 Java 等受支持的源码文件后会自动翻译注释。'
    : '模型服务已配置。自动翻译当前关闭，可在翻译设置中开启，或手动开启当前文件翻译。');
}
