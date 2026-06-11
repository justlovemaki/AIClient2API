import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/utils/file-lock.js', () => ({
    withFileLock: jest.fn(async (_filePath, callback) => callback(() => {})),
    atomicWriteFile: jest.fn()
}));

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));

const managers = [];

function createManager(providerPools) {
    const manager = new ProviderPoolManager(providerPools, {
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.weight-test.json'
        },
        logLevel: 'error'
    });

    if (manager.saveTimer) {
        clearTimeout(manager.saveTimer);
        manager.saveTimer = null;
    }
    manager._debouncedSave = jest.fn();
    managers.push(manager);
    return manager;
}

afterEach(() => {
    for (const manager of managers) {
        if (manager.saveTimer) {
            clearTimeout(manager.saveTimer);
            manager.saveTimer = null;
        }
    }
    managers.length = 0;
});

describe('ProviderPoolManager weighted selection', () => {
    test('selects healthy providers according to configured weights', async () => {
        const manager = createManager({
            'openai-custom': [
                { uuid: 'high', customName: 'High weight', isHealthy: true, isDisabled: false, weight: 3 },
                { uuid: 'default', customName: 'Default weight', isHealthy: true, isDisabled: false }
            ]
        });

        const selectedCounts = { high: 0, default: 0 };
        for (let i = 0; i < 40; i++) {
            const selected = await manager.selectProvider('openai-custom');
            selectedCounts[selected.uuid]++;
        }

        expect(selectedCounts).toEqual({ high: 30, default: 10 });
    });

    test('uses another provider when the high weight provider has no concurrency capacity', async () => {
        const manager = createManager({
            'openai-custom': [
                {
                    uuid: 'primary',
                    customName: 'Primary',
                    isHealthy: true,
                    isDisabled: false,
                    weight: 100,
                    concurrencyLimit: 1,
                    queueLimit: 0
                },
                {
                    uuid: 'secondary',
                    customName: 'Secondary',
                    isHealthy: true,
                    isDisabled: false,
                    weight: 1,
                    concurrencyLimit: 1,
                    queueLimit: 0
                }
            ]
        });

        const first = await manager.acquireSlot('openai-custom');
        const second = await manager.acquireSlot('openai-custom');

        expect(first.uuid).toBe('primary');
        expect(second.uuid).toBe('secondary');
    });
});
