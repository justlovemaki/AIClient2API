import { getProviderModels } from '../src/providers/provider-models.js';
import { resolveGrokCliQualityModel } from '../src/providers/grok/grok-cli-models.js';

describe('Grok CLI virtual quality models', () => {
    test('advertises the four free-account Grok 4.7 quality variants', () => {
        const models = getProviderModels('grok-cli-oauth');

        expect(models).toEqual(expect.arrayContaining([
            'grok-4.7-low',
            'grok-4.7-medium',
            'grok-4.7-high',
            'grok-4.7-extra-high'
        ]));
    });

    test.each([
        ['grok-4.7-low', 'low'],
        ['grok-4.7-medium', 'medium'],
        ['grok-4.7-high', 'high'],
        ['grok-4.7-extra-high', 'extra_high']
    ])('maps %s to Grok 4.7 with %s reasoning', (model, effort) => {
        expect(resolveGrokCliQualityModel(model)).toEqual({
            model: 'grok-4.7',
            effort
        });
    });
});
