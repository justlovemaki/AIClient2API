import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ENDPOINT_TYPE, handleContentGenerationRequest } from '../src/utils/common.js';
import { MODEL_PROTOCOL_PREFIX as PROTOCOL } from '../src/utils/constants.js';
import { replaceRequestSystemPrompts } from '../src/utils/system-prompt-replacements.js';
import { getPluginManager } from '../src/core/plugin-manager.js';
import { ProviderStrategy } from '../src/utils/provider-strategy.js';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { GrokApiService } from '../src/providers/grok/grok-core.js';
import logger from '../src/utils/logger.js';
import monitor from '../src/plugins/ai-monitor/index.js';
import '../src/converters/register-converters.js';

const rules = [{ old: 'old', new: 'old!' }, { old: '!', new: '?' }];
const openaiBody = () => ({ model: 'test-model', messages: [
    { role: 'system', content: 'old old' },
    { role: 'developer', content: [{ type: 'text', text: 'old' }] },
    { role: 'user', content: 'old' },
] });

async function send(t, input, options = {}) {
    const { endpoint = ENDPOINT_TYPE.OPENAI_CHAT, response = { choices: [] }, buildPayload, ...config } = options;
    let sent;
    let hook;
    const logs = [];
    t.mock.method(ProviderStrategy.prototype, '_updateSystemPromptFile', async () => {});
    t.mock.method(logger, 'info', msg => logs.push(msg));
    t.mock.method(getPluginManager(), 'executeHook', async (name, args) => {
        if (name === 'onContentGenerated') {
            hook = args;
            await monitor.hooks.onContentGenerated(args);
        }
    });
    const req = Readable.from([Buffer.from(JSON.stringify(input))]);
    req.url = '/v1beta/models/gemini-3-flash:generateContent';
    req.headers = { host: 'localhost' };
    const res = { writeHead: status => assert.equal(status, 200), end() {} };
    const service = { async generateContent(model, body) {
        buildPayload?.(model, body);
        sent = structuredClone(body);
        return response;
    } };
    await handleContentGenerationRequest(req, res, service, endpoint, {
        MODEL_PROVIDER: 'openai-custom', SYSTEM_PROMPT_FILE_PATH: 'unused.txt',
        SYSTEM_PROMPT_CONTENT: null, SYSTEM_PROMPT_REPLACEMENTS: rules, ...config,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(hook.originalRequestBody, input);
    assert.deepEqual(hook.processedRequestBody, sent);
    return { sent, logs };
}

test('request-only replacement preserves the original monitor snapshot and user text', async t => {
    const input = openaiBody();
    const { sent, logs } = await send(t, input);
    assert.equal(sent.messages[0].content, 'old? old?');
    assert.deepEqual(sent.messages[1].content, [{ type: 'text', text: 'old?' }]);
    assert.equal(sent.messages[2].content, 'old');
    assert.ok(logs.some(line => line.endsWith(`[Req Original]: ${JSON.stringify(input)}`)));
    assert.ok(logs.some(line => line.endsWith(`[Req Processed]: ${JSON.stringify(sent)}`)));
});

const overwrite = { SYSTEM_PROMPT_MODE: 'overwrite', SYSTEM_PROMPT_CONTENT: 'file old' };

test('Chat overwrite removes every system and developer message, including via Forward', async t => {
    for (const provider of ['openai-custom', 'forward-api']) {
        await t.test(provider, async t => {
            const input = openaiBody();
            input.messages.push({ role: 'system', content: 'later system' });
            const { sent } = await send(t, input, { ...overwrite, MODEL_PROVIDER: provider });
            assert.deepEqual(sent.messages, [
                { role: 'system', content: 'file old?' }, input.messages[2],
            ]);
        });
    }
});

test('Responses overwrite removes both instruction forms but keeps tool and user input', async t => {
    for (const provider of ['openaiResponses-custom', 'grok-cli-oauth', 'forward-api', 'openai-codex-oauth']) {
        await t.test(provider, async t => {
            const kept = [{ type: 'message', role: 'user', content: 'old' },
                { type: 'function_call_output', call_id: 'call_1', output: 'old' },
                { type: 'additional_tools', role: 'developer', tools: [] }];
            const input = { model: 'test-model', instructions: 'old instructions', input: [
                { type: 'message', role: 'system', content: 'old system' },
                { role: 'developer', content: 'old developer' },
                { type: 'developer', content: 'legacy developer' }, ...kept,
            ] };
            const { sent } = await send(t, input, { ...overwrite, MODEL_PROVIDER: provider,
                endpoint: ENDPOINT_TYPE.OPENAI_RESPONSES, response: { output: [], status: 'completed' } });
            assert.equal(sent.instructions, 'file old?');
            assert.deepEqual(sent.input, kept);
            assert.equal(sent.messages, undefined);
        });
    }
});

test('Forward overwrites Gemini and Claude system fields in their original formats', async t => {
    await t.test('Gemini', async t => {
        const input = { system_instruction: { parts: [{ text: 'old snake' }] }, systemInstruction: 'old camel',
            contents: [{ role: 'user', parts: [{ text: 'old' }] }] };
        const { sent } = await send(t, input, { ...overwrite, MODEL_PROVIDER: 'forward-api',
            endpoint: ENDPOINT_TYPE.GEMINI_CONTENT, response: { candidates: [] } });
        assert.deepEqual(sent.systemInstruction, { parts: [{ text: 'file old?' }] });
        assert.equal(sent.system_instruction, undefined);
        assert.deepEqual(sent.contents, input.contents);
        assert.equal(sent.messages, undefined);
    });
    await t.test('Claude', async t => {
        const input = { model: 'test-model', system: [{ type: 'text', text: 'old system' }],
            messages: [{ role: 'user', content: 'old' }] };
        const { sent } = await send(t, input, { ...overwrite, MODEL_PROVIDER: 'forward-api',
            endpoint: ENDPOINT_TYPE.CLAUDE_MESSAGE, response: { content: [] } });
        assert.equal(sent.system, 'file old?');
        assert.deepEqual(sent.messages, input.messages);
    });
});

test('cross-protocol overwrite removes a lone Chat system message before Gemini can turn it into user text', async t => {
    const input = { model: 'test-model', messages: [{ role: 'system', content: 'old system' }] };
    const { sent } = await send(t, input, { ...overwrite, MODEL_PROVIDER: 'gemini-antigravity',
        response: { candidates: [] } });
    assert.deepEqual(sent.systemInstruction, { parts: [{ text: 'file old?' }] });
    assert.deepEqual(sent.contents, []);
});

test('overwrite without a loaded file keeps the original roles and applies text rules only', async t => {
    const { sent } = await send(t, openaiBody(), { SYSTEM_PROMPT_MODE: 'overwrite' });
    assert.deepEqual(sent.messages.map(message => message.role), ['system', 'developer', 'user']);
    assert.equal(sent.messages[0].content, 'old? old?');
});

test('file and request text are replaced once after append', async t => {
    const { sent } = await send(t, openaiBody(), { SYSTEM_PROMPT_MODE: 'append', SYSTEM_PROMPT_CONTENT: 'file old' });
    assert.equal(sent.messages[0].content, 'old? old?\nfile old?');
    assert.equal(sent.messages[1].content[0].text, 'old?');
    assert.equal(sent.messages[2].content, 'old');
});

test('converted requests receive replacements in the upstream format', async t => {
    const { sent } = await send(t, openaiBody(), { MODEL_PROVIDER: 'claude-custom', response: {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'test-model',
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    } });
    assert.match(JSON.stringify(sent.system), /old\? old\?/);
    assert.match(JSON.stringify(sent.messages), /"text":"old"/);
});

for (const [endpoint, input] of [
    [ENDPOINT_TYPE.OPENAI_CHAT, { model: 'gemini-3-flash', messages: [
        { role: 'system', content: 'old' }, { role: 'user', content: 'old' },
    ] }],
    [ENDPOINT_TYPE.GEMINI_CONTENT, { system_instruction: { parts: ['old'] },
        contents: [{ role: 'user', parts: [{ text: 'old' }] }] }],
]) {
    test(`Antigravity forwards replaced system text from ${endpoint} in its final payload`, async t => {
        let payload;
        await send(t, input, {
            endpoint, MODEL_PROVIDER: 'gemini-antigravity', response: { candidates: [] },
            buildPayload(model, body) {
                ({ payload } = AntigravityApiService.prototype.buildAntigravityPayload.call({
                    availableModels: ['gemini-3-flash'],
                }, model, body));
            },
        });
        assert.equal(payload.request.systemInstruction.parts.at(-1).text, 'old?');
        assert.equal(payload.request.contents[0].parts[0].text, 'old');
    });
}

test('forward preserves client protocol and replaces Responses instructions', async t => {
    const { sent } = await send(t, { model: 'test-model', instructions: 'old', input: 'old' }, {
        MODEL_PROVIDER: 'forward-api', endpoint: ENDPOINT_TYPE.OPENAI_RESPONSES,
    });
    assert.equal(sent.instructions, 'old?');
    assert.equal(sent.input, 'old');
});

test('Codex appends file to incoming instructions without duplicating or dropping developer text', async t => {
    const user = { type: 'message', role: 'user', content: 'old' };
    const { sent } = await send(t, { model: 'test-model', instructions: 'top old', input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev old' }] }, user,
    ] }, { MODEL_PROVIDER: 'openai-codex-oauth', endpoint: ENDPOINT_TYPE.OPENAI_RESPONSES,
        SYSTEM_PROMPT_MODE: 'append', SYSTEM_PROMPT_CONTENT: 'file old', response: { output: [], status: 'completed' } });
    assert.equal(sent.instructions, 'top old?\ndev old?\nfile old?');
    assert.deepEqual(sent.input, [user]);
});

test('Grok web keeps the replaced file prompt in the structured messages sent to its provider', async t => {
    const { sent } = await send(t, openaiBody(), {
        MODEL_PROVIDER: 'grok-web', SYSTEM_PROMPT_MODE: 'append', SYSTEM_PROMPT_CONTENT: 'file old',
        response: { message: 'OK' },
    });
    assert.equal(sent.messages[0].content, 'old? old?');
    assert.deepEqual(sent.messages[2], { role: 'user', content: 'old' });
    assert.deepEqual(sent.messages[3], { role: 'system', content: 'file old?' });
});

test('Grok web overwrite removes old system and developer messages from the flattened prompt', async t => {
    const input = openaiBody();
    input.messages.push({ role: 'assistant', content: 'assistant history' }, { role: 'user', content: 'follow-up' });
    let flattened;
    const { sent } = await send(t, input, {
        MODEL_PROVIDER: 'grok-web', SYSTEM_PROMPT_MODE: 'overwrite', SYSTEM_PROMPT_CONTENT: 'file old',
        response: { message: 'OK' },
        buildPayload(_model, body) {
            const copy = structuredClone(body);
            GrokApiService.prototype._extractMessagesAndFiles.call({}, copy);
            flattened = copy.message;
        },
    });
    assert.deepEqual(sent.messages, [{ role: 'system', content: 'file old?' }, ...input.messages.slice(2)]);
    assert.equal(flattened, '[system]: file old?\n\nold\n\n[assistant]: assistant history\n\nfollow-up');
});

test('replaces only structured system text for Gemini, Claude, and Responses', () => {
    const gemini = { systemInstruction: { parts: [{ text: 'old' }] },
        system_instruction: { parts: [{ text: 'old' }] }, contents: [{ parts: [{ text: 'old' }] }] };
    replaceRequestSystemPrompts(gemini, PROTOCOL.GEMINI, rules);
    assert.equal(gemini.systemInstruction.parts[0].text, 'old?');
    assert.equal(gemini.system_instruction.parts[0].text, 'old?');
    assert.equal(gemini.contents[0].parts[0].text, 'old');

    const claude = { system: [{ type: 'text', text: 'old', cache_control: { type: 'ephemeral' } }] };
    replaceRequestSystemPrompts(claude, PROTOCOL.CLAUDE, rules);
    assert.deepEqual(claude.system, [{ type: 'text', text: 'old?', cache_control: { type: 'ephemeral' } }]);

    const responses = { instructions: 'old', input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'old' }] },
        { role: 'user', content: 'old' },
    ] };
    replaceRequestSystemPrompts(responses, PROTOCOL.OPENAI_RESPONSES, [null, { old: '', new: '?' }, { old: 'old', new: '' }]);
    assert.equal(responses.instructions, '');
    assert.equal(responses.input[0].content[0].text, '');
    assert.equal(responses.input[1].content, 'old');
});
