import { existsSync, readFileSync } from 'fs';
import logger from '../utils/logger.js';
import { getRequestBody } from '../utils/common.js';
import {
    extractModelIdsFromNativeList,
    getConfiguredSupportedModels,
    getProviderModels,
    normalizeModelIds,
    usesManagedModelList
} from '../providers/provider-models.js';
import { generateUUID, createProviderConfig, formatSystemPath, detectProviderFromPath, addToUsedPaths, isPathUsed, pathsEqual } from '../utils/provider-utils.js';
import { broadcastEvent } from './event-broadcast.js';
import { getRegisteredProviders, getServiceAdapter, invalidateServiceAdapter, serviceInstances } from '../providers/adapter.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { normalizeProviderConfigFields } from '../utils/provider-config-normalizer.js';



// 文件级互斥锁：防止并发读写导致数据丢失
// 安全净化：移除用户输入字段中的危险内容（script、事件处理器、javascript:协议等），
// 存储原始文本。HTML 转义统一由前端 escHtml() 负责，避免双编码问题。
// 安全净化：移除用户输入字段中的危险内容，并可选地过滤敏感 API 密钥
function sanitizeProviderData(provider, maskSensitive = false) {
    if (!provider || typeof provider !== 'object') return provider;
    const sanitized = { ...provider };
    
    // 1. 过滤敏感字段（API Keys, Tokens 等）
    if (maskSensitive) {
        for (const key in sanitized) {
            // 排除已知非敏感字段
            if (key === 'uuid' || key === 'customName' || key === 'isHealthy' || key === 'isDisabled' || key === 'needsRefresh') continue;
            
            const val = sanitized[key];
            if (typeof val !== 'string' || !val) continue;

            // 识别敏感字段：包含 KEY, TOKEN, SSO, SECRET, PASSWORD, CLEARANCE, BM, STATSIG_ID 等关键词
            // 同时排除包含 PATH, URL, DIR, ENDPOINT 等关键词的路径/地址字段
            const isSensitive = /API_KEY|TOKEN|SSO|SECRET|PASSWORD|CLEARANCE|ACCESS_KEY|credentials|BM|STATSIG_ID/i.test(key);
            const isPath = /PATH|URL|DIR|ENDPOINT|REGION/i.test(key);

            if (isSensitive && !isPath) {
                // 对密钥进行脱敏显示（只保留前 4 位和后 4 位）
                if (val.length > 10) {
                    sanitized[key] = val.substring(0, 4) + '****' + val.substring(val.length - 4);
                } else {
                    sanitized[key] = '********';
                }
            }
        }
    }

    // 2. 净化 customName 中的 HTML/脚本
    if (typeof sanitized.customName === 'string') {
        let name = sanitized.customName;
        if (/(?:data|javascript|vbscript)\s*:/i.test(name)) {
            sanitized.customName = '';
            return sanitized;
        }
        name = name.replace(/<[^>]*>/g, '');
        name = name.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
        name = name.replace(/&[#\w]+;/g, '');
        sanitized.customName = name.trim();
    }
    return sanitized;
}

function sanitizeProviderPools(pools, maskSensitive = false) {
    if (!pools || typeof pools !== 'object') return pools;
    const sanitized = {};
    for (const [type, providers] of Object.entries(pools)) {
        sanitized[type] = Array.isArray(providers)
            ? providers.map(p => sanitizeProviderData(p, maskSensitive))
            : providers;
    }
    return sanitized;
}

/**
 * 过滤掉数据中的脱敏占位符，避免在保存时覆盖真实数据
 */
function filterMaskedData(data) {
    if (!data || typeof data !== 'object') return data;
    const result = { ...data };
    
    for (const key in result) {
        const val = result[key];
        if (typeof val === 'string') {
            // 匹配 ******** 或 XXXX****XXXX 格式
            // 如果值包含 **** 且长度符合脱敏特征，则认为它是脱敏后的回传值，应该忽略
            // 不再仅限于特定的 sensitiveKeys，而是检查所有字符串字段
            if (val === '********' || (val.includes('****') && val.length >= 10)) {
                delete result[key];
            }
        }
    }
    
    return result;
}

function getProviderPoolsFilePath(currentConfig) {
    return currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
}

function loadProviderPools(currentConfig, providerPoolManager) {
    const filePath = getProviderPoolsFilePath(currentConfig);

    if (providerPoolManager?.providerPools) {
        return providerPoolManager.providerPools;
    }

    if (!existsSync(filePath)) {
        return {};
    }

    return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function getManagedSupportedModels(providerType, providers = []) {
    return normalizeModelIds(
        providers.flatMap(provider => getConfiguredSupportedModels(providerType, provider))
    );
}

async function persistProviderStatusToFile(currentConfig, providerPoolManager) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    const providerPools = {};

    for (const providerType in providerPoolManager.providerStatus) {
        providerPools[providerType] = providerPoolManager.providerStatus[providerType].map(providerStatus => providerStatus.config);
    }

    await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
    return filePath;
}

function isAuthHealthCheckError(errorMessage = '') {
    return /\b(401|403)\b/.test(errorMessage) ||
        /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
}

async function runProviderHealthCheck(providerPoolManager, providerType, providerStatus) {
    const providerConfig = providerStatus.config;

    try {
        // 对于管理模型列表的提供商，如果配置了支持的模型，从中挑选一个用于健康检查
        let checkModelName = providerConfig.checkModelName;
        if (!checkModelName && usesManagedModelList(providerType)) {
            const supportedModels = getConfiguredSupportedModels(providerType, providerConfig);
            if (supportedModels.length > 0) {
                // 优先挑选常见的/轻量级的模型，或者直接取第一个
                checkModelName = supportedModels.find(m =>
                    m.includes('flash') || m.includes('mini') || m.includes('3.5') || m.includes('small')
                ) || supportedModels[0];
                logger.info(`[UI API] Selected model ${checkModelName} for health check of managed provider ${providerConfig.uuid}`);
            }
        }

        const healthResult = await providerPoolManager._checkProviderHealth(providerType, {
            ...providerConfig,
            checkModelName
        });

        if (healthResult.success) {
            providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
            return {
                uuid: providerConfig.uuid,
                success: true,
                healthy: true,
                modelName: healthResult.modelName,
                message: 'Healthy'
            };
        }

        const errorMessage = healthResult.errorMessage || 'Check failed';
        const isAuthError = isAuthHealthCheckError(errorMessage);

        if (isAuthError) {
            providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
            logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
        } else {
            providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
        }

        providerStatus.config.lastHealthCheckTime = new Date().toISOString();
        if (healthResult.modelName) {
            providerStatus.config.lastHealthCheckModel = healthResult.modelName;
        }

        return {
            uuid: providerConfig.uuid,
            success: false,
            healthy: false,
            modelName: healthResult.modelName,
            message: errorMessage,
            isAuthError
        };
    } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        const isAuthError = isAuthHealthCheckError(errorMessage);

        if (isAuthError) {
            providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
            logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
        } else {
            providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
        }

        providerStatus.config.lastHealthCheckTime = new Date().toISOString();

        return {
            uuid: providerConfig.uuid,
            success: false,
            healthy: false,
            message: errorMessage,
            isAuthError
        };
    }
}

/**
 * 获取所有提供商的状态（包括支持的类型和号池组）
 */
export async function handleGetProviders(req, res, currentConfig, providerPoolManager) {
    // 1. 获取支持的基础提供商类型
    const registeredProviders = getRegisteredProviders();
    let poolTypes = [];

    // 2. 从管理器获取当前所有池的状态
    const providerStatus = {};
    if (providerPoolManager) {
        for (const [type, providers] of Object.entries(providerPoolManager.providerStatus)) {
            providerStatus[type] = providers.map(p => ({
                ...p.config,
                activeRequests: p.state?.activeCount || 0,
                waitingRequests: p.state?.waitingCount || 0
            }));
        }
    }
    
    // 3. 补全号池配置文件中的所有组
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            poolTypes = Object.keys(poolsData);
            poolTypes.forEach(type => {
                // 如果管理器中没有该组，或者该组是空的，则从文件中补全
                if (!providerStatus[type] || providerStatus[type].length === 0) {
                    const fileProviders = poolsData[type] || [];
                    if (fileProviders.length > 0) {
                        providerStatus[type] = fileProviders.map(p => ({
                            ...p,
                            activeRequests: 0,
                            waitingRequests: 0
                        }));
                    } else if (!providerStatus[type]) {
                        providerStatus[type] = [];
                    }
                }
            });
        }
    } catch (error) {
        logger.warn('[UI API] Failed to supplement provider status:', error.message);
    }

    // 合并生成支持的类型列表
    const supportedProviders = [...new Set([...registeredProviders, ...poolTypes])];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providers: sanitizeProviderPools(providerStatus, true), // 列表显示进行打码
        supportedProviders: supportedProviders
    }));
    return true;
}

