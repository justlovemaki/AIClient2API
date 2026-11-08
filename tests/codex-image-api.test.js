import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import axios from 'axios';
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
const imageOutput = { type: 'image_generation_call', result: 'aW1hZ2U=', output_format: 'png' };

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
    const res = {
        writableEnded: false,
        writeHead: jest.fn(),
        end: jest.fn(function (body) {
            this.writableEnded = true;
            this.body = JSON.parse(body);
        })
    };
    expect(await handleAPIRequests('POST', route, req, res, currentConfig, null, manager)).toBe(true);
    return res;
}

function expectSlotReleased() {
    expect(pool.releaseSlot).toHaveBeenCalledTimes(1);
    expect(pool.releaseSlot).toHaveBeenCalledWith(config.MODEL_PROVIDER, 'test-node');
}

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
