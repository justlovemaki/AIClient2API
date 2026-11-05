import { CONFIG } from '../core/config-manager.js';
import logger from '../utils/logger.js';
import { serviceInstances, getServiceAdapter } from '../providers/adapter.js';
import { usageService } from '../services/usage-service.js';
import { readUsageCache, writeUsageCache, readProviderUsageCache, updateProviderUsageCache } from './usage-cache.js';
import { PROVIDER_MAPPINGS } from '../utils/provider-utils.js';
import { MODEL_PROVIDER } from '../utils/common.js';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.end(JSON.stringify(payload));
}

const supportedProviders = [
    MODEL_PROVIDER.KIRO_API, 
    MODEL_PROVIDER.GEMINI_CLI, 
    MODEL_PROVIDER.ANTIGRAVITY, 
    MODEL_PROVIDER.CODEX_API, 
    MODEL_PROVIDER.GROK_CLI
];


/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
async function getAllProvidersUsage(currentConfig, providerPoolManager) {
    const results = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    // 并发获取所有提供商的用量数据
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
            return { providerType, data: providerUsage, success: true };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    instances: []
                },
                success: false
            };
        }
    });

    // 等待所有并发请求完成
    const usageResults = await Promise.all(usagePromises);

    // 将结果整合到 results.providers 中
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
    }

    return results;
}

/**
 * 加载提供商池数据（从内存或文件）
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Array} 提供商列表
 */
function loadProviderList(providerType, currentConfig, providerPoolManager) {
    // 优先从内存获取
    if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
        return providerPoolManager.providerPools[providerType];
    }
    if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
        return currentConfig.providerPools[providerType];
    }
    // Fallback: 从文件读取
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            if (poolsData[providerType] && poolsData[providerType].length > 0) {
                logger.info(`[Usage API] Loaded ${poolsData[providerType].length} providers for ${providerType} from file fallback`);
                return poolsData[providerType];
            }
        }
    } catch (fileError) {
        logger.warn(`[Usage API] Failed to load provider pools from file: ${fileError.message}`);
    }
    return [];
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 提供商用量信息
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager) {
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // 获取提供商池中的所有实例（使用统一的加载函数）
    const providers = loadProviderList(providerType, currentConfig, providerPoolManager);

    result.totalCount = providers.length;

    // 遍历所有提供商实例获取用量
    for (const provider of providers) {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];
        
        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            configFilePath: getProviderConfigFilePath(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            success: false,
            usage: null,
            error: null
        };

        // First check if disabled, skip initialization for disabled providers
        if (provider.isDisabled) {
            instanceResult.error = 'Provider is disabled';
            result.errorCount++;
        } else if (!adapter) {
            // Service instance not initialized, try auto-initialization
            try {
                logger.info(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
                // Build configuration object
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                logger.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                result.errorCount++;
            }
        }
        
        // If adapter exists (including just initialized), and no error, try to get usage
        if (adapter && !instanceResult.error) {
            try {
                const usage = await usageService.getFormattedUsage(providerType, provider.uuid);
                instanceResult.success = true;
                instanceResult.usage = usage;
                result.successCount++;
            } catch (error) {
                instanceResult.error = error.message;
                result.errorCount++;
            }
        }

        result.instances.push(instanceResult);
    }

    return result;
}

/**
 * 获取提供商显示名称

 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(provider, providerType) {
    // 1. 优先使用自定义名称
    if (provider.customName) {
        return provider.customName;
    }

    // 2. 尝试从凭据文件路径提取名称（自动从文件名识别账号）
    const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === providerType);
    const credPathKey = mapping ? mapping.credPathKey : null;

    // 只有当键名包含 'PATH' 或 'FILE' 时，才将其视为文件路径进行解析
    if (credPathKey && provider[credPathKey] && (credPathKey.includes('PATH') || credPathKey.includes('FILE'))) {
        const filePath = provider[credPathKey];
        // 提取文件名（不含扩展名）作为显示名称，例如 account-a.json -> account-a
        const fileName = path.basename(filePath, path.extname(filePath));
        if (fileName) return fileName;
    }

    // 3. 兜底显示 UUID
    if (provider.uuid) {
        return provider.uuid;
    }

    return 'Unnamed';
}

/**
 * 获取提供商配置文件路径
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string|null} 配置文件路径
 */