/**
 * 获取特定提供商类型的详细信息
 */
export async function handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType) {
    let providerPools = {};
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (providerPoolManager && providerPoolManager.providerPools) {
            providerPools = providerPoolManager.providerPools;
        } else if (filePath && existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            providerPools = poolsData;
        }
    } catch (error) {
        logger.warn('[UI API] Failed to load provider pools:', error.message);
    }

    const providers = providerPools[providerType] || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providerType,
        providers: providers.map(p => sanitizeProviderData(p, true)), // 详情页也进行打码，确保即便点击显示也是脱敏数据
        totalCount: providers.length,
        healthyCount: providers.filter(p => p.isHealthy).length
    }));
    return true;
}

/**
 * Read Copilot quota for one PAT-backed provider node.
 */
export async function handleGetProviderQuota(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    if (providerType !== 'github-copilot') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Quota lookup is not supported for this provider.' } }));
        return true;
    }

    try {
        const providerPools = loadProviderPools(currentConfig, providerPoolManager);
        const providerConfig = (providerPools[providerType] || []).find(provider => provider.uuid === providerUuid);
        if (!providerConfig) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider node was not found.' } }));
            return true;
        }

        const serviceConfig = {
            ...currentConfig,
            ...providerConfig,
            MODEL_PROVIDER: providerType,
            uuid: providerUuid
        };
        delete serviceConfig.providerPools;

        const serviceAdapter = getServiceAdapter(serviceConfig);
        if (typeof serviceAdapter.getQuota !== 'function') {
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Quota lookup is not supported by this adapter.' } }));
            return true;
        }

        const quota = await serviceAdapter.getQuota();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ providerType, providerUuid, quota }));
        return true;
    } catch (error) {
        logger.warn(`[UI API] Copilot quota lookup failed for provider ${providerUuid}: ${error.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unable to retrieve GitHub Copilot quota.' } }));
        return true;
    }
}

/**
 * 获取支持的提供商类型（已注册适配器的，以及号池中已存在的自定义类型）
 */
export async function handleGetSupportedProviders(req, res, currentConfig, providerPoolManager) {
    const registeredProviders = getRegisteredProviders();
    let poolTypes = [];

    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (providerPoolManager && providerPoolManager.providerPools) {
            poolTypes = Object.keys(providerPoolManager.providerPools);
        } else if (filePath && existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            poolTypes = Object.keys(poolsData);
        }
    } catch (error) {
        logger.warn('[UI API] Failed to load provider pools for supported types:', error.message);
    }

    // 合并注册的提供商和号池中的类型
    const supportedProviders = [...new Set([...registeredProviders, ...poolTypes])];
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(supportedProviders));
    return true;
}

/**
 * 获取所有提供商的可用模型（支持动态配置组）
 */
export async function handleGetProviderModels(req, res, currentConfig, providerPoolManager) {
    const registeredProviders = getRegisteredProviders();
    let providerPools = {};

    // 获取所有存在的类型（基础 + 动态）
    try {
        providerPools = loadProviderPools(currentConfig, providerPoolManager);
    } catch (error) {
        logger.warn('[UI API] Failed to load provider pools for models:', error.message);
    }

    const poolTypes = Object.keys(providerPools);
    const allTypes = [...new Set([...registeredProviders, ...poolTypes])];
    const allModels = {};

    allTypes.forEach(type => {
        let models = getProviderModels(type);
        if (usesManagedModelList(type)) {
            const managedModels = getManagedSupportedModels(type, providerPools[type] || []);
            if (managedModels.length > 0) {
                models = managedModels;
            }
        }
        if (models && models.length > 0) {
            allModels[type] = models;
        }
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allModels));
    return true;
}

/**
 * 获取特定提供商类型的可用模型
 */
export async function handleGetProviderTypeModels(req, res, currentConfig, providerPoolManager, providerType) {
    let models = getProviderModels(providerType);
    if (usesManagedModelList(providerType)) {
        try {
            const providerPools = loadProviderPools(currentConfig, providerPoolManager);
            const managedModels = getManagedSupportedModels(providerType, providerPools[providerType] || []);
            if (managedModels.length > 0) {
                models = managedModels;
            }
        } catch (error) {
            logger.warn('[UI API] Failed to load managed provider models:', error.message);
        }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providerType,
        models
    }));
    return true;
}

/**
 * Detect available models for a specific provider node.
 */
export async function handleDetectProviderModels(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        if (!usesManagedModelList(providerType)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Model detection is not supported for provider type: ${providerType}` } }));
            return true;
        }

        const body = await getRequestBody(req);
        const draftConfig = normalizeProviderConfigFields(filterMaskedData(body?.providerConfig || {}));

        const providerPools = loadProviderPools(currentConfig, providerPoolManager);
        const providers = providerPools[providerType] || [];
        const existingProvider = providers.find(provider => provider.uuid === providerUuid) || {};

        const detectionUuid = `${providerUuid}-detect-models`;
        const instanceKey = `${providerType}${detectionUuid}`;
        const tempConfig = {
            ...currentConfig,
            ...existingProvider,
            ...draftConfig,
            MODEL_PROVIDER: providerType,
            uuid: detectionUuid
        };
        delete tempConfig.providerPools;

        let models = [];
        try {
            delete serviceInstances[instanceKey];
            const serviceAdapter = getServiceAdapter(tempConfig);
            if (typeof serviceAdapter.listModels !== 'function') {
                throw new Error(`Provider ${providerType} does not support model detection`);
            }

            const nativeModels = await serviceAdapter.listModels();
            models = extractModelIdsFromNativeList(nativeModels, providerType);
        } finally {
            delete serviceInstances[instanceKey];
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            providerType,
            uuid: providerUuid,
            count: models.length,
            models,
            selectedModels: getConfiguredSupportedModels(providerType, existingProvider)
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 添加新的提供商配置
 */
export async function handleAddProvider(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        return await withFileLock(filePath, () => _handleAddProvider(req, res, currentConfig, providerPoolManager, body));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    }
}
async function _handleAddProvider(req, res, currentConfig, providerPoolManager, body) {
    try {
        const { providerType, providerConfig } = body;

        if (!providerType || !providerConfig) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providerType and providerConfig are required' } }));
            return true;
        }

        // Generate UUID if not provided
        if (!providerConfig.uuid) {
            providerConfig.uuid = generateUUID();
        }

        // Set default values
        providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
        providerConfig.lastUsed = providerConfig.lastUsed || null;
        providerConfig.usageCount = providerConfig.usageCount || 0;
        providerConfig.errorCount = providerConfig.errorCount || 0;
        providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;

        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                logger.warn('[UI API] Failed to read existing provider pools:', readError.message);
            }
        }

        // Add new provider to the appropriate type
        if (!providerPools[providerType]) {
            providerPools[providerType] = [];
        }
        
        // 过滤掉脱敏字段
        const filteredConfig = normalizeProviderConfigFields(filterMaskedData(providerConfig));
        if (usesManagedModelList(providerType)) {
            filteredConfig.supportedModels = normalizeModelIds(filteredConfig.supportedModels);
            filteredConfig.notSupportedModels = [];
        }
        providerPools[providerType].push(filteredConfig);

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Added new provider to ${providerType}: ${providerConfig.uuid}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'add',
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(providerConfig),
            timestamp: new Date().toISOString()
        });

        // 广播提供商更新事件
        broadcastEvent('provider_update', {
            action: 'add',
            providerType,
            providerConfig: sanitizeProviderData(providerConfig),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider added successfully',
            provider: sanitizeProviderData(providerConfig, true),
            providerType
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 更新特定提供商配置
 */
export async function handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const body = await getRequestBody(req);
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        return await withFileLock(filePath, () => _handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, body));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    }
}
async function _handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, body) {
    try {
        const { providerConfig } = body;

        if (!providerConfig) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providerConfig is required' } }));
            return true;
        }

        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find and update the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Update provider while preserving certain fields
        const existingProvider = providers[providerIndex];
        
        // 过滤掉传入配置中的脱敏占位符，避免覆盖真实数据
        const filteredConfig = normalizeProviderConfigFields(filterMaskedData(providerConfig));
        if (usesManagedModelList(providerType)) {
            filteredConfig.supportedModels = normalizeModelIds(filteredConfig.supportedModels);
            filteredConfig.notSupportedModels = [];
        }
        
        const updatedProvider = {
            ...existingProvider,
            ...filteredConfig,
            uuid: providerUuid, // Ensure UUID doesn't change
            lastUsed: existingProvider.lastUsed, // Preserve usage stats
            usageCount: existingProvider.usageCount,
            errorCount: existingProvider.errorCount,
            lastErrorTime: existingProvider.lastErrorTime
        };

        providerPools[providerType][providerIndex] = updatedProvider;

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Updated provider ${providerUuid} in ${providerType}`);
        invalidateServiceAdapter(providerType, providerUuid);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'update',
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(updatedProvider),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider updated successfully',
            provider: sanitizeProviderData(updatedProvider, true)
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 删除特定提供商配置
 */
export async function handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find and remove the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const deletedProvider = providers[providerIndex];
        providers.splice(providerIndex, 1);

        // Remove the entire provider type if no providers left
        if (providers.length === 0) {
            delete providerPools[providerType];
        }

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Deleted provider ${providerUuid} from ${providerType}`);
        invalidateServiceAdapter(providerType, providerUuid);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete',
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(deletedProvider),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider deleted successfully',
            deletedProvider: sanitizeProviderData(deletedProvider)
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}


