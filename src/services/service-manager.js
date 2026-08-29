import { getServiceAdapter, serviceInstances } from '../providers/adapter.js';
import logger from '../utils/logger.js';
import { ProviderPoolManager } from '../providers/provider-pool-manager.js';
import deepmerge from 'deepmerge';
import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import {
    PROVIDER_MAPPINGS,
    createProviderConfig,
    addToUsedPaths,
    isPathUsed,
    getFileName,
    formatSystemPath
} from '../utils/provider-utils.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { MODEL_PROVIDER } from '../utils/constants.js';

// 存储 ProviderPoolManager 实例
let providerPoolManager = null;

/**
 * 扫描 configs 目录并自动关联未关联的配置文件到对应的提供商
 * @param {Object} config - 服务器配置对象
 * @param {Object} options - 可选参数
 * @param {boolean} options.onlyCurrentCred - 为 true 时，只自动关联当前凭证
 * @param {string} options.credPath - 当前凭证的路径（当 onlyCurrentCred 为 true 时必需）
 * @returns {Promise<Object>} 更新后的 providerPools 对象
 */
export async function autoLinkProviderConfigs(config, options = {}) {
    // 确保 providerPools 对象存在
    if (!config.providerPools) {
        config.providerPools = {};
    }
    
    let totalNewProviders = 0;
    const allNewProviders = {};
    
    // 如果只关联当前凭证
    if (options.onlyCurrentCred && options.credPath) {
        const result = await linkSingleCredential(config, options.credPath);
        if (result) {
            totalNewProviders = 1;
            allNewProviders[result.displayName] = [result.provider];
        }
    } else {
        // 遍历所有提供商映射
        for (const mapping of PROVIDER_MAPPINGS) {
            const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
            const { providerType, credPathKey, defaultCheckModel, displayName, needsProjectId } = mapping;
            
            // 确保提供商类型数组存在
            if (!config.providerPools[providerType]) {
                config.providerPools[providerType] = [];
            }
            
            // 检查目录是否存在
            if (!fs.existsSync(configsPath)) {
                continue;
            }
            
            // 获取已关联的配置文件路径集合
            const linkedPaths = new Set();
            for (const provider of config.providerPools[providerType]) {
                if (provider[credPathKey]) {
                    // 使用公共方法添加路径的所有变体格式
                    addToUsedPaths(linkedPaths, provider[credPathKey]);
                }
            }
            
            // 递归扫描目录
            const newProviders = [];
            await scanProviderDirectory(configsPath, linkedPaths, newProviders, {
                credPathKey,
                defaultCheckModel,
                needsProjectId
            });
            
            // 如果有新的配置文件需要关联
            if (newProviders.length > 0) {
                config.providerPools[providerType].push(...newProviders);
                totalNewProviders += newProviders.length;
                allNewProviders[displayName] = newProviders;
            }
        }
    }
    
    // 如果有新的配置文件需要关联，保存更新后的 provider_pools.json
    if (totalNewProviders > 0) {
        const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        try {
            await withFileLock(filePath, async () => {
                await atomicWriteFile(filePath, JSON.stringify(config.providerPools, null, 2), 'utf8');
            });
            logger.info(`[Auto-Link] Added ${totalNewProviders} new config(s) to provider pools:`);
            for (const [displayName, providers] of Object.entries(allNewProviders)) {
                logger.info(`  ${displayName}: ${providers.length} config(s)`);
                providers.forEach(p => {
                    // 获取凭据路径键（支持 _CREDS_FILE_PATH 和 _TOKEN_FILE_PATH 两种格式）
                    const credKey = Object.keys(p).find(k =>
                        k.endsWith('_CREDS_FILE_PATH') || k.endsWith('_TOKEN_FILE_PATH')
                    );
                    if (credKey) {
                        logger.info(`    - ${p[credKey]}`);
                    }
                });
            }
        } catch (error) {
            logger.error(`[Auto-Link] Failed to save provider_pools.json: ${error.message}`);
        }
    } else {
        logger.info('[Auto-Link] No new configs to link');
    }
    
    // Update provider pool manager if available
    if (providerPoolManager) {
        providerPoolManager.providerPools = config.providerPools;
        providerPoolManager.initializeProviderStatus();
    }
    return config.providerPools;
}

/**
 * 关联单个凭证文件到对应的提供商
 * @param {Object} config - 服务器配置对象
 * @param {string} credPath - 凭证文件路径（相对或绝对路径）
 * @returns {Promise<Object|null>} 返回关联结果或 null
 */
