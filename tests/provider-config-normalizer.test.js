import { describe, expect, test } from '@jest/globals';
import { normalizeProviderConfigFields } from '../src/utils/provider-config-normalizer.js';

describe('normalizeProviderConfigFields', () => {
    test('normalizes provider weight to an integer', () => {
        expect(normalizeProviderConfigFields({ weight: '42' })).toEqual({ weight: 42 });
    });

    test('defaults invalid provider weight to 1', () => {
        expect(normalizeProviderConfigFields({ weight: '0' })).toEqual({ weight: 1 });
        expect(normalizeProviderConfigFields({ weight: 'abc' })).toEqual({ weight: 1 });
    });

    test('caps provider weight at 100', () => {
        expect(normalizeProviderConfigFields({ weight: '999' })).toEqual({ weight: 100 });
    });
});