/**
 * 禁用/启用特定提供商配置
 */
export async function handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find and update the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Update isDisabled field
        const provider = providers[providerIndex];
        provider.isDisabled = action === 'disable';
        
        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] ${action === 'disable' ? 'Disabled' : 'Enabled'} provider ${providerUuid} in ${providerType}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            
            // Call the appropriate method
            if (action === 'disable') {
                providerPoolManager.disableProvider(providerType, provider);
            } else {
                providerPoolManager.enableProvider(providerType, provider);
            }
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: action,
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(provider),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Provider ${action}d successfully`,
            provider: sanitizeProviderData(provider)
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 重置特定提供商类型的所有提供商健康状态
 */
export async function handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        
        let resetCount = 0;
        let totalCount = 0;
        let providerPools = {};

        // 1. 首先加载完整的提供商池数据
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                logger.warn('[UI API] Failed to read provider pools during reset:', readError.message);
                // 如果读取失败且管理器也不存在，才返回错误
                if (!providerPoolManager) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Failed to read provider pools' } }));
                    return true;
                }
            }
        }

        // 2. 执行重置逻辑
        if (providerPoolManager && providerPoolManager.providerStatus[providerType]) {
            // 如果管理器存在，优先使用管理器的方法
            const pool = providerPoolManager.providerStatus[providerType];
            totalCount = pool.length;
            
            pool.forEach(ps => {
                if (!ps.config.isHealthy || ps.config.needsRefresh || (ps.config.errorCount && ps.config.errorCount > 0)) {
                    resetCount++;
                }
            });
            
            // 重置内存状态
            providerPoolManager.resetAllHealthInType(providerType);
            
            // 从管理器获取最新的完整的池数据用于持久化
            if (providerPoolManager.providerPools) {
                providerPools = providerPoolManager.providerPools;
            }
        } else {
            // 如果管理器中没有，则只重置文件中的数据
            const providers = providerPools[providerType] || [];
            if (providers.length === 0) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
                return true;
            }

            totalCount = providers.length;
            providers.forEach(provider => {
                if (!provider.isHealthy || provider.needsRefresh || (provider.errorCount && provider.errorCount > 0)) {
                    resetCount++;
                }
                provider.isHealthy = true;
                provider.errorCount = 0;
                provider.refreshCount = 0;
                provider.needsRefresh = false;
                provider.lastErrorTime = null;
                provider.lastErrorMessage = null;
            });
        }

        // 3. 立即保存到文件，不依赖管理器的防抖保存，确保“重置”操作的即时性
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        
        // 4. 同步更新 currentConfig 引用
        if (currentConfig) {
            currentConfig.providerPools = providerPools;
        }

        logger.info(`[UI API] Reset health status for type ${providerType}: ${resetCount}/${totalCount} nodes reset`);

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'reset_health',
            filePath: filePath,
            providerType,
            resetCount,
            totalCount,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully reset health status for ${resetCount} providers`,
            resetCount: resetCount,
            totalCount: totalCount,
            providerType: providerType
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Reset health status failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 删除特定提供商类型的所有不健康节点
 */
