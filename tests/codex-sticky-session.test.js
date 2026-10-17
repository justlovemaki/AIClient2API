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

import {
    extractSchedulerContext,
    SessionAffinityManager,
    resetSessionAffinityManager
} from '../src/providers/session-affinity-manager.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { MODEL_PROVIDER } from '../src/utils/constants.js';

describe('Codex Sticky Session and Scheduler Tests', () => {
    beforeEach(() => {
        resetSessionAffinityManager();
    });

    describe('extractSchedulerContext', () => {
        test('defaults to sticky mode when no header or query param is provided', () => {
            const req = { headers: {} };
            const body = { prompt_cache_key: 'session-123' };
            const ctx = extractSchedulerContext(req, body, MODEL_PROVIDER.CODEX_API);
            expect(ctx.mode).toBe('sticky');
            expect(ctx.isRoundRobin).toBe(false);
            expect(ctx.sessionId).toBe('session-123');
            expect(ctx.sessionSource).toBe('body.prompt_cache_key');
        });

        test('detects x-account-scheduler: round-robin opt-out header', () => {
            const req = {
                headers: {
                    'x-account-scheduler': 'round-robin',
                    'session-id': 'session-abc'
                }
            };
            const body = { input: [] };
            const ctx = extractSchedulerContext(req, body, MODEL_PROVIDER.CODEX_API);
            expect(ctx.mode).toBe('round-robin');
            expect(ctx.isRoundRobin).toBe(true);
            expect(ctx.sessionId).toBe('session-abc');
            expect(ctx.sessionSource).toBe('header.session-id');
        });

        test('detects ?scheduler=round-robin URL query parameter opt-out', () => {
            const req = {
                headers: { host: 'localhost:3000' },
                url: '/v1/responses?scheduler=round-robin'
            };
            const body = { metadata: { conversation_id: 'conv-999' } };
            const ctx = extractSchedulerContext(req, body, MODEL_PROVIDER.CODEX_API);
            expect(ctx.mode).toBe('round-robin');
            expect(ctx.isRoundRobin).toBe(true);
            expect(ctx.sessionId).toBe('conv-999');
            expect(ctx.sessionSource).toBe('body.metadata.conversation_id');
        });

        test('extracts session ID from headers: x-session-id, x-copilot-session-id, session-id, thread-id', () => {
            const req1 = { headers: { 'x-copilot-session-id': 'copilot-uuid-1' } };
            expect(extractSchedulerContext(req1, {}, MODEL_PROVIDER.CODEX_API).sessionId).toBe('copilot-uuid-1');

            const req2 = { headers: { 'thread-id': 'codex-thread-10' } };
            expect(extractSchedulerContext(req2, {}, MODEL_PROVIDER.CODEX_API).sessionId).toBe('codex-thread-10');

            const req3 = { headers: { 'x-session-id': 'sess-custom' } };
            expect(extractSchedulerContext(req3, {}, MODEL_PROVIDER.CODEX_API).sessionId).toBe('sess-custom');
        });

        test('extracts session ID from body user, metadata.session_id, or JSON user_id', () => {
            const req = { headers: {} };
            expect(extractSchedulerContext(req, { user: 'user-chat-42' }, MODEL_PROVIDER.CODEX_API).sessionId).toBe('user-chat-42');
            expect(extractSchedulerContext(req, { metadata: { session_id: 'meta-sess-1' } }, MODEL_PROVIDER.CODEX_API).sessionId).toBe('meta-sess-1');
            expect(extractSchedulerContext(req, { metadata: { user_id: JSON.stringify({ session_id: 'json-user-id' }) } }, MODEL_PROVIDER.CODEX_API).sessionId).toBe('json-user-id');
        });

        test('derives deterministic fallback cache identity for Codex requests without explicit session ID', () => {
            const req = { headers: {} };
            const body = {
                instructions: 'test system instructions',
                input: [{ type: 'message', role: 'user', content: 'test prompt' }]
            };
            const ctx = extractSchedulerContext(req, body, MODEL_PROVIDER.CODEX_API);
            expect(ctx.sessionId).toMatch(/^aic2a-[a-f0-9]{32}$/);
            expect(ctx.sessionSource).toBe('codex.prefix_fingerprint');
        });
    });

    describe('SessionAffinityManager', () => {
        test('binds, retrieves, and unbinds sessions correctly', () => {
            const mgr = new SessionAffinityManager();
            expect(mgr.supportsProvider(MODEL_PROVIDER.CODEX_API)).toBe(true);

            expect(mgr.getBinding(MODEL_PROVIDER.CODEX_API, 'sess-1')).toBeNull();

            mgr.bindSession(MODEL_PROVIDER.CODEX_API, 'sess-1', 'account-uuid-a');
            expect(mgr.getBinding(MODEL_PROVIDER.CODEX_API, 'sess-1')).toBe('account-uuid-a');

            mgr.unbindSession(MODEL_PROVIDER.CODEX_API, 'sess-1', 'test');
            expect(mgr.getBinding(MODEL_PROVIDER.CODEX_API, 'sess-1')).toBeNull();
        });

        test('expires bindings older than ttlMs', () => {
            const mgr = new SessionAffinityManager({ ttlMs: 100 });
            mgr.bindSession(MODEL_PROVIDER.CODEX_API, 'sess-temp', 'account-uuid-a');
            expect(mgr.getBinding(MODEL_PROVIDER.CODEX_API, 'sess-temp')).toBe('account-uuid-a');

            // Simulate time passage
            const binding = mgr.bindings.get(`${MODEL_PROVIDER.CODEX_API}:sess-temp`);
            binding.lastSeen = Date.now() - 200;

            expect(mgr.getBinding(MODEL_PROVIDER.CODEX_API, 'sess-temp')).toBeNull();
        });
    });

    describe('ProviderPoolManager Integration with Sticky Sessions', () => {
        function createPoolManager(accounts) {
            const manager = new ProviderPoolManager({});
            manager.providerStatus[MODEL_PROVIDER.CODEX_API] = accounts.map(acc => ({
                uuid: acc.uuid,
                type: MODEL_PROVIDER.CODEX_API,
                config: {
                    uuid: acc.uuid,
                    customName: acc.name,
                    isHealthy: acc.isHealthy !== false,
                    isDisabled: acc.isDisabled === true,
                    usageCount: acc.usageCount || 0,
                    lastUsed: acc.lastUsed || new Date(0).toISOString(),
                    _lastSelectionSeq: acc.seq || 0
                },
                state: {
                    activeCount: 0,
                    waitingCount: 0,
                    queue: []
                }
            }));
            return manager;
        }

        test('keeps the same Codex account across multiple requests for the same session (sticky default)', async () => {
            const pool = createPoolManager([
                { uuid: 'acc-1', name: 'Account 1', lastUsed: '2026-10-01T00:00:00.000Z' },
                { uuid: 'acc-2', name: 'Account 2', lastUsed: '2026-10-01T00:00:00.000Z' },
                { uuid: 'acc-3', name: 'Account 3', lastUsed: '2026-10-01T00:00:00.000Z' }
            ]);

            // First turn for session A
            const first = await pool.selectProvider(MODEL_PROVIDER.CODEX_API, 'gpt-5.5', {
                sessionId: 'session-turn-1'
            });
            expect(first).not.toBeNull();
            const boundUuid = first.uuid;

            // Second turn for session A: should NOT switch accounts despite LRU
            const second = await pool.selectProvider(MODEL_PROVIDER.CODEX_API, 'gpt-5.5', {
                sessionId: 'session-turn-1'
            });
            expect(second.uuid).toBe(boundUuid);

            // Third turn for session A
            const third = await pool.selectProvider(MODEL_PROVIDER.CODEX_API, 'gpt-5.5', {
                sessionId: 'session-turn-1'
            });
            expect(third.uuid).toBe(boundUuid);
        });

        test('rotates accounts across requests when isRoundRobin is set (opt-out)', async () => {
            const pool = createPoolManager([
                { uuid: 'acc-1', name: 'Account 1', seq: 1 },
                { uuid: 'acc-2', name: 'Account 2', seq: 2 },
                { uuid: 'acc-3', name: 'Account 3', seq: 3 }
            ]);

            const selectedUuids = [];
            for (let i = 0; i < 3; i++) {
                const res = await pool.selectProvider(MODEL_PROVIDER.CODEX_API, 'gpt-5.5', {
                    sessionId: 'eval-session-constant',
                    isRoundRobin: true
                });
                selectedUuids.push(res.uuid);
            }

            // With round-robin opt-out, it rotates through different accounts
            const uniqueAccounts = new Set(selectedUuids);
            expect(uniqueAccounts.size).toBeGreaterThan(1);
        });

        test('transparently reassigns session if the bound account becomes unhealthy or excluded', async () => {
            const pool = createPoolManager([
                { uuid: 'acc-1', name: 'Account 1' },
                { uuid: 'acc-2', name: 'Account 2' }
            ]);

            // First turn binds to acc-1
            const first = await pool.selectProvider(MODEL_PROVIDER.CODEX_API, 'gpt-5.5', {
                sessionId: 'failover-session'
            });
            expect(first.uuid).toBe('acc-1');

            // acc-1 encounters rate limits or errors and is excluded during retry
            const failover = await pool.selectProvider(MODEL_PROVIDER.CODEX_API, 'gpt-5.5', {
                sessionId: 'failover-session',
                excludeUuids: ['acc-1']
            });

            expect(failover.uuid).toBe('acc-2');

            // Subsequent turn stays on new healthy account acc-2
            const nextTurn = await pool.selectProvider(MODEL_PROVIDER.CODEX_API, 'gpt-5.5', {
                sessionId: 'failover-session'
            });
            expect(nextTurn.uuid).toBe('acc-2');
        });
    });
});