async function linkSingleCredential(config, credPath) {
    try {
        // 规范化路径
        const absolutePath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
        const relativePath = path.relative(process.cwd(), absolutePath);
        
        // 检查文件是否存在
        if (!fs.existsSync(absolutePath)) {
            logger.warn(`[Auto-Link] Credential file not found: ${relativePath}`);
            return null;
        }
        
        // 检查文件扩展名
        const ext = path.extname(absolutePath).toLowerCase();
        if (ext !== '.json') {
            logger.warn(`[Auto-Link] Only JSON files are supported: ${relativePath}`);
            return null;
        }
        
        // 根据文件路径确定提供商类型
        let matchedMapping = null;
        for (const mapping of PROVIDER_MAPPINGS) {
            const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
            // 检查文件是否在该提供商的配置目录下
            if (absolutePath.startsWith(configsPath)) {
                matchedMapping = mapping;
                break;
            }
        }
        
        if (!matchedMapping) {
            logger.warn(`[Auto-Link] Could not determine provider type for: ${relativePath}`);
            return null;
        }
        
        const { providerType, credPathKey, defaultCheckModel, displayName, needsProjectId } = matchedMapping;
        
        // 确保提供商类型数组存在
        if (!config.providerPools[providerType]) {
            config.providerPools[providerType] = [];
        }
        
        // 检查是否已关联
        const linkedPaths = new Set();
        for (const provider of config.providerPools[providerType]) {
            if (provider[credPathKey]) {
                addToUsedPaths(linkedPaths, provider[credPathKey]);
            }
        }
        
        const fileName = getFileName(absolutePath);
        const isLinked = isPathUsed(relativePath, fileName, linkedPaths);
        
        if (isLinked) {
            logger.info(`[Auto-Link] Credential already linked: ${relativePath}`);
            return null;
        }
        
        // 创建新的提供商配置
        const newProvider = createProviderConfig({
            credPathKey,
            credPath: formatSystemPath(relativePath),
            defaultCheckModel,
            needsProjectId
        });
        
        // 添加到配置
        config.providerPools[providerType].push(newProvider);
        
        logger.info(`[Auto-Link] Successfully linked credential: ${relativePath} to ${displayName}`);
        
        return {
            provider: newProvider,
            displayName,
            providerType
        };
    } catch (error) {
        logger.error(`[Auto-Link] Failed to link credential ${credPath}: ${error.message}`);
        return null;
    }
}

/**
 * 递归扫描提供商配置目录
 * @param {string} dirPath - 目录路径
 * @param {Set} linkedPaths - 已关联的路径集合
 * @param {Array} newProviders - 新提供商配置数组
 * @param {Object} options - 配置选项
 * @param {string} options.credPathKey - 凭据路径键名
 * @param {string} options.defaultCheckModel - 默认检测模型
 * @param {boolean} options.needsProjectId - 是否需要 PROJECT_ID
 */
async function scanProviderDirectory(dirPath, linkedPaths, newProviders, options) {
    const { credPathKey, defaultCheckModel, needsProjectId } = options;
    
    try {
        const files = await pfs.readdir(dirPath, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(dirPath, file.name);
            
            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                // 只处理 JSON 文件
                if (ext === '.json') {
                    const relativePath = path.relative(process.cwd(), fullPath);
                    const fileName = getFileName(fullPath);
                    
                    // 使用与 ui-manager.js 相同的 isPathUsed 函数检查是否已关联
                    const isLinked = isPathUsed(relativePath, fileName, linkedPaths);
                    
                    if (!isLinked) {
                        // 使用公共方法创建新的提供商配置
                        const newProvider = createProviderConfig({
                            credPathKey,
                            credPath: formatSystemPath(relativePath),
                            defaultCheckModel,
                            needsProjectId
                        });
                        
                        newProviders.push(newProvider);
                    }
                }
            } else if (file.isDirectory()) {
                // 递归扫描子目录（限制深度为 3 层）
                const relativePath = path.relative(process.cwd(), fullPath);
                const depth = relativePath.split(path.sep).length;
                if (depth < 5) { // configs/{provider}/subfolder/subsubfolder
                    await scanProviderDirectory(fullPath, linkedPaths, newProviders, options);
                }
            }
        }
    } catch (error) {
        logger.warn(`[Auto-Link] Failed to scan directory ${dirPath}: ${error.message}`);
    }
}

// 注意：isValidOAuthCredentials 已移至 provider-utils.js 公共模块

/**
 * Initialize API services and provider pool manager
 * @param {Object} config - The server configuration
 * @returns {Promise<Object>} The initialized services
 */
