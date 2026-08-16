import {
    getProviderModels,
    IFLOW_MANUAL_MODELS
} from '../src/providers/provider-models.js';

describe('MiniMax model registry', () => {
    test('includes the current MiniMax models', () => {
        const models = getProviderModels('openai-iflow');

        expect(models).toEqual(expect.arrayContaining([
            'MiniMax-M3',
            'MiniMax-M2.7'
        ]));
    });

    test('supplements upstream model responses from the same registry source', () => {
        expect(IFLOW_MANUAL_MODELS).toEqual(expect.arrayContaining([
            'MiniMax-M3',
            'MiniMax-M2.7'
        ]));
    });
});
