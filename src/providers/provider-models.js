import { convertData } from '../convert/convert.js';
import { MODEL_PROVIDER } from '../utils/common.js';
import { CONFIG } from '../core/config-manager.js';

/**
 * 判断字符串是否是一个已知的提供商标识（支持 openai-custom-1 这类带后缀的自定义分组）
 * @param {string} prefix
 * @returns {boolean}
 */
function isKnownProviderPrefix(prefix) {
    if (!prefix || typeof prefix !== 'string') {
        return false;
    }
    if (CONFIG.providerPools && Object.prototype.hasOwnProperty.call(CONFIG.providerPools, prefix)) {
        return true;
    }
    if (Object.prototype.hasOwnProperty.call(PROVIDER_MODELS, prefix)) {
        return true;
    }
    const knownProviders = Object.values(MODEL_PROVIDER);
    if (knownProviders.includes(prefix)) {
        return true;
    }
    return knownProviders.some(p => p !== MODEL_PROVIDER.AUTO && prefix.startsWith(`${p}-`));
}

/**
 * 拆分 "provider:model" 形式的模型名。
 * 仅当前缀确实是一个已知提供商时才拆分，避免把模型名自带的冒号误判为提供商前缀。
 * @param {string} modelId
 * @returns {{providerPrefix: string|null, modelId: string}}
 */
export function splitProviderPrefixedModel(modelId) {
    if (typeof modelId !== 'string') {
        return { providerPrefix: null, modelId };
    }
    const separatorIndex = modelId.indexOf(':');
    // 冒号在首尾时不构成合法前缀
    if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
        return { providerPrefix: null, modelId };
    }
    const prefix = modelId.slice(0, separatorIndex);
    if (!isKnownProviderPrefix(prefix)) {
        return { providerPrefix: null, modelId };
    }
    return { providerPrefix: prefix, modelId: modelId.slice(separatorIndex + 1) };
}

/**
 * 获取模型配置元数据
 * @param {string} modelId - 模型 ID 或别名
 * @param {string|null} provider - 自定义模型归属的提供商
 * @returns {Object|null} 模型配置
 */
export function getCustomModelConfig(modelId, provider = null) {
    if (!CONFIG.customModels || !Array.isArray(CONFIG.customModels)) {
        return null;
    }

    const { providerPrefix, modelId: targetModelId } = splitProviderPrefixedModel(modelId);
    const targetProvider = providerPrefix ||
        (provider && provider !== MODEL_PROVIDER.AUTO ? provider : null);

    if (!targetProvider) {
        return CONFIG.customModels.find(m =>
            !m.provider &&
            (m.id === targetModelId || m.alias === targetModelId)
        ) || null;
    }

    return CONFIG.customModels.find(m =>
        customModelMatchesProvider(m, targetProvider) &&
        (m.id === targetModelId || m.alias === targetModelId)
    ) || null;
}

/**
 * 获取所有匹配的自定义模型配置（多候选优先级路由用）
 *
 * 三种语义：
 * - 模型名带合法提供商前缀（如 `atlascloud:gpt-4o`）：用户硬约束，只返回该提供商下的配置
 * - 请求显式指定了提供商（header `model-provider` 或路径首段）：只返回该提供商下的配置
 * - 未显式指定（含 auto、含 config.json 里的默认值）：返回全部同名配置，交由优先级决定走哪条
 *
 * @param {string} modelId - 模型 ID 或别名，可带提供商前缀
 * @param {string|null} provider - 当前生效的提供商
 * @param {Object} [options]
 * @param {boolean} [options.providerExplicit] - provider 是否来自用户显式指定（而非配置默认值）
 * @returns {Array<Object>} 匹配的自定义模型配置列表
 */
export function getAllCustomModelConfigs(modelId, provider = null, options = {}) {
    if (!CONFIG.customModels || !Array.isArray(CONFIG.customModels)) {
        return [];
    }

    const { providerPrefix, modelId: targetModelId } = splitProviderPrefixedModel(modelId);
    const matchesModelId = m => m && (m.id === targetModelId || m.alias === targetModelId);

    // 情况 A：模型名带提供商前缀，必须按前缀过滤
    if (providerPrefix) {
        return CONFIG.customModels.filter(m =>
            matchesModelId(m) && customModelMatchesProvider(m, providerPrefix)
        );
    }

    // 情况 B：请求显式指定了提供商，必须按该提供商过滤
    if (options.providerExplicit && provider && provider !== MODEL_PROVIDER.AUTO) {
        return CONFIG.customModels.filter(m =>
            matchesModelId(m) && customModelMatchesProvider(m, provider)
        );
    }

    // 情况 C：未显式指定，全部同名自定义模型都是候选
    return CONFIG.customModels.filter(matchesModelId);
}