function getProviderConfigFilePath(provider, providerType) {
    const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === providerType);
    const credPathKey = mapping ? mapping.credPathKey : null;

    // 只有当键名包含 'PATH' 或 'FILE' 时，才返回路径
    if (credPathKey && provider[credPathKey] && (credPathKey.includes('PATH') || credPathKey.includes('FILE'))) {
        return provider[credPathKey];
    }
    return null;
}

/**
 * 重新格式化用量结果（基于保存的原始数据）
 * 确保即使格式化逻辑改变，缓存数据也能以最新格式返回
 * @param {Object} results - 用量结果对象
 */
function reformatUsageResults(results) {
    if (!results || !results.providers) return;
    
    for (const [providerType, providerData] of Object.entries(results.providers)) {
        if (providerData.instances && Array.isArray(providerData.instances)) {
            for (const instance of providerData.instances) {
                // 如果有原始数据（保存在 usage.raw 中），重新执行格式化
                if (instance.success && instance.usage && instance.usage.raw) {
                    try {
                        instance.usage = usageService.formatUsage(providerType, instance.usage.raw);
                    } catch (err) {
                        logger.error(`[Usage API] Failed to re-format cached data for ${providerType}:`, err.message);
                    }
                }
            }
        }
    }
}

async function resolveProviderInstance(currentConfig, providerPoolManager, providerType, uuid) {
    const providers = loadProviderList(providerType, currentConfig, providerPoolManager);
    const provider = providers.find(p => p.uuid === uuid);

    if (!provider) {
        throw new Error(`未找到指定的提供商实例: ${uuid}`);
    }

    const providerKey = providerType + (provider.uuid || '');
    let adapter = serviceInstances[providerKey];

    const instanceResult = {
        uuid: provider.uuid || 'unknown',
        name: getProviderDisplayName(provider, providerType),
        configFilePath: getProviderConfigFilePath(provider, providerType),
        isHealthy: provider.isHealthy !== false,
        isDisabled: provider.isDisabled === true,
        success: false,
        usage: null,
        error: null
    };

    if (provider.isDisabled) {
        instanceResult.error = 'Provider is disabled';
        return { provider, adapter: null, instanceResult };
    }

    if (!adapter) {
        const serviceConfig = {
            ...CONFIG,
            ...provider,
            MODEL_PROVIDER: providerType
        };
        adapter = getServiceAdapter(serviceConfig);
    }

    return { provider, adapter, instanceResult };
}

async function updateSingleInstanceInCache(providerType, uuid, instanceResult) {
    try {
        const cache = await readUsageCache();
        if (!cache?.providers?.[providerType]?.instances || !Array.isArray(cache.providers[providerType].instances)) {
            return;
        }

        const providerCache = cache.providers[providerType];
        const idx = providerCache.instances.findIndex(inst => inst.uuid === uuid);
        if (idx !== -1) {
            providerCache.instances[idx] = instanceResult;
        } else {
            providerCache.instances.push(instanceResult);
        }

        let successCount = 0;
        let errorCount = 0;
        providerCache.instances.forEach(inst => {
            if (inst.success) {
                successCount++;
            } else {
                errorCount++;
            }
        });
        providerCache.successCount = successCount;
        providerCache.errorCount = errorCount;
        providerCache.totalCount = providerCache.instances.length;

        cache.timestamp = new Date().toISOString();
        await writeUsageCache(cache);
        logger.info(`[Usage API] Updated global usage cache for single instance ${providerType}:${uuid}`);
    } catch (cacheError) {
        logger.warn('[Usage API] Failed to update global usage cache for single instance:', cacheError.message);
    }
}

/**
 * 获取支持用量查询的提供商列表
 */
