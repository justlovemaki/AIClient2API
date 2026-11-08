import { jest } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

let CodexApiService;
let CODEX_DEFAULT_MODEL;
let CodexConverter;

beforeAll(async () => {
    ({ CodexApiService, CODEX_DEFAULT_MODEL } = await import('../src/providers/openai/codex-core.js'));
    ({ CodexConverter } = await import('../src/converters/strategies/CodexConverter.js'));
});

function imageRequest(overrides = {}) {
    return {
        input: [{
            role: 'user',
            content: [{ type: 'input_text', text: 'Draw a red circle.' }]
        }],
        ...overrides
    };
}

async function prepare(config, model = 'gpt-image-2', request = imageRequest(), stream = false) {
    const service = new CodexApiService(config);
    return service.prepareRequestBody(model, request, stream);
}

describe('Codex image helper model request construction', () => {
    test('uses Codex client version 0.166.0 in upstream headers', () => {
        const headers = new CodexApiService({}).buildHeaders('cache-key', true);

        expect(headers.version).toBe('0.166.0');
        expect(headers['user-agent']).toContain('codex-tui/0.166.0');
        expect(headers['user-agent']).toContain('codex-tui; 0.166.0');
    });

    test('defaults to gpt-5.6-sol, publishes gpt-6.1-terra, and removes unsupported gpt-5.5', async () => {
        const models = await new CodexApiService({}).listModels();
        const ids = models.data.map(model => model.id);

        expect(CODEX_DEFAULT_MODEL).toBe('gpt-5.6-sol');
        expect(ids).toContain('gpt-5.6-sol');
        expect(ids).toContain('gpt-5.6-sol-fast');
        expect(ids).toContain('gpt-6.1-terra');
        expect(ids).toContain('gpt-6.1-terra-fast');
        expect(ids).not.toContain('gpt-5.5');
        expect(ids).not.toContain('gpt-5.5-fast');
    });

    test('uses the configured helper model for a normal image model', async () => {
        const result = await prepare({ CODEX_IMAGE_HELPER_MODEL: '  gpt-6.1-sol  ' });

        expect(result.model).toBe('gpt-6.1-sol');
        expect(result.tools).toEqual([{ type: 'image_generation' }]);
        expect(result.instructions).toBe('You are a helpful assistant.');
    });

    test('uses the configured helper for an image -fast model with priority but no default effort', async () => {
        const result = await prepare(
            { CODEX_IMAGE_HELPER_MODEL: 'gpt-6-sol' },
            'gpt-image-2-fast',
            imageRequest(),
            true
        );

        expect(result.model).toBe('gpt-6-sol');
        expect(result.stream).toBe(true);
        expect(result.service_tier).toBe('priority');
        expect(result.reasoning.effort).toBeNull();
        expect(result.tools).toEqual([{ type: 'image_generation' }]);
    });

    test('a merged node setting takes precedence over the global setting', async () => {
        const globalConfig = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6-sol' };
        const nodeConfig = { CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' };
        const result = await prepare({ ...globalConfig, ...nodeConfig });

        expect(result.model).toBe('gpt-6.1-sol');
    });

    test.each([
        ['missing', {}],
        ['blank', { CODEX_IMAGE_HELPER_MODEL: '   ' }],
        ['non-string', { CODEX_IMAGE_HELPER_MODEL: 123 }]
    ])('falls back to gpt-5.6-sol for a %s configuration', async (_label, config) => {
        const result = await prepare(config);
        expect(result.model).toBe('gpt-5.6-sol');
    });

    test('moves _imageSize to the image_generation tool only', async () => {
        const result = await prepare(
            { CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' },
            'gpt-image-2',
            imageRequest({ _imageSize: '1536x1024' })
        );

        expect(result.tools).toEqual([{ type: 'image_generation', size: '1536x1024' }]);
        expect(result).not.toHaveProperty('_imageSize');
    });

    test.each([false, true])('passes stream=%s through for image requests', async (stream) => {
        const result = await prepare({ CODEX_IMAGE_HELPER_MODEL: 'gpt-6.1-sol' }, 'gpt-image-2', imageRequest(), stream);
        expect(result.stream).toBe(stream);
    });

    test.each(['gpt-image-2', 'gpt-image-2-fast', 'gpt-image-custom'])('rejects image helper model %s', async (helperModel) => {
        await expect(prepare({ CODEX_IMAGE_HELPER_MODEL: helperModel })).rejects.toThrow(
            'CODEX_IMAGE_HELPER_MODEL must name a mainline model, not a gpt-image-* model.'
        );
    });

    test('does not apply or validate the image helper setting for non-image models', async () => {
        const result = await prepare(
            { CODEX_IMAGE_HELPER_MODEL: 'gpt-image-2' },
            'gpt-6-sol',
            { input: [{ role: 'user', content: 'Hello' }] },
            false
        );

        expect(result.model).toBe('gpt-6-sol');
        expect(result.stream).toBe(false);
        expect(result.tools).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'web_search' }),
            expect.objectContaining({ type: 'image_generation' })
        ]));
    });
});