/**
 * 各提供商支持的模型列表
 * 用于前端UI选择不支持的模型
 */
export const PROVIDER_MODELS = {
    'gemini-cli-oauth': [
        'gemini-3-flash-preview',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-pro',
        'gemini-3-pro-preview',
        'gemini-3.1-pro-preview',
        'gemini-3.1-flash-lite-preview',
        'gemini-3.5-flash',
        'gemini-3.6-flash',
        'gemini-3.7-flash',
        'gemini-3.8-flash',
    ],
    'gemini-antigravity': [
        'gemini-3-flash',
        'gemini-3.5-flash-low',
        'gemini-3.5-flash-high',
        'gemini-3.6-flash',
        'gemini-3.6-flash-low',
        'gemini-3.6-flash-high',
        'gemini-3.7-flash',
        'gemini-3.7-flash-low',
        'gemini-3.7-flash-high',
        'gemini-3.8-flash',
        'gemini-3.8-flash-low',
        'gemini-3.8-flash-high',
        'gemini-3.1-pro-low',
        'gemini-3.1-pro-high',
        'gemini-3.1-flash-image',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash-thinking',
        'gemini-claude-sonnet-4-6',
        'gemini-claude-opus-4-6-thinking',
    ],
    'claude-custom': [],
    'claude-kiro-oauth': [
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'claude-haiku-4-5',
        'claude-haiku-4-5-20251001',
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-opus-4-5',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929',
    ],
    'openai-custom': [],
    'atlascloud': [],
    'qiniu': [],
    'fenno': [],
    'openaiResponses-custom': [],
    'openai-qwen-oauth': [
        'coder-model',
        'vision-model',
        'qwen3-coder-plus',
        'qwen3-coder-flash',
    ],
    'openai-iflow': [
        // iFlow 特有模型
        'iflow-rome-30ba3b',
        // Qwen 模型
        'qwen3-coder-plus',
        'qwen3-max',
        'qwen3-vl-plus',
        'qwen3-max-preview',
        'qwen3-32b',
        'qwen3-235b-a22b-thinking-2507',
        'qwen3-235b-a22b-instruct',
        'qwen3-235b',
        // Kimi 模型
        'kimi-k2-0905',
        'kimi-k2',
        // GLM 模型
        'glm-4.6',
        // DeepSeek 模型
        'deepseek-v3.2',
        'deepseek-r1',
        'deepseek-v3',
        // 手动定义
        'glm-4.7',
        'glm-5',
        'kimi-k2.5',
        'minimax-m2.1',
        'minimax-m2.5',
    ],
    'openai-codex-oauth': [
        'gpt-5.3-codex-spark',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.5',
        'gpt-6-astra',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-image-2',
    ],
    'grok-cli-oauth': [
        'grok-build-0.1',
        'grok-imagine-image-quality',
        'grok-imagine-image',
        'grok-imagine-image-pro',
        'grok-imagine-video',
        'grok-imagine-video-1.5-preview',
        'grok-imagine-video-1.5-2026-05-30',
        'grok-4.6',
        'grok-4.5',
        'grok-4.3',
        'grok-4.20-0309-reasoning',
        'grok-4.20-0309-non-reasoning',
        'grok-4.20-multi-agent-0309',
        'grok-4',
        'grok-4-fast',
        'grok-3-mini',
        'grok-3-mini-fast',
        'grok-3'
    ],
    'forward-api': [],
    'grok-web': [
        'grok-4.1-mini',
        'grok-4.1-thinking',
        'grok-4.20',
        'grok-4.20-auto',
        'grok-4.20-fast',
        'grok-4.20-expert',
        'grok-4.20-heavy',
        'grok-imagine-1.0',
        'grok-imagine-1.0-edit',
        'grok-imagine-1.0-fast',
        'grok-imagine-1.0-fast-edit',
    ]
};

export const MANAGED_MODEL_LIST_PROVIDERS = [
    'openai-custom',
    'openaiResponses-custom',
    'claude-custom',
    'atlascloud',
    'qiniu',
    'fenno'
];

export function getManagedModelListProviderType(providerType) {
    return MANAGED_MODEL_LIST_PROVIDERS.find(baseType =>
        providerType === baseType || providerType.startsWith(baseType + '-')
    ) || null;
}

export function usesManagedModelList(providerType) {
    return getManagedModelListProviderType(providerType) !== null;
}