export async function handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find and remove unhealthy providers
        const providers = providerPools[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // Filter out unhealthy providers (keep only healthy ones)
        const unhealthyProviders = providers.filter(p => !p.isHealthy);
        const healthyProviders = providers.filter(p => p.isHealthy);
        
        if (unhealthyProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to delete',
                deletedCount: 0,
                remainingCount: providers.length
            }));
            return true;
        }

        // Update the provider pool with only healthy providers
        if (healthyProviders.length === 0) {
            delete providerPools[providerType];
        } else {
            providerPools[providerType] = healthyProviders;
        }

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Deleted ${unhealthyProviders.length} unhealthy providers from ${providerType}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete_unhealthy',
            filePath: filePath,
            providerType,
            deletedCount: unhealthyProviders.length,
            deletedProviders: unhealthyProviders.map(p => sanitizeProviderData({ uuid: p.uuid, customName: p.customName })),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully deleted ${unhealthyProviders.length} unhealthy providers`,
            deletedCount: unhealthyProviders.length,
            remainingCount: healthyProviders.length,
            deletedProviders: unhealthyProviders.map(p => ({ uuid: p.uuid, customName: p.customName }))
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 批量刷新特定提供商类型的所有不健康节点的 UUID
 */
export async function handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find unhealthy providers
        const providers = providerPools[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // Filter unhealthy providers and refresh their UUIDs
        const refreshedProviders = [];
        for (const provider of providers) {
            if (!provider.isHealthy) {
                const oldUuid = provider.uuid;
                const newUuid = generateUUID();
                provider.uuid = newUuid;
                refreshedProviders.push({
                    oldUuid,
                    newUuid,
                    customName: provider.customName
                });
            }
        }

        if (refreshedProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to refresh',
                refreshedCount: 0,
                totalCount: providers.length
            }));
            return true;
        }

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Refreshed UUIDs for ${refreshedProviders.length} unhealthy providers in ${providerType}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'refresh_unhealthy_uuids',
            filePath: filePath,
            providerType,
            refreshedCount: refreshedProviders.length,
            refreshedProviders: refreshedProviders.map(p => sanitizeProviderData(p)),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully refreshed UUIDs for ${refreshedProviders.length} unhealthy providers`,
            refreshedCount: refreshedProviders.length,
            totalCount: providers.length,
            refreshedProviders
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 对特定提供商类型的所有提供商执行健康检查
 */
