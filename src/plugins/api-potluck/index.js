/**
 * API 大锅饭插件 - 标准插件格式
 * 
 * 功能：
 * 1. API Key 管理（创建、删除、启用/禁用）
 * 2. 每日配额限制
 * 3. 用量统计
 * 4. 管理 API 接口
 */

import {
    createKey,
    listKeys,
    getKey,
    deleteKey,
    updateKeyLimit,
    resetKeyUsage,
    resetKeyTokenStats,
    toggleKey,
    updateKeyName,
    validateKey,
    incrementUsage,
    getStats,
    resetAllTokenStats,
    KEY_PREFIX,
    setConfigGetter
} from './key-manager.js';

import {
    extractPotluckKey,
    isPotluckRequest,
    sendPotluckError
} from './middleware.js';

import logger from '../../utils/logger.js';

import { handlePotluckApiRoutes, handlePotluckUserApiRoutes } from './api-routes.js';

const pendingUsage = new Map();

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function normalizeUsageCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    if (Array.isArray(candidate)) {
        return candidate.reduce((usage, item) => mergeUsage(usage, normalizeUsageCandidate(item)), {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0
        });
    }

    const usage = candidate.usage || candidate.message?.usage || candidate.usageMetadata || candidate.response?.usage || null;
    const reasoningTokens = toNumber(
        candidate.completion_tokens_details?.reasoning_tokens ??
        candidate.output_tokens_details?.reasoning_tokens ??
        usage?.completion_tokens_details?.reasoning_tokens ??
        usage?.output_tokens_details?.reasoning_tokens ??
        usage?.thoughtsTokenCount
    );
    const promptTokens = toNumber(
        candidate.prompt_tokens ??
        usage?.prompt_tokens ??
        usage?.input_tokens ??
        usage?.promptTokenCount ??
        usage?.inputTokenCount
    );
    const completionTokens = toNumber(
        candidate.completion_tokens ??
        usage?.completion_tokens ??
        usage?.output_tokens ??
        usage?.candidatesTokenCount ??
        usage?.outputTokenCount
    ) + reasoningTokens;
    const totalTokens = toNumber(
        candidate.total_tokens ??
        usage?.total_tokens ??
        usage?.totalTokenCount
    );

    const cachedTokens = toNumber(
        candidate.cached_tokens ??
        usage?.cached_tokens ??
        candidate.prompt_tokens_details?.cached_tokens ??
        candidate.input_tokens_details?.cached_tokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.input_tokens_details?.cached_tokens ??
        usage?.cache_read_input_tokens ??
        usage?.cachedContentTokenCount
    );

    return {
        promptTokens,
        completionTokens,
        totalTokens: totalTokens || (promptTokens + completionTokens),
        cachedTokens
    };
}

function mergeUsage(baseUsage, nextUsage) {
    if (!nextUsage) return baseUsage;
    return {
        promptTokens: Math.max(baseUsage.promptTokens, nextUsage.promptTokens),
        completionTokens: Math.max(baseUsage.completionTokens, nextUsage.completionTokens),
        totalTokens: Math.max(baseUsage.totalTokens, nextUsage.totalTokens),
        cachedTokens: Math.max(baseUsage.cachedTokens || 0, nextUsage.cachedTokens || 0)
    };
}

function extractUsage(...candidates) {
    return candidates.reduce((usage, candidate) => mergeUsage(usage, normalizeUsageCandidate(candidate)), {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0
    });
}

function getTrackedRequestIds(hookContext = {}) {
    return [...new Set([
        hookContext._monitorRequestId
    ].filter(Boolean))];
}