export function normalizeModelIds(models = []) {
    return [...new Set(
        (Array.isArray(models) ? models : [])
            .filter(model => typeof model === 'string')
            .map(model => model.trim())
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
}

export function getCustomModelActualProvider(modelConfig) {
    if (!modelConfig) {
        return '';
    }
    if (Object.prototype.hasOwnProperty.call(modelConfig, 'actualProvider')) {
        return modelConfig.actualProvider || '';
    }
    return modelConfig.provider || '';
}

export function getCustomModelListProvider(modelConfig) {
    return modelConfig?.provider || getCustomModelActualProvider(modelConfig);
}

export function customModelMatchesProvider(modelConfig, providerType) {
    const listProvider = getCustomModelListProvider(modelConfig);
    return listProvider === providerType || (listProvider && providerType.startsWith(listProvider + '-'));
}

function extractModelIdsFromListShape(modelList) {
    if (!modelList) {
        return [];
    }

    if (Array.isArray(modelList)) {
        return modelList.map(item => {
            if (typeof item === 'string') return item;
            return item?.id || item?.name || item?.model || null;
        }).filter(Boolean);
    }

    if (Array.isArray(modelList.data)) {
        return modelList.data.map(item => item?.id || item?.name || item?.model || null).filter(Boolean);
    }

    if (Array.isArray(modelList.models)) {
        return modelList.models.map(item => {
            if (typeof item === 'string') return item;
            return item?.id || item?.name || item?.model || null;
        }).filter(Boolean);
    }

    return [];
}

export function extractModelIdsFromNativeList(modelList, providerType) {
    let convertedModelList = modelList;

    // 只有在提供商类型与目标类型协议不同时才尝试转换
    if (providerType !== MODEL_PROVIDER.OPENAI_CUSTOM && !providerType.startsWith(MODEL_PROVIDER.OPENAI_CUSTOM + '-')) {
        try {
            convertedModelList = convertData(modelList, 'modelList', providerType, MODEL_PROVIDER.OPENAI_CUSTOM);
        } catch {
            convertedModelList = modelList;
        }
    }

    const convertedIds = normalizeModelIds(extractModelIdsFromListShape(convertedModelList));
    if (convertedIds.length > 0) {
        return convertedIds;
    }

    return normalizeModelIds(extractModelIdsFromListShape(modelList));
}

export function getConfiguredSupportedModels(providerType, providerConfig = {}) {
    if (!usesManagedModelList(providerType)) {
        return [];
    }

    return normalizeModelIds(providerConfig?.supportedModels);
}

/**
 * 获取指定提供商类型支持的模型列表
 * @param {string} providerType - 提供商类型
 * @returns {Array<string>} 模型列表
 */
export function getProviderModels(providerType) {
    let models = [];
    if (PROVIDER_MODELS[providerType]) {
        models = [...PROVIDER_MODELS[providerType]];
    } else {
        // 尝试前缀匹配 (例如 openai-custom-1 -> openai-custom)
        for (const key of Object.keys(PROVIDER_MODELS)) {
            if (providerType.startsWith(key + '-')) {
                models = [...PROVIDER_MODELS[key]];
                break;
            }
        }
    }

    // 注入自定义模型
    if (CONFIG.customModels && Array.isArray(CONFIG.customModels)) {
        CONFIG.customModels.forEach(m => {
            // 匹配模型列表归属提供商或其后缀分组
            if (customModelMatchesProvider(m, providerType)) {
                // 注入 ID
                if (!models.includes(m.id)) {
                    models.push(m.id);
                }
            }
        });
    }

    return normalizeModelIds(models);
}

/**
 * 获取所有提供商的模型列表
 * @returns {Object} 所有提供商的模型映射
 */
export function getAllProviderModels() {
    // 执行深拷贝，避免修改原始 PROVIDER_MODELS 对象
    const allModels = {};
    for (const provider in PROVIDER_MODELS) {
        allModels[provider] = [...PROVIDER_MODELS[provider]];
    }
    
    // 合并自定义模型到对应的提供商
    if (CONFIG.customModels && Array.isArray(CONFIG.customModels)) {
        CONFIG.customModels.forEach(m => {
            // 如果指定了模型列表归属提供商，注入到该提供商
            // 如果没有指定（Auto），则注入到特殊的虚拟分组
            const targetProvider = getCustomModelListProvider(m) || 'custom-auto';
            
            if (!allModels[targetProvider]) {
                allModels[targetProvider] = [];
            }
            
            // 注入 ID
            if (!allModels[targetProvider].includes(m.id)) {
                allModels[targetProvider].push(m.id);
            }
        });
    }
    
    // 对每个列表进行排序
    for (const provider in allModels) {
        allModels[provider] = normalizeModelIds(allModels[provider]);
    }
    
    return allModels;
}
