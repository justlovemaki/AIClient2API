import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

import '../src/converters/register-converters.js';
import { ConverterFactory } from '../src/converters/ConverterFactory.js';
import { handleStreamRequest } from '../src/utils/common.js';
import {
    releaseStreamState,
    toOpenAIStreamChunkFromGemini
} from '../src/convert/convert.js';

function geminiChunk({ callId, args = {}, text, finishReason } = {}) {
    const parts = [];
    if (text !== undefined) parts.push({ text });
    if (callId) parts.push({
        functionCall: { id: callId, name: 'lookup', args }
    });
    return {
        candidates: [{
            content: { role: 'model', parts },
            ...(finishReason ? { finishReason } : {})
        }]
    };
}

function createResponse() {
    const response = new EventEmitter();
    response.writableEnded = false;
    response.writeHead = jest.fn();
    response.write = jest.fn();
    response.end = jest.fn(function end() {
        this.writableEnded = true;
    });
    return response;
}

function createPool() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        releaseSlot: jest.fn()
    };
}

function createService(chunks) {
    return {
        generateContentStream: jest.fn(() => (async function* stream() {
            for (const chunk of chunks) {
                if (chunk instanceof Error) throw chunk;
                if (typeof chunk === 'function') {
                    await chunk();
                    continue;
                }
                yield chunk;
            }
        })())
    };
}

async function runStream({ service, response = createResponse(), retryContext = null } = {}) {
    const pool = createPool();
    await handleStreamRequest(
        response,
        service,
        'gemini-3.8-flash-high',
        {},
        'openai',
        'gemini-antigravity',
        'none',
        null,
        pool,
        'test-account',
        null,
        retryContext || { CONFIG: {}, maxRetries: 0 }
    );
    return { response, pool };
}

function getGeminiConverter() {
    return ConverterFactory.getConverter('gemini');
}

describe('Gemini → OpenAI stream state lifecycle (#724)', () => {
    beforeEach(() => {
        getGeminiConverter().openAIStreamStates?.clear();
    });

    test('parallel function calls keep one chunk id, increment indexes, and end only on STOP', () => {
        const converter = getGeminiConverter();
        const first = converter.toOpenAIStreamChunk(geminiChunk({ callId: 'a', args: { q: 'alpha' } }), 'm', 'request-a');
        const second = converter.toOpenAIStreamChunk(geminiChunk({ callId: 'b', args: { q: 'beta' } }), 'm', 'request-a');
        const stop = converter.toOpenAIStreamChunk(geminiChunk({ finishReason: 'STOP' }), 'm', 'request-a');

        expect(first.id).toBe(second.id);
        expect(first.choices[0].delta.tool_calls[0].index).toBe(0);
        expect(second.choices[0].delta.tool_calls[0].index).toBe(1);
        expect(first.choices[0].finish_reason).toBeNull();
        expect(second.choices[0].finish_reason).toBeNull();
        expect(stop.choices[0].finish_reason).toBe('tool_calls');
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test('real handler: STOP releases its request state', async () => {
        const converter = getGeminiConverter();
        await runStream({
            service: createService([
                geminiChunk({ callId: 'a' }),
                geminiChunk({ finishReason: 'STOP' })
            ])
        });
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test('real handler: client close releases state without an upstream finish block', async () => {
        const converter = getGeminiConverter();
        const response = createResponse();
        await runStream({
            response,
            service: createService([
                geminiChunk({ callId: 'a' }),
                () => response.emit('close'),
                geminiChunk({ text: 'never forwarded' })
            ])
        });
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test('real handler: upstream throw releases state', async () => {
        const converter = getGeminiConverter();
        await runStream({
            service: createService([
                geminiChunk({ callId: 'a' }),
                new Error('upstream boom')
            ])
        });
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test('real handler: EOF without finishReason releases state', async () => {
        const converter = getGeminiConverter();
        await runStream({
            service: createService([geminiChunk({ callId: 'a' })])
        });
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test('recursive retry frame releases its own state', async () => {
        const converter = getGeminiConverter();
        await runStream({
            service: createService([geminiChunk({ callId: 'retry-call' })]),
            retryContext: {
                CONFIG: {},
                maxRetries: 1,
                currentRetry: 1,
                clientDisconnected: { value: false }
            }
        });
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test('finishing one real handler stream does not clear another active request', async () => {
        const converter = getGeminiConverter();
        let releaseA;
        const waitA = new Promise(resolve => { releaseA = resolve; });
        const responseA = createResponse();
        const responseB = createResponse();

        const promiseA = runStream({
            response: responseA,
            service: createService([
                geminiChunk({ callId: 'a' }),
                () => waitA
            ])
        });

        await new Promise(resolve => setImmediate(resolve));
        expect(converter.openAIStreamStateCount()).toBe(1);

        await runStream({
            response: responseB,
            service: createService([
                geminiChunk({ callId: 'b' }),
                geminiChunk({ finishReason: 'STOP' })
            ])
        });
        expect(converter.openAIStreamStateCount()).toBe(1);

        releaseA();
        await promiseA;
        expect(converter.openAIStreamStateCount()).toBe(0);
    });

    test('compatibility helper forwards requestId and release is per request', () => {
        const converter = getGeminiConverter();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const a = toOpenAIStreamChunkFromGemini(geminiChunk({ callId: 'a' }), 'm', 'helper-a');
        const b = toOpenAIStreamChunkFromGemini(geminiChunk({ callId: 'b' }), 'm', 'helper-b');
        const a2 = toOpenAIStreamChunkFromGemini(geminiChunk({ callId: 'a2' }), 'm', 'helper-a');

        expect(a.choices[0].delta.tool_calls[0].index).toBe(0);
        expect(b.choices[0].delta.tool_calls[0].index).toBe(0);
        expect(a2.choices[0].delta.tool_calls[0].index).toBe(1);
        expect(a.id).not.toBe(b.id);

        releaseStreamState('gemini', 'helper-a');
        expect(converter.openAIStreamStateCount()).toBe(1);
        releaseStreamState('gemini', 'helper-b');
        expect(converter.openAIStreamStateCount()).toBe(0);

        toOpenAIStreamChunkFromGemini(geminiChunk({ callId: 'default' }), 'm');
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
