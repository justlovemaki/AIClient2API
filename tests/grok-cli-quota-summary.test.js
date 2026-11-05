import { createGrokCliQuotaUsageLoader } from '../static/app/grok-cli-quota-summary.js';

describe('Grok CLI quota summary', () => {
    test('separates paid usage from free accounts', async () => {
        const apiClient = {
            get: jest.fn()
                .mockResolvedValueOnce({
                    quota: { available: true, usedPercentage: 35, accountTier: 'SuperGrok' }
                })
                .mockResolvedValueOnce({
                    quota: { available: false, isFree: true, accountTier: 'Free' }
                })
        };

        const loadQuota = createGrokCliQuotaUsageLoader({ apiClient });
        const summary = await loadQuota([
            { uuid: 'paid', isHealthy: true, isDisabled: false },
            { uuid: 'free', isHealthy: true, isDisabled: false }
        ]);

        expect(summary).toMatchObject({
            available: true,
            usedPercent: 35,
            totalPercent: 100,
            paidAccountCount: 1,
            freeAccountCount: 1,
            unavailableAccountCount: 0
        });
    });

    test('does not report paid usage when every account is free', async () => {
        const apiClient = {
            get: jest.fn().mockResolvedValue({
                quota: { available: false, isFree: true, accountTier: 'Free' }
            })
        };

        const loadQuota = createGrokCliQuotaUsageLoader({ apiClient });
        const summary = await loadQuota([
            { uuid: 'free-a', isHealthy: true, isDisabled: false },
            { uuid: 'free-b', isHealthy: true, isDisabled: false }
        ]);

        expect(summary).toMatchObject({
            available: false,
            usedPercent: 0,
            totalPercent: 0,
            paidAccountCount: 0,
            freeAccountCount: 2,
            unavailableAccountCount: 0
        });
    });
});
