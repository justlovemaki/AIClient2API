jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import { handleGetProviderQuota } from '../src/ui-modules/provider-api.js';
import { getServiceAdapter } from '../src/providers/adapter.js';

describe('provider account quota API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('normalizes grouped Antigravity summary quotas into separate Gemini and Claude usage', async () => {
        const getQuotaSummary = jest.fn().mockResolvedValue({
            source: 'summary',
            groups: [
                {
                    displayName: 'Gemini Models',
                    buckets: [
                        { bucketId: 'gemini-session', remainingFraction: 0.6 },
                        { bucketId: 'gemini-weekly', remainingFraction: 0.15 }
                    ]
                },
                {
                    displayName: 'Claude + GPT Models',
                    buckets: [
                        { bucketId: 'claude-session', remainingFraction: 0.8 },
                        { bucketId: 'claude-weekly', remainingFraction: 0.3 }
                    ]
                }
            ]
        });
        getServiceAdapter.mockReturnValue({ getQuotaSummary });
        const response = { writeHead: jest.fn(), end: jest.fn() };
        const providerPoolManager = {
            providerPools: { 'gemini-antigravity': [{ uuid: 'antigravity-account-1' }] }
        };

        await handleGetProviderQuota(
            {}, response, {}, providerPoolManager, 'gemini-antigravity', 'antigravity-account-1'
        );

        expect(response.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        const body = JSON.parse(response.end.mock.calls[0][0]);
        expect(body.quota).toEqual({
            gemini: { available: true, usedPercentage: 85 },
            claude: { available: true, usedPercentage: 70 }
        });
        expect(getQuotaSummary).toHaveBeenCalledTimes(1);
        expect(getServiceAdapter).toHaveBeenCalledWith(expect.objectContaining({
            MODEL_PROVIDER: 'gemini-antigravity',
            uuid: 'antigravity-account-1'
        }));
    });
});
