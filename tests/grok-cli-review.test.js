jest.mock('../src/services/ui-manager.js', () => ({
    broadcastEvent: jest.fn()
}));
jest.mock('../src/services/service-manager.js', () => ({
    autoLinkProviderConfigs: jest.fn(),
    getProviderPoolManager: jest.fn(() => null)
}));
jest.mock('../src/core/config-manager.js', () => ({ CONFIG: {} }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    getProxyConfigForProvider: jest.fn(() => null)
}));
jest.mock('axios', () => ({
    create: jest.fn(() => ({
        post: jest.fn()
    }))
}));

import { GrokCliAuth } from '../src/auth/grok-cli-oauth.js';
import { getGrokCliTieredModels, normalizeGrokCliQuota } from '../src/ui-modules/provider-api.js';
import { getServiceAdapter } from '../src/providers/adapter.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn()
}));

describe('Grok CLI review regressions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test.each([
        ['timeout', new Error('timeout')],
        ['unauthorized', Object.assign(new Error('unauthorized'), { response: { status: 401 } })],
        ['rate limited', Object.assign(new Error('rate limited'), { response: { status: 429 } })]
    ])('keeps paid models visible when tier lookup fails with %s', async (_, error) => {
        getServiceAdapter.mockReturnValue({ getUsageLimits: jest.fn().mockRejectedValue(error) });

        const models = await getGrokCliTieredModels({
            'grok-cli-oauth': [{ uuid: 'account-1' }]
        });

        expect(models).toEqual(expect.arrayContaining(['grok-4.7-low', 'grok-4.3']))
    });

    test('normalizes quota lookup failures as unknown rather than free', () => {
        const quota = normalizeGrokCliQuota({});

        expect(quota).toMatchObject({
            available: false,
            isFree: false,
            accountTier: 'Unknown',
            tierStatus: 'unknown'
        });
    });

    test('cancels a device flow after waiting before making the next request', async () => {
        const auth = new GrokCliAuth({});
        const request = auth.httpClient.post;
        let checks = 0;

        await expect(auth.completeDeviceCodeFlow(
            { device_code: 'device', interval: 0, expires_in: 1 },
            'https://auth.x.ai/token',
            () => ++checks > 1
        )).rejects.toThrow('session was replaced');
        expect(request).not.toHaveBeenCalled();
    });

    test('cancels a device flow after an in-flight token response', async () => {
        const auth = new GrokCliAuth({});
        let cancelled = false;
        auth.httpClient.post.mockImplementation(async () => {
            cancelled = true;
            return { status: 200, data: { id_token: 'token' } };
        });

        await expect(auth.completeDeviceCodeFlow(
            { device_code: 'device', interval: 0, expires_in: 1 },
            'https://auth.x.ai/token',
            () => cancelled
        )).rejects.toThrow('session was replaced');
    });

    test('aborts an in-flight token request when the session is replaced', async () => {
        const auth = new GrokCliAuth({});
        let cancelled = false;
        let resolveRequest;
        const requestPromise = new Promise(resolve => { resolveRequest = resolve; });
        auth.httpClient.post.mockReturnValue(requestPromise);

        const flow = auth.completeDeviceCodeFlow(
            { device_code: 'device', interval: 0, expires_in: 1 },
            'https://auth.x.ai/token',
            () => cancelled
        );
        await new Promise(resolve => setTimeout(resolve, 10));
        cancelled = true;

        await expect(flow).rejects.toThrow('session was replaced');
        expect(auth.httpClient.post).toHaveBeenCalled();
        resolveRequest({ status: 200, data: { id_token: 'token' } });
    });
});