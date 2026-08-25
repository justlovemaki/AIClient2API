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

test('discovers and persists a missing IdC profileArn', async () => {
    const credentialPath = '/tmp/kiro-test.json';
    const service = new KiroApiService({ KIRO_OAUTH_CREDS_FILE_PATH: credentialPath });
    service.authMethod = 'builder-id';
    service.accessToken = 'access-token';
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

test('includes an existing profileArn in getUsageLimits for Builder ID', async () => {
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
