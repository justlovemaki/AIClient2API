jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(),
    getProxyConfigForProvider: jest.fn(),
    getGoogleAuthProxyConfig: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { AntigravityApiService, isAntigravityModelRetired } from '../src/providers/gemini/antigravity-core.js';
import { PROVIDER_MODELS } from '../src/providers/provider-models.js';

describe('Antigravity model availability', () => {
    const cutoff = Date.UTC(2026, 10, 3);

    test('includes the supplied Gemini Medium aliases and GPT-OSS model', () => {
        expect(PROVIDER_MODELS['gemini-antigravity']).toEqual(expect.arrayContaining([
            'gemini-3.6-flash-medium',
            'gemini-3.7-flash-medium',
            'gemini-3.8-flash-medium',
            'gemini-3.1-pro-low',
            'gemini-claude-sonnet-4-6',
            'gemini-claude-opus-4-6-thinking',
            'gpt-oss-120b-medium'
        ]));
    });

    test('retires third-party aliases starting November 3, 2026 UTC', () => {
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff - 1)).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff)).toBe(true);
        expect(isAntigravityModelRetired('gpt-oss-120b-medium', cutoff)).toBe(true);
        expect(isAntigravityModelRetired('gemini-3.8-flash-medium', cutoff)).toBe(false);
    });

    test('omits retired models from the API list and rejects direct requests', async () => {
        const service = Object.create(AntigravityApiService.prototype);
        service.isInitialized = true;
        service.availableModels = [
            'gemini-3.8-flash-medium',
            'gemini-claude-sonnet-4-6',
            'gpt-oss-120b-medium'
        ];
        jest.useFakeTimers().setSystemTime(cutoff);

        try {
            const response = await service.listModels();
            expect(response.models.map(model => model.name)).toEqual([
                'models/gemini-3.8-flash-medium'
            ]);
            expect(() => service.buildAntigravityPayload('gemini-claude-sonnet-4-6', {}))
                .toThrow('Free-plan access to non-Gemini model');
            expect(() => service.buildAntigravityPayload('gpt-oss-120b-medium', {}))
                .toThrow('Free-plan access to non-Gemini model');
        } finally {
            jest.useRealTimers();
        }
    });
});