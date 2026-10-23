jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));
jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: config => config,
    isTLSSidecarEnabledForProvider: () => false,
    getProxyConfigForProvider: () => null
}));

import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { resolveCodexCacheIdentity } from '../src/providers/openai/codex-request-utils.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';

describe('Codex prompt cache identity', () => {
    test('preserves an explicit client prompt_cache_key in the upstream body and headers', async () => {
        const service = new CodexApiService({});
        const request = {
            model: 'gpt-5.5',
            prompt_cache_key: 'factory-session-713',
            metadata: {session_id: 'metadata-must-not-override-explicit-key'},
            input: [{
                type: 'message',
                role: 'user',
                content: [
                    {type: 'input_text', text: 'inspect this image'},
                    {type: 'input_image', image_url: 'data:image/png;base64,AAAA'}
                ]
            }]
        };

        const converter = new CodexConverter();
        const converted = converter.toOpenAIResponsesToCodexRequest(structuredClone(request), 'request-1');
        const body = await service.prepareRequestBody('gpt-5.5', converted, true);
        const headers = service.buildHeaders(body.prompt_cache_key, true);

        const followUpRequest = structuredClone(request);
        followUpRequest.input.push({type: 'message', role: 'assistant', content: 'first answer'});
        followUpRequest.input.push({type: 'message', role: 'user', content: 'follow up'});
        const convertedFollowUp = converter.toOpenAIResponsesToCodexRequest(followUpRequest, 'request-2');
        const followUpBody = await service.prepareRequestBody('gpt-5.5', convertedFollowUp, true);

        expect(body.prompt_cache_key).toBe('factory-session-713');
        expect(followUpBody.prompt_cache_key).toBe(body.prompt_cache_key);
        expect(body.metadata).toBeUndefined();
        expect(headers['session-id']).toBe('factory-session-713');
        expect(headers['thread-id']).toBe('factory-session-713');
        expect(headers.Session_id).toBe('factory-session-713');
        expect(headers.Conversation_id).toBe('factory-session-713');
    });

    test('uses stable client session metadata without a one-hour proxy-local UUID', async () => {
        const firstService = new CodexApiService({});
        const secondService = new CodexApiService({});
        const request = {
            metadata: {session_id: 'long-running-session'},
            input: [{type: 'message', role: 'user', content: 'hello'}]
        };

        const first = await firstService.prepareRequestBody('gpt-5.5', structuredClone(request), true);
        const afterRestart = await secondService.prepareRequestBody('gpt-5.5', structuredClone(request), true);

        expect(first.prompt_cache_key).toBe('long-running-session');
        expect(afterRestart.prompt_cache_key).toBe(first.prompt_cache_key);
    });

    test('derives a deterministic fallback from the append-only prefix', () => {
        const base = {
            instructions: 'stable instructions',
            tools: [{type: 'function', name: 'shell'}],
            input: [{type: 'message', role: 'user', content: 'first turn'}]
        };
        const appended = {
            ...base,
            input: [...base.input, {type: 'message', role: 'user', content: 'second turn'}]
        };
        const unrelated = {
            ...base,
            input: [{type: 'message', role: 'user', content: 'different first turn'}]
        };

        const first = resolveCodexCacheIdentity(base);
        const second = resolveCodexCacheIdentity(appended);
        const third = resolveCodexCacheIdentity(unrelated);

        expect(first.source).toBe('prefix_fingerprint');
        expect(second.key).toBe(first.key);
        expect(third.key).not.toBe(first.key);
    });

    test('distinguishes Chat Completions chats by their first user message', () => {
        const shared = {
            messages: [
                {role: 'system', content: 'You are a helpful assistant.'}
            ],
            tools: [{type: 'function', name: 'shell'}]
        };
        const first = resolveCodexCacheIdentity({
            ...shared,
            messages: [...shared.messages, {role: 'user', content: 'first chat'}]
        });
        const different = resolveCodexCacheIdentity({
            ...shared,
            messages: [...shared.messages, {role: 'user', content: 'different chat'}]
        });

        expect(first.key).not.toBe(different.key);
    });

    test('keeps a Chat Completions identity stable as history is appended', () => {
        const firstTurn = {
            messages: [
                {role: 'system', content: 'You are a helpful assistant.'},
                {role: 'user', content: 'start this conversation'}
            ]
        };
        const followUp = {
            ...firstTurn,
            messages: [
                ...firstTurn.messages,
                {role: 'assistant', content: 'acknowledged'},
                {role: 'user', content: 'continue'}
            ]
        };

        expect(resolveCodexCacheIdentity(followUp).key)
            .toBe(resolveCodexCacheIdentity(firstTurn).key);
    });

    test('hashes values that are unsafe to mirror into HTTP headers', () => {
        const service = new CodexApiService({});
        const unsafe = '会话 cache key';

        const first = service.toSafeCacheHeaderValue(unsafe);
        const second = service.toSafeCacheHeaderValue(unsafe);

        expect(first).toMatch(/^aic2a-[a-f0-9]{32}$/);
        expect(second).toBe(first);
    });
});
