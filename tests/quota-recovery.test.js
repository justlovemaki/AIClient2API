import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));

const mockGetApiServiceWithFallback = jest.fn();
jest.mock('../src/services/service-manager.js', () => ({
    getApiServiceWithFallback: mockGetApiServiceWithFallback
}));

import { getQuotaRecoveryTime, isQuotaExhaustedError } from '../src/providers/gemini/quota-recovery.js';

let handleStreamRequest;
let handleUnaryRequest;

beforeAll(async () => {
    await import('../src/converters/register-converters.js');
    ({ handleStreamRequest, handleUnaryRequest } = await import('../src/utils/common.js'));
});

function response() {
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = jest.fn();
    res.write = jest.fn();
    res.end = jest.fn(function end() { this.writableEnded = true; });
    return res;
}

function poolWith(accounts, currentUuid) {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        releaseSlot: jest.fn(),
        providerStatus: {
            'gemini-antigravity': accounts.map(account => ({
                uuid: account.uuid,
                config: { uuid: account.uuid, isHealthy: account.healthy !== false, isDisabled: account.disabled === true }
            }))
        },
        currentUuid
    };
}

function quotaError({ body, asString = false, recovery, exhausted = true } = {}) {
    const error = new Error('Upstream API Error (Status 429)');
    error.status = 429;
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    error.quotaExhausted = exhausted;
    error.response = { status: 429, data: asString ? JSON.stringify(body) : body };
    if (recovery) error.quotaRecoveryTime = recovery;
    return error;
}

const exhaustedBody = (extra = {}) => [{
    error: {
        status: 'RESOURCE_EXHAUSTED',
        message: 'quota',
        details: [{ metadata: extra }]
    }
}];

function failingService(error) {
    return {
        generateContentStream: jest.fn(async () => { throw error; }),
        generateContent: jest.fn(async () => { throw error; })
    };
}

async function runStream(error, manager, maxRetries = 5) {
    const res = response();
    const started = Date.now();
    await handleStreamRequest(
        res, failingService(error), 'gemini-3.8-flash-high', {}, 'claude', 'gemini-antigravity',
        'none', null, manager, manager.currentUuid, null,
        { CONFIG: {}, maxRetries }
    );
    return { res, elapsed: Date.now() - started, body: res.write.mock.calls.flat().join('') };
}

describe('Google quota metadata parsing', () => {
    const now = Date.parse('2026-10-09T12:00:00.000Z');

    test('reads an absolute timestamp from an array body', () => {
        const recovery = getQuotaRecoveryTime(quotaError({
            body: exhaustedBody({ quotaResetTimeStamp: '2026-10-09T18:00:00.000Z' })
        }), now);
        expect(recovery.toISOString()).toBe('2026-10-09T18:00:00.000Z');
        expect(isQuotaExhaustedError(quotaError({ body: exhaustedBody() }))).toBe(true);
    });

    test('reads hours, minutes and seconds from a raw string body', () => {
        const recovery = getQuotaRecoveryTime(quotaError({
            asString: true,
            body: exhaustedBody({ quotaResetDelay: '3h48m29s' })
        }), now);
        expect(recovery.getTime() - now).toBe((3 * 3600 + 48 * 60 + 29) * 1000);
    });

    test('plain 429 and Retry-After are not quota exhaustion', () => {
        const plain = new Error('limited');
        plain.response = { status: 429, headers: { 'retry-after': '2' }, data: { error: { message: 'slow down' } } };
        expect(isQuotaExhaustedError(plain)).toBe(false);
        expect(getQuotaRecoveryTime(plain, now)).toBeNull();
    });
});

