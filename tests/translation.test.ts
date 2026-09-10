import { describe, expect, it, vi } from 'vitest';
import {
  normalizeEndpoint,
  PROMPT_VERSION,
  TranslationError,
  TranslationService,
  type TranslationConfig,
  type TranslationItem,
  type TranslationTransport,
  type TransportRequest,
  type TransportResponse,
} from '../src/translation';

const CONFIG: TranslationConfig = {
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  apiKey: 'secret-test-key',
  targetLanguage: '简体中文',
  prompt: '',
  responseFormat: 'text',
  timeoutMs: 1000,
  maxBatchChars: 8000,
  maxOutputTokens: 2000,
};
const ITEMS: TranslationItem[] = [
  { id: 'a', text: 'First comment' },
  { id: 'b', text: 'Second comment' },
  { id: 'c', text: 'Third comment' },
];

function response(translations: unknown[], finishReason = 'stop'): TransportResponse {
  return {
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: finishReason }] }),
  };
}

function inputItems(request: TransportRequest): TranslationItem[] {
  const body = JSON.parse(request.body) as { messages: { content: string }[] };
  return (JSON.parse(body.messages[1]!.content) as { comments: TranslationItem[] }).comments;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('normalizeEndpoint', () => {
  it.each([
    ['https://example.test', 'https://example.test/v1/chat/completions'],
    ['https://example.test/', 'https://example.test/v1/chat/completions'],
    ['https://example.test/v1/', 'https://example.test/v1/chat/completions'],
    ['https://example.test/api/v3', 'https://example.test/api/v3/chat/completions'],
    ['https://example.test/v1/chat/completions/', 'https://example.test/v1/chat/completions'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
    ['http://127.0.0.2:1234/v1', 'http://127.0.0.2:1234/v1/chat/completions'],
    ['http://[::1]:1234/v1', 'http://[::1]:1234/v1/chat/completions'],
    ['http://192.168.1.10:8000/v1', 'http://192.168.1.10:8000/v1/chat/completions'],
    ['http://models.company.test/api/v2', 'http://models.company.test/api/v2/chat/completions'],
  ])('normalizes %s', (base, expected) => {
    expect(normalizeEndpoint(base)).toBe(expected);
  });

  it.each([
    'not-a-url', 'file:///tmp/model', 'ftp://example.test',
    'https://user:password@example.test/v1', 'https://example.test/v1?key=secret',
    'https://example.test/v1#section', 'https://example.test/v1?', 'https://example.test/v1#',
  ])('rejects unsafe or malformed endpoint %s', (base) => {
    expect(() => normalizeEndpoint(base)).toThrow(TranslationError);
  });
});

describe('TranslationService', () => {
  it.each([
    ['@param userId The user ID.\n@returns The profile.', '用户标识与资料。', '@param userId 用户标识。\n@returns 用户资料。'],
    ['@param userId The user ID.', '@param 用户 用户标识。', '@param userId 用户标识。'],
    ['@param {string} userId The user ID.', '@param {字符串} userId 用户标识。', '@param {string} userId 用户标识。'],
    ['@throws IOException On failure.', '@throws 异常 失败时抛出。', '@throws IOException 失败时抛出。'],
    ['See {@link User#find lookup details}.', '参见 {@link User#search 查找详情}。', '参见 {@link User#find 查找详情}。'],
    ['<summary>Load user.</summary>\n<param name="userId">User ID.</param>', '<summary>加载用户。</summary>\n<param name="用户">用户标识。</param>', '<summary>加载用户。</summary>\n<param name="userId">用户标识。</param>'],
  ])('retries only structurally invalid translations before exposing them: %s', async (source, invalid, fixed) => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce(response([{ id: 'doc', text: invalid }, { id: 'plain', text: '普通译文' }]))
      .mockResolvedValueOnce(response([{ id: 'doc', text: fixed }]));
    const onBatch = vi.fn();
    const result = await new TranslationService(transport).translate([
      { id: 'doc', text: source }, { id: 'plain', text: 'Ordinary comment' },
    ], CONFIG, signal(), onBatch);
    expect(inputItems(transport.mock.calls[1]![0])).toEqual([{ id: 'doc', text: source }]);
    expect(onBatch.mock.calls[0]![0]).toEqual(new Map([['plain', '普通译文']]));
    expect(onBatch.mock.calls[1]![0]).toEqual(new Map([['doc', fixed]]));
    expect(result.get('doc')).toBe(fixed);
  });

  it('never exposes or caches a structurally broken result after its one repair attempt', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'doc', text: '被删掉的标签描述。' }]));
    const onBatch = vi.fn();
    await expect(new TranslationService(transport).translate([{ id: 'doc', text: '@param userId The user ID.' }], CONFIG, signal(), onBatch))
      .rejects.toMatchObject({ code: 'MISSING_TRANSLATIONS', partialTranslations: new Map() });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('uses the new prompt contract while sending normalized comment bodies unchanged', async () => {
    const source = 'Load a user.\n\n@param userId The user ID.';
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'doc', text: '加载用户。\n\n@param userId 用户标识。' }]));
    await new TranslationService(transport).translate([{ id: 'doc', text: source }], CONFIG, signal());
    expect(PROMPT_VERSION).toBe('2');
    expect(inputItems(transport.mock.calls[0]![0])).toEqual([{ id: 'doc', text: source }]);
    const body = JSON.parse(transport.mock.calls[0]![0].body) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain('without adding external comment wrappers');
    expect(body.messages[0]!.content).toContain('blank lines');
  });

  it('preserves an arbitrary model ID and the configured intranet Chat Completions path', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'a', text: '译文' }]));
    await new TranslationService(transport).translate([ITEMS[0]!], {
      ...CONFIG,
      baseUrl: 'http://10.10.1.30:8080/custom/api/chat/completions',
      model: 'company/fine-tuned-model:release-7',
    }, signal());
    const request = transport.mock.calls[0]![0];
    expect(request.url).toBe('http://10.10.1.30:8080/custom/api/chat/completions');
    expect((JSON.parse(request.body) as { model: string }).model).toBe('company/fine-tuned-model:release-7');
  });

  it.each(['max_tokens', 'max_completion_tokens', 'omit'] as const)('supports the %s token limit convention', async (tokenLimitParameter) => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'a', text: '译文' }]));
    await new TranslationService(transport).translate([ITEMS[0]!], { ...CONFIG, tokenLimitParameter }, signal());
    const body = JSON.parse(transport.mock.calls[0]![0].body) as Record<string, unknown>;
    expect(body.max_tokens).toBe(tokenLimitParameter === 'max_tokens' ? CONFIG.maxOutputTokens : undefined);
    expect(body.max_completion_tokens).toBe(tokenLimitParameter === 'max_completion_tokens' ? CONFIG.maxOutputTokens : undefined);
  });

  it('sends one JSON user message and matches reordered results by ID', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([
      { id: 'c', text: '第三条' }, { id: 'a', text: '第一条' }, { id: 'b', text: '第二条' },
    ]));
    const onBatch = vi.fn();
    const result = await new TranslationService(transport).translate(ITEMS, CONFIG, signal(), onBatch);
    expect(result).toEqual(new Map([['c', '第三条'], ['a', '第一条'], ['b', '第二条']]));
    expect(transport).toHaveBeenCalledTimes(1);
    const request = transport.mock.calls[0]![0];
    const body = JSON.parse(request.body) as { messages: { role: string; content: string }[]; response_format?: unknown };
    expect(body.messages.map(({ role }) => role)).toEqual(['system', 'user']);
    expect(inputItems(request)).toEqual(ITEMS);
    expect(body.response_format).toBeUndefined();
    expect(onBatch).toHaveBeenCalledWith(result);
  });

  it('splits large files into serial batches within the JSON character budget', async () => {
    let active = 0;
    let maxActive = 0;
    const transport = vi.fn<TranslationTransport>(async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      const items = inputItems(request);
      const userText = (JSON.parse(request.body) as { messages: { content: string }[] }).messages[1]!.content;
      expect(userText.length).toBeLessThanOrEqual(75);
      active -= 1;
      return response(items.map(({ id }) => ({ id, text: '译文' })));
    });
    const result = await new TranslationService(transport).translate(ITEMS, { ...CONFIG, maxBatchChars: 75 }, signal());
    expect(result.size).toBe(3);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });

  it('retains valid results and retries only missing IDs once', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce(response([{ id: 'b', text: '第二条' }]))
      .mockResolvedValueOnce(response([{ id: 'c', text: '第三条' }, { id: 'a', text: '第一条' }]));
    const onBatch = vi.fn();
    const result = await new TranslationService(transport).translate(ITEMS, CONFIG, signal(), onBatch);
    expect(result.size).toBe(3);
    expect(inputItems(transport.mock.calls[1]![0]).map(({ id }) => id)).toEqual(['a', 'c']);
    expect(onBatch.mock.calls[0]![0]).toEqual(new Map([['b', '第二条']]));
    expect(onBatch).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicated IDs instead of choosing either translation', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce(response([
        { id: 'a', text: 'wrong 1' }, { id: 'b', text: '第二条' }, { id: 'a', text: 'wrong 2' },
      ]))
      .mockResolvedValueOnce(response([{ id: 'a', text: '第一条' }]));
    const onBatch = vi.fn();
    const result = await new TranslationService(transport).translate(ITEMS.slice(0, 2), CONFIG, signal(), onBatch);
    expect(result.get('a')).toBe('第一条');
    expect(onBatch.mock.calls[0]![0]).toEqual(new Map([['b', '第二条']]));
    expect(inputItems(transport.mock.calls[1]![0])).toEqual([ITEMS[0]]);
  });

  it('reports persistent omissions with valid partial translations', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce(response([{ id: 'a', text: '第一条' }]))
      .mockResolvedValueOnce(response([]));
    await expect(new TranslationService(transport).translate(ITEMS, CONFIG, signal())).rejects.toMatchObject({
      code: 'MISSING_TRANSLATIONS', partialTranslations: new Map([['a', '第一条']]),
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('detects unknown IDs while preserving verified known results', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([
      { id: 'a', text: '第一条' }, { id: 'unexpected', text: 'ignore me' },
    ]));
    await expect(new TranslationService(transport).translate([ITEMS[0]!], CONFIG, signal())).rejects.toMatchObject({
      code: 'INVALID_IDS', partialTranslations: new Map([['a', '第一条']]),
    });
  });

  it('splits batches after truncated or malformed JSON', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"translations":[' }, finish_reason: 'length' }] }) })
      .mockImplementation(async (request) => response(inputItems(request).map(({ id }) => ({ id, text: `译文 ${id}` }))));
    const result = await new TranslationService(transport).translate(ITEMS, CONFIG, signal());
    expect(result.size).toBe(3);
    expect(transport.mock.calls.map(([request]) => inputItems(request).length)).toEqual([3, 2, 1]);
  });

  it('limits malformed-response retries for a single comment', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({ status: 200, body: 'bad JSON' });
    await expect(new TranslationService(transport).translate([ITEMS[0]!], CONFIG, signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('accepts JSON fenced by a text-mode compatible model', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '```json\n{"translations":[{"id":"a","text":"译文"}]}\n```' } }] }),
    });
    expect((await new TranslationService(transport).translate([ITEMS[0]!], CONFIG, signal())).get('a')).toBe('译文');
  });

  it.each(['json_object', 'json_schema'] as const)('supports opt-in %s response format', async (format) => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'a', text: '译文' }]));
    await new TranslationService(transport).translate([ITEMS[0]!], { ...CONFIG, responseFormat: format }, signal());
    const body = JSON.parse(transport.mock.calls[0]![0].body) as { response_format: { type: string; json_schema?: { strict: boolean } } };
    expect(body.response_format.type).toBe(format);
    if (format === 'json_schema') expect(body.response_format.json_schema?.strict).toBe(true);
  });

  it('rejects a single oversized comment before sending any request', async () => {
    const transport = vi.fn<TranslationTransport>();
    await expect(new TranslationService(transport).translate([{ id: 'a', text: 'x'.repeat(100) }], { ...CONFIG, maxBatchChars: 64 }, signal()))
      .rejects.toMatchObject({ code: 'ITEM_TOO_LARGE', retryable: true });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects repeated input IDs before sending requests', async () => {
    const transport = vi.fn<TranslationTransport>();
    await expect(new TranslationService(transport).translate([ITEMS[0]!, ITEMS[0]!], CONFIG, signal()))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('makes no request for an empty file', async () => {
    const transport = vi.fn<TranslationTransport>();
    expect(await new TranslationService(transport).translate([], CONFIG, signal())).toEqual(new Map());
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails authentication immediately and never exposes response text or API key', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({ status: 401, body: `sensitive comment ${CONFIG.apiKey}` });
    const promise = new TranslationService(transport).translate(ITEMS, CONFIG, signal());
    await expect(promise).rejects.toMatchObject({ code: 'AUTH' });
    await expect(promise).rejects.not.toThrow(CONFIG.apiKey);
    await expect(promise).rejects.not.toThrow('sensitive comment');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not follow redirects with the API key', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({ status: 302, body: '', headers: { location: 'https://other.test' } });
    await expect(new TranslationService(transport).translate(ITEMS, CONFIG, signal())).rejects.toMatchObject({ code: 'REDIRECT' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('retries rate limiting a bounded number of times', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({ status: 429, body: 'private provider details' });
    await expect(new TranslationService(transport, { retryDelayMs: 0 }).translate(ITEMS, CONFIG, signal()))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('recovers after a transient rate limit without duplicating successful callbacks', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce({ status: 429, body: '' })
      .mockResolvedValueOnce(response([{ id: 'a', text: '译文' }]));
    const onBatch = vi.fn();
    expect((await new TranslationService(transport, { retryDelayMs: 0 }).translate([ITEMS[0]!], CONFIG, signal(), onBatch)).size).toBe(1);
    expect(onBatch).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight request even when the injected transport ignores its signal', async () => {
    const controller = new AbortController();
    const transport = vi.fn<TranslationTransport>(() => new Promise(() => {}));
    const onBatch = vi.fn();
    const promise = new TranslationService(transport).translate(ITEMS, CONFIG, controller.signal, onBatch);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transport.mock.calls[0]![1].aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('does not send requests when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn<TranslationTransport>();
    await expect(new TranslationService(transport).translate(ITEMS, CONFIG, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('times out transports and retries only a bounded number of times', async () => {
    const transport = vi.fn<TranslationTransport>(() => new Promise(() => {}));
    await expect(new TranslationService(transport, { retryDelayMs: 0 }).translate(ITEMS, { ...CONFIG, timeoutMs: 5 }, signal()))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls.every(([, requestSignal]) => requestSignal.aborted)).toBe(true);
  });

  it('limits response size before JSON parsing', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({ status: 200, body: 'x'.repeat(2 * 1024 * 1024 + 1) });
    await expect(new TranslationService(transport).translate(ITEMS, CONFIG, signal())).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport failures that contain private request details', async () => {
    const transport = vi.fn<TranslationTransport>().mockRejectedValue(new Error(`network leaked ${CONFIG.apiKey}`));
    const promise = new TranslationService(transport, { retryDelayMs: 0 }).translate(ITEMS, CONFIG, signal());
    await expect(promise).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(promise).rejects.not.toThrow(CONFIG.apiKey);
  });
});
