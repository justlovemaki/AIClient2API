import { createAntigravityQuotaUsageLoader } from '../static/app/antigravity-quota-summary.js';

describe('Antigravity quota summary loader', () => {
    test('loads healthy enabled accounts and aggregates their quota', async () => {
        const apiClient = { get: jest.fn()
            .mockResolvedValueOnce({ quota: { available: true, usedPercentage: 25 } })
            .mockResolvedValueOnce({ quota: { available: true, usedPercentage: 50 } }) };
        const load = createAntigravityQuotaUsageLoader({ apiClient });

        await expect(load([
            { uuid: 'one', isHealthy: true, isDisabled: false },
            { uuid: 'two', isHealthy: true },
            { uuid: 'skip-unhealthy', isHealthy: false },
            { uuid: 'skip-disabled', isHealthy: true, isDisabled: true }
        ])).resolves.toEqual({ available: true, usedPercent: 75, totalPercent: 200 });
        expect(apiClient.get).toHaveBeenCalledWith('/providers/gemini-antigravity/one/quota');
        expect(apiClient.get).toHaveBeenCalledWith('/providers/gemini-antigravity/two/quota');
    });

    test('reports unavailable when all quota requests fail or are unavailable', async () => {
        const apiClient = { get: jest.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ quota: { available: false, usedPercentage: null } }) };
        const load = createAntigravityQuotaUsageLoader({ apiClient });

        await expect(load([
            { uuid: 'one', isHealthy: true },
            { uuid: 'two', isHealthy: true }
        ])).resolves.toEqual({ available: false, usedPercent: 0, totalPercent: 200 });
    });
});
