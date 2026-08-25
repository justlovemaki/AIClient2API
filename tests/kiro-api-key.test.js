import { beforeAll, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/convert/convert.js', () => ({
    convertData: jest.fn()
}));

jest.mock('../src/providers/provider-models.js', () => ({
    getConfiguredSupportedModels: jest.fn(() => []),
    getCustomModelListProvider: jest.fn(),
    getProviderModels: jest.fn(() => []),
    normalizeModelIds: jest.fn(models => models)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

let KiroApiService;

beforeAll(async () => {
    ({ KiroApiService } = await import('../src/providers/claude/claude-kiro.js'));
});

describe('Kiro API Key and Rust User-Agent Integration', () => {
    test('should initialize with KIRO_API_KEY from config', async () => {
        const service = new KiroApiService({
            uuid: 'test-api-key-node',
            KIRO_API_KEY: 'ksk_test_key_123456789'
        });

        expect(service.apiKey).toBe('ksk_test_key_123456789');
        await service.loadCredentials();
        expect(service.accessToken).toBe('ksk_test_key_123456789');
    });

    test('should skip OAuth token refresh when accessToken starts with ksk_', async () => {
        const service = new KiroApiService({
            uuid: 'test-api-key-node',
            KIRO_API_KEY: 'ksk_test_key_123456789'
        });

        await service.loadCredentials();
        // initializeAuth should return early and not throw "No refresh token available"
        await expect(service.initializeAuth(false)).resolves.toBeUndefined();
    });

    test('should configure official Rust User-Agent and target headers on initialize', async () => {
        const service = new KiroApiService({
            uuid: 'test-api-key-node',
            KIRO_API_KEY: 'ksk_test_key_123456789'
        });

        await service.initialize();
        expect(service.axiosInstance).toBeDefined();
        
        const headers = service.axiosInstance.defaults.headers;
        expect(headers['x-amz-target']).toBe('AmazonCodeWhispererStreamingService.GenerateAssistantResponse');
        expect(headers['user-agent']).toContain('aws-sdk-rust');
        expect(headers['user-agent']).toContain('app/AmazonQ-For-CLI');
        expect(headers['x-amz-user-agent']).toContain('aws-sdk-rust');
    });

    test('should inject TokenType: API_KEY for ksk_ tokens during requests', async () => {
        const service = new KiroApiService({
            uuid: 'test-api-key-node',
            KIRO_API_KEY: 'ksk_test_key_123456789'
        });

        await service.initialize();

        let capturedConfig = null;
        service.axiosInstance.request = jest.fn().mockImplementation((config) => {
            capturedConfig = config;
            return Promise.resolve({
                status: 200,
                data: {
                    conversationId: 'test-conv-id',
                    assistantResponseMessage: {
                        content: 'Test response'
                    }
                }
            });
        });

        const body = {
            model: 'claude-opus-5',
            messages: [{ role: 'user', content: 'Hello' }]
        };
        await service.callApi('POST', 'claude-opus-5', body);

        expect(capturedConfig).toBeDefined();
        const headers = capturedConfig.headers;
        expect(headers['TokenType']).toBe('API_KEY');
        expect(headers['Authorization']).toBe('Bearer ksk_test_key_123456789');
        expect(headers['x-amz-target']).toBe('AmazonCodeWhispererStreamingService.GenerateAssistantResponse');
    });

    test('should not inject TokenType: API_KEY for standard OAuth tokens', async () => {
        const service = new KiroApiService({
            uuid: 'test-oauth-node'
        });

        service.accessToken = 'standard_oauth_bearer_token_abc';
        service.isInitialized = true;

        let capturedConfig = null;
        service.axiosInstance = {
            defaults: { headers: {} },
            request: jest.fn().mockImplementation((config) => {
                capturedConfig = config;
                return Promise.resolve({
                    status: 200,
                    data: {
                        conversationId: 'test-conv-id',
                        assistantResponseMessage: {
                            content: 'OAuth response'
                        }
                    }
                });
            })
        };

        const body = {
            model: 'claude-opus-5',
            messages: [{ role: 'user', content: 'Hello' }]
        };
        await service.callApi('POST', 'claude-opus-5', body);

        expect(capturedConfig).toBeDefined();
        const headers = capturedConfig.headers;
        expect(headers['TokenType']).toBeUndefined();
        expect(headers['Authorization']).toBe('Bearer standard_oauth_bearer_token_abc');
    });
});
