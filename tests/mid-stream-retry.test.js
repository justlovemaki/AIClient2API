import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));

let handleStreamRequest;

beforeAll(async () => {
    await import('../src/converters/register-converters.js');
    ({ handleStreamRequest } = await import('../src/utils/common.js'));
});

function response() {
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = jest.fn();
    res.write = jest.fn();
    res.end = jest.fn(function end() { this.writableEnded = true; });
    return res;
}

function pool() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        releaseSlot: jest.fn()
    };
}

function serviceWith(attempts) {
    let call = 0;
    return {
        calls: () => call,
        generateContentStream: jest.fn(() => {
            const items = attempts[Math.min(call, attempts.length - 1)] || [];
            call += 1;
            return (async function* () {
                for (const item of items) yield item;
            })();
        })
    };
}

async function run(service, fromProvider = 'openai', toProvider = 'gemini-antigravity', model = 'gemini-3.8-flash-high') {
    const res = response();
    const manager = pool();
    await handleStreamRequest(
        res, service, model, {}, fromProvider, toProvider,
        'none', null, manager, 'only', null,
        { CONFIG: { EMPTY_RESPONSE_RETRY_DELAY_MS: 1 }, maxRetries: 0 }
    );
    return { body: res.write.mock.calls.flat().join(''), calls: service.calls(), manager };
}

describe('upstream stream completion and truncation', () => {
    test('a finished Responses stream is requested once', async () => {
        const service = serviceWith([[
            { type: 'response.created', response: { id: 'resp-1', model: 'grok' } },
            { type: 'response.output_text.delta', delta: 'hello' },
            { type: 'response.completed', response: { output: [], usage: {} } }
        ]]);
        const { calls, body } = await run(service, 'openai', 'grok-cli-oauth', 'grok');
        expect(calls).toBe(1);
        expect(body).toContain('hello');
    });

    test('a native Claude message_stop is requested once', async () => {
        const service = serviceWith([[
            { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'message_stop' }
        ]]);
        const { calls } = await run(service, 'claude', 'claude-kiro', 'claude-sonnet');
        expect(calls).toBe(1);
    });

    test('a partial tool argument is not concatenated with a replayed request', async () => {
        const service = serviceWith([
            [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"x":' } }] } }] }],
            [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }] }]
        ]);
        const { calls, body, manager } = await run(service, 'openai', 'openai-custom', 'gpt-4o');
        const events = body.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
            .map(line => JSON.parse(line.slice(6)));
        const argument = events.find(event => event.choices)?.choices[0].delta.tool_calls[0].function.arguments;
        expect(calls).toBe(1);
        expect(argument).toBe('{"x":');
        expect(argument).not.toContain('{"x":1}');
        expect(events.some(event => event.error)).toBe(true);
        expect(manager.markProviderHealthy).not.toHaveBeenCalled();
    });

    test('an EOF after a malformed finish is a truncation, not a success', async () => {
        const malformed = { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { role: 'model', parts: [{ text: 'partial' }] } }] };
        const service = serviceWith([
            [malformed],
            [{ candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] }]
        ]);
        const { body, manager } = await run(service);
        expect(body).toContain('error');
        expect(manager.markProviderHealthy).not.toHaveBeenCalled();
    });

    test('three truncated attempts end as an error instead of a synthetic success', async () => {
        const textOnly = { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] };
        const service = serviceWith([[], [], [textOnly]]);
        const { calls, body, manager } = await run(service);
        expect(calls).toBeLessThanOrEqual(3);
        expect(body).toContain('error');
        expect(manager.markProviderHealthy).not.toHaveBeenCalled();
    });
});
