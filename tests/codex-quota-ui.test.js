import { createCodexQuotaBadgeLoader, createCodexQuotaUsageLoader } from '../static/app/codex-quota-badges.js';

describe('Codex provider quota badges', () => {
    const translations = {
        'providers.codexQuota.fiveHour': '5h',
        'providers.codexQuota.weekly': 'weekly',
        'providers.codexQuota.monthly': 'monthly',
        'providers.codexQuota.unknownReset': 'reset unknown',
        'providers.codexQuota.unknownPlan': 'Unknown plan',
        'providers.codexQuota.unavailable': 'Codex quota unavailable'
    };

    const translate = (key, params = {}) => {
        if (key === 'providers.codexQuota.windowUsed') return `${params.window} ${params.percent}% used`;
        if (key === 'providers.codexQuota.details') return `${params.plan} plan · ${params.windows}`;
        return translations[key] || key;
    };

    const createBadge = uuid => ({ dataset: { providerUuid: uuid }, isConnected: true, textContent: 'Loading Codex quota...', title: '' });
    const createContainer = badges => ({ querySelectorAll: () => badges });

    test('fetches every configured account on open and renders visible account percentages', async () => {
        const providers = Array.from({ length: 8 }, (_, index) => ({ uuid: `codex-${index + 1}` }));
        const visibleBadges = providers.slice(0, 5).map(provider => createBadge(provider.uuid));
        const apiClient = { get: jest.fn(async url => ({ quota: { available: true, planType: 'plus', windows: [
            { key: 'fiveHour', usedPercentage: 32, resetsAt: 1_800_003_600 },
            { key: 'weekly', usedPercentage: 57, resetsAt: 1_800_604_800 }
        ], account: url } })) };
        const loadBadges = createCodexQuotaBadgeLoader({ apiClient, translate });

        await loadBadges(createContainer(visibleBadges), { forceRefresh: true, providers });

        expect(apiClient.get).toHaveBeenCalledTimes(providers.length);
        expect(visibleBadges[0].textContent).toBe('5h 32% used · weekly 57% used');
        expect(visibleBadges[0].title).toContain('plus plan');
    });

    test('refreshes every account when the provider modal is opened again', async () => {
        const providers = [{ uuid: 'codex-a' }, { uuid: 'codex-b' }];
        const apiClient = { get: jest.fn().mockResolvedValue({ quota: { available: true, planType: 'free', windows: [{ key: 'monthly', usedPercentage: 81, resetsAt: null }] } }) };
        const loadBadges = createCodexQuotaBadgeLoader({ apiClient, translate });
        const container = createContainer(providers.map(provider => createBadge(provider.uuid)));

        await loadBadges(container, { forceRefresh: true, providers });
        await loadBadges(container, { forceRefresh: true, providers });
        expect(apiClient.get).toHaveBeenCalledTimes(providers.length * 2);
    });

    test('sums the highest quota window for each healthy enabled account', async () => {
        const providers = [
            { uuid: 'codex-a', isHealthy: true },
            { uuid: 'codex-b', isHealthy: true, isDisabled: false },
            { uuid: 'codex-c', isHealthy: false },
            { uuid: 'codex-d', isHealthy: true, isDisabled: true }
        ];
        const apiClient = { get: jest.fn(async url => url.endsWith('/codex-a/quota')
            ? { quota: { available: true, windows: [{ usedPercentage: 32 }, { usedPercentage: 57 }] } }
            : { quota: { available: true, windows: [{ usedPercentage: 81.4 }] } }) };
        const loadUsage = createCodexQuotaUsageLoader({ apiClient });

        await expect(loadUsage(providers)).resolves.toEqual({ available: true, usedPercent: 138, totalPercent: 200 });
        expect(apiClient.get).toHaveBeenCalledTimes(2);
        expect(apiClient.get).toHaveBeenCalledWith('/providers/openai-codex-oauth/codex-a/quota');
    });

    test('marks the aggregate unavailable if a healthy account quota cannot be read', async () => {
        const apiClient = { get: jest.fn().mockRejectedValue(new Error('request failed')) };
        const loadUsage = createCodexQuotaUsageLoader({ apiClient });
        await expect(loadUsage([{ uuid: 'codex-a', isHealthy: true }])).resolves.toEqual({ available: false, usedPercent: null, totalPercent: 100 });
    });

    test('returns zero usage without requests when there are no healthy enabled accounts', async () => {
        const apiClient = { get: jest.fn() };
        const loadUsage = createCodexQuotaUsageLoader({ apiClient });
        await expect(loadUsage([{ uuid: 'codex-a', isHealthy: false }])).resolves.toEqual({ available: true, usedPercent: 0, totalPercent: 0 });
        expect(apiClient.get).not.toHaveBeenCalled();
    });
});