export async function handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType) {
    // 健康检查涉及大量异步操作，但最后的文件保存必须加锁
    // 为了不长时间占用文件锁，我们只在保存文件时加锁
    try {
        if (!providerPoolManager) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
            return true;
        }

        const providers = providerPoolManager.providerStatus[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // 只检测不健康的节点
        const unhealthyProviders = providers.filter(ps => !ps.config.isHealthy);
        
        if (unhealthyProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to check',
                successCount: 0,
                failCount: 0,
                totalCount: providers.length,
                results: []
            }));
            return true;
        }

        logger.info(`[UI API] Starting health check for ${unhealthyProviders.length} unhealthy providers in ${providerType} (total: ${providers.length})`);

        // 执行健康检测（检查所有未禁用的 unhealthy providers）
        const results = [];
        for (const providerStatus of unhealthyProviders) {
            const providerConfig = providerStatus.config;
            
            // 跳过已禁用的节点
            if (providerConfig.isDisabled) {
                logger.info(`[UI API] Skipping health check for disabled provider: ${providerConfig.uuid}`);
                continue;
            }

             try {
                const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig);
                
                if (healthResult.success) {
                    providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
                    results.push({
                        uuid: providerConfig.uuid,
                        success: true,
                        modelName: healthResult.modelName,
                        message: 'Healthy'
                    });
                } else {
                    // 检查是否为认证错误（401/403），如果是则立即标记为不健康
                    const errorMessage = healthResult.errorMessage || 'Check failed';
                    const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                                       /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
                    
                    if (isAuthError) {
                        providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
                        logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
                    } else {
                        providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
                    }
                    
                    providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                    if (healthResult.modelName) {
                        providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                    }
                    results.push({
                        uuid: providerConfig.uuid,
                        success: false,
                        modelName: healthResult.modelName,
                        message: errorMessage,
                        isAuthError: isAuthError
                    });
                }
            } catch (error) {
                const errorMessage = error.message || 'Unknown error';
                // 检查是否为认证错误（401/403），如果是则立即标记为不健康
                const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                                   /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
                
                if (isAuthError) {
                    providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
                    logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
                } else {
                    providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
                }
                
                results.push({
                    uuid: providerConfig.uuid,
                    success: false,
                    message: errorMessage,
                    isAuthError: isAuthError
                });
            }
        }

        // 保存更新后的状态到文件 - 使用文件锁
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        
        await withFileLock(filePath, async (checkValidity) => {
            let currentPools = {};
            // 读取现有配置，保留未知字段
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf-8');
                    currentPools = JSON.parse(fileContent);
                } catch (readError) {
                    logger.warn('[UI API] Failed to read existing provider pools for health check merge:', readError.message);
                }
            }

            // 在写入前检查锁是否过期
            checkValidity();

            // 更新当前 providerType 的所有节点
            currentPools[providerType] = providerPoolManager.providerStatus[providerType].map(ps => ps.config);

            await atomicWriteFile(filePath, JSON.stringify(currentPools, null, 2), 'utf-8');
        });

        const successCount = results.filter(r => r.success === true).length;
        const failCount = results.filter(r => r.success === false).length;

        logger.info(`[UI API] Health check completed for ${providerType}: ${successCount} recovered, ${failCount} still unhealthy (checked ${unhealthyProviders.length} unhealthy nodes)`);

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'health_check',
            filePath,
            providerType,
            results: results.map(r => ({ ...r, message: sanitizeProviderData({ message: r.message }).message })),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Health check completed: ${successCount} healthy, ${failCount} unhealthy`,
            successCount,
            failCount,
            totalCount: providers.length,
            results
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Health check error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 快速链接配置文件到对应的提供商
 * 支持单个文件路径或文件路径数组
 */
export async function handleSingleProviderHealthCheck(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        if (!providerPoolManager) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
            return true;
        }

        const providers = providerPoolManager.providerStatus[providerType] || [];
        const providerStatus = providers.find(item => item.config?.uuid === providerUuid);

        if (!providerStatus) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        logger.info(`[UI API] Starting single health check for provider ${providerUuid} in ${providerType}`);

        const result = await runProviderHealthCheck(providerPoolManager, providerType, providerStatus);

        // 使用文件锁进行持久化，防止并发写入冲突
        const poolFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        const filePath = await withFileLock(poolFilePath, async () => {
            return persistProviderStatusToFile(currentConfig, providerPoolManager);
        });

        broadcastEvent('config_update', {
            action: 'health_check_single',
            filePath,
            providerType,
            providerUuid,
            result: {
                ...result,
                message: sanitizeProviderData({ message: result.message }).message
            },
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            providerType,
            uuid: providerUuid,
            healthy: result.healthy,
            modelName: result.modelName || null,
            message: result.message,
            isAuthError: result.isAuthError || false
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Single health check error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

export async function handleQuickLinkProvider(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { filePath, filePaths } = body;

        // 支持单个文件路径或文件路径数组
        const pathsToLink = filePaths || (filePath ? [filePath] : []);

        if (!pathsToLink || pathsToLink.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'filePath or filePaths is required' } }));
            return true;
        }

        const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        
        // Load existing pools
        let providerPools = {};
        if (existsSync(poolsFilePath)) {
            try {
                const fileContent = readFileSync(poolsFilePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                logger.warn('[UI API] Failed to read existing provider pools:', readError.message);
            }
        }

        const results = [];
        const linkedProviders = [];

        // 处理每个文件路径
        for (const currentFilePath of pathsToLink) {
            const normalizedPath = currentFilePath.replace(/\\/g, '/').toLowerCase();
            
            // 根据文件路径自动识别提供商类型
            const providerMapping = detectProviderFromPath(normalizedPath);
            
            if (!providerMapping) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'Unable to identify provider type for config file'
                });
                continue;
            }

            const { providerType, credPathKey, defaultCheckModel, displayName, urlKeys } = providerMapping;

            // Ensure provider type array exists
            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }

            // Check if already linked - 使用标准化路径进行比较
            const normalizedForComparison = currentFilePath.replace(/\\/g, '/');
            const isAlreadyLinked = providerPools[providerType].some(p => {
                const existingPath = p[credPathKey];
                if (!existingPath) return false;
                const normalizedExistingPath = existingPath.replace(/\\/g, '/');
                return normalizedExistingPath === normalizedForComparison ||
                       normalizedExistingPath === './' + normalizedForComparison ||
                       './' + normalizedExistingPath === normalizedForComparison;
            });

            if (isAlreadyLinked) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'This config file is already linked',
                    providerType: providerType
                });
                continue;
            }

            // Create new provider config based on provider type
            const newProvider = createProviderConfig({
                credPathKey,
                credPath: formatSystemPath(currentFilePath),
                defaultCheckModel,
                needsProjectId: providerMapping.needsProjectId,
                urlKeys: urlKeys
            });

            providerPools[providerType].push(newProvider);
            linkedProviders.push({ providerType, provider: newProvider });

            results.push({
                filePath: currentFilePath,
                success: true,
                providerType: providerType,
                displayName: displayName,
                provider: newProvider
            });

            logger.info(`[UI API] Quick linked config: ${currentFilePath} -> ${providerType}`);
        }

        // Save to file only if there were successful links
        const successCount = results.filter(r => r.success).length;
        if (successCount > 0) {
            await withFileLock(poolsFilePath, async () => {
                await atomicWriteFile(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf-8');
                return poolsFilePath;
            });

        // Update provider pool manager if available
        if (providerPoolManager) {
            // 重要：更新管理器的内存池数据，确保后续扫描能立即看到变化
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus(true);

            const uniqueTypes = [...new Set(linkedProviders.map(lp => lp.providerType))];
            for (const type of uniqueTypes) {
                providerPoolManager.resetAllHealthInType(type);
            }
        }

        // 更新当前配置引用
        if (currentConfig) {
            currentConfig.providerPools = providerPools;
        }

            // Broadcast update events
            broadcastEvent('config_update', {
                action: 'quick_link_batch',
                filePath: poolsFilePath,
                results: results,
                timestamp: new Date().toISOString()
            });

            for (const { providerType, provider } of linkedProviders) {
                broadcastEvent('provider_update', {
                    action: 'add',
                    providerType,
                    providerConfig: provider,
                    timestamp: new Date().toISOString()
                });
            }
        }

        const failCount = results.filter(r => !r.success).length;
        const message = successCount > 0
            ? `Successfully linked ${successCount} config file(s)${failCount > 0 ? `, ${failCount} failed` : ''}`
            : `Failed to link all ${failCount} config file(s)${failCount === 1 && results[0].error ? `: ${results[0].error}` : ''}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: successCount > 0,
            message: message,
            successCount: successCount,
            failCount: failCount,
            results: results
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Quick link failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Link failed: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 刷新特定提供商的UUID
 */
export async function handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    return withFileLock(filePath, () => _handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Generate new UUID
        const oldUuid = providerUuid;
        const newUuid = generateUUID();
        
        // Update provider UUID
        providerPools[providerType][providerIndex].uuid = newUuid;

        // Save to file
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');

        logger.info(`[UI API] Refreshed UUID for provider in ${providerType}: ${oldUuid} -> ${newUuid}`);
        invalidateServiceAdapter(providerType, oldUuid);
        invalidateServiceAdapter(providerType, newUuid);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'refresh_uuid',
            filePath: filePath,
            providerType,
            oldUuid,
            newUuid,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'UUID refreshed successfully',
            oldUuid,
            newUuid,
            provider: sanitizeProviderData(providerPools[providerType][providerIndex])
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}