describe('quota exhaustion does not spin on the same account', () => {
    beforeEach(() => {
        mockGetApiServiceWithFallback.mockReset();
    });

    test('one account returns 429 immediately and stores the absolute recovery time', async () => {
        const recovery = new Date('2026-10-09T18:00:00.000Z');
        const manager = poolWith([{ uuid: 'only' }], 'only');
        const { elapsed, body } = await runStream(
            quotaError({ body: exhaustedBody({ quotaResetTimeStamp: recovery.toISOString() }), recovery }),
            manager
        );

        expect(elapsed).toBeLessThan(1500);
        expect(mockGetApiServiceWithFallback).not.toHaveBeenCalled();
        expect(manager.markProviderUnhealthyWithRecoveryTime).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'only' },
            '429 RESOURCE_EXHAUSTED - quota recovery scheduled',
            recovery
        );
        expect(body).toContain('Quota is expected to recover at 2026-10-09T18:00:00.000Z');
        expect(body).toContain('rate_limit_error');
    });

    test('string error body with an h/m/s delay is accepted by the recovery parser path', async () => {
        const now = Date.now();
        const recovery = new Date(now + ((3 * 3600 + 48 * 60 + 29) * 1000));
        const manager = poolWith([{ uuid: 'only' }], 'only');
        await runStream(
            quotaError({
                asString: true,
                body: exhaustedBody({ quotaResetDelay: '3h48m29s' }),
                recovery
            }),
            manager
        );
        const stored = manager.markProviderUnhealthyWithRecoveryTime.mock.calls[0][3];
        expect(stored.toISOString()).toBe(recovery.toISOString());
    });

    test('two healthy accounts switch exactly once and do not wait when the next uuid differs', async () => {
        const recovery = new Date('2026-10-09T18:00:00.000Z');
        const manager = poolWith([{ uuid: 'first' }, { uuid: 'second' }], 'first');
        const stop = new Error('stop after one switch');
        stop.status = 400;
        stop.response = { status: 400, data: {} };
        const second = failingService(stop);
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: second,
            uuid: 'second',
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-3.8-flash-high',
            serviceConfig: {}
        });

        const { elapsed } = await runStream(quotaError({ body: exhaustedBody(), recovery }), manager);

        expect(elapsed).toBeLessThan(1500);
        expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(second.generateContentStream).toHaveBeenCalledTimes(1);
    });

    test('a plain 429 without quota metadata still uses the short cooldown path', async () => {
        const manager = poolWith([{ uuid: 'only' }], 'only');
        const error = new Error('too many requests');
        error.status = 429;
        error.response = { status: 429, data: { error: { message: 'slow down' } } };
        await runStream(error, manager, 0);
        expect(manager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(manager.markProviderUnhealthy).toHaveBeenCalled();
    });

    test('one account without a parseable recovery time is not selected again', async () => {
        const manager = poolWith([{ uuid: 'only' }], 'only');
        const { elapsed } = await runStream(quotaError({ body: exhaustedBody() }), manager);
        expect(elapsed).toBeLessThan(1500);
        expect(mockGetApiServiceWithFallback).not.toHaveBeenCalled();
        expect(manager.markProviderHealthy).not.toHaveBeenCalled();
    });

    test('a configured healthy fallback provider is used when the current pool is exhausted', async () => {
        const manager = poolWith([{ uuid: 'only' }], 'only');
        manager.fallbackChain = { 'gemini-antigravity': ['gemini-cli-oauth'] };
        manager.providerStatus['gemini-cli-oauth'] = [{
            uuid: 'backup',
            config: { uuid: 'backup', isHealthy: true }
        }];
        const backup = failingService(Object.assign(new Error('backup answered'), { status: 400, response: { status: 400, data: {} } }));
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: backup,
            uuid: 'backup',
            actualProviderType: 'gemini-cli-oauth',
            actualModel: 'gemini-3.8-flash-high',
            serviceConfig: {}
        });
        await runStream(quotaError({ body: exhaustedBody() }), manager);
        expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(mockGetApiServiceWithFallback.mock.calls[0][2].excludeUuids).toEqual(['only']);
        expect(backup.generateContentStream).toHaveBeenCalledTimes(1);
    });

    test('unary requests with one account also return immediately', async () => {
        const recovery = new Date('2026-10-09T19:00:00.000Z');
        const manager = poolWith([{ uuid: 'only' }], 'only');
        const res = response();
        const started = Date.now();
        await handleUnaryRequest(
            res, failingService(quotaError({ body: exhaustedBody(), recovery })),
            'gemini-3.8-flash-high', {}, 'openai', 'gemini-antigravity',
            'none', null, manager, 'only', null, { CONFIG: {}, maxRetries: 5 }
        );
        expect(Date.now() - started).toBeLessThan(1500);
        expect(mockGetApiServiceWithFallback).not.toHaveBeenCalled();
        expect(res.end.mock.calls.flat().join('')).toContain('2026-10-09T19:00:00.000Z');
    });
});