function getPendingUsageForHookContext(hookContext = {}) {
    for (const requestId of getTrackedRequestIds(hookContext)) {
        const usage = pendingUsage.get(requestId);
        if (usage) {
            return usage;
        }
    }

    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * 插件定义
 */
const apiPotluckPlugin = {
    name: 'api-potluck',
    version: '1.0.2',
    description: 'API 大锅饭 - Key 管理和用量统计插件<br>管理端：<a href="potluck.html" target="_blank">potluck.html</a><br>用户端：<a href="potluck-user.html" target="_blank">potluck-user.html</a>',
    
    // 插件类型：认证插件
    type: 'auth',
    
    // 优先级：数字越小越先执行，默认认证插件优先级为 9999
    _priority: 10,

    /**
     * 初始化钩子
     * @param {Object} config - 服务器配置
     */
    async init(config) {
        logger.info('[API Potluck Plugin] Initializing...');
    },

    /**
     * 销毁钩子
     */
    async destroy() {
        logger.info('[API Potluck Plugin] Destroying...');
    },

    /**
     * 静态文件路径
     */
    staticPaths: ['potluck.html', 'potluck-user.html'],

    /**
     * 路由定义
     */
    routes: [
        {
            method: '*',
            path: '/api/potluckuser',
            public: true, // This user-only handler validates the user's maki_ API key itself.
            handler: handlePotluckUserApiRoutes
        },
        {
            method: '*',
            path: '/api/potluck',
            handler: handlePotluckApiRoutes
        }
    ],

    /**
     * 认证方法 - 处理 Potluck Key 认证
     * @param {http.IncomingMessage} req - HTTP 请求
     * @param {http.ServerResponse} res - HTTP 响应
     * @param {URL} requestUrl - 解析后的 URL
     * @param {Object} config - 服务器配置
     * @returns {Promise<{handled: boolean, authorized: boolean|null, error?: Object, data?: Object}>}
     */
    async authenticate(req, res, requestUrl, config) {
        const apiKey = extractPotluckKey(req, requestUrl);
        
        if (!apiKey) {
            // 不是 potluck 请求，返回 null 让其他认证插件处理
            return { handled: false, authorized: null };
        }

        // 验证 Key
        const validation = await validateKey(apiKey);
        
        if (!validation.valid) {
            const errorMessages = {
                'invalid_format': 'Invalid API key format',
                'not_found': 'API key not found',
                'disabled': 'API key has been disabled',
                'quota_exceeded': 'Quota exceeded for this API key'
            };

            const statusCodes = {
                'invalid_format': 401,
                'not_found': 401,
                'disabled': 403,
                'quota_exceeded': 429
            };

            const error = {
                statusCode: statusCodes[validation.reason] || 401,
                message: errorMessages[validation.reason] || 'Authentication failed',
                code: validation.reason,
                keyData: validation.keyData
            };

            // 发送错误响应
            sendPotluckError(res, error);
            return { handled: true, authorized: false, error };
        }

        // 认证成功，返回数据供后续使用
        logger.info(`[API Potluck Plugin] Authorized with key: ${apiKey.substring(0, 12)}...`);
        return {
            handled: false,
            authorized: true,
            data: {
                potluckApiKey: apiKey,
                potluckKeyData: validation.keyData
            }
        };
    },

    /**
     * 钩子函数
     */
    hooks: {
        async onUnaryResponse({ requestId, nativeResponse, clientResponse }) {
            if (!requestId) return;
            pendingUsage.set(requestId, mergeUsage(
                pendingUsage.get(requestId) || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                extractUsage(nativeResponse, clientResponse)
            ));
        },

        async onStreamChunk({ requestId, nativeChunk, chunkToSend }) {
            if (!requestId) return;
            pendingUsage.set(requestId, mergeUsage(
                pendingUsage.get(requestId) || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                extractUsage(nativeChunk, chunkToSend)
            ));
        },

        /**
         * 内容生成后钩子 - 记录用量
         * @param {Object} hookContext - 钩子上下文，包含请求和模型信息
         */
        async onContentGenerated(hookContext) {
            const trackedRequestIds = getTrackedRequestIds(hookContext);

            if (hookContext.potluckApiKey) {
                try {
                    const usage = getPendingUsageForHookContext(hookContext);

                    // 传入提供商和模型信息，以及请求 ID 用于防重
                    await incrementUsage(
                        hookContext.potluckApiKey, 
                        hookContext.toProvider, 
                        hookContext.model,
                        usage,
                        trackedRequestIds[0] || null
                    );

                } catch (e) {
                    // 静默失败，不影响主流程
                    logger.error('[API Potluck Plugin] Failed to record usage:', e.message);
                }
            }

            for (const requestId of trackedRequestIds) {
                pendingUsage.delete(requestId);
            }
        }

    },

    // 导出内部函数供外部使用（可选）
    exports: {
        createKey,
        listKeys,
        getKey,
        deleteKey,
        updateKeyLimit,
        resetKeyUsage,
        resetKeyTokenStats,
        toggleKey,
        updateKeyName,
        validateKey,
        incrementUsage,
        getStats,
        resetAllTokenStats,
        KEY_PREFIX,
        extractPotluckKey,
        isPotluckRequest
    }
};

export default apiPotluckPlugin;

// 也导出命名导出，方便直接引用
export {
    createKey,
    listKeys,
    getKey,
    deleteKey,
    updateKeyLimit,
    resetKeyUsage,
    resetKeyTokenStats,
    toggleKey,
    updateKeyName,
    validateKey,
    incrementUsage,
    getStats,
    resetAllTokenStats,
    KEY_PREFIX,
    extractPotluckKey,
    isPotluckRequest
};
