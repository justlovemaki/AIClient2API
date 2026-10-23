jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: config => config,
    isTLSSidecarEnabledForProvider: () => false,
    getProxyConfigForProvider: () => null
}));
jest.mock('../src/utils/tls-sidecar.js', () => ({
    ensureSidecarRunning: jest.fn(),
    stopSidecar: jest.fn()
}));
jest.mock('../src/providers/gemini/antigravity-core.js', () => ({
    isAntigravityModelRetired: jest.fn(() => false)
}));

import {
    extractAntigravitySchedulerContext,
    AntigravitySessionAffinityManager,
    getAntigravitySessionAffinityManager,
    resetAntigravitySessionAffinityManager
} from '../src/providers/gemini/antigravity-sticky-scheduler.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { MODEL_PROVIDER } from '../src/utils/constants.js';

describe('Antigravity sticky session scheduler', () => {
    beforeEach(() => {
        resetAntigravitySessionAffinityManager();
    });

    test('defaults to sticky and extracts metadata.user_id.session_id', () => {
        const context = extractAntigravitySchedulerContext(
            { headers: {} },
            { metadata: { user_id: JSON.stringify({ session_id: 'agy-session-1' }) } }
        );

        expect(context).toEqual({
            mode: 'sticky',
            isRoundRobin: false,
            sessionId: 'agy-session-1'
        });
    });

    test('supports round-robin opt-out through header and query string', () => {
        expect(extractAntigravitySchedulerContext(
            { headers: { 'x-account-scheduler': 'round-robin' } },
            { metadata: { session_id: 'session-1' } }
        ).isRoundRobin).toBe(true);

        expect(extractAntigravitySchedulerContext(
            { headers: { host: 'localhost' }, url: '/v1/chat/completions?scheduler=round-robin' },
            { metadata: { session_id: 'session-1' } }
        ).isRoundRobin).toBe(true);
    });

    test('derives a stable session ID from the first user message', () => {
        const first = extractAntigravitySchedulerContext(
            { headers: {} },
            { messages: [{ role: 'user', content: 'start this agent task' }] }
        );
        const second = extractAntigravitySchedulerContext(
            { headers: {} },
            { messages: [
                { role: 'user', content: 'start this agent task' },
                { role: 'assistant', content: 'acknowledged' }
            ] }
        );

        expect(first.sessionId).toMatch(/^-[0-9]+$/);
        expect(second.sessionId).toBe(first.sessionId);
    });

    test('derives a stable session ID from native Gemini contents parts', () => {
        const first = extractAntigravitySchedulerContext(
            { headers: {} },
            { contents: [{ role: 'user', parts: [{ text: 'start this native Gemini task' }] }] }
        );
        const second = extractAntigravitySchedulerContext(
            { headers: {} },
            { contents: [
                { role: 'user', parts: [{ text: 'start this native Gemini task' }] },
                { role: 'model', parts: [{ text: 'acknowledged' }] }
            ] }
        );

        expect(first.sessionId).toMatch(/^-[0-9]+$/);
        expect(second.sessionId).toBe(first.sessionId);
    });

    test('does not invent a session ID for an empty single-turn request', () => {
        const context = extractAntigravitySchedulerContext({ headers: {} }, { messages: [] });
        expect(context.sessionId).toBeNull();
    });

    function createPoolManager(accounts) {
        const manager = new ProviderPoolManager({});
        manager.providerStatus[MODEL_PROVIDER.ANTIGRAVITY] = accounts.map(account => ({
            uuid: account.uuid,
            type: MODEL_PROVIDER.ANTIGRAVITY,
            config: {
                uuid: account.uuid,
                customName: account.uuid,
                isHealthy: true,
                isDisabled: false,
                needsRefresh: false,
                usageCount: 0,
                lastUsed: account.lastUsed || new Date(0).toISOString(),
                _lastSelectionSeq: account.sequence || 0
            },
            state: { activeCount: 0, waitingCount: 0, queue: [] }
        }));
        return manager;
    }

    test('keeps a conversation on the same account across turns', async () => {
        const pool = createPoolManager([
            { uuid: 'agy-1' },
            { uuid: 'agy-2' }
        ]);

        const first = await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low', {
            sessionId: 'conversation-1'
        });
        const second = await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low', {
            sessionId: 'conversation-1'
        });

        expect(first.uuid).toBe(second.uuid);
    });

    test('uses quota for initial placement but never rebalances a warm session', async () => {
        const pool = createPoolManager([
            { uuid: 'agy-low' },
            { uuid: 'agy-high' }
        ]);
        const manager = getAntigravitySessionAffinityManager();
        const now = Date.now();
        manager.updateQuota('agy-low', {
            groups: { low: { bucketId: 'gemini-weekly', remainingFraction: 0.1, resetTime: new Date(now + 60 * 60 * 1000).toISOString() } }
        });
        manager.updateQuota('agy-high', {
            groups: { high: { bucketId: 'gemini-weekly', remainingFraction: 0.9, resetTime: new Date(now + 60 * 60 * 1000).toISOString() } }
        });

        const first = await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low', {
            sessionId: 'quota-session'
        });
        expect(first.uuid).toBe('agy-high');

        manager.updateQuota('agy-low', {
            groups: { low: { bucketId: 'gemini-weekly', remainingFraction: 1, resetTime: new Date(now + 60 * 60 * 1000).toISOString() } }
        });
        const second = await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low', {
            sessionId: 'quota-session'
        });
        expect(second.uuid).toBe(first.uuid);
    });

    test('uses the parent model ID when quotaInfo is nested in a real usage response', () => {
        const manager = new AntigravitySessionAffinityManager();
        const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        manager.updateQuota('gemini-account', {
            models: {
                'gemini-3.8-flash-low': {
                    quotaInfo: {
                        remainingFraction: 0.75,
                        resetTime
                    }
                },
                'gemini-claude-sonnet-4-6': {
                    quotaInfo: {
                        remainingFraction: 0.25,
                        resetTime
                    }
                }
            }
        });

        expect(manager.getQuotaScore('gemini-account', 'gemini-3.8-flash-low')).toBeGreaterThan(0);
        expect(manager.getQuotaScore('gemini-account', 'gemini-claude-sonnet-4-6')).toBeGreaterThan(0);
        expect(manager.isQuotaExhausted('gemini-account', 'gemini-3.8-flash-low')).toBe(false);
    });

    test('keeps quota priority ahead of LRU ordering', async () => {
        const pool = createPoolManager([
            { uuid: 'quota-high', lastUsed: new Date().toISOString() },
            { uuid: 'quota-low', lastUsed: new Date(0).toISOString() }
        ]);
        const manager = getAntigravitySessionAffinityManager();
        const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        manager.updateQuota('quota-high', {
            models: { 'gemini-3.8-flash-low': { quotaInfo: { remainingFraction: 0.9, resetTime } } }
        });
        manager.updateQuota('quota-low', {
            models: { 'gemini-3.8-flash-low': { quotaInfo: { remainingFraction: 0.1, resetTime } } }
        });

        await expect(pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low'))
            .resolves.toMatchObject({ uuid: 'quota-high' });
    });

    test('does not construct an adapter when a quota snapshot is fresh', async () => {
        const pool = createPoolManager([{ uuid: 'fresh-quota' }]);
        const manager = getAntigravitySessionAffinityManager();
        manager.updateQuota('fresh-quota', {
            models: { 'gemini-3.8-flash-low': { quotaInfo: { remainingFraction: 0.8 } } }
        });
        const { getServiceAdapter } = await import('../src/providers/adapter.js');
        getServiceAdapter.mockClear();

        await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low');

        expect(getServiceAdapter).not.toHaveBeenCalled();
    });

    test('refreshes quota asynchronously and caches the result', async () => {
        const manager = new AntigravitySessionAffinityManager({ quotaRefreshIntervalMs: 60 * 60 * 1000 });
        const usage = { groups: { flash: { bucketId: 'gemini-weekly', remainingFraction: 0.75 } } };
        const fetchQuota = jest.fn(async () => usage);

        expect(await manager.refreshQuota('agy-refresh', fetchQuota)).toBe(true);
        expect(fetchQuota).toHaveBeenCalledTimes(1);
        expect(manager.getQuotaScore('agy-refresh', 'gemini-3.8-flash-low')).toBeGreaterThan(0);
        expect(await manager.refreshQuota('agy-refresh', fetchQuota)).toBe(false);
        expect(fetchQuota).toHaveBeenCalledTimes(1);
    });

    test('scores Gemini and 3p quota books independently for initial placement', async () => {
        const pool = createPoolManager([
            { uuid: 'gemini-ready' },
            { uuid: '3p-ready' }
        ]);
        const manager = getAntigravitySessionAffinityManager();
        const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        manager.updateQuota('gemini-ready', {
            groups: [
                { bucketId: 'gemini-weekly', remainingFraction: 0.9, resetTime },
                { bucketId: '3p-weekly', remainingFraction: 0, resetTime }
            ]
        });
        manager.updateQuota('3p-ready', {
            groups: [
                { bucketId: 'gemini-weekly', remainingFraction: 0, resetTime },
                { bucketId: '3p-weekly', remainingFraction: 0.9, resetTime }
            ]
        });

        await expect(pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low'))
            .resolves.toMatchObject({ uuid: 'gemini-ready' });
        await expect(pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-claude-sonnet-4-6'))
            .resolves.toMatchObject({ uuid: '3p-ready' });
    });

    test('excludes an account when any bucket in the requested family is exhausted', async () => {
        const pool = createPoolManager([
            { uuid: 'five-hour-exhausted' },
            { uuid: 'available' }
        ]);
        const manager = getAntigravitySessionAffinityManager();
        const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        manager.updateQuota('five-hour-exhausted', {
            groups: [
                { bucketId: 'gemini-weekly', remainingFraction: 0.8, resetTime },
                { bucketId: 'gemini-5h', remainingFraction: 0, resetTime }
            ]
        });
        manager.updateQuota('available', {
            groups: [
                { bucketId: 'gemini-weekly', remainingFraction: 0.1, resetTime },
                { bucketId: 'gemini-5h', remainingFraction: 0.1, resetTime }
            ]
        });

        await expect(pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low'))
            .resolves.toMatchObject({ uuid: 'available' });
    });

    test('rotates accounts when round-robin is explicitly requested', async () => {
        const pool = createPoolManager([
            { uuid: 'agy-1', sequence: 1 },
            { uuid: 'agy-2', sequence: 2 },
            { uuid: 'agy-3', sequence: 3 }
        ]);

        const selected = [];
        for (let index = 0; index < 3; index += 1) {
            const account = await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low', {
                sessionId: 'evaluation-session',
                isRoundRobin: true
            });
            selected.push(account.uuid);
        }

        expect(new Set(selected).size).toBeGreaterThan(1);
    });

    test('fails over and rebinds when the bound account is excluded', async () => {
        const pool = createPoolManager([
            { uuid: 'agy-1' },
            { uuid: 'agy-2' }
        ]);

        const first = await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low', {
            sessionId: 'conversation-failover'
        });
        const failover = await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low', {
            sessionId: 'conversation-failover',
            excludeUuids: [first.uuid]
        });
        const nextTurn = await pool.selectProvider(MODEL_PROVIDER.ANTIGRAVITY, 'gemini-3.8-flash-low', {
            sessionId: 'conversation-failover'
        });

        expect(failover.uuid).not.toBe(first.uuid);
        expect(nextTurn.uuid).toBe(failover.uuid);
        expect(getAntigravitySessionAffinityManager().getBinding('conversation-failover')).toBe(failover.uuid);
    });

    test('expires idle account bindings', () => {
        const manager = getAntigravitySessionAffinityManager();
        manager.ttlMs = 100;
        manager.bindSession('short-lived', 'agy-1');
        const binding = manager.bindings.get('short-lived');
        binding.lastSeen = Date.now() - 200;

        expect(manager.getBinding('short-lived')).toBeNull();
    });
});
