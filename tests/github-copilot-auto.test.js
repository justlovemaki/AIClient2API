jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: config => config,
    configureTLSSidecar: config => config,
    isTLSSidecarEnabledForProvider: () => false
}));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

import { GitHubCopilotApiService, normalizeCopilotAutoTier } from '../src/providers/github/github-copilot-core.js';
import { PROVIDER_MODELS } from '../src/providers/provider-models.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import logger from '../src/utils/logger.js';

describe('GitHub Copilot Auto routing', () => {
    function createService() {
        let emit;
        const session = {
            sessionId: 'test-session',
            sendAndWait: jest.fn().mockResolvedValue({
                data: { content: 'Auto response', outputTokens: 2 }
            }),
            send: jest.fn(async () => {
                emit({ type: 'assistant.message_delta', data: { deltaContent: 'Auto ' } });
                emit({ type: 'assistant.message_delta', data: { deltaContent: 'response' } });
                emit({ type: 'assistant.message', data: { content: 'Auto response' } });
                emit({ type: 'session.idle', data: { mode: 'interactive' } });
            }),
            on: jest.fn(handler => {
                emit = handler;
                return jest.fn();
            }),
            disconnect: jest.fn().mockResolvedValue(undefined)
        };
        const client = {
            start: jest.fn().mockResolvedValue(undefined),
            createSession: jest.fn().mockResolvedValue(session),
            deleteSession: jest.fn().mockResolvedValue(undefined)
        };
        const service = new GitHubCopilotApiService({
            GITHUB_COPILOT_API_KEY: 'github_pat_test',
            uuid: 'test-provider'
        });
        service.createSdkClient = () => client;
        return { service, client, session };
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('offers GPT-4.1 and Auto, with GPT-4.1 as the health-check model', () => {
        expect(PROVIDER_MODELS['github-copilot']).toEqual(['gpt-4.1', 'auto']);
        expect(ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS['github-copilot']).toBe('gpt-4.1');
    });

    test('routes GPT-4.1 through the Copilot chat-completions API', async () => {
        const { service } = createService();
        service.callApi = jest.fn().mockResolvedValue({ choices: [] });

        await service.generateContent('gpt-4.1', {
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: 'Health check.' }]
        });

        expect(service.callApi).toHaveBeenCalledWith('/chat/completions', expect.objectContaining({
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: 'Health check.' }]
        }));
    });

    test('routes streamed named-model requests through the Copilot chat-completions API', async () => {
        const { service } = createService();
        service.streamApi = jest.fn(async function* () {
            yield { choices: [{ delta: { content: 'OK' } }] };
        });

        for await (const chunk of service.generateContentStream('gpt-4.1', {
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: 'Health check.' }]
        })) {
            expect(chunk.choices[0].delta.content).toBe('OK');
        }

        expect(service.streamApi).toHaveBeenCalledWith('/chat/completions', expect.objectContaining({
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: 'Health check.' }]
        }));
    });

    test('preserves Copilot API error details for health-check diagnostics', async () => {
        const { service } = createService();
        service.axiosInstance.request = jest.fn().mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
            response: {
                status: 400,
                data: 'Personal Access Tokens are not supported for this endpoint'
            }
        }));

        await expect(service.callApi('/chat/completions', { model: 'gpt-4.1' }))
            .rejects.toThrow('HTTP 400: Personal Access Tokens are not supported for this endpoint');
    });

    test('accepts only the three user-facing Auto tiers', () => {
        expect(normalizeCopilotAutoTier('efficiency')).toBe('efficiency');
        expect(normalizeCopilotAutoTier('balance')).toBe('balance');
        expect(normalizeCopilotAutoTier('intelligence')).toBe('intelligence');
        expect(() => normalizeCopilotAutoTier('fast')).toThrow('Invalid Auto tier');
    });

    test('creates an Auto session with the selected tier and returns chat output', async () => {
        const { service, client, session } = createService();
        const response = await service.generateContent('auto', {
            auto_tier: 'intelligence',
            messages: [
                { role: 'system', content: 'Be concise.' },
                { role: 'user', content: 'Say hello.' }
            ]
        });

        expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
            model: 'auto',
            capi: { autoTier: 'intelligence' },
            availableTools: []
        }));
        expect(session.sendAndWait).toHaveBeenCalledWith(expect.objectContaining({
            prompt: expect.stringContaining('USER:\nSay hello.')
        }));
        expect(response.model).toBe('auto');
        expect(response.choices[0].message.content).toBe('Auto response');
        expect(client.deleteSession).toHaveBeenCalledWith('test-session');
    });

    test('logs request and tier context without logging the prompt or PAT', async () => {
        const { service } = createService();
        await service.generateContent('auto', {
            _monitorRequestId: 'request-123',
            auto_tier: 'balance',
            messages: [{ role: 'user', content: 'private prompt text' }]
        });

        const messages = logger.info.mock.calls.map(([message]) => message).join('\n');
        expect(messages).toContain('requestId=request-123');
        expect(messages).toContain('tier=balance');
        expect(messages).toContain('Auto request succeeded');
        expect(messages).not.toContain('private prompt text');
        expect(messages).not.toContain('github_pat_test');
    });

    test('returns a cached used percentage and reset date from account quota', async () => {
        const { service } = createService();
        const getQuota = jest.fn().mockResolvedValue({
            quotaSnapshots: {
                premium_interactions: {
                    isUnlimitedEntitlement: false,
                    entitlementRequests: 300,
                    usedRequests: 87,
                    remainingPercentage: 71,
                    resetDate: '2026-11-01T00:00:00Z'
                }
            }
        });
        service.getSdkClient = jest.fn().mockResolvedValue({
            rpc: { account: { getQuota } }
        });

        const first = await service.getQuota();
        const second = await service.getQuota();

        expect(first).toEqual(expect.objectContaining({
            available: true,
            quotaType: 'premium_interactions',
            usedRequests: 87,
            entitlementRequests: 300,
            remainingPercentage: 71,
            usedPercentage: 29,
            resetDate: '2026-11-01T00:00:00Z',
            isUnlimited: false
        }));
        expect(second).toEqual(first);
        expect(getQuota).toHaveBeenCalledTimes(1);
        expect(getQuota).toHaveBeenCalledWith({ gitHubToken: 'github_pat_test' });
    });

    test('skips zero-entitlement premium quota when chat quota is available', async () => {
        const { service } = createService();
        service.getSdkClient = jest.fn().mockResolvedValue({
            rpc: {
                account: {
                    getQuota: jest.fn().mockResolvedValue({
                        quotaSnapshots: {
                            premium_interactions: {
                                isUnlimitedEntitlement: false,
                                entitlementRequests: 0,
                                usedRequests: 0,
                                remainingPercentage: 0
                            },
                            chat: {
                                isUnlimitedEntitlement: false,
                                entitlementRequests: 200,
                                usedRequests: 58,
                                remainingPercentage: 71,
                                resetDate: '2026-11-01T00:00:00Z'
                            }
                        }
                    })
                }
            }
        });

        await expect(service.getQuota()).resolves.toEqual(expect.objectContaining({
            quotaType: 'chat',
            usedRequests: 58,
            usedPercentage: 29
        }));
    });

    test('reports unlimited entitlement without a misleading percentage', async () => {
        const { service } = createService();
        service.getSdkClient = jest.fn().mockResolvedValue({
            rpc: {
                account: {
                    getQuota: jest.fn().mockResolvedValue({
                        quotaSnapshots: {
                            premium_interactions: {
                                isUnlimitedEntitlement: true,
                                entitlementRequests: -1,
                                usedRequests: 10,
                                remainingPercentage: 100
                            }
                        }
                    })
                }
            }
        });

        await expect(service.getQuota()).resolves.toEqual(expect.objectContaining({
            available: true,
            isUnlimited: true,
            usedPercentage: null
        }));
    });

    test('streams SDK deltas as OpenAI chat-completion chunks', async () => {
        const { service, client } = createService();
        const chunks = [];
        for await (const chunk of service.generateContentStream('auto', {
            auto_tier: 'efficiency',
            messages: [{ role: 'user', content: 'Say hello.' }]
        })) {
            chunks.push(chunk);
        }

        expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
            model: 'auto',
            capi: { autoTier: 'efficiency' }
        }));
        expect(chunks.map(chunk => chunk.choices[0].delta.content).filter(Boolean))
            .toEqual(['Auto ', 'response']);
        expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
        expect(client.deleteSession).toHaveBeenCalledWith('test-session');
    });
});