/**
 * Jest tests for KIRO_API_KEY (ksk_...) + Rust User-Agent integration
 * in src/providers/claude/claude-kiro.js (KiroApiService).
 *
 * All network calls are mocked (axios.create/request) — no real HTTP is made.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Mocks (hoisted by babel-jest) ---
var mockAxiosCreate;
var mockAxiosRequest;
var mockAxiosCreateConfigs;

jest.mock('axios', () => {
    mockAxiosCreateConfigs = [];
    mockAxiosRequest = jest.fn();
    // Snapshot the config: initialize() reuses the same object and later
    // replaces headers with a WHATWG Headers instance, which would otherwise
    // clobber the first call's captured headers.
    mockAxiosCreate = jest.fn((config) => {
        mockAxiosCreateConfigs.push({ ...config, headers: { ...(config.headers || {}) } });
        return { request: mockAxiosRequest };
    });
    return {
        __esModule: true,
        default: { create: mockAxiosCreate }
    };
});

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        initialize: jest.fn(),
        cleanupOldLogs: jest.fn()
    }
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn((config) => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/services/service-manager.js', () => ({
    __esModule: true,
    getProviderPoolManager: jest.fn(() => null)
}));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';

const RUST_UA_PATTERN = 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0';
const KIRO_AMZ_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';
const KSK_KEY = 'ksk_test_1234567890';

const REQUEST_BODY = {
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    system: '',
    thinking: null
};

let tempDir;

function makeService(config = {}) {
    return new KiroApiService({
        KIRO_OAUTH_CREDS_DIR_PATH: tempDir,
        ...config
    });
}

function writeTokenFile(data) {
    fs.writeFileSync(path.join(tempDir, 'kiro-auth-token.json'), JSON.stringify(data, null, 2));
}

function lastRequestConfig() {
    expect(mockAxiosRequest).toHaveBeenCalledTimes(1);
    return mockAxiosRequest.mock.calls[0][0];
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-api-key-test-'));
    jest.clearAllMocks();
    mockAxiosCreateConfigs.length = 0;
    delete process.env.KIRO_API_KEY;
});

afterEach(() => {
    delete process.env.KIRO_API_KEY;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('KIRO_API_KEY support via config and process.env', () => {
    test('reads KIRO_API_KEY from config', () => {
        const service = new KiroApiService({ KIRO_API_KEY: KSK_KEY });
        expect(service.apiKey).toBe(KSK_KEY);
    });

    test('falls back to process.env.KIRO_API_KEY when config has none', () => {
        process.env.KIRO_API_KEY = 'ksk_env_123';
        const service = new KiroApiService({});
        expect(service.apiKey).toBe('ksk_env_123');
    });

    test('config KIRO_API_KEY takes precedence over process.env.KIRO_API_KEY', () => {
        process.env.KIRO_API_KEY = 'ksk_env_123';
        const service = new KiroApiService({ KIRO_API_KEY: 'ksk_config_456' });
        expect(service.apiKey).toBe('ksk_config_456');
    });

    test('loadCredentials promotes config KIRO_API_KEY to accessToken without OAuth files', async () => {
        const service = makeService({ KIRO_API_KEY: KSK_KEY });
        await service.loadCredentials();
        expect(service.accessToken).toBe(KSK_KEY);
        expect(service.accessToken.startsWith('ksk_')).toBe(true);
    });

    test('loadCredentials promotes process.env.KIRO_API_KEY to accessToken', async () => {
        process.env.KIRO_API_KEY = 'ksk_env_123';
        const service = makeService({});
        await service.loadCredentials();
        expect(service.accessToken).toBe('ksk_env_123');
    });

    test('KIRO_API_KEY overrides OAuth accessToken loaded from token file', async () => {
        writeTokenFile({ accessToken: 'oauth_access_old', refreshToken: 'refresh_123', region: 'us-east-1' });
        const service = makeService({ KIRO_API_KEY: KSK_KEY });
        await service.loadCredentials();
        expect(service.accessToken).toBe(KSK_KEY);
    });
});

describe('OAuth token refresh bypass for ksk_ keys', () => {
    test('initializeAuth(true) skips OAuth refresh when accessToken is a ksk_ key', async () => {
        const service = makeService({ KIRO_API_KEY: KSK_KEY });
        const refreshSpy = jest.spyOn(service, '_doTokenRefresh');

        await expect(service.initializeAuth(true)).resolves.toBeUndefined();

        expect(refreshSpy).not.toHaveBeenCalled();
        expect(mockAxiosRequest).not.toHaveBeenCalled();
        expect(service.accessToken).toBe(KSK_KEY);
        refreshSpy.mockRestore();
    });

    test('initializeAuth(true) does not refresh even when an OAuth refreshToken exists in the credentials file', async () => {
        writeTokenFile({ accessToken: 'oauth_access_old', refreshToken: 'refresh_token_abc', region: 'us-east-1' });
        const service = makeService({ KIRO_API_KEY: KSK_KEY });
        const refreshSpy = jest.spyOn(service, '_doTokenRefresh');

        await service.initializeAuth(true);

        expect(refreshSpy).not.toHaveBeenCalled();
        expect(mockAxiosRequest).not.toHaveBeenCalled();
        expect(service.accessToken).toBe(KSK_KEY);
        refreshSpy.mockRestore();
    });

    test('initializeAuth(true) with a ksk_ key persists no token file', async () => {
        const service = makeService({ KIRO_API_KEY: KSK_KEY });
        await service.initializeAuth(true);
        expect(fs.existsSync(path.join(tempDir, 'kiro-auth-token.json'))).toBe(false);
    });

    test('initializeAuth() returns early when an access token is already present', async () => {
        const service = makeService({});
        service.accessToken = KSK_KEY;
        const loadSpy = jest.spyOn(service, 'loadCredentials');

        await service.initializeAuth();

        expect(loadSpy).not.toHaveBeenCalled();
        expect(mockAxiosRequest).not.toHaveBeenCalled();
        loadSpy.mockRestore();
    });

    test('without a ksk_ key, initializeAuth(true) attempts refresh and fails without refreshToken', async () => {
        const service = makeService({});
        await expect(service.initializeAuth(true)).rejects.toThrow(
            'No refresh token available to refresh access token.'
        );
        expect(mockAxiosRequest).not.toHaveBeenCalled();
    });
});

describe('Rust User-Agent, x-amz-target and TokenType headers', () => {
    test('initialize() configures axios with Rust User-Agent and x-amz-target headers', async () => {
        const service = makeService({ KIRO_API_KEY: KSK_KEY });
        await service.initialize();

        expect(mockAxiosCreate).toHaveBeenCalled();
        const headers = mockAxiosCreateConfigs[0].headers;

        expect(headers['user-agent']).toBe(RUST_UA_PATTERN + ' md/appVersion-2.10.0 app/AmazonQ-For-CLI');
        expect(headers['x-amz-user-agent']).toBe(RUST_UA_PATTERN + ' m/F app/AmazonQ-For-CLI');
        expect(headers['x-amz-target']).toBe(KIRO_AMZ_TARGET);
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['Accept']).toBe('application/json');
    });

    test('callApi sends Bearer auth, TokenType: API_KEY, Rust User-Agent and x-amz-target for a ksk_ key', async () => {
        mockAxiosRequest.mockResolvedValue({ data: {} });
        const service = makeService({ KIRO_API_KEY: KSK_KEY });
        await service.initialize();
        await service.callApi('', 'claude-sonnet-4-5', REQUEST_BODY);

        const config = lastRequestConfig();
        expect(config.method).toBe('post');
        expect(config.url).toBe(service.baseUrl);
        expect(config.headers['Authorization']).toBe(`Bearer ${KSK_KEY}`);
        expect(config.headers['TokenType']).toBe('API_KEY');
        expect(config.headers['x-amz-target']).toBe(KIRO_AMZ_TARGET);
        expect(config.headers['user-agent']).toContain('aws-sdk-rust');
        expect(config.headers['x-amz-user-agent']).toContain('lang/rust/1.92.0');
    });

    test('callApi sets TokenType: API_KEY when the key comes from process.env.KIRO_API_KEY', async () => {
        process.env.KIRO_API_KEY = 'ksk_env_123';
        mockAxiosRequest.mockResolvedValue({ data: {} });
        const service = makeService({});
        await service.initialize();
        await service.callApi('', 'claude-sonnet-4-5', REQUEST_BODY);

        const config = lastRequestConfig();
        expect(config.headers['Authorization']).toBe('Bearer ksk_env_123');
        expect(config.headers['TokenType']).toBe('API_KEY');
    });

    test('callApi sets TokenType: API_KEY when KIRO_API_KEY is configured even if the token lacks the ksk_ prefix', async () => {
        mockAxiosRequest.mockResolvedValue({ data: {} });
        const service = makeService({ KIRO_API_KEY: 'custom_key_not_ksk' });
        await service.initialize();
        await service.callApi('', 'claude-sonnet-4-5', REQUEST_BODY);

        const config = lastRequestConfig();
        expect(config.headers['Authorization']).toBe('Bearer custom_key_not_ksk');
        expect(config.headers['TokenType']).toBe('API_KEY');
    });

    test('callApi omits TokenType for plain OAuth access tokens', async () => {
        writeTokenFile({ accessToken: 'oauth_access_123', refreshToken: 'refresh_123', region: 'us-east-1' });
        mockAxiosRequest.mockResolvedValue({ data: {} });
        const service = makeService({});
        await service.initialize();
        await service.callApi('', 'claude-sonnet-4-5', REQUEST_BODY);

        const config = lastRequestConfig();
        expect(config.headers['Authorization']).toBe('Bearer oauth_access_123');
        expect(config.headers['TokenType']).toBeUndefined();
        expect(config.headers['x-amz-target']).toBe(KIRO_AMZ_TARGET);
    });

    test('streamApiReal sends TokenType: API_KEY and Rust User-Agent on the stream request', async () => {
        mockAxiosRequest.mockResolvedValue({ data: [] });
        const service = makeService({ KIRO_API_KEY: KSK_KEY });
        await service.initialize();

        const iterator = service.streamApiReal('', 'claude-sonnet-4-5', REQUEST_BODY);
        await iterator.next();
        await iterator.return();

        const config = lastRequestConfig();
        expect(config.responseType).toBe('stream');
        expect(config.headers['Authorization']).toBe(`Bearer ${KSK_KEY}`);
        expect(config.headers['TokenType']).toBe('API_KEY');
        expect(config.headers['x-amz-target']).toBe(KIRO_AMZ_TARGET);
        expect(config.headers['user-agent']).toContain('aws-sdk-rust');
        expect(config.headers['x-amz-user-agent']).toContain('lang/rust/1.92.0');
    });
});
