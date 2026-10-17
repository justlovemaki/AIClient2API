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
