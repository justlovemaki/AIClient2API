import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import axios from 'axios';

jest.mock('axios', () => ({ __esModule: true, default: { request: jest.fn() } }));
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

let CodexApiService;
let getCodexImageEffortRetryBody;
const complexityMessage = "Complexity 'medium' is not supported for this image model.";
const image = { id: 'img_test', type: 'image_generation_call', status: 'completed', result: 'aW1hZ2U=' };
const completed = { type: 'response.completed', response: { id: 'resp_success', status: 'completed', output: [image] } };
const failure = { type: 'response.failed', response: { error: { message: complexityMessage, param: 'complexity', code: 'invalid_value' } } };

beforeAll(async () => {
    ({ CodexApiService } = await import('../src/providers/openai/codex-core.js'));
    ({ getCodexImageEffortRetryBody } = await import('../src/providers/openai/codex-request-utils.js'));
});

beforeEach(() => {
    jest.resetAllMocks();
    axios.request.mockImplementation(async (request) => responseFor(request, [completed]));
});

function service() {
    const instance = new CodexApiService({});
    instance.isInitialized = true;
    instance.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return instance;
}

function request(effort) {
    return {
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Draw a cat.' }] }],
        prompt_cache_key: 'stable-test-cache',
        ...(effort !== undefined ? { reasoning: { effort, summary: 'detailed' } } : {})
    };
}

function httpError(message = complexityMessage, status = 400) {
    const error = new Error('Upstream request failed');
    error.response = { status, data: { error: { message } } };
    return error;
}

function responseFor(requestConfig, events) {
    const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    return { data: requestConfig.responseType === 'stream' ? Readable.from([Buffer.from(text)]) : text };
}

async function collect(stream) {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
}

function assertRequestLocalRetry(expectedFirstEffort) {
    expect(axios.request).toHaveBeenCalledTimes(2);
    const [first, second] = axios.request.mock.calls.map(([config]) => config);
    expect(first.data.reasoning.effort).toBe(expectedFirstEffort);
    expect(second.data).toEqual({ ...first.data, reasoning: { ...first.data.reasoning, effort: null } });
    expect(second.headers).toEqual(first.headers);
    expect(second.data.prompt_cache_key).toBe('stable-test-cache');
}

