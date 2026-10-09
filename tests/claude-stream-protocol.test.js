import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));

const mockRetryService = {
    generateContentStream: jest.fn()
};
const mockGetApiServiceWithFallback = jest.fn();
jest.mock('../src/services/service-manager.js', () => ({
    getApiServiceWithFallback: mockGetApiServiceWithFallback
}));

let handleStreamRequest;

beforeAll(async () => {
    await import('../src/converters/register-converters.js');
    ({ handleStreamRequest } = await import('../src/utils/common.js'));
});

function geminiChunk({ text, thought = false, call, finishReason } = {}) {
    const parts = [];
    if (text !== undefined) parts.push({ text, ...(thought ? { thought: true } : {}) });
    if (call) parts.push({ functionCall: call });
    return {
        candidates: [{
            content: { role: 'model', parts },
            ...(finishReason ? { finishReason } : {})
        }]
    };
}

function streamOf(items) {
    return (async function* () {
        for (const item of items) {
            if (item instanceof Error) throw item;
            yield item;
        }
    })();
}

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

function events(res) {
    const raw = res.write.mock.calls.flat().join('');
    const result = [];
    let eventType = null;
    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        if (line.startsWith('data: ')) {
            try { result.push({ event: eventType, data: JSON.parse(line.slice(6)) }); } catch {}
            eventType = null;
        }
    }
    return result;
}

async function run({ nativeChunks, fromProvider = 'claude', toProvider = 'gemini-antigravity', serviceOverride, retryContext } = {}) {
    const res = response();
    const service = serviceOverride || { generateContentStream: jest.fn(() => streamOf(nativeChunks)) };
    const manager = pool();
    await handleStreamRequest(
        res, service, 'gemini-3.8-flash-high', {}, fromProvider, toProvider,
        'none', null, manager, 'test-account', null,
        retryContext || { CONFIG: { EMPTY_RESPONSE_RETRY_DELAY_MS: 1 }, maxRetries: 1 }
    );
    return { res, service, manager, out: events(res) };
}

function starts(out) { return out.filter(x => x.data?.type === 'content_block_start'); }
function stops(out) { return out.filter(x => x.data?.type === 'content_block_stop'); }
function deltas(out) { return out.filter(x => x.data?.type === 'content_block_delta'); }