export async function initApiService(config, isReady = false) {

    // Initialize or update ProviderPoolManager
    if (providerPoolManager) {
        providerPoolManager.providerPools = config.providerPools || {};
        providerPoolManager.initializeProviderStatus();
        logger.info('[Initialization] ProviderPoolManager existing instance updated.');
    } else {
        providerPoolManager = new ProviderPoolManager(config.providerPools || {}, {
            globalConfig: config,
            maxErrorCount: config.MAX_ERROR_COUNT ?? 10,
            providerFallbackChain: config.providerFallbackChain || {},
        });
        logger.info('[Initialization] ProviderPoolManager initialized.');
    }

    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        if(isReady){
            // --- V2: 触发系统预热 ---
            // 预热逻辑是异步的，不会阻塞服务器启动
            providerPoolManager.warmupNodes().catch(err => {
                logger.error(`[Initialization] Warmup failed: ${err.message}`);
            });

            // 检查并刷新即将过期的节点（异步调用，不阻塞启动）
            providerPoolManager.checkAndRefreshExpiringNodes().catch(err => {
                logger.error(`[Initialization] Check and refresh expiring nodes failed: ${err.message}`);
            });
        }
    } else {
        logger.info('[Initialization] Provider pools are currently empty.');
    }

    // Initialize all provider pool nodes at startup
    // 初始化号池中所有提供商的所有节点，以避免首个请求的额外延迟
    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        let totalInitialized = 0;
        let totalFailed = 0;
        
        for (const [providerType, providerConfigs] of Object.entries(config.providerPools)) {
            // 验证提供商类型是否有效且被包含在 DEFAULT_MODEL_PROVIDERS 中
            // 如果没设置 DEFAULT_MODEL_PROVIDERS，则允许所有已注册的类型
            const isDefaultProvider = !config.DEFAULT_MODEL_PROVIDERS || 
                                     (Array.isArray(config.DEFAULT_MODEL_PROVIDERS) && config.DEFAULT_MODEL_PROVIDERS.includes(providerType));
            
            if (!isDefaultProvider) {
                // 进一步检查是否是注册提供商的变体（带后缀）
                const isVariantOfDefault = Array.isArray(config.DEFAULT_MODEL_PROVIDERS) && 
                                          config.DEFAULT_MODEL_PROVIDERS.some(p => providerType.startsWith(p + '-'));
                
                if (!isVariantOfDefault) {
                    logger.info(`[Initialization] Skipping provider type '${providerType}' (not in DEFAULT_MODEL_PROVIDERS).`);
                    continue;
                }
            }
            
            if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
                continue;
            }
            
            logger.info(`[Initialization] Initializing ${providerConfigs.length} node(s) for provider '${providerType}'...`);
            
            // 初始化该提供商类型的所有节点
            for (const providerConfig of providerConfigs) {
                // 跳过已禁用的节点
                if (providerConfig.isDisabled) {
                    continue;
                }
                
                try {
                    // 合并全局配置和节点配置
                    const nodeConfig = deepmerge(config, {
                        ...providerConfig,
                        MODEL_PROVIDER: providerType
                    });
                    delete nodeConfig.providerPools; // 移除 providerPools 避免递归
                    
                    // 初始化服务适配器
                    getServiceAdapter(nodeConfig);
                    totalInitialized++;
                    
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.info(`  ✓ Initialized node: ${identifier}`);
                } catch (error) {
                    totalFailed++;
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.warn(`  ✗ Failed to initialize node ${identifier}: ${error.message}`);
                }
            }
        }
        
        logger.info(`[Initialization] Provider pool initialization complete: ${totalInitialized} succeeded, ${totalFailed} failed.`);
    } else {
        logger.info('[Initialization] No provider pools configured. Skipping node initialization.');
    }
    return serviceInstances; // Return the collection of initialized service instances
}

/**
 * [路由解析层] 负责前置处理前缀和 AUTO 模式转换
 * @private
 * @returns {Promise<Object>} { effectiveProvider, actualModelName }
 */
async function _resolveEffectiveRouting(config, requestedModel) {
    let effectiveProvider = config.MODEL_PROVIDER;
    let actualModelName = requestedModel;

    // 1. 处理显式前缀 (无论是否是 AUTO 模式都支持)
    if (requestedModel && requestedModel.includes(':')) {
        const [prefix, ...modelParts] = requestedModel.split(':');
        const modelSuffix = modelParts.join(':');
        // 检查前缀是否是有效的提供商标识
        if (providerPoolManager && (providerPoolManager.providerStatus[prefix] || config.providerPools?.[prefix])) {
            effectiveProvider = prefix;
            actualModelName = modelSuffix;
            logger.info(`[Routing] Prefix resolved: ${prefix}:${modelSuffix}`);
        }
    }

    // 2. 严格性检查：在 AUTO 模式下，如果到这里还没解析出具体提供商，则报错 (除非是列出模型场景)
    if (effectiveProvider === MODEL_PROVIDER.AUTO && requestedModel) {
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${requestedModel}'`);
    }

    return { effectiveProvider, actualModelName };
}