test('unfinished native image calls do not become empty Chat content chunks', () => {
    const converter = new CodexConverter();
    const event = { type: 'response.output_item.done', item: { id: 'ig_pending', type: 'image_generation_call', status: 'generating' } };
    expect(converter.toOpenAIStreamChunk(event, 'gpt-5.6-sol', 'pending-image-test')).toBeNull();
});

describe('Codex reasoning effort defaults and explicit null (#759)', () => {
    test.each(['gpt-5.6-sol', 'gpt-5.6-sol-fast'])(
        '%s does not clear reasoning just because the image tool is available', async (model) => {
            for (const effort of ['low', 'medium', 'high', 'xhigh', 'minimal', null]) {
                const request = imageRequest({ reasoning: { effort, summary: 'detailed' } });
                const result = await prepare({}, model, request);
                const expectedEffort = effort === null ? null
                    : model.endsWith('-fast') ? 'xhigh'
                    : effort === 'minimal' ? 'none' : effort;
                expect(result.reasoning).toEqual({ effort: expectedEffort, summary: 'detailed' });
                expect(request.reasoning.effort).toBe(effort);
                expect(result.service_tier).toBe(model.endsWith('-fast') ? 'priority' : undefined);
            }
        }
    );

    test.each(['gpt-5.6-sol', 'gpt-5.6-sol-fast'])(
        '%s retains reasoning defaults when tool choice disables image generation', async (model) => {
            for (const tool_choice of ['none', { type: 'function', name: 'lookup' }, { type: 'web_search' },
                { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'web_search' }] }]) {
                const result = await prepare({}, model, imageRequest({ tool_choice }));
                expect(result.reasoning.effort).toBe(model.endsWith('-fast') ? 'xhigh' : 'medium');
            }
        }
    );

    test.each(['auto', 'required', { type: 'image_generation' },
        { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'image_generation' }] }])(
        'keeps the fast effort default when image generation is only available: %j', async (tool_choice) => {
            const result = await prepare({}, 'gpt-5.6-sol-fast', imageRequest({ tool_choice, reasoning: { effort: 'high' } }));
            expect(result.reasoning.effort).toBe('xhigh');
        }
    );

    test('a request without an image tool keeps the original reasoning defaults and minimal alias', async () => {
        const result = await prepare({}, 'gpt-5.3-codex-spark');
        expect(result.tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_generation' })]));
        expect(result.reasoning.effort).toBe('medium');
        const minimal = await prepare({}, 'gpt-5.3-codex-spark', imageRequest({ reasoning: { effort: 'minimal' } }));
        expect(minimal.reasoning.effort).toBe('none');
    });
    test.each([
        ['gpt-image-2', null],
        ['gpt-image-2-fast', null],
        ['gpt-5.6-sol', 'medium'],
        ['gpt-5.6-sol-fast', 'xhigh']
    ])('%s defaults to %s only in the provider', async (model, effort) => {
        const result = await prepare({}, model);
        expect(result.reasoning.effort).toBe(effort);
    });

    test.each(['gpt-image-2', 'gpt-image-2-fast', 'gpt-5.6-sol', 'gpt-5.6-sol-fast'])(
        '%s preserves explicit null in the provider', async (model) => {
            const request = imageRequest({ reasoning: { effort: null, summary: 'detailed' } });
            const result = await prepare({}, model, request);
            expect(result.reasoning).toEqual({ effort: null, summary: 'detailed' });
            expect(request.reasoning.effort).toBeNull();
        }
    );

    describe.each(['toOpenAIRequestToCodexRequest', 'toOpenAIResponsesToCodexRequest'])('%s', (method) => {
        test.each([
            ['absent', {}, undefined, null],
            ['nested null', { reasoning: { effort: null } }, null, null],
            ['top-level null', { reasoning_effort: null }, null, null],
            ['top-level null wins', { reasoning_effort: null, reasoning: { effort: 'high' } }, null, null],
            ['top-level value wins', { reasoning_effort: 'low', reasoning: { effort: null } }, 'low', 'low'],
            ['explicit effort', { reasoning: { effort: 'high' } }, 'high', 'high'],
            ['minimal alias', { reasoning: { effort: 'minimal' } }, 'minimal', 'none']
        ])('preserves %s through conversion and preparation', async (_label, reasoning, convertedEffort, upstreamEffort) => {
            const original = {
                model: 'gpt-image-2',
                messages: [{ role: 'user', content: 'Draw a cat.' }],
                input: 'Draw a cat.',
                ...reasoning
            };
            const converted = new CodexConverter()[method](original);
            expect(converted.reasoning.effort).toBe(convertedEffort);
            expect(converted).not.toHaveProperty('reasoning_effort');

            const result = await prepare({}, original.model, converted);
            expect(result.reasoning.effort).toBe(upstreamEffort);
            // JSON serialization must retain null, not omit it or replace it with a string.
            expect(JSON.parse(JSON.stringify(result)).reasoning.effort).toBe(upstreamEffort);
        });

        test.each(['gpt-5.6-sol', 'gpt-5.6-sol-fast'])('preserves text defaults for %s after conversion', async (model) => {
            const converted = new CodexConverter()[method]({ model, messages: [], input: 'Hello' });
            const result = await prepare({}, model, converted);
            expect(result.reasoning.effort).toBe(model.endsWith('-fast') ? 'xhigh' : 'medium');
        });
    });
});
