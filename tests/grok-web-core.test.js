/**
 * Unit tests for Grok Web WebSocket core functionality
 * Follows the same Jest-based testing pattern as other tests in the repository
 */

// Mock modules that have side effects - must be done before any imports
jest.mock('../src/utils/proxy-utils.js', () => ({
    getProxyConfigForProvider: jest.fn(() => null),
    configureTLSSidecar: jest.fn((config) => config),
    configureAxiosProxy: jest.fn((config) => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/utils/logger.js', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../src/utils/common.js', () => ({
    MODEL_PROTOCOL_PREFIX: {
        GROK: 'grok',
        OPENAI: 'openai',
        CLAUDE: 'claude',
        GEMINI: 'gemini',
        CODEX: 'codex',
        FORWARD: 'forward',
        GITHUB: 'github'
    },
    MODEL_PROVIDER: {
        GROK_WEB: 'grok-web',
        GROK_CLI: 'grok-cli-oauth'
    },
    isRetryableNetworkError: jest.fn(() => false),
    normalizeProviderErrorMessage: jest.fn()
}));

jest.mock('../src/converters/ConverterFactory.js', () => ({
    ConverterFactory: {
        getConverter: jest.fn(() => ({
            setUuid: jest.fn()
        }))
    }
}));

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => ({
        resetProviderRefreshStatus: jest.fn(),
        markProviderNeedRefresh: jest.fn()
    }))
}));

// Import after mocks
import { GrokWebApiService } from '../src/providers/grok/grok-web-core.js';
import { buildWebSocketHeaders, buildHttpHeaders, normalizeImageUrl } from '../src/providers/grok/web-headers.js';
import { convertMessagesToGrokFormat, buildStartConversationPayload } from '../src/providers/grok/web-payloads.js';
import { GROK_WEB_MODELS, getModelMapping, normalizeGrokModelId, isGrokNsfwModel } from '../src/providers/grok/web-config.js';