describe.each([false, true])('Codex image-effort compatibility retry, stream=%s', (stream) => {
    async function generate(instance, model, body) {
        return stream ? collect(instance.generateContentStream(model, body)) : instance.generateContent(model, body);
    }

    test.each([
        ['gpt-5.6-sol', undefined, 'medium'],
        ['gpt-5.6-sol', 'high', 'high'],
        ['gpt-5.6-sol-fast', undefined, 'xhigh'],
        ['gpt-image-2', 'high', 'high']
    ])('%s retains reasoning on the first request and retries only the known HTTP error', async (model, effort, expected) => {
        const original = request(effort);
        const snapshot = JSON.parse(JSON.stringify(original));
        axios.request.mockRejectedValueOnce(httpError());
        const result = await generate(service(), model, original);
        assertRequestLocalRetry(expected);
        expect(original).toEqual(snapshot);
        expect(stream ? result.at(-1).response.output : result.response.output).toEqual([image]);
    });

    test('a streamed HTTP error body can be normalized before classifying it', async () => {
        const error = httpError();
        error.response.data = Readable.from([Buffer.from(JSON.stringify(error.response.data))]);
        axios.request.mockRejectedValueOnce(error);
        await generate(service(), 'gpt-5.6-sol', request());
        assertRequestLocalRetry('medium');
    });

    test('retries an early SSE parameter failure carried over HTTP 200', async () => {
        axios.request.mockImplementationOnce(async (config) => responseFor(config, [
            { type: 'response.created', response: { id: 'resp_failed_attempt' } }, failure
        ]));
        const result = await generate(service(), 'gpt-5.6-sol', request());
        assertRequestLocalRetry('medium');
        if (stream) expect(result.some(event => event.response?.id === 'resp_failed_attempt')).toBe(false);
    });

    test('retries a structured image tool complexity failure, not an assistant apology', async () => {
        axios.request.mockImplementationOnce(async (config) => responseFor(config, [{
            type: 'response.completed',
            response: {
                output: [{ type: 'image_generation_call', status: 'failed', error: { message: complexityMessage } }]
            }
        }]));
        await generate(service(), 'gpt-5.6-sol', request());
        assertRequestLocalRetry('medium');
    });

    test('a permanently failing request gets exactly one compatibility retry', async () => {
        axios.request.mockImplementation(async () => { throw httpError(); });
        await expect(generate(service(), 'gpt-5.6-sol', request())).rejects.toThrow(complexityMessage);
        assertRequestLocalRetry('medium');
    });

    test.each([
        ['unrelated 400', 'Invalid image size', 400],
        ['server failure', complexityMessage, 503],
        ['rate limit', 'Rate limit reached', 429]
    ])('does not downgrade reasoning or retry for %s', async (_label, message, status) => {
        axios.request.mockRejectedValueOnce(httpError(message, status));
        await expect(generate(service(), 'gpt-5.6-sol', request())).rejects.toThrow();
        expect(axios.request).toHaveBeenCalledTimes(1);
        expect(axios.request.mock.calls[0][0].data.reasoning.effort).toBe('medium');
    });

    test('does not retry a request that already sends null', async () => {
        axios.request.mockRejectedValueOnce(httpError());
        await expect(generate(service(), 'gpt-5.6-sol', request(null))).rejects.toThrow(complexityMessage);
        expect(axios.request).toHaveBeenCalledTimes(1);
    });

    test('ordinary chat retains its reasoning settings on subsequent requests', async () => {
        const instance = service();
        axios.request.mockRejectedValueOnce(httpError());
        await generate(instance, 'gpt-5.6-sol', request('high'));
        await generate(instance, 'gpt-5.6-sol', request('high'));
        expect(axios.request.mock.calls.map(([config]) => config.data.reasoning.effort)).toEqual(['high', null, 'high']);
    });

    test('does not retry based on a generic tool-failure apology in successful model text', async () => {
        axios.request.mockImplementationOnce(async (config) => responseFor(config, [{
            type: 'response.completed', response: {
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '图片生成工具暂时出现错误，请稍后再试。' }] }]
            }
        }]));
        await generate(service(), 'gpt-5.6-sol', request());
        expect(axios.request).toHaveBeenCalledTimes(1);
    });
});

test('a stream must not replay after emitting reasoning, text, or tool events', async () => {
    for (const event of [
        { type: 'response.reasoning_summary_text.delta', delta: 'Planning' },
        { type: 'response.output_text.delta', delta: 'Generating' },
        { type: 'response.output_item.done', item: { type: 'function_call', name: 'lookup', arguments: '{}' } }
    ]) {
        axios.request.mockClear();
        axios.request.mockImplementationOnce(async (config) => responseFor(config, [event, failure]));
        const emitted = [];
        await expect((async () => {
            for await (const chunk of service().generateContentStream('gpt-5.6-sol', request())) emitted.push(chunk);
        })()).rejects.toThrow(complexityMessage);
        expect(emitted).toEqual([event]);
        expect(axios.request).toHaveBeenCalledTimes(1);
    }
});

test('a non-stream request must not regenerate images already completed before a later failure', async () => {
    axios.request.mockImplementationOnce(async (config) => responseFor(config, [
        { type: 'response.output_item.done', item: image }, failure
    ]));
    await expect(service().generateContent('gpt-5.6-sol', request())).rejects.toThrow(complexityMessage);
    expect(axios.request).toHaveBeenCalledTimes(1);
});

test('an error item in an otherwise completed response can retry before any output is delivered', async () => {
    axios.request.mockImplementationOnce(async (config) => responseFor(config, [{
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', status: 'failed', error: { message: complexityMessage } }
    }]));
    await service().generateContent('gpt-5.6-sol', request());
    assertRequestLocalRetry('medium');
});

test('no compatibility retry without an image_generation tool', () => {
    const body = { reasoning: { effort: 'high' }, tools: [{ type: 'web_search' }] };
    expect(getCodexImageEffortRetryBody(httpError(), body)).toBeNull();
});
