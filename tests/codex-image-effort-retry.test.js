import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import axios from 'axios';
import { incompleteImageEvents } from './fixtures/codex-incomplete-image-stream.js';

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

function service(config = {}) {
    const instance = new CodexApiService(config);
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

describe('Replay of the HTTP-200 unfinished-image failure from app-2026-11-08.log', () => {
    test.each([false, true])('recovers the actual image segment without clearing normal reasoning, stream=%s', async (stream) => {
        const original = request('high');
        const snapshot = JSON.parse(JSON.stringify(original));
        const recovered = { ...completed, response: {
            ...completed.response,
            usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300,
                input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 10 } },
            tool_usage: { image_gen: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }
        } };
        axios.request.mockImplementationOnce(async config => responseFor(config, incompleteImageEvents()));
        axios.request.mockImplementationOnce(async config => responseFor(config, [recovered]));
        const instance = service({ CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' });
        const events = stream ? await collect(instance.generateContentStream('gpt-5.6-sol', original)) : null;
        const result = stream ? events.at(-1) : await instance.generateContent('gpt-5.6-sol', original);
        const [first, second] = axios.request.mock.calls.map(([config]) => config);
        expect(axios.request).toHaveBeenCalledTimes(2);
        expect(first.data.reasoning.effort).toBe('high');
        expect(second.data.model).toBe('gpt-6.1-sol');
        expect(second.data.reasoning.effort).toBeNull();
        expect(second.data.tools).toEqual([{ type: 'image_generation' }]);
        expect(second.data.tool_choice).toEqual({ type: 'image_generation' });
        expect(second.data.instructions).toBe('You are a helpful assistant.');
        expect(second.data.input).toEqual(first.data.input);
        expect(second.data.prompt_cache_key).toBe(first.data.prompt_cache_key);
        expect(second.headers.authorization).toBe(first.headers.authorization);
        expect(original).toEqual(snapshot);
        expect(result.response.id).toBe('resp_original');
        expect(result.response.output.map(item => item.id)).toEqual(['rs_before_image', image.id]);
        expect(result.response.usage.total_tokens).toBe(5692);
        expect(result.response.usage.input_tokens_details.cached_tokens).toBe(4432);
        expect(result.response.usage.output_tokens_details.reasoning_tokens).toBe(42);
        expect(result.response.tool_usage.image_gen.total_tokens).toBe(30);
        expect(JSON.stringify(result)).not.toContain('抱歉');
        if (stream) {
            expect(events.filter(event => event.type === 'response.created')).toHaveLength(1);
            expect(events.filter(event => event.type === 'response.completed')).toHaveLength(1);
            expect(events.filter(event => event.type === 'response.reasoning_summary_text.delta')).toHaveLength(1);
            expect(events.some(event => event.type === 'response.output_text.delta')).toBe(false);
            const added = events.find(event => event.type === 'response.output_item.added' && event.item.type === 'image_generation_call');
            const done = events.find(event => event.type === 'response.output_item.done' && event.item.type === 'image_generation_call');
            expect(added.item.id).toBe(done.item.id);
            expect(added.output_index).toBe(1);
            expect(done.output_index).toBe(1);
            for (let i = 1; i < events.length; i++) expect(events[i].sequence_number).toBeGreaterThan(events[i - 1].sequence_number);
        }
        await instance.generateContent('gpt-5.6-sol', request('high'));
        expect(axios.request.mock.calls.at(-1)[0].data.reasoning.effort).toBe('high');
    });

    test.each([false, true])('recovery with no image produces a bounded error, stream=%s', async (stream) => {
        axios.request.mockImplementation(async config => responseFor(config, incompleteImageEvents()));
        const instance = service();
        const operation = stream ? collect(instance.generateContentStream('gpt-5.6-sol', request()))
            : instance.generateContent('gpt-5.6-sol', request());
        await expect(operation).rejects.toMatchObject({
            response: { status: 502 }, imageRecoveryAttempted: true, skipErrorCount: true
        });
        expect(axios.request).toHaveBeenCalledTimes(2);
    });

    test('a recovery HTTP error must not trigger a third compatibility request', async () => {
        axios.request.mockImplementationOnce(async config => responseFor(config, incompleteImageEvents()));
        axios.request.mockRejectedValueOnce(httpError());
        await expect(service().generateContent('gpt-5.6-sol', request())).rejects.toMatchObject({ imageRecoveryAttempted: true });
        expect(axios.request).toHaveBeenCalledTimes(2);
    });

    test.each(['already-null', 'image-produced', 'billed-image', 'policy-error', 'no-image-attempt', 'async-background', 'missing-usage'])(
        'does not replay an ineligible response: %s', async mode => {
            for (const stream of [false, true]) {
                axios.request.mockClear();
                const events = incompleteImageEvents();
                const final = events.at(-1).response;
                if (mode === 'image-produced') final.output[1].result = image.result;
                if (mode === 'billed-image') final.tool_usage.image_gen.total_tokens = 100;
                if (mode === 'async-background') final.background = true;
                if (mode === 'missing-usage') delete final.tool_usage;
                if (mode === 'policy-error') {
                    for (const item of final.output.filter(item => item.type === 'image_generation_call')) {
                        item.status = 'failed';
                        item.error = { code: 'content_policy_violation', message: 'Blocked by image safety policy' };
                    }
                }
                if (mode === 'no-image-attempt') final.output = final.output.filter(item => item.type !== 'image_generation_call');
                axios.request.mockImplementationOnce(async config => responseFor(config, events));
                const instance = service();
                const body = request(mode === 'already-null' ? null : undefined);
                if (stream) await collect(instance.generateContentStream('gpt-5.6-sol', body));
                else await instance.generateContent('gpt-5.6-sol', body);
                expect(axios.request).toHaveBeenCalledTimes(1);
            }
        }
    );

    test('interleaved prefix reasoning still closes before the recovered image segment', async () => {
        const events = incompleteImageEvents();
        const index = events.findIndex(event => event.type === 'response.output_item.done' && event.item.id === 'rs_before_image');
        const [done] = events.splice(index, 1);
        events.splice(8, 0, done);
        events.forEach((event, sequence_number) => { event.sequence_number = sequence_number; });
        axios.request.mockImplementationOnce(async config => responseFor(config, events));
        const emitted = await collect(service().generateContentStream('gpt-5.6-sol', request()));
        const prefixDone = emitted.findIndex(event => event.type === 'response.output_item.done' && event.item.id === 'rs_before_image');
        const imageAdded = emitted.findIndex(event => event.type === 'response.output_item.added' && event.item.type === 'image_generation_call');
        expect(prefixDone).toBeGreaterThan(0);
        expect(prefixDone).toBeLessThan(imageAdded);
        for (let i = 1; i < emitted.length; i++) expect(emitted[i].sequence_number).toBeGreaterThan(emitted[i - 1].sequence_number);
    });

    test('successful interleaved streams remain sequence-safe when the buffered image tail is flushed', async () => {
        const events = incompleteImageEvents();
        const index = events.findIndex(event => event.type === 'response.output_item.done' && event.item.id === 'rs_before_image');
        const [done] = events.splice(index, 1);
        events.splice(8, 0, done);
        events.splice(-1, 0, { type: 'response.output_item.done', output_index: 1, item: { ...image, id: 'ig_first' } });
        events.forEach((event, sequence_number) => { event.sequence_number = sequence_number; });
        axios.request.mockImplementationOnce(async config => responseFor(config, events));
        const emitted = await collect(service().generateContentStream('gpt-5.6-sol', request()));
        expect(axios.request).toHaveBeenCalledTimes(1);
        for (let i = 1; i < emitted.length; i++) expect(emitted[i].sequence_number).toBeGreaterThan(emitted[i - 1].sequence_number);
    });

    test.each([false, true])('does not regenerate a result omitted from the terminal envelope, stream=%s', async stream => {
        const events = incompleteImageEvents();
        events.splice(-1, 0, {
            type: 'response.output_item.done', output_index: 1,
            item: { ...image, id: 'ig_first' }
        });
        axios.request.mockImplementationOnce(async config => responseFor(config, events));
        const instance = service();
        const result = stream ? (await collect(instance.generateContentStream('gpt-5.6-sol', request()))).at(-1)
            : await instance.generateContent('gpt-5.6-sol', request());
        expect(axios.request).toHaveBeenCalledTimes(1);
        expect(result.response.output.find(item => item.id === 'ig_first').result).toBe(image.result);
    });

    test.each(['function-call', 'partial-image', 'buffer-limit', 'no-terminal-event'])(
        'does not replay or hide unsafe/bounded stream tails: %s', async mode => {
            const events = incompleteImageEvents();
            const extra = mode === 'function-call'
                ? { type: 'response.output_item.done', item: { id: 'fn1', type: 'function_call', name: 'lookup', arguments: '{}' } }
                : mode === 'partial-image'
                    ? { type: 'response.image_generation_call.partial_image', partial_image_b64: 'cGFydGlhbA==' }
                    : { type: 'response.output_text.delta', delta: 'x'.repeat(1024 * 1024 + 1) };
            if (mode === 'no-terminal-event') events.pop();
            else events.splice(7, 0, extra);
            axios.request.mockImplementationOnce(async config => responseFor(config, events));
            const emitted = await collect(service().generateContentStream('gpt-5.6-sol', request()));
            expect(axios.request).toHaveBeenCalledTimes(1);
            if (mode !== 'no-terminal-event') expect(emitted).toContainEqual(extra);
        }
    );
});

test('no compatibility retry without an image_generation tool', () => {
    const body = { reasoning: { effort: 'high' }, tools: [{ type: 'web_search' }] };
    expect(getCodexImageEffortRetryBody(httpError(), body)).toBeNull();
});