describe('Grok Web Core', () => {
    describe('web-config', () => {
        test('GROK_WEB_MODELS contains expected models', () => {
            expect(GROK_WEB_MODELS).toContain('grok-4.3');
            expect(GROK_WEB_MODELS).toContain('grok-4.1-mini');
            expect(GROK_WEB_MODELS).toContain('grok-imagine-1.0');
        });

        test('isGrokNsfwModel identifies NSFW models', () => {
            expect(isGrokNsfwModel('grok-4.3-nsfw')).toBe(true);
            expect(isGrokNsfwModel('grok-4.3-NSFW')).toBe(true);
            expect(isGrokNsfwModel('grok-4.3')).toBe(false);
            expect(isGrokNsfwModel('')).toBe(false);
            expect(isGrokNsfwModel(null)).toBe(false);
        });

        test('normalizeGrokModelId removes NSFW suffix', () => {
            expect(normalizeGrokModelId('grok-4.3-nsfw')).toBe('grok-4.3');
            expect(normalizeGrokModelId('grok-4.3')).toBe('grok-4.3');
            expect(normalizeGrokModelId(null)).toBe(null);
        });

        test('getModelMapping returns correct mapping', () => {
            const mapping = getModelMapping('grok-4.3');
            expect(mapping.name).toBe('grok-4.3');
            expect(mapping.modeId).toBe('auto');
        });

        test('getModelMapping returns default for unknown models', () => {
            const mapping = getModelMapping('unknown-model');
            expect(mapping).toBeDefined();
            expect(mapping.name).toBeDefined();
        });
    });

    describe('web-headers', () => {
        test('buildWebSocketHeaders includes all required cookies', () => {
            const headers = buildWebSocketHeaders(
                'sso=test-token',
                'cf-clearance-value',
                'cf-bm-value',
                'https://grok.com',
                'test-agent'
            );

            expect(headers.Cookie).toContain('sso=test-token');
            expect(headers.Cookie).toContain('sso-rw=test-token');
            expect(headers.Cookie).toContain('cf_clearance=cf-clearance-value');
            expect(headers.Cookie).toContain('__cf_bm=cf-bm-value');
            expect(headers.Origin).toBe('https://grok.com');
            expect(headers.Host).toBe('grok.com');
            expect(headers['User-Agent']).toBe('test-agent');
            expect(headers.Connection).toBe('Upgrade');
        });

        test('buildWebSocketHeaders strips sso= prefix', () => {
            const headers = buildWebSocketHeaders(
                'sso=actual-token',
                undefined,
                undefined,
                'https://grok.com',
                'agent'
            );

            expect(headers.Cookie).toContain('sso=actual-token');
            expect(headers.Cookie).toContain('sso-rw=actual-token');
            expect(headers.Cookie).not.toContain('sso=sso=');
        });

        test('buildWebSocketHeaders handles missing optional cookies', () => {
            const headers = buildWebSocketHeaders(
                'sso=token',
                undefined,
                undefined,
                'https://grok.com',
                'agent'
            );

            expect(headers.Cookie).toContain('sso=token');
            expect(headers.Cookie).not.toContain('cf_clearance');
            expect(headers.Cookie).not.toContain('__cf_bm');
        });

        test('buildHttpHeaders includes all required fields', () => {
            const headers = buildHttpHeaders(
                'sso=test-token',
                'cf-clearance-value',
                'cf-bm-value',
                'https://grok.com',
                'test-agent'
            );

            expect(headers.cookie).toContain('sso=test-token');
            expect(headers.origin).toBe('https://grok.com');
            expect(headers['user-agent']).toBe('test-agent');
        });

        test('normalizeImageUrl returns http URLs as-is', () => {
            expect(normalizeImageUrl('https://example.com/image.png')).toBe('https://example.com/image.png');
            expect(normalizeImageUrl('http://example.com/image.png')).toBe('http://example.com/image.png');
        });

        test('normalizeImageUrl returns data URLs as-is', () => {
            expect(normalizeImageUrl('data:image/png;base64,...')).toBe('data:image/png;base64,...');
        });

        test('normalizeImageUrl converts paths to assets.grok.com', () => {
            expect(normalizeImageUrl('/path/to/image.png')).toBe('https://assets.grok.com/path/to/image.png');
            expect(normalizeImageUrl('path/to/image.png')).toBe('https://assets.grok.com/path/to/image.png');
        });

        test('normalizeImageUrl handles null/undefined', () => {
            expect(normalizeImageUrl(null)).toBe(null);
            expect(normalizeImageUrl(undefined)).toBe(undefined);
        });
    });

    describe('web-payloads', () => {
        test('convertMessagesToGrokFormat converts OpenAI messages', () => {
            const result = convertMessagesToGrokFormat([
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' }
            ]);

            expect(result).toHaveLength(2);
            expect(result[0].role).toBe('user');
            expect(result[0].content).toBe('Hello');
            expect(result[1].role).toBe('assistant');
            expect(result[1].content).toBe('Hi there');
        });

        test('convertMessagesToGrokFormat handles array content', () => {
            const result = convertMessagesToGrokFormat([
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Hello' }
                    ]
                }
            ]);

            expect(result).toHaveLength(1);
            expect(result[0].role).toBe('user');
        });

        test('convertMessagesToGrokFormat handles empty array', () => {
            const result = convertMessagesToGrokFormat([]);
            expect(result).toHaveLength(1);
            expect(result[0].role).toBe('user');
            expect(result[0].content).toBe('');
        });

        test('convertMessagesToGrokFormat handles null input', () => {
            const result = convertMessagesToGrokFormat(null);
            expect(result).toHaveLength(1);
            expect(result[0].role).toBe('user');
            expect(result[0].content).toBe('');
        });

        test('buildStartConversationPayload builds correct structure', () => {
            const payload = buildStartConversationPayload(
                'conv-123',
                'evt-456',
                [{ role: 'user', content: 'Hello' }]
            );

            expect(payload.session_id).toBe('conv-123');
            expect(payload.event.type).toBe('conversation.item.create');
            expect(payload.event.client_event_id).toBe('evt-456');
            expect(payload.event.conversation.id).toBe('conv-123');
            expect(payload.event.item.type).toBe('message');
            expect(payload.event.item.role).toBe('user');
        });

        test('buildStartConversationPayload handles empty messages', () => {
            const payload = buildStartConversationPayload('conv-123', 'evt-456', []);
            expect(payload).toEqual({});
        });
    });

    describe('GrokWebApiService', () => {
        const createConfig = (overrides = {}) => ({
            uuid: 'test-uuid',
            GROK_COOKIE_TOKEN: 'sso=test-token',
            GROK_CF_CLEARANCE: 'cf-clearance',
            GROK_CF_BM: 'cf-bm',
            GROK_BASE_URL: 'https://grok.com',
            GROK_USER_AGENT: 'test-agent',
            MODEL_PROVIDER: 'grok-web',
            REQUEST_MAX_RETRIES: '3',
            ...overrides
        });

        test('initializes with required configuration', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);

            expect(service.config).toBe(config);
            expect(service.uuid).toBe('test-uuid');
            expect(service.token).toBe('sso=test-token');
            expect(service.cfClearance).toBe('cf-clearance');
            expect(service.cfBm).toBe('cf-bm');
            expect(service.baseUrl).toBe('https://grok.com');
            expect(service.wsBaseUrl).toBe('wss://grok.com');
            expect(service.userAgent).toBe('test-agent');
            expect(service.isInitialized).toBe(false);
        });

        test('sets default base URL when not provided', () => {
            const config = createConfig({ GROK_BASE_URL: undefined });
            const service = new GrokWebApiService(config);

            expect(service.baseUrl).toBe('https://grok.com');
            expect(service.wsBaseUrl).toBe('wss://grok.com');
        });

        test('sets default user agent when not provided', () => {
            const config = createConfig({ GROK_USER_AGENT: undefined });
            const service = new GrokWebApiService(config);

            expect(service.userAgent).toContain('Mozilla');
        });

        test('getWebSocketUrl generates correct URL', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);
            service.userID = 'test-user-id';

            expect(service.getWebSocketUrl()).toBe('wss://grok.com/ws/mgw/?uid=test-user-id');
        });

        test('getWebSocketUrl URL encodes special characters', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);
            service.userID = 'user@id.com';

            expect(service.getWebSocketUrl()).toBe('wss://grok.com/ws/mgw/?uid=user%40id.com');
        });

        test('getWebSocketUrl throws when user ID not set', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);

            expect(() => service.getWebSocketUrl()).toThrow('User ID not resolved');
        });

        test('buildWebSocketHeaders uses service config', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);
            const headers = service.buildWebSocketHeaders();

            expect(headers.Cookie).toContain('sso=test-token');
            expect(headers.Origin).toBe('https://grok.com');
        });

        test('buildHeaders uses service config', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);
            const headers = service.buildHeaders();

            expect(headers.cookie).toContain('sso=test-token');
            expect(headers.origin).toBe('https://grok.com');
        });

        test('_getModelMapping returns correct mapping', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);

            const mapping = service._getModelMapping('grok-4.3');
            expect(mapping.name).toBe('grok-4.3');
        });

        test('getMaxRequestRetries returns parsed config', () => {
            const config = createConfig({ REQUEST_MAX_RETRIES: '5' });
            const service = new GrokWebApiService(config);

            expect(service.getMaxRequestRetries()).toBe(5);
        });

        test('getMaxRequestRetries returns default when invalid', () => {
            const config = createConfig({ REQUEST_MAX_RETRIES: 'invalid' });
            const service = new GrokWebApiService(config);

            expect(service.getMaxRequestRetries()).toBe(3);
        });

        test('listModels returns array of models', async () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);

            const models = await service.listModels();
            expect(Array.isArray(models)).toBe(true);
            expect(models.length).toBeGreaterThan(0);
            expect(models).toContain('grok-4.3');
        });

        test('isExpiryDateNear returns true when never synced', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);

            expect(service.isExpiryDateNear()).toBe(true);
        });

        test('isExpiryDateNear returns false when recently synced', () => {
            const config = createConfig();
            const service = new GrokWebApiService(config);
            service.lastSyncAt = Date.now();

            expect(service.isExpiryDateNear()).toBe(false);
        });
    });
});

