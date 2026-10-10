jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: config => config,
    configureTLSSidecar: config => config,
    isTLSSidecarEnabledForProvider: () => false
}));
jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => []),
    getServiceAdapter: jest.fn(),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: new Map()
}));

import { normalizeAntigravityQuota } from '../src/ui-modules/provider-api.js';

describe('Antigravity provider quota', () => {
    test('converts model remaining fractions to average used percentage', () => {
        expect(normalizeAntigravityQuota({
            models: {
                'gemini-3-flash': { quotaInfo: { remainingFraction: 0.75 } },
                'gemini-3-pro': { quotaInfo: { remainingFraction: 0.25 } }
            }
        })).toEqual({ available: true, usedPercentage: 50 });
    });

    test('returns unavailable when no model has a numeric remaining fraction', () => {
        expect(normalizeAntigravityQuota({ models: { broken: { quotaInfo: {} } } }))
            .toEqual({ available: false, usedPercentage: null });
    });
});