/**
 * Get API service adapter, considering provider pools
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
 * @returns {Promise<Object>} The API service adapter
 */
export async function getApiService(config, requestedModel = null, options = {}) {
    // 1. 前置路由解析
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel);
    config.MODEL_PROVIDER = effectiveProvider;

    // 模型列表特殊场景：AUTO 且无模型名
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) return null;

    let serviceConfig = config;
    const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === config.MODEL_PROVIDER);
    if (providerPoolManager && ((config.providerPools && config.providerPools[config.MODEL_PROVIDER]) || isPoolable)) {
        // 如果有号池管理器，并且当前模型提供者类型有对应的号池（或属于号池类型提供商），则从号池中选择一个提供者配置
        // selectProvider 现在是异步的，使用链式锁确保并发安全
        const selectedProviderConfig = await providerPoolManager.selectProvider(config.MODEL_PROVIDER, actualModelName, { ...options, skipUsageCount: true });
        if (selectedProviderConfig) {
            // 合并选中的提供者配置到当前请求的 config 中
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools; // 移除 providerPools 属性
            config.uuid = serviceConfig.uuid;
            config.customName = serviceConfig.customName;
            const customNameDisplay = serviceConfig.customName ? ` (${serviceConfig.customName})` : '';
            logger.info(`[API Service] Using pooled configuration for ${config.MODEL_PROVIDER}: ${serviceConfig.uuid}${customNameDisplay}${actualModelName ? ` (model: ${actualModelName})` : ''}`);
        } else {
            const errorMsg = `[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ''}`;
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    return getServiceAdapter(serviceConfig);
}

/**
 * Get API service adapter with fallback support and return detailed result
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @returns {Promise<Object>} Object containing service adapter and metadata
 */
export async function getApiServiceWithFallback(config, requestedModel = null, options = {}) {
    // 1. 前置路由解析
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel);
    config.MODEL_PROVIDER = effectiveProvider;

    // 模型列表特殊场景：AUTO 且无模型名
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) {
        return { service: null, serviceConfig: config, actualProviderType: effectiveProvider, isFallback: false, uuid: null, actualModel: null };
    }

    let serviceConfig = config;
    let actualProviderType = config.MODEL_PROVIDER;
    let isFallback = false;
    let selectedUuid = null;
    let actualModel = actualModelName;
    
    const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === config.MODEL_PROVIDER);
    if (providerPoolManager && ((config.providerPools && config.providerPools[config.MODEL_PROVIDER]) || isPoolable)) {
        // selectProviderWithFallback 现在是异步的，使用链式锁确保并发安全
        // 如果开启了并发限制，则使用 acquireSlot 进行选择和占位
        const useAcquire = options.acquireSlot === true;
        let selectedResult;
        
        if (useAcquire) {
             // 我们需要一个支持 Fallback 的 acquireSlot
             selectedResult = await providerPoolManager.acquireSlotWithFallback(
                config.MODEL_PROVIDER,
                actualModelName,
                options
            );
        } else {
            selectedResult = await providerPoolManager.selectProviderWithFallback(
                config.MODEL_PROVIDER,
                actualModelName,
                { ...options, skipUsageCount: true }
            );
        }
        
        if (selectedResult) {
            const { config: selectedProviderConfig, actualProviderType: selectedType, isFallback: fallbackUsed, actualModel: fallbackModel } = selectedResult;
            
            // 合并选中的提供者配置到当前请求的 config 中
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools;
            
            actualProviderType = selectedType;
            isFallback = fallbackUsed;
            selectedUuid = selectedProviderConfig.uuid;
            actualModel = fallbackModel || actualModelName;
            
            // 如果发生了 fallback，需要更新 MODEL_PROVIDER
            if (isFallback) {
                serviceConfig.MODEL_PROVIDER = actualProviderType;
            }
        } else {
            const errorMsg = `[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ''}`;
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    
    const service = getServiceAdapter(serviceConfig);
    
    return {
        service,
        serviceConfig,
        actualProviderType,
        isFallback,
        uuid: selectedUuid,
        actualModel
    };
}

/**
 * Get the provider pool manager instance
 * @returns {Object} The provider pool manager
 */
export function getProviderPoolManager() {
    return providerPoolManager;
}

/**
 * Mark provider as unhealthy
 * @param {string} provider - The model provider
 * @param {Object} providerInfo - Provider information including uuid
 */
export function markProviderUnhealthy(provider, providerInfo) {
    if (providerPoolManager) {
        providerPoolManager.markProviderUnhealthy(provider, providerInfo);
    }
}

/**
 * Get providers status
 * @param {Object} config - The current request configuration
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.provider] - Optional.provider filter by provider type
 * @param {boolean} [options.customName] - Optional.customName filter by customName
 * @returns {Promise<Object>} The API service adapter
 */
export async function getProviderStatus(config, options = {}) {
    let providerPools = {};
    const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (providerPoolManager && providerPoolManager.providerPools) {
            providerPools = providerPoolManager.providerPools;
        } else if (filePath && fs.existsSync(filePath)) {
            const poolsData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            providerPools = poolsData;
        }
    } catch (error) {
        logger.warn('[API Service] Failed to load provider pools:', error.message);
    }

    // providerPoolsSlim 只保留顶级 key 及部分字段
    const slimFields = [
        'uuid',
        'customName',
        'isHealthy',
        'isDisabled',
        'lastErrorTime',
        'lastErrorMessage',
        'needsRefresh'
    ];
    // identify 字段映射表
    const identifyFieldMap = {
        'openai-custom': 'OPENAI_BASE_URL',
        'atlascloud': 'OPENAI_BASE_URL',
        'orcarouter': 'OPENAI_BASE_URL',
        'qiniu': 'OPENAI_BASE_URL',
        'fenno': 'OPENAI_BASE_URL',
        'openaiResponses-custom': 'OPENAI_BASE_URL',
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'claude-custom': 'CLAUDE_BASE_URL',
        'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH',
        'openai-qwen-oauth': 'QWEN_OAUTH_CREDS_FILE_PATH',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'openai-iflow': 'IFLOW_TOKEN_FILE_PATH',
        'forward-api': 'FORWARD_BASE_URL',
        'grok-web': 'GROK_COOKIE_TOKEN',
        'grok-cli-oauth': 'GROK_CLI_OAUTH_CREDS_FILE_PATH',
        'openai-codex-oauth': 'CODEX_OAUTH_CREDS_FILE_PATH'
    };
    let providerPoolsSlim = [];
    let unhealthyProvideIdentifyList = [];
    let count = 0;
    let unhealthyCount = 0;
    let unhealthyRatio = 0;
    const filterProvider = options && options.provider;
    const filterCustomName = options && options.customName;
    for (const key of Object.keys(providerPools)) {
        if (!Array.isArray(providerPools[key])) continue;
        if (filterProvider && key !== filterProvider) continue;
        
        let identifyField = identifyFieldMap[key] || null;
        if (!identifyField) {
            // 尝试通过前缀查找 identifyField (例如 openai-custom-1 -> openai-custom)
            for (const [prefix, field] of Object.entries(identifyFieldMap)) {
                if (key.startsWith(prefix + '-')) {
                    identifyField = field;
                    break;
                }
            }
        }
        
        const slimArr = providerPools[key]
            .filter(item => {
                if (item.isDisabled) return false;
                if (filterCustomName && item.customName !== filterCustomName) return false;
                return true;
            })
            .map(item => {
                const slim = {};
                for (const f of slimFields) {
                    let val = item.hasOwnProperty(f) ? item[f] : null;
                    if (f === 'uuid' && typeof val === 'string' && val.length > 8) {
                        val = val.substring(0, 8) + '...' + val.substring(val.length - 4);
                    }
                    slim[f] = val;
                }
                // identify 字段
                if (identifyField && item.hasOwnProperty(identifyField)) {
                    let tmpCustomName = item.customName ? `${item.customName}` : (slim.uuid || 'NoUUID');
                    let identifyStr = `${tmpCustomName}::${key}`;
                    slim.identify = identifyStr;
                } else {
                    slim.identify = null;
                }
                slim.provider = key;
                // 统计
                count++;
                if (slim.isHealthy === false) {
                    unhealthyCount++;
                    if (slim.identify) unhealthyProvideIdentifyList.push(slim.identify);
                }
                return slim;
            });
        providerPoolsSlim.push(...slimArr);
    }
    if (count > 0) {
        unhealthyRatio = Number((unhealthyCount / count).toFixed(2));
    }
        let unhealthySummeryMessage = unhealthyProvideIdentifyList.join('\n');
        if (unhealthySummeryMessage === '') unhealthySummeryMessage = null;
    return {
        providerPoolsSlim,
        unhealthySummeryMessage,
        count,
        unhealthyCount,
        unhealthyRatio
    };
}
