import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import axios from 'axios';
import { incompleteImageEvents } from './fixtures/codex-incomplete-image-stream.js';
import { getApiServiceWithFallback } from '../src/services/service-manager.js';

jest.mock('axios', () => ({ __esModule: true, default: { request: jest.fn() } }));
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
    getApiServiceWithFallback: jest.fn()
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

let handleAPIRequests;
let CodexApiService;
let pool;
const config = { MODEL_PROVIDER: 'openai-codex-oauth', providerPools: {} };
const imageOutput = { id: 'ig_recovered', type: 'image_generation_call', status: 'completed', result: 'aW1hZ2U=', output_format: 'png' };

beforeAll(async () => {
    await import('../src/converters/register-converters.js');
    ({ handleAPIRequests } = await import('../src/services/api-manager.js'));
    ({ CodexApiService } = await import('../src/providers/openai/codex-core.js'));
});

beforeEach(() => {
    jest.clearAllMocks();
    const service = new CodexApiService(config);
    service.isInitialized = true;
    service.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    getApiServiceWithFallback.mockResolvedValue({
        service, uuid: 'test-node', actualProviderType: config.MODEL_PROVIDER
    });
    pool = {
        releaseSlot: jest.fn(),
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn()
    };
    axios.request.mockResolvedValue({ data: `data: ${JSON.stringify({
        type: 'response.completed', response: { output: [imageOutput] }
    })}\n\n` });
});

function request(body = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify({ prompt: 'Draw a cat.', size: '768x1024', ...body }))]);
    req.headers = { 'content-type': 'application/json' };
    return req;
}

function editRequest() {
    const boundary = 'test-image-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nEdit this cat.\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="cat.png"\r\nContent-Type: image/png\r\n\r\nimage\r\n`
        + `--${boundary}--\r\n`;
    const req = Readable.from([Buffer.from(body)]);
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    req.complete = true;
    return req;
}

async function dispatch(req, route = '/v1/images/generations', currentConfig = config, manager = pool) {
    const res = Object.assign(new EventEmitter(), {
        writableEnded: false,
        chunks: [],
        writeHead: jest.fn(),
        write: jest.fn(function (chunk) {
            this.chunks.push(chunk);
            return true;
        }),
        end: jest.fn(function (body) {
            this.writableEnded = true;
            if (body) this.body = JSON.parse(body);
        })
    });
    expect(await handleAPIRequests('POST', route, req, res, currentConfig, null, manager)).toBe(true);
    return res;
}

function expectSlotReleased() {
    expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
    expect(pool.releaseSlot).toHaveBeenCalledWith(config.MODEL_PROVIDER, 'test-node');
}

describe('Codex Chat / Responses image transport (mock upstream, not live generation)', () => {
    test.each([
        ['gpt-image-2', null],
        ['gpt-image-2-fast', null],
        ['gpt-5.6-sol', 'medium'],
        ['gpt-5.6-sol-fast', 'xhigh']
    ])('%s keeps the image tool and delivers images through Chat / Responses', async (model, effort) => {
        for (const route of ['/v1/chat/completions', '/v1/responses']) {
            for (const stream of [false, true]) {
                const response = { id: 'resp_chat_image', model: 'gpt-5.6-sol', status: 'completed', output: [imageOutput] };
                const events = [
                    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
                    { type: 'response.completed', response }
                ];
                const sse = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
                // This tests response transport only, not whether the live upstream will generate an image.
                axios.request.mockImplementation(async (upstream) => ({
                    data: upstream.responseType === 'stream' ? Readable.from([Buffer.from(sse)]) : sse
                }));
                const req = request({
                    model, stream,
                    messages: [{ role: 'user', content: 'Generate an image of a cat.' }],
                    input: 'Generate an image of a cat.'
                });
                const res = await dispatch(req, route);
                const upstream = axios.request.mock.calls.at(-1)[0].data;
                expect(upstream.tools).toEqual(expect.arrayContaining([
                    expect.objectContaining({ type: 'image_generation' })
                ]));
                expect(upstream.reasoning.effort).toBe(effort);
                expect(upstream.input).toEqual(expect.arrayContaining([
                    expect.objectContaining({ role: 'user' })
                ]));
                if (stream) {
                    expect(res.chunks.join('')).toContain(imageOutput.result);
                    if (route.endsWith('/completions')) {
                        expect(res.chunks.join('')).toContain('data:image/png;base64,');
                        expect(res.chunks.join('')).toContain('[DONE]');
                    }
                } else {
                    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
                    if (route.endsWith('/completions')) {
                        expect(res.body.choices[0].message.content).toContain(`data:image/png;base64,${imageOutput.result}`);
                    } else {
                        expect(res.body.output).toEqual(expect.arrayContaining([
                            expect.objectContaining({ type: 'image_generation_call', result: imageOutput.result })
                        ]));
                    }
                }
                expect(res.writableEnded).toBe(true);
            }
        }
    });
});

