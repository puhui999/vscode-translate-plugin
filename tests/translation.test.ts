import { describe, expect, it, vi } from 'vitest';
import { FileScheduler } from '../src/core/scheduler';
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
const MARKDOWN_CONFIG: TranslationConfig = { ...CONFIG, contentKind: 'markdown' };
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
  it('sends one logical comment per concurrent request and publishes completed comments immediately', async () => {
    const releases = new Map<string, () => void>();
    const transport = vi.fn<TranslationTransport>((request) => {
      const items = inputItems(request);
      expect(items).toHaveLength(1);
      const id = items[0]!.id;
      return new Promise((resolve) => releases.set(id, () => resolve(response([{ id, text: `译文 ${id}` }]))));
    });
    const onBatch = vi.fn();
    const promise = new TranslationService(transport).translate(ITEMS, CONFIG, signal(), onBatch);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    releases.get('b')!();
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledExactlyOnceWith(new Map([['b', '译文 b']])));
    releases.get('c')!();
    releases.get('a')!();
    expect(await promise).toEqual(new Map([['b', '译文 b'], ['c', '译文 c'], ['a', '译文 a']]));
    expect(transport.mock.calls.every(([request]) => JSON.parse(request.body).response_format === undefined)).toBe(true);
  });

  it('uses one shared concurrency limit across comments, Markdown and service instances', async () => {
    const scheduler = new FileScheduler(2);
    let active = 0;
    let peak = 0;
    const pending: (() => void)[] = [];
    const transport = vi.fn<TranslationTransport>((request) => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => pending.push(() => {
        active -= 1;
        resolve(response(inputItems(request).map(({ id }) => ({ id, text: `译文 ${id}` }))));
      }));
    });
    const first = new TranslationService(transport, { scheduler }).translate(ITEMS, { ...CONFIG, maxConcurrentRequests: 64 }, signal());
    const second = new TranslationService(transport, { scheduler }).translate(ITEMS, MARKDOWN_CONFIG, signal());
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending.shift()!();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    pending.shift()!();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(4));
    pending.splice(0).forEach((release) => release());
    expect((await first).size).toBe(3);
    expect((await second).size).toBe(3);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    scheduler.dispose();
  });

  it('defaults to at most ten simultaneous comment requests', async () => {
    const controller = new AbortController();
    const transport = vi.fn<TranslationTransport>(() => new Promise(() => {}));
    const items = Array.from({ length: 16 }, (_, i) => ({ id: String(i), text: 'A comment' }));
    const promise = new TranslationService(transport).translate(items, CONFIG, controller.signal);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(10));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transport).toHaveBeenCalledTimes(10);
    expect(transport.mock.calls.every(([, requestSignal]) => requestSignal.aborted)).toBe(true);
  });

  it('cancels the current file on authentication failure while preserving completed results and other files', async () => {
    const scheduler = new FileScheduler(2);
    let failAuthentication: (() => void) | undefined;
    const transport = vi.fn<TranslationTransport>(async (request) => {
      const item = inputItems(request)[0]!;
      if (item.id === 'bad') return new Promise((resolve) => { failAuthentication = () => resolve({ status: 401, body: '' }); });
      if (item.id === 'late') return new Promise(() => {});
      return response([{ id: item.id, text: '译文' }]);
    });
    const service = new TranslationService(transport, { scheduler });
    const onBatch = vi.fn();
    const failed = service.translate([
      { id: 'good', text: 'Valid comment' }, { id: 'bad', text: 'Invalid credentials' },
      { id: 'late', text: 'Pending request' }, { id: 'queued', text: 'Not started' },
    ], CONFIG, signal(), onBatch, 'file:a');
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledExactlyOnceWith(new Map([['good', '译文']])));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    const other = service.translate([{ id: 'other', text: 'Another file' }], CONFIG, signal(), undefined, 'file:b');
    failAuthentication!();
    await expect(failed).rejects.toMatchObject({ code: 'AUTH', partialTranslations: new Map([['good', '译文']]) });
    expect(await other).toEqual(new Map([['other', '译文']]));
    expect(transport.mock.calls.flatMap(([request]) => inputItems(request).map(({ id }) => id))).not.toContain('queued');
    expect(onBatch).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('waits for successful siblings after a non-authentication failure before returning stable partial results', async () => {
    let releaseGood: (() => void) | undefined;
    const transport = vi.fn<TranslationTransport>(async (request) => {
      const item = inputItems(request)[0]!;
      if (item.id === 'bad') return { status: 400, body: '' };
      return new Promise((resolve) => { releaseGood = () => resolve(response([{ id: item.id, text: '译文' }])); });
    });
    const onBatch = vi.fn();
    const promise = new TranslationService(transport).translate([
      { id: 'bad', text: 'Failed comment' }, { id: 'good', text: 'Successful comment' },
    ], CONFIG, signal(), onBatch);
    const settled = vi.fn();
    void promise.then(settled, settled);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(settled).not.toHaveBeenCalled();
    releaseGood!();
    await expect(promise).rejects.toMatchObject({ code: 'HTTP', partialTranslations: new Map([['good', '译文']]) });
    expect(onBatch).toHaveBeenCalledExactlyOnceWith(new Map([['good', '译文']]));
  });

  it('translates valid siblings when one comment exceeds the per-comment size limit', async () => {
    const transport = vi.fn<TranslationTransport>(async (request) => response(inputItems(request).map(({ id }) => ({ id, text: '译文' }))));
    await expect(new TranslationService(transport).translate([
      { id: 'large', text: 'x'.repeat(200) }, { id: 'small', text: 'Short' },
    ], { ...CONFIG, maxBatchChars: 64 }, signal())).rejects.toMatchObject({
      code: 'ITEM_TOO_LARGE', partialTranslations: new Map([['small', '译文']]),
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['text', 'json_object'] as const)('restores the original from the compact same-language response in %s mode', async (responseFormat) => {
    const original = '@param userId 用户标识。\n参阅 {@link User 用户类型}。';
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({
      status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"same":true}' }, finish_reason: 'stop' }] }),
    });
    const onBatch = vi.fn();
    expect(await new TranslationService(transport).translate([{ id: 'doc', text: original }], { ...CONFIG, responseFormat }, signal(), onBatch))
      .toEqual(new Map([['doc', original]]));
    expect(onBatch).toHaveBeenCalledExactlyOnceWith(new Map([['doc', original]]));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(PROMPT_VERSION).toBe('2');
  });

  it.each([
    '{"same":false}', '{"same":"true"}', '{"same":1}', '{"same":null}',
    '{"same":true,"translations":[]}', '{"same":true,"id":"a"}',
    '{"same":false,"same":true}', '{"same":true,"same":true}',
    '{"same":true,"\\u0073ame":true}', '{"same":true} trailing',
    '[{"same":true}]', '{"translations":[{"id":"a","same":true}]}',
  ])('does not expose an invalid same-language response: %s', async (content) => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({
      status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }),
    });
    const onBatch = vi.fn();
    await expect(new TranslationService(transport).translate([ITEMS[0]!], CONFIG, signal(), onBatch))
      .rejects.toMatchObject({ partialTranslations: new Map() });
    expect(transport.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(transport.mock.calls.length).toBeLessThanOrEqual(3);
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('accepts exactly one escaped same property and repairs an invalid marker without caching it', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"same":true,"same":true}' } }] }) })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '```json\n{ "\\u0073ame" : true }\n```' } }] }) });
    const onBatch = vi.fn();
    const original = '原文';
    expect(await new TranslationService(transport).translate([{ id: 'a', text: original }], CONFIG, signal(), onBatch))
      .toEqual(new Map([['a', original]]));
    expect(onBatch).toHaveBeenCalledExactlyOnceWith(new Map([['a', original]]));
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('places target variant, whole-comment and mixed-language decisions ahead of wording preferences', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'a', text: '你好。返回用户。' }]));
    const original = '你好。Return the user.';
    await new TranslationService(transport).translate([{ id: 'a', text: original }], { ...CONFIG, prompt: 'Prefer terse wording.' }, signal());
    const prompt = JSON.parse(transport.mock.calls[0]![0].body).messages[0].content as string;
    expect(prompt).toContain('entire comment');
    expect(prompt).toContain('Mixed-language comments require translation');
    expect(prompt).toContain('Simplified Chinese and Traditional Chinese are different targets');
    expect(prompt).toContain('If you cannot confidently determine');
    expect(prompt).toContain('no natural-language explanations');
    expect(prompt.indexOf('Additional wording preferences')).toBeLessThan(prompt.indexOf('The following output contract'));
    expect(inputItems(transport.mock.calls[0]![0])[0]!.text).toBe(original);
  });

  it.each(['markdown', 'json_schema'] as const)('keeps the existing %s contract without the compact marker', async (mode) => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({
      status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"same":true}' } }] }),
    });
    const config: TranslationConfig = mode === 'markdown' ? MARKDOWN_CONFIG : { ...CONFIG, responseFormat: 'json_schema' };
    await expect(new TranslationService(transport).translate([ITEMS[0]!], config, signal())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(transport).toHaveBeenCalledTimes(3);
    const body = JSON.parse(transport.mock.calls[0]![0].body);
    expect(body.messages[0].content).not.toContain('{"same":true}');
    if (mode === 'json_schema') expect(body.response_format.json_schema.schema.required).toEqual(['translations']);
  });

  it.each([undefined, 0, 0.6, 2])('sends the configured temperature %s with a default of 0.2', async (temperature) => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'a', text: '译文' }]));
    await new TranslationService(transport).translate([ITEMS[0]!], { ...CONFIG, temperature }, signal());
    expect(JSON.parse(transport.mock.calls[0]![0].body).temperature).toBe(temperature ?? 0.2);
  });

  it.each([undefined, 'provider', 'enabled', 'disabled'] as const)('applies thinking mode %s without overriding provider defaults', async (thinking) => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'a', text: '译文' }]));
    await new TranslationService(transport).translate([ITEMS[0]!], { ...CONFIG, thinking }, signal());
    const body = JSON.parse(transport.mock.calls[0]![0].body);
    if (thinking === undefined || thinking === 'provider') expect(body).not.toHaveProperty('thinking');
    else expect(body.thinking).toEqual({ type: thinking });
  });

  it.each([
    { temperature: -0.1 }, { temperature: 2.1 }, { temperature: Number.NaN }, { temperature: Number.POSITIVE_INFINITY },
    { thinking: 'auto' }, { maxConcurrentRequests: 0 }, { maxConcurrentRequests: 65 }, { maxConcurrentRequests: 1.5 },
  ])('rejects invalid inference settings before sending a request: %j', async (invalid) => {
    const transport = vi.fn<TranslationTransport>();
    await expect(new TranslationService(transport).translate([ITEMS[0]!], { ...CONFIG, ...invalid } as TranslationConfig, signal()))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses the Markdown contract and preserves formatting, code and link targets', async () => {
    const source = '# Guide\n\nUse `load()` and [the docs](https://example.test/docs).';
    const translated = '# 指南\n\n使用 `load()` 并参阅[文档](https://example.test/docs)。';
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([{ id: 'md', text: translated }]));
    const result = await new TranslationService(transport).translate([{ id: 'md', text: source }], { ...CONFIG, contentKind: 'markdown' }, signal());
    expect(result.get('md')).toBe(translated);
    const body = JSON.parse(transport.mock.calls[0][0].body);
    expect(body.messages[0].content).toContain('Markdown fragment');
    expect(body.messages[0].content).not.toContain('Translate every code comment');
    expect(inputItems(transport.mock.calls[0][0])).toEqual([{ id: 'md', text: source }]);
  });

  it.each([
    ['# Guide', '指南'],
    ['Use `load()`.', '使用 `delete()`。'],
    ['[Docs](https://example.test/docs)', '[文档](https://attacker.test)'],
    ['- First\n- Second', '- 第一项'],
  ])('repairs structurally broken Markdown without publishing invalid fragments: %s', async (source, invalid) => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce(response([{ id: 'md', text: invalid }]))
      .mockResolvedValueOnce(response([{ id: 'md', text: source }]));
    const onBatch = vi.fn();
    await new TranslationService(transport).translate([{ id: 'md', text: source }], { ...CONFIG, contentKind: 'markdown' }, signal(), onBatch);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(onBatch).toHaveBeenCalledExactlyOnceWith(new Map([['md', source]]));
  });

  it.each([
    ['@param userId The user ID.\n@returns The profile.', '用户标识与资料。', '@param userId 用户标识。\n@returns 用户资料。'],
    ['@param userId The user ID.', '@param 用户 用户标识。', '@param userId 用户标识。'],
    ['@param {string} userId The user ID.', '@param {字符串} userId 用户标识。', '@param {string} userId 用户标识。'],
    ['@throws IOException On failure.', '@throws 异常 失败时抛出。', '@throws IOException 失败时抛出。'],
    ['See {@link User#find lookup details}.', '参见 {@link User#search 查找详情}。', '参见 {@link User#find 查找详情}。'],
    ['<summary>Load user.</summary>\n<param name="userId">User ID.</param>', '<summary>加载用户。</summary>\n<param name="用户">用户标识。</param>', '<summary>加载用户。</summary>\n<param name="userId">用户标识。</param>'],
  ])('retries only structurally invalid translations before exposing them: %s', async (source, invalid, fixed) => {
    let docAttempts = 0;
    const transport = vi.fn<TranslationTransport>(async (request) => {
      const item = inputItems(request)[0]!;
      if (item.id === 'doc') return response([{ id: item.id, text: ++docAttempts === 1 ? invalid : fixed }]);
      return response([{ id: item.id, text: '普通译文' }]);
    });
    const onBatch = vi.fn();
    const result = await new TranslationService(transport).translate([
      { id: 'doc', text: source }, { id: 'plain', text: 'Ordinary comment' },
    ], CONFIG, signal(), onBatch);
    expect(transport.mock.calls.filter(([request]) => inputItems(request)[0]!.id === 'doc')).toHaveLength(2);
    expect(transport.mock.calls.filter(([request]) => inputItems(request)[0]!.id === 'plain')).toHaveLength(1);
    expect(onBatch).toHaveBeenCalledWith(new Map([['plain', '普通译文']]));
    expect(onBatch).toHaveBeenCalledWith(new Map([['doc', fixed]]));
    expect(onBatch.mock.calls.every(([batch]) => ![...batch.values()].includes(invalid))).toBe(true);
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

  it('Markdown: sends one JSON user message and matches reordered results by ID', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue(response([
      { id: 'c', text: '第三条' }, { id: 'a', text: '第一条' }, { id: 'b', text: '第二条' },
    ]));
    const onBatch = vi.fn();
    const result = await new TranslationService(transport).translate(ITEMS, MARKDOWN_CONFIG, signal(), onBatch);
    expect(result).toEqual(new Map([['c', '第三条'], ['a', '第一条'], ['b', '第二条']]));
    expect(transport).toHaveBeenCalledTimes(1);
    const request = transport.mock.calls[0]![0];
    const body = JSON.parse(request.body) as { messages: { role: string; content: string }[]; response_format?: unknown };
    expect(body.messages.map(({ role }) => role)).toEqual(['system', 'user']);
    expect(inputItems(request)).toEqual(ITEMS);
    expect(body.response_format).toBeUndefined();
    expect(onBatch).toHaveBeenCalledWith(result);
  });

  it('Markdown: splits large files into serial batches within the JSON character budget', async () => {
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
    const result = await new TranslationService(transport).translate(ITEMS, { ...MARKDOWN_CONFIG, maxBatchChars: 75 }, signal());
    expect(result.size).toBe(3);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });

  it('Markdown: retains valid results and retries only missing IDs once', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce(response([{ id: 'b', text: '第二条' }]))
      .mockResolvedValueOnce(response([{ id: 'c', text: '第三条' }, { id: 'a', text: '第一条' }]));
    const onBatch = vi.fn();
    const result = await new TranslationService(transport).translate(ITEMS, MARKDOWN_CONFIG, signal(), onBatch);
    expect(result.size).toBe(3);
    expect(inputItems(transport.mock.calls[1]![0]).map(({ id }) => id)).toEqual(['a', 'c']);
    expect(onBatch.mock.calls[0]![0]).toEqual(new Map([['b', '第二条']]));
    expect(onBatch).toHaveBeenCalledTimes(2);
  });

  it('Markdown: rejects duplicated IDs instead of choosing either translation', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce(response([
        { id: 'a', text: 'wrong 1' }, { id: 'b', text: '第二条' }, { id: 'a', text: 'wrong 2' },
      ]))
      .mockResolvedValueOnce(response([{ id: 'a', text: '第一条' }]));
    const onBatch = vi.fn();
    const result = await new TranslationService(transport).translate(ITEMS.slice(0, 2), MARKDOWN_CONFIG, signal(), onBatch);
    expect(result.get('a')).toBe('第一条');
    expect(onBatch.mock.calls[0]![0]).toEqual(new Map([['b', '第二条']]));
    expect(inputItems(transport.mock.calls[1]![0])).toEqual([ITEMS[0]]);
  });

  it('Markdown: reports persistent omissions with valid partial translations', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce(response([{ id: 'a', text: '第一条' }]))
      .mockResolvedValueOnce(response([]));
    await expect(new TranslationService(transport).translate(ITEMS, MARKDOWN_CONFIG, signal())).rejects.toMatchObject({
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

  it('Markdown: splits batches after truncated or malformed JSON', async () => {
    const transport = vi.fn<TranslationTransport>()
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"translations":[' }, finish_reason: 'length' }] }) })
      .mockImplementation(async (request) => response(inputItems(request).map(({ id }) => ({ id, text: `译文 ${id}` }))));
    const result = await new TranslationService(transport).translate(ITEMS, MARKDOWN_CONFIG, signal());
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
    const promise = new TranslationService(transport).translate([ITEMS[0]!], CONFIG, signal());
    await expect(promise).rejects.toMatchObject({ code: 'AUTH' });
    await expect(promise).rejects.not.toThrow(CONFIG.apiKey);
    await expect(promise).rejects.not.toThrow('sensitive comment');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not follow redirects with the API key', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({ status: 302, body: '', headers: { location: 'https://other.test' } });
    await expect(new TranslationService(transport).translate([ITEMS[0]!], CONFIG, signal())).rejects.toMatchObject({ code: 'REDIRECT' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('retries rate limiting a bounded number of times', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({ status: 429, body: 'private provider details' });
    await expect(new TranslationService(transport, { retryDelayMs: 0 }).translate([ITEMS[0]!], CONFIG, signal()))
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
    const promise = new TranslationService(transport).translate([ITEMS[0]!], CONFIG, controller.signal, onBatch);
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
    await expect(new TranslationService(transport, { retryDelayMs: 0 }).translate([ITEMS[0]!], { ...CONFIG, timeoutMs: 5 }, signal()))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls.every(([, requestSignal]) => requestSignal.aborted)).toBe(true);
  });

  it('limits response size before JSON parsing', async () => {
    const transport = vi.fn<TranslationTransport>().mockResolvedValue({ status: 200, body: 'x'.repeat(2 * 1024 * 1024 + 1) });
    await expect(new TranslationService(transport).translate([ITEMS[0]!], CONFIG, signal())).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport failures that contain private request details', async () => {
    const transport = vi.fn<TranslationTransport>().mockRejectedValue(new Error(`network leaked ${CONFIG.apiKey}`));
    const promise = new TranslationService(transport, { retryDelayMs: 0 }).translate([ITEMS[0]!], CONFIG, signal());
    await expect(promise).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(promise).rejects.not.toThrow(CONFIG.apiKey);
  });
});
