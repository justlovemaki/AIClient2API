jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(),
    getProxyConfigForProvider: jest.fn(),
    getGoogleAuthProxyConfig: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { AntigravityApiService, isAntigravityModelRetired } from '../src/providers/gemini/antigravity-core.js';
import { PROVIDER_MODELS } from '../src/providers/provider-models.js';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { getServiceAdapter } from '../src/providers/adapter.js';
import { handleGetProviderModels, handleGetProviderTypeModels } from '../src/ui-modules/provider-api.js';
import { ENDPOINT_TYPE, MODEL_PROVIDER, handleModelListRequest, handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';

describe('Antigravity model availability', () => {
    const cutoff = Date.UTC(2026, 10, 3);

    test('includes the supplied Gemini Medium aliases and GPT-OSS model', () => {
        expect(PROVIDER_MODELS['gemini-antigravity']).toEqual(expect.arrayContaining([
            'gemini-3.6-flash-medium',
            'gemini-3.7-flash-medium',
            'gemini-3.8-flash-medium',
            'gemini-3.1-pro-low',
            'gemini-claude-sonnet-4-6',
            'gemini-claude-opus-4-6-thinking',
            'gpt-oss-120b-medium'
        ]));
    });

    test('restricts free-tier accounts to Gemini 3.8 Flash high, medium, and low', () => {
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff - 1, 'free-tier')).toBe(true);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff, 'free-tier')).toBe(true);
        expect(isAntigravityModelRetired('gpt-oss-120b-medium', cutoff, 'free-tier')).toBe(true);
        expect(isAntigravityModelRetired('gemini-3.7-flash-high', cutoff, 'free-tier')).toBe(true);
        for (const model of ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']) {
            expect(isAntigravityModelRetired(model, cutoff, 'free-tier')).toBe(false);
        }
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff - 1, 'Google AI Pro(free)')).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff, 'Google AI Pro(free)')).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff - 1, undefined)).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff, undefined)).toBe(false);
    });

    test('filters model lists and direct requests according to account tier', async () => {
        jest.useFakeTimers().setSystemTime(cutoff);

        try {
            const createService = tierId => {
                const service = Object.create(AntigravityApiService.prototype);
                service.isInitialized = true;
                service.tierId = tierId;
                service.availableModels = [
                    'gemini-3.8-flash-high',
                    'gemini-3.8-flash-medium',
                    'gemini-3.8-flash-low',
                    'gemini-3.7-flash-high',
                    'gemini-claude-sonnet-4-6',
                    'gpt-oss-120b-medium'
                ];
                return service;
            };

            const freeService = createService('free-tier');
            const freeResponse = await freeService.listModels();
            expect(freeResponse.models.map(model => model.name)).toEqual([
                'models/gemini-3.8-flash-high',
                'models/gemini-3.8-flash-medium',
                'models/gemini-3.8-flash-low'
            ]);
            expect(() => freeService.buildAntigravityPayload('gemini-claude-sonnet-4-6', {}))
                .toThrow('unavailable on the free tier');
            expect(() => freeService.buildAntigravityPayload('gpt-oss-120b-medium', {}))
                .toThrow('unavailable on the free tier');
            expect(() => freeService.buildAntigravityPayload('gemini-3.7-flash-high', {}))
                .toThrow('unavailable on the free tier');

            for (const tierId of ['Google AI Pro', undefined]) {
                const service = createService(tierId);
                const response = await service.listModels();
                expect(response.models.map(model => model.name)).toEqual([
                    'models/gemini-3.8-flash-high',
                    'models/gemini-3.8-flash-medium',
                    'models/gemini-3.8-flash-low',
                    'models/gemini-3.7-flash-high',
                    'models/gemini-claude-sonnet-4-6',
                    'models/gpt-oss-120b-medium'
                ]);
            }
        } finally {
            jest.useRealTimers();
        }
    });

    test.each([
        ['unary', handleUnaryRequest, 'generateContent'],
        ['streaming', handleStreamRequest, 'generateContentStream']
    ])('reports a free-tier unavailable model as a non-retryable 404 for %s requests', async (_label, handler, method) => {
        jest.useFakeTimers().setSystemTime(cutoff);

        const service = Object.create(AntigravityApiService.prototype);
        service.tierId = 'free-tier';
        service.availableModels = ['gemini-claude-sonnet-4-6'];
        let policyError;
        try {
            service.buildAntigravityPayload('gemini-claude-sonnet-4-6', {});
        } catch (error) {
            policyError = error;
        } finally {
            jest.useRealTimers();
        }

        expect(policyError).toMatchObject({
            status: 404,
            response: { status: 404 },
            skipErrorCount: true
        });

        const requestService = { [method]: jest.fn().mockRejectedValue(policyError) };
        const poolManager = {
            markProviderHealthy: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            releaseSlot: jest.fn()
        };
        const response = {
            writableEnded: false,
            writeHead: jest.fn(function (statusCode) {
                this.statusCode = statusCode;
            }),
            write: jest.fn(),
            end: jest.fn(function () {
                this.writableEnded = true;
            }),
            on: jest.fn(),
            off: jest.fn()
        };

        await handler(
            response,
            requestService,
            'gemini-claude-sonnet-4-6',
            {},
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            poolManager,
            'healthy-account',
            null,
            { CONFIG: {}, maxRetries: 2 }
        );

        expect(requestService[method]).toHaveBeenCalledTimes(1);
        expect(poolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(poolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(poolManager.releaseSlot).toHaveBeenCalledWith('gemini-antigravity', 'healthy-account');
        if (method === 'generateContent') {
            expect(response.statusCode).toBe(404);
        } else {
            const streamPayload = response.write.mock.calls.flat().join('');
            expect(response.statusCode).toBe(200);
            expect(streamPayload).toContain('"code":404');
            expect(streamPayload).toContain('NOT_FOUND');
            expect(streamPayload).toContain('unavailable on the free tier');
        }
    });

    test('filters auto-mode listings across free and mixed-tier Antigravity pools', async () => {
        jest.useFakeTimers().setSystemTime(cutoff);

        const listAutoModels = async (tiers, endpointType) => {
            const providerStatus = tiers.map((tierId, index) => {
                const config = {
                    MODEL_PROVIDER: MODEL_PROVIDER.ANTIGRAVITY,
                    uuid: `antigravity-auto-${index}`
                };
                const serviceAdapter = getServiceAdapter(config);
                serviceAdapter.listModels = jest.fn(async () => {
                    serviceAdapter.antigravityApiService.tierId = tierId;
                    const models = tierId === 'free-tier'
                        ? ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']
                        : tierId
                            ? ['gemini-3.8-flash-medium', 'gemini-claude-sonnet-4-6']
                            : [];
                    return { models: models.map(model => ({ name: `models/${model}` })) };
                });
                return { config, uuid: config.uuid };
            });
            const poolManager = Object.create(ProviderPoolManager.prototype);
            poolManager.providerStatus = { [MODEL_PROVIDER.ANTIGRAVITY]: providerStatus };
            poolManager.globalConfig = {};
            poolManager._log = jest.fn();

            const response = {
                writeHead: jest.fn(),
                end: jest.fn(body => {
                    response.body = body;
                })
            };
            await handleModelListRequest(
                {},
                response,
                null,
                endpointType,
                { MODEL_PROVIDER: MODEL_PROVIDER.AUTO, customModels: [] },
                poolManager,
                null
            );
            const modelList = JSON.parse(response.body);
            return endpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST
                ? modelList.data.map(model => model.id)
                : modelList.models.map(model => model.name.replace(/^models\//, ''));
        };

        try {
            for (const endpointType of [ENDPOINT_TYPE.OPENAI_MODEL_LIST, ENDPOINT_TYPE.GEMINI_MODEL_LIST]) {
                const freeOnlyModels = await listAutoModels(['free-tier'], endpointType);
                expect(freeOnlyModels).toContain('gemini-antigravity:gemini-3.8-flash-high');
                expect(freeOnlyModels).toContain('gemini-antigravity:gemini-3.8-flash-medium');
                expect(freeOnlyModels).toContain('gemini-antigravity:gemini-3.8-flash-low');
                expect(freeOnlyModels).not.toContain('gemini-antigravity:gemini-3.7-flash-high');
                expect(freeOnlyModels).not.toContain('gemini-antigravity:gemini-claude-sonnet-4-6');
                expect(freeOnlyModels).not.toContain('gemini-antigravity:gpt-oss-120b-medium');

                const mixedTierModels = await listAutoModels(['free-tier', 'Google AI Pro(free)'], endpointType);
                expect(mixedTierModels).toContain('gemini-antigravity:gemini-claude-sonnet-4-6');
                expect(mixedTierModels).not.toContain('gemini-antigravity:gpt-oss-120b-medium');

                const unknownTierModels = await listAutoModels(['free-tier', undefined], endpointType);
                expect(unknownTierModels).toContain('gemini-antigravity:gemini-claude-sonnet-4-6');
                expect(unknownTierModels).toContain('gemini-antigravity:gpt-oss-120b-medium');
            }
        } finally {
            jest.useRealTimers();
        }
    });

    test('uses tier-filtered Antigravity models in playground model APIs', async () => {
        const models = [
            'gemini-3.8-flash-high',
            'gemini-3.8-flash-low',
            'gemini-3.8-flash-medium'
        ];
        const providerPoolManager = {
            providerPools: { [MODEL_PROVIDER.ANTIGRAVITY]: [{ uuid: 'free-account' }] },
            providerStatus: { [MODEL_PROVIDER.ANTIGRAVITY]: [{ uuid: 'free-account' }] },
            getAllAvailableModels: jest.fn(async () => models.map(model => ({
                provider: MODEL_PROVIDER.ANTIGRAVITY,
                model
            })))
        };
        const createResponse = () => ({
            writeHead: jest.fn(),
            end: jest.fn(function (body) {
                this.body = body;
            })
        });

        const allModelsResponse = createResponse();
        await handleGetProviderModels({}, allModelsResponse, {}, providerPoolManager);
        expect(JSON.parse(allModelsResponse.body)[MODEL_PROVIDER.ANTIGRAVITY]).toEqual(models);

        const typeModelsResponse = createResponse();
        await handleGetProviderTypeModels(
            {},
            typeModelsResponse,
            {},
            providerPoolManager,
            MODEL_PROVIDER.ANTIGRAVITY
        );
        expect(JSON.parse(typeModelsResponse.body).models).toEqual(models);
        expect(providerPoolManager.getAllAvailableModels).toHaveBeenCalledTimes(2);
    });

    test('routes only Gemini 3.8 Flash variants to free-tier accounts', async () => {
        const createPool = () => {
            const createNode = (tierId, uuid, lastUsed) => {
                const config = {
                    MODEL_PROVIDER: MODEL_PROVIDER.ANTIGRAVITY,
                    uuid,
                    isHealthy: true,
                    isDisabled: false,
                    needsRefresh: false,
                    lastUsed,
                    usageCount: 0
                };
                const serviceAdapter = getServiceAdapter(config);
                serviceAdapter.antigravityApiService.tierId = tierId;
                return {
                    config,
                    uuid,
                    state: { activeCount: 0, waitingCount: 0 }
                };
            };
            const freeNode = createNode('free-tier', 'antigravity-free-selection', new Date(Date.now() - 100000).toISOString());
            const paidNode = createNode('Google AI Pro', 'antigravity-paid-selection', new Date(Date.now() - 50000).toISOString());
            const poolManager = Object.create(ProviderPoolManager.prototype);
            poolManager.providerStatus = { [MODEL_PROVIDER.ANTIGRAVITY]: [freeNode, paidNode] };
            poolManager.globalConfig = {};
            poolManager._selectionSequence = 0;
            poolManager._isSelecting = {};
            poolManager._checkAndRecoverScheduledProviders = jest.fn();
            poolManager._getDisplayName = config => config.uuid;
            poolManager._debouncedSave = jest.fn();
            poolManager._log = jest.fn();
            return { poolManager, freeNode, paidNode };
        };

        jest.useFakeTimers().setSystemTime(cutoff - 1);
        try {
            const beforeCutoff = createPool();
            expect(beforeCutoff.poolManager._calculateNodeScore(beforeCutoff.freeNode, cutoff - 1, 0))
                .toBeLessThan(beforeCutoff.poolManager._calculateNodeScore(beforeCutoff.paidNode, cutoff - 1, 0));
            await expect(beforeCutoff.poolManager.selectProvider(
                MODEL_PROVIDER.ANTIGRAVITY,
                'gemini-claude-sonnet-4-6'
            )).resolves.toBe(beforeCutoff.paidNode.config);

            jest.setSystemTime(cutoff);
            const atCutoff = createPool();
            expect(atCutoff.poolManager._calculateNodeScore(atCutoff.freeNode, cutoff, 0))
                .toBeLessThan(atCutoff.poolManager._calculateNodeScore(atCutoff.paidNode, cutoff, 0));
            await expect(atCutoff.poolManager.selectProvider(
                MODEL_PROVIDER.ANTIGRAVITY,
                'gemini-claude-sonnet-4-6'
            )).resolves.toBe(atCutoff.paidNode.config);
            for (const model of ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']) {
                const eligiblePool = createPool();
                await expect(eligiblePool.poolManager.selectProvider(
                    MODEL_PROVIDER.ANTIGRAVITY,
                    model
                )).resolves.toBe(eligiblePool.freeNode.config);
            }
        } finally {
            jest.useRealTimers();
        }
    });

    test('discovers cold account tiers before routing requests at the cutoff', async () => {
        jest.useFakeTimers().setSystemTime(cutoff);

        const createResponse = () => ({
            writableEnded: false,
            writeHead: jest.fn(function (statusCode) {
                this.statusCode = statusCode;
            }),
            write: jest.fn(),
            end: jest.fn(function () {
                this.writableEnded = true;
            }),
            on: jest.fn(),
            off: jest.fn()
        });
        const createNode = (uuid, tierId, lastUsed) => {
            const config = {
                MODEL_PROVIDER: MODEL_PROVIDER.ANTIGRAVITY,
                uuid,
                isHealthy: true,
                isDisabled: false,
                needsRefresh: false,
                lastUsed,
                usageCount: 0
            };
            const serviceAdapter = getServiceAdapter(config);
            const service = serviceAdapter.antigravityApiService;
            expect(service.tierId).toBeUndefined();
            service.loadCredentials = jest.fn();
            service.discoverProjectAndModels = jest.fn(async () => {
                service.tierId = tierId;
                service.availableModels = [
                    'gemini-3.8-flash-medium',
                    'gemini-claude-sonnet-4-6'
                ];
                return `${uuid}-project`;
            });
            service.isExpiryDateNear = jest.fn(() => false);
            service.executeClaudeNonStream = jest.fn(async () => ({
                candidates: [{ content: { role: 'model', parts: [{ text: 'paid response' }] } }]
            }));
            service.callApi = jest.fn(async () => ({
                response: { candidates: [{ content: { role: 'model', parts: [{ text: 'free response' }] } }] }
            }));
            return { config, uuid, serviceAdapter, service, state: { activeCount: 0, waitingCount: 0 } };
        };

        try {
            const freeNode = createNode(
                'antigravity-cold-free',
                'free-tier',
                new Date(cutoff - 100000).toISOString()
            );
            const paidNode = createNode(
                'antigravity-cold-paid',
                'Google AI Pro',
                new Date(cutoff - 50000).toISOString()
            );
            const poolManager = Object.create(ProviderPoolManager.prototype);
            poolManager.providerStatus = { [MODEL_PROVIDER.ANTIGRAVITY]: [freeNode, paidNode] };
            poolManager.globalConfig = {};
            poolManager._selectionSequence = 0;
            poolManager._isSelecting = {};
            poolManager._checkAndRecoverScheduledProviders = jest.fn();
            poolManager._getDisplayName = config => config.uuid;
            poolManager._debouncedSave = jest.fn();
            poolManager._log = jest.fn();
            poolManager.markProviderHealthy = jest.fn();
            poolManager.markProviderUnhealthy = jest.fn();
            poolManager.markProviderUnhealthyWithRecoveryTime = jest.fn();
            poolManager.releaseSlot = jest.fn();

            const requestConfig = { CONFIG: {}, maxRetries: 0 };
            const claudeConfig = await poolManager.selectProvider(
                MODEL_PROVIDER.ANTIGRAVITY,
                'gemini-claude-sonnet-4-6'
            );
            expect(claudeConfig).toBe(paidNode.config);
            expect(freeNode.service.isInitialized).toBe(true);
            expect(paidNode.service.isInitialized).toBe(true);
            expect(freeNode.service.loadCredentials).toHaveBeenCalledTimes(1);
            expect(paidNode.service.loadCredentials).toHaveBeenCalledTimes(1);
            expect(freeNode.service.discoverProjectAndModels).toHaveBeenCalledTimes(1);
            expect(paidNode.service.discoverProjectAndModels).toHaveBeenCalledTimes(1);

            const claudeResponse = createResponse();
            await handleUnaryRequest(
                claudeResponse,
                paidNode.serviceAdapter,
                'gemini-claude-sonnet-4-6',
                { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
                'gemini',
                MODEL_PROVIDER.ANTIGRAVITY,
                'none',
                null,
                poolManager,
                paidNode.uuid,
                null,
                requestConfig
            );
            expect(paidNode.service.executeClaudeNonStream).toHaveBeenCalledTimes(1);
            expect(freeNode.service.executeClaudeNonStream).not.toHaveBeenCalled();
            expect(claudeResponse.statusCode).toBe(200);

            const geminiConfig = await poolManager.selectProvider(
                MODEL_PROVIDER.ANTIGRAVITY,
                'gemini-3.8-flash-medium'
            );
            expect(geminiConfig).toBe(freeNode.config);
            const geminiResponse = createResponse();
            await handleUnaryRequest(
                geminiResponse,
                freeNode.serviceAdapter,
                'gemini-3.8-flash-medium',
                { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
                'gemini',
                MODEL_PROVIDER.ANTIGRAVITY,
                'none',
                null,
                poolManager,
                freeNode.uuid,
                null,
                requestConfig
            );
            expect(freeNode.service.callApi).toHaveBeenCalledTimes(1);
            expect(geminiResponse.statusCode).toBe(200);
        } finally {
            jest.useRealTimers();
        }
    });
});