describe.each(['/v1/chat/completions', '/v1/responses'])('Request-local complexity recovery at %s', (route) => {
    test.each([false, true])('only the failed request is downgraded, stream=%s', async (stream) => {
        const message = "Complexity 'high' is not supported for this image model.";
        axios.request.mockImplementation(async (upstream) => {
            const events = [{ type: 'response.completed', response: { id: 'resp_success', output: [imageOutput] } }];
            const sse = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
            return { data: upstream.responseType === 'stream' ? Readable.from([Buffer.from(sse)]) : sse };
        });
        const error = new Error(message);
        error.response = { status: 400, data: { error: { message, param: 'complexity' } } };
        axios.request.mockRejectedValueOnce(error);
        const body = {
            model: 'gpt-5.6-sol', stream,
            messages: [{ role: 'user', content: 'Draw a cat.' }], input: 'Draw a cat.',
            reasoning: { effort: 'high' }
        };
        const res = await dispatch(request(body), route);
        expect(axios.request.mock.calls.map(([config]) => config.data.reasoning.effort)).toEqual(['high', null]);
        expect(getApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(pool.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        if (stream) expect(res.chunks.join('')).toContain(imageOutput.result);
        else expect(JSON.stringify(res.body)).toContain(imageOutput.result);

        await dispatch(request(body), route);
        expect(axios.request.mock.calls.map(([config]) => config.data.reasoning.effort)).toEqual(['high', null, 'high']);
    });
});

describe.each(['/v1/chat/completions', '/v1/responses'])('Logged unfinished image-call recovery at %s', (route) => {
    test.each([false, true])('returns an image instead of the buffered apology, stream=%s', async (stream) => {
        axios.request.mockImplementationOnce(async config => {
            const text = incompleteImageEvents().map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
            return { data: config.responseType === 'stream' ? Readable.from([Buffer.from(text)]) : text };
        });
        const success = `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_helper', output: [imageOutput] } })}\n\n`;
        axios.request.mockResolvedValueOnce({ data: success });
        const res = await dispatch(request({
            model: 'gpt-5.6-sol', stream,
            messages: [{ role: 'user', content: 'Draw a cat.' }], input: 'Draw a cat.'
        }), route);
        expect(axios.request).toHaveBeenCalledTimes(2);
        const [first, second] = axios.request.mock.calls.map(([config]) => config.data);
        expect(first.reasoning.effort).toBe('medium');
        expect(second.reasoning.effort).toBeNull();
        expect(second.tools).toEqual([{ type: 'image_generation' }]);
        expect(second.tool_choice).toEqual({ type: 'image_generation' });
        const output = stream ? res.chunks.join('') : JSON.stringify(res.body);
        expect(output).toContain(imageOutput.result);
        expect(output).not.toContain('抱歉');
        if (stream && route.endsWith('/completions')) {
            expect(output.match(/data:image\/png;base64,/g)).toHaveLength(1);
            expect(output.match(/Planning image generation/g)).toHaveLength(1);
        }
        if (stream && route === '/v1/responses') {
            const events = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
            expect(events.filter(event => event.type === 'response.created')).toHaveLength(1);
            expect(events.filter(event => event.type === 'response.completed')).toHaveLength(1);
            expect(events.at(-1).response.id).toBe('resp_original');
            for (let i = 1; i < events.length; i++) expect(events[i].sequence_number).toBeGreaterThan(events[i - 1].sequence_number);
        }
        expect(getApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expectSlotReleased();
    });

    test.each([false, true])('does not switch credentials or loop if image-only recovery also fails, stream=%s', async (stream) => {
        axios.request.mockImplementation(async config => {
            const text = incompleteImageEvents().map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
            return { data: config.responseType === 'stream' ? Readable.from([Buffer.from(text)]) : text };
        });
        const res = await dispatch(request({
            model: 'gpt-5.6-sol', stream,
            messages: [{ role: 'user', content: 'Draw a cat.' }], input: 'Draw a cat.'
        }), route);
        expect(axios.request).toHaveBeenCalledTimes(2);
        expect(getApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        if (stream) expect(res.chunks.join('')).toContain('image recovery failed');
        else expect(res.writeHead).toHaveBeenCalledWith(502, expect.any(Object));
        expectSlotReleased();
    });
});

describe('Explicit image-model effort parity across endpoint payloads', () => {
    test.each([undefined, null, 'medium', 'high', 'xhigh'])(
        'an explicit image model preserves the same effort across endpoints for input %s', async (effort) => {
            const routes = ['/v1/images/generations', '/v1/chat/completions', '/v1/responses'];
            const payloads = [];
            for (const route of routes) {
                const res = await dispatch(request({
                    model: 'gpt-image-2',
                    messages: [{ role: 'user', content: 'Draw a cat.' }],
                    input: 'Draw a cat.',
                    reasoning: { effort }
                }), route);
                expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
                payloads.push(axios.request.mock.calls.at(-1)[0].data);
            }
            expect(payloads.map(payload => payload.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-5.6-sol']);
            const expectedEffort = effort === undefined ? null : effort;
            expect(payloads.map(payload => payload.reasoning.effort)).toEqual([expectedEffort, expectedEffort, expectedEffort]);
            for (const payload of payloads) {
                expect(payload.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_generation' })]));
            }
        }
    );
});

describe('Codex Images API regression (#759)', () => {
    test.each([
        ['no reasoning', {}, null],
        ['explicit null', { reasoning: { effort: null, summary: 'detailed' } }, null],
        ['top-level null', { reasoning_effort: null }, null],
        ['explicit effort', { reasoning: { effort: 'high' } }, 'high']
    ])('passes %s through the Images endpoint to the upstream request', async (_label, body, effort) => {
        const res = await dispatch(request(body));
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        expect(res.body.data).toEqual([{ b64_json: imageOutput.result }]);
        expect(axios.request).toHaveBeenCalledTimes(1);
        const upstream = axios.request.mock.calls[0][0].data;
        expect(upstream.model).toBe('gpt-5.6-sol');
        expect(upstream.reasoning.effort).toBe(effort);
        if (body.reasoning?.summary) expect(upstream.reasoning.summary).toBe('detailed');
        expect(upstream.tools).toEqual([{ type: 'image_generation', size: '768x1024' }]);
        expect(upstream).not.toHaveProperty('reasoning_effort');
        expectSlotReleased();
    });

    test('image editing also defaults effort to null', async () => {
        const res = await dispatch(editRequest(), '/v1/images/edits');
        expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        expect(axios.request.mock.calls[0][0].data.reasoning.effort).toBeNull();
        expectSlotReleased();
    });

    test.each(['/v1/images/generations', '/v1/images/edits'])(
        '%s preserves upstream 400 without credential penalties or retries', async (route) => {
            const message = "Complexity 'medium' is not supported for this image model.";
            const error = new Error('Request failed with status code 400');
            error.response = { status: 400, data: JSON.stringify({ error: { message } }) };
            axios.request.mockRejectedValue(error);

            const res = await dispatch(route.endsWith('/edits') ? editRequest() : request(), route);
            expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
            expect(res.body.error.type).toBe('invalid_request_error');
            expect(res.body.error.message).toContain(message);
            expect(axios.request).toHaveBeenCalledTimes(1);
            expect(getApiServiceWithFallback).toHaveBeenCalledTimes(1);
            expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
            expect(pool.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
            expectSlotReleased();
        }
    );

    test('an SSE response.failed parameter error remains HTTP 400 without retries', async () => {
        axios.request.mockResolvedValue({ data: `data: ${JSON.stringify({
            type: 'response.failed',
            response: { error: { code: 'invalid_request_error', message: 'Invalid image parameter' } }
        })}\n\n` });
        const res = await dispatch(request());
        expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        expect(res.body.error.type).toBe('invalid_request_error');
        expect(axios.request).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expectSlotReleased();
    });

    test('HTTP 422 parameter errors do not penalize or switch credentials', async () => {
        const error = new Error('Invalid size');
        error.response = { status: 422, data: { error: { message: error.message } } };
        axios.request.mockRejectedValue(error);
        const res = await dispatch(request());
        expect(res.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
        expect(axios.request).toHaveBeenCalledTimes(1);
        expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
        expectSlotReleased();
    });

    test('still switches credentials on an explicit insufficient_quota SSE error', async () => {
        const random = jest.spyOn(Math, 'random').mockReturnValue(0);
        try {
            axios.request.mockResolvedValueOnce({ data: `data: ${JSON.stringify({
                type: 'error', error: { code: 'insufficient_quota', message: 'Quota exhausted' }
            })}\n\n` });
            const res = await dispatch(request({ reasoning: { effort: null } }));
            expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
            expect(getApiServiceWithFallback).toHaveBeenCalledTimes(2);
            expect(axios.request).toHaveBeenCalledTimes(2);
            for (const [upstream] of axios.request.mock.calls) {
                expect(upstream.data.reasoning.effort).toBeNull();
            }
            expect(pool.releaseSlot).toHaveBeenCalledTimes(2);
        } finally {
            random.mockRestore();
        }
    });

    test.each([
        [401, 'authentication_error'],
        [403, 'permission_error'],
        [422, 'invalid_request_error'],
        [429, 'rate_limit_error'],
        [503, 'server_error'],
        [undefined, 'server_error']
    ])('preserves status %s and maps its error type without a pool', async (status, type) => {
        const error = new Error('Upstream failure');
        if (status) error.response = { status, data: { error: { message: error.message } } };
        axios.request.mockRejectedValue(error);
        const res = await dispatch(request(), '/v1/images/generations', { MODEL_PROVIDER: config.MODEL_PROVIDER }, null);
        expect(res.writeHead).toHaveBeenCalledWith(status || 500, expect.any(Object));
        expect(res.body.error.type).toBe(type);
        expect(axios.request).toHaveBeenCalledTimes(1);
    });

    test('a body-limit error retains its local HTTP status', async () => {
        const res = await dispatch(request(), '/v1/images/generations', { ...config, REQUEST_BODY_MAX_BYTES: 1 });
        expect(res.writeHead).toHaveBeenCalledWith(413, expect.any(Object));
        expect(res.body.error.type).toBe('invalid_request_error');
        expect(axios.request).not.toHaveBeenCalled();
    });
});
