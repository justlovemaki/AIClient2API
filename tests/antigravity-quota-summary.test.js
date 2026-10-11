import { createAntigravityQuotaUsageLoader } from '../static/app/antigravity-quota-summary.js';

describe('Antigravity provider quota summary', () => {
    test('sums each healthy enabled account usage percentage', async () => {
        const providers = [
            { uuid: 'antigravity-a', isHealthy: true },
            { uuid: 'antigravity-b', isHealthy: true, isDisabled: false },
            { uuid: 'antigravity-c', isHealthy: false },
            { uuid: 'antigravity-d', isHealthy: true, isDisabled: true }
        ];
        const apiClient = {
            get: jest.fn(async url => url.endsWith('/antigravity-a/quota')
                ? { quota: {
                    gemini: { available: true, usedPercentage: 24.2 },
                    claude: { available: true, usedPercentage: 42.1 }
                } }
                : { quota: {
                    gemini: { available: true, usedPercentage: 79.7 },
                    claude: { available: true, usedPercentage: 15.2 }
                } })
        };
        const loadUsage = createAntigravityQuotaUsageLoader({ apiClient });

        await expect(loadUsage(providers)).resolves.toEqual({
            gemini: { available: true, usedPercent: 104, totalPercent: 200 },
            claude: { available: true, usedPercent: 57, totalPercent: 200 }
        });
        expect(apiClient.get).toHaveBeenCalledTimes(2);
        expect(apiClient.get).toHaveBeenCalledWith('/providers/gemini-antigravity/antigravity-a/quota');
    });

    test('marks the total unavailable when a healthy account quota cannot be read', async () => {
        const apiClient = { get: jest.fn().mockRejectedValue(new Error('request failed')) };
        const loadUsage = createAntigravityQuotaUsageLoader({ apiClient });

        await expect(loadUsage([{ uuid: 'antigravity-a', isHealthy: true }])).resolves.toEqual({
            gemini: { available: false, usedPercent: null, totalPercent: 100 },
            claude: { available: false, usedPercent: null, totalPercent: 100 }
        });
    });

    test('returns zero usage without requests when there are no healthy enabled accounts', async () => {
        const apiClient = { get: jest.fn() };
        const loadUsage = createAntigravityQuotaUsageLoader({ apiClient });

        await expect(loadUsage([{ uuid: 'antigravity-a', isHealthy: false }])).resolves.toEqual({
            gemini: { available: true, usedPercent: 0, totalPercent: 0 },
            claude: { available: true, usedPercent: 0, totalPercent: 0 }
        });
        expect(apiClient.get).not.toHaveBeenCalled();
    });

    test('keeps quota families independently unavailable when a group is missing', async () => {
        const apiClient = {
            get: jest.fn().mockResolvedValue({
                quota: { gemini: { available: true, usedPercentage: 52 } }
            })
        };
        const loadUsage = createAntigravityQuotaUsageLoader({ apiClient });

        await expect(loadUsage([{ uuid: 'antigravity-a', isHealthy: true }])).resolves.toEqual({
            gemini: { available: true, usedPercent: 52, totalPercent: 100 },
            claude: { available: false, usedPercent: null, totalPercent: 100 }
        });
    });

    test('does not treat an available family with a missing percentage as zero usage', async () => {
        const apiClient = {
            get: jest.fn().mockResolvedValue({
                quota: { gemini: { available: true, usedPercentage: null } }
            })
        };
        const loadUsage = createAntigravityQuotaUsageLoader({ apiClient });

        await expect(loadUsage([{ uuid: 'antigravity-a', isHealthy: true }])).resolves.toEqual({
            gemini: { available: false, usedPercent: null, totalPercent: 100 },
            claude: { available: false, usedPercent: null, totalPercent: 100 }
        });
    });
});
