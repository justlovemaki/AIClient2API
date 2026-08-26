import test from 'node:test';
import assert from 'node:assert/strict';
import { KiroApiService } from '../src/providers/claude/claude-kiro.js';

function disposeService(service) {
    if (service?.keepAliveAgent) service.keepAliveAgent.destroy();
    if (service?.keepAliveAgentHttps) service.keepAliveAgentHttps.destroy();
}

test('includes an existing profileArn for Builder ID generation requests', async () => {
    const service = new KiroApiService({});
    service.authMethod = 'builder-id';
    service.profileArn = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL';

    const request = await service.buildCodewhispererRequest(
        [{ role: 'user', content: 'hello' }],
        'claude-sonnet-4-5'
    );

    assert.equal(request.profileArn, service.profileArn);
    disposeService(service);
});

test('uses the Kiro Builder ID profile when profile discovery is unsupported', async () => {
    const service = new KiroApiService({});
    service.authMethod = 'builder-id';
    service.accessToken = 'access-token';
    service.expiresAt = new Date(Date.now() + 60_000).toISOString();
    service.region = 'us-east-1';
    const requests = [];
    service.axiosInstance = {
        request: async (config) => {
            requests.push(config);
            const error = new Error('Request failed with status code 403');
            error.response = {
                status: 403,
                data: { message: 'AWS Builder ID is not supported for this operation.' }
            };
            throw error;
        }
    };
    service.saveCredentialsToFile = async () => {};

    const arn = await service.ensureProfileArn();

    assert.equal(arn, 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX');
    assert.equal(service.profileArn, arn);
    assert.equal(requests.length, 1);
    disposeService(service);
});

test('refreshes an expired access token before profile discovery', async () => {
    const service = new KiroApiService({});
    service.authMethod = 'builder-id';
    service.accessToken = 'expired-access-token';
    service.expiresAt = new Date(Date.now() - 60_000).toISOString();
    service.region = 'us-east-1';
    let refreshCount = 0;
    service.initializeAuth = async (forceRefresh) => {
        assert.equal(forceRefresh, true);
        refreshCount++;
        service.accessToken = 'fresh-access-token';
        service.expiresAt = new Date(Date.now() + 60_000).toISOString();
    };
    service.axiosInstance = {
        request: async (config) => {
            assert.equal(config.headers.Authorization, 'Bearer fresh-access-token');
            return {
                data: {
                    profiles: [
                        { arn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL' }
                    ]
                }
            };
        }
    };
    service.saveCredentialsToFile = async () => {};

    const arn = await service.ensureProfileArn();

    assert.equal(arn, 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL');
    assert.equal(refreshCount, 1);
    disposeService(service);
});

test('refreshes and retries profile discovery after an unexpected 401', async () => {
    const service = new KiroApiService({});
    service.authMethod = 'builder-id';
    service.accessToken = 'stale-access-token';
    service.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    service.region = 'us-east-1';
    let refreshCount = 0;
    let requestCount = 0;
    service.initializeAuth = async (forceRefresh) => {
        assert.equal(forceRefresh, true);
        refreshCount++;
        service.accessToken = 'fresh-access-token';
    };
    service.axiosInstance = {
        request: async (config) => {
            requestCount++;
            if (requestCount === 1) {
                assert.equal(config.headers.Authorization, 'Bearer stale-access-token');
                const error = new Error('Request failed with status code 401');
                error.response = { status: 401, data: { message: 'Unauthorized' } };
                throw error;
            }
            assert.equal(config.headers.Authorization, 'Bearer fresh-access-token');
            return {
                data: {
                    profiles: [
                        { arn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL' }
                    ]
                }
            };
        }
    };
    service.saveCredentialsToFile = async () => {};

    const arn = await service.ensureProfileArn();

    assert.equal(arn, 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL');
    assert.equal(refreshCount, 1);
    assert.equal(requestCount, 2);
    disposeService(service);
});

test('does not treat unrelated 403 responses as Builder ID fallback', async () => {
    const service = new KiroApiService({});
    service.authMethod = 'builder-id';
    service.accessToken = 'access-token';
    service.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    service.region = 'us-east-1';
    service.idcRegion = 'us-east-1';
    service.axiosInstance = {
        request: async () => {
            const error = new Error('Request failed with status code 403');
            error.response = { status: 403, data: { message: 'User is not authorized to make this call.' } };
            throw error;
        }
    };

    await assert.rejects(
        service.ensureProfileArn(),
        /Kiro profileArn is missing and automatic discovery failed: User is not authorized/
    );
    assert.equal(service.profileArn, undefined);
    disposeService(service);
});

test('refreshes at most once when profile discovery keeps returning 401', async () => {
    const service = new KiroApiService({});
    service.authMethod = 'builder-id';
    service.accessToken = 'stale-access-token';
    service.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    service.region = 'ap-southeast-1';
    service.idcRegion = 'eu-west-1';
    let refreshCount = 0;
    service.initializeAuth = async () => {
        refreshCount++;
        service.accessToken = 'fresh-access-token';
    };
    service.axiosInstance = {
        request: async () => {
            const error = new Error('Request failed with status code 401');
            error.response = { status: 401, data: { message: 'Unauthorized' } };
            throw error;
        }
    };

    await assert.rejects(service.ensureProfileArn(), /Unauthorized/);
    assert.equal(refreshCount, 1);
    disposeService(service);
});

test('uses a discovered profileArn when credential persistence fails', async () => {
    const service = new KiroApiService({});
    service.authMethod = 'builder-id';
    service.accessToken = 'access-token';
    service.expiresAt = new Date(Date.now() + 60_000).toISOString();
    service.region = 'us-east-1';
    service.axiosInstance = {
        request: async () => ({
            data: {
                profiles: [
                    { arn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL' }
                ]
            }
        })
    };
    service.saveCredentialsToFile = async () => {
        throw new Error('read-only credential file');
    };

    const arn = await service.ensureProfileArn();

    assert.equal(arn, 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL');
    assert.equal(service.profileArn, arn);
    disposeService(service);
});

test('discovers and persists a missing IdC profileArn', async () => {
    const credentialPath = '/tmp/kiro-test.json';
    const service = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: credentialPath });
    service.authMethod = 'builder-id';
    service.accessToken = 'access-token';
    service.expiresAt = new Date(Date.now() + 60_000).toISOString();
    service.region = 'us-east-1';
    const requests = [];
    service.axiosInstance = {
        request: async (config) => {
            requests.push(config);
            return {
                status: 200,
                data: {
                    profiles: [
                        { arn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL' }
                    ]
                }
            };
        }
    };
    const writes = [];
    service.saveCredentialsToFile = async (...args) => writes.push(args);

    const arn = await service.ensureProfileArn();

    assert.equal(arn, 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL');
    assert.equal(service.profileArn, arn);
    assert.deepEqual(writes, [[credentialPath, { profileArn: arn }]]);
    assert.equal(requests.length, 1);
    disposeService(service);
});

test('omits the Builder ID placeholder profileArn from getUsageLimits', async () => {
    const service = new KiroApiService({});
    service.isInitialized = true;
    service.authMethod = 'builder-id';
    service.accessToken = 'access-token';
    service.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    service.baseUrl = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse';
    service.region = 'us-east-1';
    const requests = [];
    service.axiosInstance = {
        request: async (config) => {
            requests.push(config);
            if (config.headers?.['x-amz-target'] === 'AmazonCodeWhispererService.ListAvailableProfiles') {
                const error = new Error('Request failed with status code 403');
                error.response = {
                    status: 403,
                    data: { message: 'AWS Builder ID is not supported for this operation.' }
                };
                throw error;
            }
            return { data: { usedCount: 1, limitCount: 10 } };
        }
    };

    await service.getUsageLimits();

    assert.equal(service.profileArn, 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX');
    assert.equal(requests.length, 2);
    assert.doesNotMatch(requests[1].url, /profileArn=/);
    disposeService(service);
});

test('includes an existing real profileArn in getUsageLimits for Builder ID', async () => {
    const service = new KiroApiService({});
    service.isInitialized = true;
    service.authMethod = 'builder-id';
    service.accessToken = 'access-token';
    service.profileArn = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/REAL';
    service.baseUrl = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse';
    service.region = 'us-east-1';
    const requests = [];
    service.axiosInstance = {
        request: async (config) => {
            requests.push(config);
            return { data: { usedCount: 1, limitCount: 10 } };
        }
    };

    await service.getUsageLimits();

    assert.match(requests[0].url, new RegExp(`profileArn=${encodeURIComponent(service.profileArn)}`));
    disposeService(service);
});
