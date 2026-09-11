import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { clearProviderApiKey, configureProvider, readApiKey, readSettings, secretKey } from '../src/config';

const HOST = vi.hoisted(() => {
  const settings = new Map<string, unknown>();
  const configuration = {
    get: <T>(key: string, fallback: T): T => settings.has(key) ? settings.get(key) as T : fallback,
    update: vi.fn(async (key: string, value: unknown, _target: number) => {
      if (value === undefined) settings.delete(key);
      else settings.set(key, value);
    }),
  };
  return {
    settings,
    configuration,
    workspace: { getConfiguration: vi.fn((..._args: unknown[]) => configuration) },
    window: {
      showInputBox: vi.fn(async (..._args: unknown[]) => undefined as string | undefined),
      showInformationMessage: vi.fn(async (..._args: unknown[]) => undefined),
    },
  };
});

vi.mock('vscode', () => ({ workspace: HOST.workspace, window: HOST.window, ConfigurationTarget: { Global: 1 } }));

function credentials(entries: [string, string][] = []) {
  const stored = new Map(entries);
  const secrets = {
    get: vi.fn(async (key: string) => stored.get(key)),
    store: vi.fn(async (key: string, value: string) => { stored.set(key, value); }),
    delete: vi.fn(async (key: string) => { stored.delete(key); }),
  };
  return { context: { secrets } as unknown as vscode.ExtensionContext, secrets, stored };
}