describe('Gemini → Claude stream protocol (#718)', () => {
    beforeEach(() => {
        mockGetApiServiceWithFallback.mockReset();
        mockRetryService.generateContentStream.mockReset();
    });

    test('real Gemini plain text gets message start, text start/delta/stop, terminal sequence', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ text: 'hello', finishReason: 'STOP' })
        ] });
        expect(out.filter(x => x.data?.type === 'message_start')).toHaveLength(1);
        expect(starts(out)).toHaveLength(1);
        expect(starts(out)[0].data.content_block.type).toBe('text');
        expect(deltas(out)[0].data.index).toBe(starts(out)[0].data.index);
        expect(stops(out)).toHaveLength(1);
        expect(out.some(x => x.data?.type === 'message_delta' && x.data.delta?.stop_reason === 'end_turn')).toBe(true);
        expect(out.filter(x => x.data?.type === 'message_stop')).toHaveLength(1);
    });

    test('thinking then text creates two correctly paired blocks with different indexes', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ text: 'reason', thought: true }),
            geminiChunk({ text: 'answer', finishReason: 'STOP' })
        ] });
        const blockStarts = starts(out);
        expect(blockStarts.map(x => x.data.content_block.type)).toEqual(['thinking', 'text']);
        expect(blockStarts.map(x => x.data.index)).toEqual([0, 1]);
        expect(stops(out).map(x => x.data.index)).toEqual([0, 1]);
        expect(deltas(out).map(x => x.data.index)).toEqual([0, 1]);
    });

    test('two Gemini function calls receive independent Claude block indexes', async () => {
        const { out } = await run({ nativeChunks: [
            geminiChunk({ call: { id: 'tool-a', name: 'Read', args: { file_path: 'a.png' } } }),
            geminiChunk({ call: { id: 'tool-b', name: 'Bash', args: { command: 'dir' } }, finishReason: 'STOP' })
        ] });
        const blockStarts = starts(out).filter(x => x.data.content_block.type === 'tool_use');
        expect(blockStarts).toHaveLength(2);
        expect(blockStarts.map(x => x.data.index)).toEqual([0, 1]);
        expect(blockStarts.map(x => x.data.content_block.name)).toEqual(['Read', 'Bash']);
        const jsonDeltas = deltas(out).filter(x => x.data.delta?.type === 'input_json_delta');
        expect(jsonDeltas.map(x => x.data.index)).toEqual([0, 1]);
        expect(stops(out).map(x => x.data.index)).toEqual([0, 1]);
        expect(out.some(x => x.data?.type === 'message_delta' && x.data.delta?.stop_reason === 'tool_use')).toBe(true);
    });

    test('native Claude stream is passed through without duplicate starts or stops', async () => {
        const native = [
            { type: 'message_start', message: { id: 'native', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native text' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' }
        ];
        const { out } = await run({ nativeChunks: native, fromProvider: 'claude', toProvider: 'claude' });
        expect(out.filter(x => x.data?.type === 'message_start')).toHaveLength(1);
        expect(starts(out)).toHaveLength(1);
        expect(stops(out)).toHaveLength(1);
        expect(out.filter(x => x.data?.type === 'message_stop')).toHaveLength(1);
        expect(out.find(x => x.data?.type === 'content_block_start').data.index).toBe(0);
    });

    test('server_tool_use input_json_delta stays server tool and never invents an empty-name tool', async () => {
        const native = [
            { type: 'message_start', message: { id: 'native', type: 'message', role: 'assistant', content: [], usage: {} } },
            { type: 'content_block_start', index: 3, content_block: { type: 'server_tool_use', id: 'srv-1', name: 'web_search', input: {} } },
            { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"query":"zcode"}' } },
            { type: 'content_block_stop', index: 3 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
            { type: 'message_stop' }
        ];
        const { out } = await run({ nativeChunks: native, fromProvider: 'claude', toProvider: 'claude' });
        const serverStart = starts(out).find(x => x.data.content_block.type === 'server_tool_use');
        expect(serverStart.data.content_block.name).toBe('web_search');
        expect(deltas(out).find(x => x.data.delta?.type === 'input_json_delta').data.index).toBe(3);
        expect(starts(out).some(x => x.data.content_block.type === 'tool_use' && !x.data.content_block.name)).toBe(false);
    });

    test('interleaved Responses tool arguments stay on their own calls', async () => {
        const native = [
            { type: 'response.created', response: { id: 'resp-1', model: 'gpt' } },
            { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-a', name: 'get_city' } },
            { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call-b', name: 'get_country' } },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call-a', delta: '{"city":"' },
            { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'call-b', delta: '{"country":"' },
            { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call-a', delta: 'Paris"}' },
            { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'call-b', delta: 'France"}' },
            { type: 'response.function_call_arguments.done', output_index: 0 },
            { type: 'response.function_call_arguments.done', output_index: 1 },
            { type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } }
        ];
        const { out } = await run({
            nativeChunks: native,
            fromProvider: 'claude',
            toProvider: 'grok-cli-oauth'
        });
        const tools = starts(out).filter(x => x.data.content_block.type === 'tool_use');
        expect(tools.map(x => x.data.content_block.id)).toEqual(['call-a', 'call-b']);
        expect(tools.map(x => x.data.content_block.name)).toEqual(['get_city', 'get_country']);
        const args = index => deltas(out)
            .filter(x => x.data.index === index && x.data.delta?.type === 'input_json_delta')
            .map(x => x.data.delta.partial_json)
            .join('');
        expect(JSON.parse(args(tools[0].data.index))).toEqual({ city: 'Paris' });
        expect(JSON.parse(args(tools[1].data.index))).toEqual({ country: 'France' });
        expect(stops(out)).toHaveLength(2);
    });

    test('empty first stream then recursive retry emits one complete shared Claude sequence', async () => {
        const first = { generateContentStream: jest.fn(() => streamOf([])) };
        mockRetryService.generateContentStream.mockImplementation(() => streamOf([
            geminiChunk({ text: 'retry result', finishReason: 'STOP' })
        ]));
        mockGetApiServiceWithFallback.mockResolvedValue({
            service: mockRetryService,
            actualModel: 'gemini-3.8-flash-high',
            actualProviderType: 'gemini-antigravity',
            uuid: 'retry-account',
            serviceConfig: {}
        });

        const { out } = await run({
            serviceOverride: first,
            retryContext: { CONFIG: { EMPTY_RESPONSE_MAX_RETRIES: 1, EMPTY_RESPONSE_RETRY_DELAY_MS: 1 }, maxRetries: 1 }
        });
        expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(out.filter(x => x.data?.type === 'message_start')).toHaveLength(1);
        expect(starts(out)).toHaveLength(1);
        expect(stops(out)).toHaveLength(1);
        expect(out.filter(x => x.data?.type === 'message_stop')).toHaveLength(1);
    });
});
