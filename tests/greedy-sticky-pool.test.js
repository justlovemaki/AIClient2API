import { jest } from '@jest/globals';

jest.mock('../src/utils/proxy-utils.js', () => ({
    getProxyConfig: jest.fn()
}));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

let ProviderPoolManager;
let getServiceAdapter;
let logger;

beforeAll(async () => {
    ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));
    ({ getServiceAdapter } = await import('../src/providers/adapter.js'));
    logger = (await import('../src/utils/logger.js')).default;
});

const now = Date.now();
const later = minutes => new Date(now + minutes * 60000).toISOString();

const managers = [];

function pool(scheduler) {
    const manager = new ProviderPoolManager({
        'openai-custom': [
            node('high', 0.9, 20),
            node('low', 0.2, 100)
        ]
    }, {
        globalConfig: { ACCOUNT_SCHEDULER: scheduler, QUOTA_REFRESH_STAGGER_MS: 0 },
        saveDebounceTime: 100000
    });
    manager._getBaseProviderType = () => 'gemini-antigravity';
    manager._debouncedSave = () => {};
    managers.push(manager);
    return manager;
}

afterEach(() => {
    for (const manager of managers) clearTimeout(manager.saveTimer);
    managers.length = 0;
});

function node(uuid, remaining, minutes) {
    return {
        uuid,
        isHealthy: true,
        isDisabled: false,
        quotaWindows: {
            weekly: { remainingFraction: remaining, resetAt: later(minutes) },
            fiveHour: { remainingFraction: 1, resetAt: later(60) }
        },
        quotaWindowsUpdatedAt: now
    };
}

describe('optional greedy sticky pool selection', () => {
    test('the default scheduler keeps the existing least-recently-used rotation', async () => {
        const manager = pool('lru');
        const first = await manager.acquireSlot('openai-custom', null, { sessionId: 'conversation' });
        const second = await manager.acquireSlot('openai-custom', null, { sessionId: 'conversation' });
        expect(first.uuid).not.toBe(second.uuid);
    });

    test('greedy sticky keeps one conversation on the greediest account', async () => {
        const manager = pool('greedy-sticky');
        const first = await manager.selectProviderWithFallback('openai-custom', null, { sessionId: 'conversation' });
        const second = await manager.selectProviderWithFallback('openai-custom', null, { sessionId: 'conversation' });
        expect(first.config.uuid).toBe('high');
        expect(second.config.uuid).toBe('high');
        manager.releaseSlot('openai-custom', first.config.uuid);
        manager.releaseSlot('openai-custom', second.config.uuid);
    });

    test('a later higher-ranked account does not steal a bound conversation', async () => {
        const manager = pool('greedy-sticky');
        await manager.selectProviderWithFallback('openai-custom', null, { sessionId: 'conversation' });
        manager.providerStatus['openai-custom'][0].config.quotaWindows.weekly.remainingFraction = 0.1;
        manager.providerStatus['openai-custom'][1].config.quotaWindows.weekly.remainingFraction = 0.9;
        const next = await manager.selectProviderWithFallback('openai-custom', null, { sessionId: 'conversation' });
        expect(next.config.uuid).toBe('high');
    });

    test('selecting an account does not query Google for quota', async () => {
        const quota = jest.fn(async () => ({}));
        getServiceAdapter.mockImplementation(() => ({ antigravityApiService: { getQuotaSummary: quota } }));
        const manager = pool('greedy-sticky');
        await manager.selectProviderWithFallback('openai-custom', null, { sessionId: 'conversation' });
        expect(quota).not.toHaveBeenCalled();
        getServiceAdapter.mockReset();
    });

    test('a full account sends a different conversation to the next account', async () => {
        const manager = pool('greedy-sticky');
        for (let i = 0; i < 3; i += 1) {
            await manager.acquireSlot('openai-custom', null, { sessionId: `conversation-${i}` });
        }
        const fourth = await manager.acquireSlot('openai-custom', null, { sessionId: 'conversation-4' });
        expect(fourth.uuid).toBe('low');
    });

    test('startup queries quota once before any user request and records the result', async () => {
        getServiceAdapter.mockClear();
        logger.info.mockClear();
        getServiceAdapter.mockImplementation(config => ({
            antigravityApiService: {
                getQuotaSummary: jest.fn(async () => ({
                    groups: [{
                        buckets: [
                            { bucketId: 'gemini-weekly', remainingFraction: config.uuid === 'high' ? 0.9 : 0.2, resetTime: later(100) },
                            { bucketId: 'gemini-5h', remainingFraction: 0.5, resetTime: later(60) }
                        ]
                    }]
                }))
            }
        }));
        const manager = pool('greedy-sticky');
        manager.refreshQuotaOnStartup();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(manager.providerStatus['openai-custom'][0].config.quotaWindows.weekly.remainingFraction).toBeCloseTo(0.9);
        expect(manager.providerStatus['openai-custom'][1].config.quotaWindows.weekly.remainingFraction).toBeCloseTo(0.2);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[Quota Refresh] startup'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('weekly 90%'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('5h 50%'));
    });

    test('marking the bound account unhealthy lets the next request move', async () => {
        const manager = pool('greedy-sticky');
        await manager.selectProviderWithFallback('openai-custom', null, { sessionId: 'conversation' });
        manager.markProviderUnhealthyImmediately('openai-custom', { uuid: 'high' }, 'token refresh failed');
        const next = await manager.selectProviderWithFallback('openai-custom', null, { sessionId: 'conversation' });
        expect(next.config.uuid).toBe('low');
    });

    test('an exhausted account is skipped and the next account serves the retry', async () => {
        const manager = pool('greedy-sticky');
        manager.markProviderUnhealthy('openai-custom', { uuid: 'high' }, 'quota exhausted');
        const selected = await manager.acquireSlot('openai-custom', null, {
            sessionId: 'conversation',
            excludeUuids: ['high']
        });
        expect(selected.uuid).toBe('low');
    });
});