describe('provider configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HOST.window.showInputBox.mockReset();
    HOST.settings.clear();
    HOST.settings.set('baseUrl', 'https://example.test/v1');
    HOST.settings.set('model', 'custom/model-v2');
  });

  it('reads any compatible endpoint and model directly from settings without credential data', () => {
    HOST.settings.set('baseUrl', 'http://192.168.50.2:8000/custom/v1');
    HOST.settings.set('model', 'arbitrary-provider/my-model:revision-9');
    HOST.settings.set('apiKey', 'dummy-configured-key');
    HOST.settings.set('tokenLimitParameter', 'max_completion_tokens');
    const settings = readSettings();
    expect(settings).toMatchObject({
      baseUrl: 'http://192.168.50.2:8000/custom/v1',
      model: 'arbitrary-provider/my-model:revision-9',
      tokenLimitParameter: 'max_completion_tokens',
    });
    expect(settings).not.toHaveProperty('apiKey');
  });

  it('defaults to JSON Object, ten concurrent requests, decimal temperature and provider thinking', () => {
    expect(readSettings()).toMatchObject({
      responseFormat: 'json_object',
      maxConcurrentRequests: 10,
      temperature: 0.2,
      thinking: 'provider',
    });
  });

  it.each(['text', 'json_object', 'json_schema'])(
    'retains the explicitly selected %s output format', (format) => {
      HOST.settings.set('responseFormat', format);
      expect(readSettings().responseFormat).toBe(format);
    },
  );

  it.each(['provider', 'enabled', 'disabled'])(
    'reads the %s thinking preference', (thinking) => {
      HOST.settings.set('thinking', thinking);
      expect(readSettings().thinking).toBe(thinking);
    },
  );

  it('rejects unsupported output and thinking settings', () => {
    HOST.settings.set('responseFormat', 'xml');
    expect(() => readSettings()).toThrow('responseFormat');
    HOST.settings.set('responseFormat', 'json_object');
    HOST.settings.set('thinking', 'automatic');
    expect(() => readSettings()).toThrow('thinking');
  });

  it.each([
    [0, 1], [-5, 1], [64, 64], [100, 64], [12.8, 12],
    [Number.NaN, 10], [Number.POSITIVE_INFINITY, 10], ['12', 10],
  ])('normalizes a manually edited concurrency value %s to %s', (value, expected) => {
    HOST.settings.set('maxConcurrentRequests', value);
    expect(readSettings().maxConcurrentRequests).toBe(expected);
  });

  it.each([
    [0, 0], [0.35, 0.35], [1.75, 1.75], [2, 2], [-0.5, 0], [3, 2],
    [Number.NaN, 0.2], [Number.POSITIVE_INFINITY, 0.2], ['0.8', 0.2],
  ])('preserves or bounds temperature %s to %s without integer rounding', (value, expected) => {
    HOST.settings.set('temperature', value);
    expect(readSettings().temperature).toBe(expected);
  });

  it('reads the shared concurrency limit without a document resource override', () => {
    const uri = { scheme: 'file', path: '/example.java' } as vscode.Uri;
    const resourceConfig = {
      ...HOST.configuration,
      get: <T>(key: string, fallback: T): T => key === 'maxConcurrentRequests'
        ? 64 as T : HOST.configuration.get(key, fallback),
    };
    HOST.settings.set('maxConcurrentRequests', 7);
    HOST.workspace.getConfiguration.mockImplementationOnce(() => resourceConfig)
      .mockImplementationOnce(() => HOST.configuration);
    expect(readSettings(uri).maxConcurrentRequests).toBe(7);
    expect(HOST.workspace.getConfiguration).toHaveBeenNthCalledWith(1, 'commentTranslator', uri);
    expect(HOST.workspace.getConfiguration).toHaveBeenNthCalledWith(2, 'commentTranslator');
  });

  it('prefers a nonempty settings key over a stored provider secret', async () => {
    const { context, secrets } = credentials([[secretKey('https://example.test/v1'), 'dummy-stored-key']]);
    HOST.settings.set('apiKey', '  dummy-configured-key  ');
    expect(await readApiKey(context, 'https://example.test/v1')).toBe('dummy-configured-key');
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it('falls back from an empty settings key to the normalized endpoint secret', async () => {
    const { context, secrets } = credentials([[secretKey('https://example.test/v1'), 'dummy-stored-key']]);
    HOST.settings.set('apiKey', '   ');
    expect(await readApiKey(context, 'https://example.test/v1/chat/completions')).toBe('dummy-stored-key');
    expect(secrets.get).toHaveBeenCalledWith(secretKey('https://example.test/v1'));
  });

  it('allows an unauthenticated server when neither key source is populated', async () => {
    const { context } = credentials();
    expect(await readApiKey(context, 'http://10.0.0.50:8080/v1')).toBe('');
  });

  it('keeps token limit omission configurable and rejects unsupported parameter names', () => {
    HOST.settings.set('tokenLimitParameter', 'omit');
    expect(readSettings().tokenLimitParameter).toBe('omit');
    HOST.settings.set('tokenLimitParameter', 'invented_parameter');
    expect(() => readSettings()).toThrow('tokenLimitParameter');
  });

  it('synchronizes a new wizard key with an existing settings key so it cannot mask the new secret', async () => {
    const { context, stored } = credentials([[secretKey('https://example.test/v1'), 'dummy-old-secret']]);
    HOST.settings.set('apiKey', 'dummy-old-settings-key');
    HOST.window.showInputBox.mockResolvedValueOnce('https://example.test/v1')
      .mockResolvedValueOnce('another/custom-model').mockResolvedValueOnce('dummy-new-key');
    await configureProvider(context);
    expect(await readApiKey(context, 'https://example.test/v1')).toBe('dummy-new-key');
    expect(HOST.settings.get('apiKey')).toBe('dummy-new-key');
    expect(stored.get(secretKey('https://example.test/v1'))).toBe('dummy-new-key');
    expect(HOST.window.showInputBox.mock.calls[2]![0]).toMatchObject({ password: true });
  });

  it('stores a wizard key only in SecretStorage when no plaintext key is configured', async () => {
    const { context, stored } = credentials();
    HOST.window.showInputBox.mockResolvedValueOnce('http://10.1.1.20:8080/v1')
      .mockResolvedValueOnce('local/custom-model').mockResolvedValueOnce('dummy-local-key');
    await configureProvider(context);
    expect(HOST.settings.has('apiKey')).toBe(false);
    expect(stored.get(secretKey('http://10.1.1.20:8080/v1'))).toBe('dummy-local-key');
    expect(HOST.settings.get('model')).toBe('local/custom-model');
  });

  it('does not reuse the previous provider plaintext key after switching services with a blank wizard key', async () => {
    const nextProvider = 'https://another-provider.test/compatible/v1';
    const { context } = credentials([[secretKey(nextProvider), 'dummy-next-provider-key']]);
    HOST.settings.set('apiKey', 'dummy-previous-provider-key');
    HOST.window.showInputBox.mockResolvedValueOnce(nextProvider)
      .mockResolvedValueOnce('custom-next-model').mockResolvedValueOnce('');
    await configureProvider(context);
    expect(HOST.settings.has('apiKey')).toBe(false);
    expect(await readApiKey(context, nextProvider)).toBe('dummy-next-provider-key');
  });

  it('preserves the same provider settings key when wizard input is blank', async () => {
    const { context } = credentials();
    HOST.settings.set('apiKey', 'dummy-existing-key');
    HOST.window.showInputBox.mockResolvedValueOnce('https://example.test/v1/chat/completions')
      .mockResolvedValueOnce('custom/model-v3').mockResolvedValueOnce('');
    await configureProvider(context);
    expect(await readApiKey(context, 'https://example.test/v1')).toBe('dummy-existing-key');
  });

  it('cancels the wizard without changing configured values or secrets', async () => {
    const { context, secrets } = credentials();
    HOST.window.showInputBox.mockResolvedValueOnce('https://another-provider.test/v1')
      .mockResolvedValueOnce('another-model').mockResolvedValueOnce(undefined);
    await configureProvider(context);
    expect(HOST.configuration.update).not.toHaveBeenCalled();
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it('deletes both key sources for the current provider while retaining other provider secrets', async () => {
    const current = secretKey('https://example.test/v1');
    const other = secretKey('https://another-provider.test/v1');
    const { context, stored } = credentials([[current, 'dummy-current-key'], [other, 'dummy-other-key']]);
    HOST.settings.set('apiKey', 'dummy-configured-key');
    await clearProviderApiKey(context);
    expect(HOST.settings.has('apiKey')).toBe(false);
    expect(stored.has(current)).toBe(false);
    expect(stored.has(other)).toBe(true);
    expect(await readApiKey(context, 'https://example.test/v1')).toBe('');
  });

  it('can still clear a settings key when the endpoint has not been configured', async () => {
    const { context, secrets } = credentials();
    HOST.settings.delete('baseUrl');
    HOST.settings.set('apiKey', 'dummy-configured-key');
    await clearProviderApiKey(context);
    expect(HOST.settings.has('apiKey')).toBe(false);
    expect(secrets.delete).not.toHaveBeenCalled();
  });
});