export async function handleGetSupportedProviders(req, res) {
    try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(supportedProviders));
        return true;
    } catch (error) {
        logger.error('[Usage API] Failed to get supported providers:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get supported providers: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取所有提供商的用量限制
 */
export async function handleGetUsage(req, res, currentConfig, providerPoolManager) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        
        let usageResults;
        
        if (!refresh) {
            // 优先读取缓存
            const cachedData = await readUsageCache();
            if (cachedData) {
                logger.info('[Usage API] Returning cached usage data');
                usageResults = { ...cachedData, fromCache: true };
                // 使用最新的格式化逻辑处理缓存的原始数据
                reformatUsageResults(usageResults);
            }
        }
        
        if (!usageResults) {
            // 缓存不存在或需要刷新，重新查询
            logger.info('[Usage API] Fetching fresh usage data');
            usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager);
            // 写入缓存
            await writeUsageCache(usageResults);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to get usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get usage info: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取特定提供商实例的用量限制
 */
export async function handleGetSingleInstanceUsage(req, res, currentConfig, providerPoolManager, providerType, uuid) {
    try {
        let instanceResult = null;

        // 重新查询
        logger.info(`[Usage API] Fetching fresh usage data for ${providerType}:${uuid}`);

        const { provider, adapter, instanceResult: baseInstanceResult } = await resolveProviderInstance(
            currentConfig,
            providerPoolManager,
            providerType,
            uuid
        );

        instanceResult = baseInstanceResult;

        if (adapter && !instanceResult.error) {
            try {
                const usage = await usageService.getFormattedUsage(providerType, provider.uuid);
                instanceResult.success = true;
                instanceResult.usage = usage;
            } catch (error) {
                instanceResult.error = error.message;
            }
        }

        await updateSingleInstanceInCache(providerType, uuid, instanceResult);
        
        const finalResults = {
            ...instanceResult,
            serverTime: new Date().toISOString()
        };

        sendJson(res, 200, finalResults);
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to get usage for ${providerType}:${uuid}:`, error);
        sendJson(res, 500, {
            error: {
                message: `Failed to get usage info for ${providerType}:${uuid}: ` + error.message
            }
        });
        return true;
    }
}

export async function handleResetSingleInstanceUsage(req, res, currentConfig, providerPoolManager, providerType, uuid) {
    try {
        if (providerType !== MODEL_PROVIDER.CODEX_API) {
            throw new Error(`当前仅支持 ${MODEL_PROVIDER.CODEX_API} 的额度重置`);
        }

        const { provider, adapter, instanceResult: baseInstanceResult } = await resolveProviderInstance(
            currentConfig,
            providerPoolManager,
            providerType,
            uuid
        );

        if (baseInstanceResult.error) {
            throw new Error(baseInstanceResult.error);
        }

        if (!adapter?.codexApiService || typeof adapter.codexApiService.resetUsageQuota !== 'function') {
            throw new Error(`${providerType} 服务实例不支持额度重置: ${provider.uuid}`);
        }

        const resetResult = await adapter.codexApiService.resetUsageQuota();
        const usage = usageService.formatUsage(providerType, resetResult.usage);
        const refreshedInstanceResult = {
            ...baseInstanceResult,
            success: true,
            usage,
            error: null
        };

        await updateProviderUsageCache(providerType, await getProviderTypeUsage(providerType, currentConfig, providerPoolManager));
        await updateSingleInstanceInCache(providerType, uuid, refreshedInstanceResult);

        sendJson(res, 200, {
            success: true,
            uuid,
            providerType,
            instance: refreshedInstanceResult,
            resetResult: resetResult.resetResult,
            serverTime: new Date().toISOString()
        });
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to reset usage for ${providerType}:${uuid}:`, error);
        sendJson(res, 500, {
            error: {
                message: `Failed to reset usage for ${providerType}:${uuid}: ` + error.message
            }
        });
        return true;
    }
}

/**
 * 获取特定提供商类型的用量限制
 */
export async function handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        
        let usageResults;
        
        if (!refresh) {
            // Prefer reading from cache
            const cachedData = await readProviderUsageCache(providerType);
            if (cachedData) {
                logger.info(`[Usage API] Returning cached usage data for ${providerType}`);
                usageResults = { ...cachedData, fromCache: true };
                
                // 包装成 reformatUsageResults 期待的结构并重新格式化
                const tempResults = { providers: { [providerType]: usageResults } };
                reformatUsageResults(tempResults);
                usageResults = tempResults.providers[providerType];
            }
        }
        
        if (!usageResults) {
            // Cache does not exist or refresh required, re-query
            logger.info(`[Usage API] Fetching fresh usage data for ${providerType}`);
            usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
            // 更新缓存
            await updateProviderUsageCache(providerType, usageResults);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to get usage for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to get usage info for ${providerType}: ` + error.message
            }
        }));
        return true;
    }
}
