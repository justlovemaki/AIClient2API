export { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as http from 'http'; // Add http for IncomingMessage and ServerResponse types
import * as crypto from 'crypto'; // Import crypto for MD5 hashing
import logger from './logger.js';
import { convertData, getOpenAIStreamChunkStop } from '../convert/convert.js';
import { ProviderStrategyFactory } from './provider-strategies.js';
import { getPluginManager } from '../core/plugin-manager.js';
import { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';

// ==================== 时间与时区 ====================

/**
 * 获取北京时间 (UTC+8) 的日期字符串 (YYYY-MM-DD)
 * @returns {string} - YYYY-MM-DD 格式的日期字符串
 */
export function getBeijingDateString() {
    const now = new Date();
    // 强制增加 8 小时偏移来模拟 UTC+8
    const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    return utc8Time.toISOString().split('T')[0];
}

// ==================== 网络错误处理 ====================

/**
 * 可重试的网络错误标识列表
 * 这些错误可能出现在 error.code 或 error.message 中
 */
export const RETRYABLE_NETWORK_ERRORS = [
    'ECONNRESET',      // 连接被重置
    'ETIMEDOUT',       // 连接超时
    'ECONNREFUSED',    // 连接被拒绝
    'ENOTFOUND',       // DNS 解析失败
    'ENETUNREACH',     // 网络不可达
    'EHOSTUNREACH',    // 主机不可达
    'EPIPE',           // 管道破裂
    'EAI_AGAIN',       // DNS 临时失败
    'ECONNABORTED',    // 连接中止
    'ESOCKETTIMEDOUT', // Socket 超时
];

/**
 * 检查是否为可重试的网络错误
 * @param {Error} error - 错误对象
 * @returns {boolean} - 是否为可重试的网络错误
 */
export function isRetryableNetworkError(error) {
    if (!error) return false;
    
    const errorCode = error.code || '';
    const errorMessage = error.message || '';
    
    return RETRYABLE_NETWORK_ERRORS.some(err => 
        errorCode === err || errorMessage.includes(err)
    );
}

/**
 * 确保状态码是有效的 HTTP 状态码
 * @param {any} code - 待检查的状态码
 * @returns {number} - 有效的 HTTP 状态码 (100-599)，默认为 500
 */
export function ensureValidStatusCode(code) {
    const num = parseInt(code, 10);
    if (!isNaN(num) && num >= 100 && num < 600) {
        return num;
    }
    return 500;
}


function getErrorStatusCode(error) {
    return error?.response?.status || error?.status || error?.statusCode || error?.code || null;
}

function getHttpStatusLabel(status) {
    switch (status) {
        case 400: return 'Bad Request';
        case 401: return 'Unauthorized';
        case 402: return 'Payment Required';
        case 403: return 'Forbidden';
        case 404: return 'Not Found';
        case 408: return 'Request Timeout';
        case 409: return 'Conflict';
        case 422: return 'Unprocessable Entity';
        case 429: return 'Too Many Requests';
        case 500: return 'Internal Server Error';
        case 502: return 'Bad Gateway';
        case 503: return 'Service Unavailable';
        case 504: return 'Gateway Timeout';
        default: return 'HTTP Error';
    }
}

function extractReadableErrorText(data) {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');

    if (Array.isArray(data)) {
        return data
            .map(item => extractReadableErrorText(item))
            .filter(Boolean)
            .join(' | ');
    }

    if (typeof data !== 'object') {
        return String(data);
    }

    const directFields = [
        data.message,
        data.error_description,
        data.description,
        data.detail,
        data.reason,
        data.msg
    ].filter(value => typeof value === 'string' && value.trim());

    if (directFields.length > 0) {
        return directFields.join(' | ');
    }

    if (typeof data.error === 'string' && data.error.trim()) {
        return data.error;
    }

    if (data.error && typeof data.error === 'object') {
        const nestedError = extractReadableErrorText(data.error);
        if (nestedError) return nestedError;
    }

    if (Array.isArray(data.details)) {
        const detailText = data.details
            .map(detail => extractReadableErrorText(detail))
            .filter(Boolean)
            .join(' | ');
        if (detailText) return detailText;
    }

    if (data.metadata && typeof data.metadata === 'object') {
        const metadataText = extractReadableErrorText(data.metadata);
        if (metadataText) return metadataText;
    }

    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

export async function getNormalizedErrorResponseText(error) {
    const data = error?.response?.data;
    const fallbackText = extractReadableErrorText(data) || error?.message || '';

    if (!data || typeof data?.on !== 'function' || typeof data?.read !== 'function') {
        return fallbackText;
    }

    const chunks = [];
    try {
        for await (const chunk of data) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }

        const bodyText = Buffer.concat(chunks).toString('utf8');
        if (!bodyText) return fallbackText;

        try {
            const parsed = JSON.parse(bodyText);
            return extractReadableErrorText(parsed) || bodyText;
        } catch {
            return bodyText;
        }
    } catch (readError) {
        logger.warn(`[Error Normalize] Failed to read error response stream: ${readError.message}`);
        return fallbackText;
    }
}

export function buildHttpErrorReason(status, context, responseText = '', options = {}) {
    const statusLabel = getHttpStatusLabel(status);
    const responseSnippet = responseText ? responseText.substring(0, 500) : '';
    const suffix = options.suffix ? ` - ${options.suffix}` : '';
    const prefix = status ? `${status} ${statusLabel}` : statusLabel;
    return `${prefix}${context ? ` (${context})` : ''}${suffix}${responseSnippet ? `: ${responseSnippet}` : ''}`;
}

export async function normalizeProviderErrorMessage(error, options = {}) {
    const status = options.status ?? getErrorStatusCode(error);
    const responseText = await getNormalizedErrorResponseText(error);
    const reason = buildHttpErrorReason(status, options.context || '', responseText, {
        suffix: options.suffix || ''
    });
    // Normalize in place so existing throw/logging paths that keep using `error`
    // automatically see the readable message without forcing every caller to reassign.
    error.message = reason;
    return { responseText, reason, status };
}

function getHeaderValue(headers, headerName) {
    if (!headers) return null;

    if (typeof headers.get === 'function') {
        return headers.get(headerName) || headers.get(headerName.toLowerCase());
    }

    const lowerName = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowerName) {
            return Array.isArray(value) ? value[0] : value;
        }
    }

    return null;
}

function parseRetryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined) return null;

    const rawValue = Array.isArray(value) ? value[0] : value;
    const text = String(rawValue).trim();
    if (!text) return null;

    const seconds = Number(text);
    if (Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1000));
    }

    const dateMs = Date.parse(text);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - now);
    }

    return null;
}

function parseDurationMs(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));

    const text = String(value).trim();
    const match = text.match(/^([\d.]+)\s*(ms|s)?$/i);
    if (!match) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;

    return Math.max(0, Math.round(match[2]?.toLowerCase() === 's' ? amount * 1000 : amount));
}

function getRetryDelayFromBody(errorBody) {
    try {
        const data = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;

        const directDelay = parseDurationMs(data?.retryDelay ?? data?.retry_delay ?? data?.retryAfterMs);
        if (directDelay !== null) return directDelay;

        const details = data?.error?.details;
        if (Array.isArray(details)) {
            for (const detail of details) {
                const retryDelay = parseDurationMs(detail?.retryDelay || detail?.metadata?.quotaResetDelay);
                if (retryDelay !== null) return retryDelay;
            }
        }

        const message = data?.error?.message;
        if (message) {
            const match = message.match(/after\s+([\d.]+)\s*(ms|s)?\.?/i);
            if (match) {
                const amount = parseFloat(match[1]);
                return Math.max(0, Math.round(match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000));
            }
        }
    } catch {}

    return null;
}

export function getRetryAfterMs(error, now = Date.now()) {
    const headerDelay = parseRetryAfterMs(getHeaderValue(error?.response?.headers, 'retry-after'), now);
    if (headerDelay !== null) return headerDelay;

    const explicitDelay = parseDurationMs(error?.retryAfterMs);
    if (explicitDelay !== null) return explicitDelay;

    const internalRetryAfterDelay = parseDurationMs(error?.retryAfter);
    if (internalRetryAfterDelay !== null) return internalRetryAfterDelay;

    const retryAfterDelay = parseRetryAfterMs(error?.response?.data?.retryAfter ?? error?.response?.data?.retry_after, now);
    if (retryAfterDelay !== null) return retryAfterDelay;

    return getRetryDelayFromBody(error?.response?.data);
}

function getPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

/**
 * Calculates a scheduled recovery time for optional 429 account cooldown.
 * Returns null when cooldown is disabled or the error is not an HTTP 429.
 */
export function getRateLimitCooldownRecoveryTime(error, config = {}, now = Date.now()) {
    if (!config?.RATE_LIMIT_COOLDOWN_ENABLED || Number(getErrorStatusCode(error)) !== 429) {
        return null;
    }

    const defaultCooldownMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_MS, 30000);
    const maxCooldownMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_MAX_MS, 300000);
    const jitterMs = getPositiveInteger(config.RATE_LIMIT_COOLDOWN_JITTER_MS, 0);
    const retryAfterMs = getRetryAfterMs(error, now);
    const baseCooldownMs = retryAfterMs === null ? defaultCooldownMs : retryAfterMs;
    const cappedCooldownMs = Math.min(baseCooldownMs, Math.max(defaultCooldownMs, maxCooldownMs));
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;

    return new Date(now + cappedCooldownMs + jitter);
}

// ==================== API 常量 ====================

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 10 * 1024 * 1024;

import {
    usesManagedModelList,
    getConfiguredSupportedModels,
    getCustomModelConfig,
    getAllCustomModelConfigs,
    getCustomModelActualProvider,
    getCustomModelListProvider,
    normalizeModelIds
} from '../providers/provider-models.js';

/**
 * 获取指定提供商类型下，所有节点配置的已选模型列表（去重聚合）
 * @param {object} providerPoolManager - 提供商池管理器
 * @param {string} providerType - 提供商类型
 * @returns {string[]} 聚合后的模型 ID 列表
 */
function getConfiguredSupportedModelsFromPool(providerPoolManager, providerType) {
    if (!providerPoolManager?.providerStatus?.[providerType]) {
        return [];
    }

    return [...new Set(
        providerPoolManager.providerStatus[providerType]
            .flatMap(providerStatus => getConfiguredSupportedModels(providerType, providerStatus.config))
    )].sort((a, b) => a.localeCompare(b));
}

function getCustomModelEntriesForProvider(config, providerType = null, options = {}) {
    const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
    const entries = [];

    customModels.forEach(modelConfig => {
        if (!modelConfig?.id) {
            return;
        }

        const modelProvider = getCustomModelListProvider(modelConfig);
        const actualProvider = getCustomModelActualProvider(modelConfig);
        const isMatch = !providerType ||
            modelProvider === providerType ||
            (modelProvider && providerType.startsWith(modelProvider + '-'));

        if (!isMatch) {
            return;
        }

        const modelId = modelConfig.id;
        if (!modelId) {
            return;
        }

        const responseId = options.prefixProvider && modelProvider
            ? `${modelProvider}:${modelId}`
            : modelId;

        entries.push({
            id: responseId,
            modelId,
            provider: modelProvider || providerType || MODEL_PROVIDER.AUTO,
            actualProvider: actualProvider || modelProvider || providerType || MODEL_PROVIDER.AUTO,
            config: modelConfig
        });
    });

    return entries;
}

export function resolveCustomModelRouting(model, currentProvider, customModelConfig = getCustomModelConfig(model, currentProvider)) {
    if (!customModelConfig) {
        return {
            isCustomModel: false,
            model,
            provider: currentProvider,
            actualModel: model,
            actualProvider: currentProvider,
            config: null
        };
    }

    const customActualProvider = getCustomModelActualProvider(customModelConfig);
    const customActualModel = customModelConfig.actualModel || customModelConfig.id || model;

    return {
        isCustomModel: true,
        model: customActualModel,
        provider: customActualProvider || currentProvider,
        actualModel: customActualModel,
        actualProvider: customActualProvider || currentProvider,
        config: customModelConfig
    };
}

function appendCustomModelsToModelList(clientModelList, customEntries, providerType, listEndpointType) {
    const entries = Array.isArray(customEntries) ? customEntries : [];
    const hasMetadataValue = (value) => value !== undefined && value !== null;

    if (!entries.length) {
        return clientModelList;
    }

    if (listEndpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
        const models = Array.isArray(clientModelList?.models) ? clientModelList.models : [];

        entries.forEach(entry => {
            const existingModel = models.find(model => {
                const existingId = model?.baseModelId || model?.name;
                if (!existingId) return false;
                const normalizedId = existingId.startsWith('models/') ? existingId.substring(7) : existingId;
                return normalizedId === entry.id;
            });
            if (existingModel) {
                existingModel.displayName = entry.config.name || existingModel.displayName || entry.id;
                existingModel.description = entry.config.description || existingModel.description || `Model ${entry.modelId} provided by ${entry.provider || providerType}`;
                if (hasMetadataValue(entry.config.contextLength)) existingModel.inputTokenLimit = entry.config.contextLength;
                if (hasMetadataValue(entry.config.maxTokens)) existingModel.outputTokenLimit = entry.config.maxTokens;
                return;
            }

            const modelResponse = {
                name: `models/${entry.id}`,
                baseModelId: entry.id,
                version: 'v1',
                displayName: entry.config.name || entry.id,
                description: entry.config.description || `Model ${entry.modelId} provided by ${entry.provider || providerType}`,
                supportedGenerationMethods: ['generateContent', 'countTokens']
            };

            if (hasMetadataValue(entry.config.contextLength)) modelResponse.inputTokenLimit = entry.config.contextLength;
            if (hasMetadataValue(entry.config.maxTokens)) modelResponse.outputTokenLimit = entry.config.maxTokens;

            models.push(modelResponse);
        });

        return {
            ...clientModelList,
            models
        };
    }

    if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
        const models = Array.isArray(clientModelList?.data) ? clientModelList.data : [];

        entries.forEach(entry => {
            const existingModel = models.find(model => model?.id === entry.id);
            if (existingModel) {
                // 更新现有模型的元数据
                if (entry.config.name) existingModel.display_name = entry.config.name;
                if (entry.config.description) existingModel.description = entry.config.description;
                if (hasMetadataValue(entry.config.contextLength)) existingModel.context_length = entry.config.contextLength;
                if (hasMetadataValue(entry.config.maxTokens)) existingModel.max_tokens = entry.config.maxTokens;
                return;
            }

            // 添加新模型
            const modelResponse = {
                id: entry.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: entry.provider || providerType || 'custom',
                display_name: entry.config.name || entry.id
            };

            if (entry.config.description) modelResponse.description = entry.config.description;
            if (hasMetadataValue(entry.config.contextLength)) modelResponse.context_length = entry.config.contextLength;
            if (hasMetadataValue(entry.config.maxTokens)) modelResponse.max_tokens = entry.config.maxTokens;

            models.push(modelResponse);
        });

        return {
            ...clientModelList,
            object: 'list',
            data: models
        };
    }

    return clientModelList;
}

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol (e.g., gemini, openai, claude).
 * @param {string} provider - The model provider string (e.g., 'gemini-cli', 'openai-custom').
 * @returns {string} The protocol prefix (e.g., 'gemini', 'openai', 'claude').
 */
export function getProtocolPrefix(provider) {
    // Special case for Codex - it needs its own protocol
    if (provider === 'openai-codex-oauth') {
        return MODEL_PROTOCOL_PREFIX.CODEX;
    }
    // Grok CLI OAuth talks to xAI Responses API directly.
    if (provider === 'grok-cli-oauth' || provider.startsWith('grok-cli-oauth-')) {
        return MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    }
    // Special cases for OpenAI-compatible dedicated providers.
    if (provider === 'atlascloud' || provider.startsWith('atlascloud-') ||
        provider === 'qiniu' || provider.startsWith('qiniu-') ||
        provider === 'fenno' || provider.startsWith('fenno-')) {
        return MODEL_PROTOCOL_PREFIX.OPENAI;
    }

    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) {
        return provider.substring(0, hyphenIndex);
    }
    return provider; // Return original if no hyphen is found
}

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai_chat',
    OPENAI_RESPONSES: 'openai_responses',
    GEMINI_CONTENT: 'gemini_content',
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
    GEMINI_MODEL_LIST: 'gemini_model_list',
};

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'fetch_system_prompt.txt');
export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/**
 * 格式化日志输出，统一日志格式
 * @param {string} tag - 日志标签，如 'Qwen', 'Kiro' 等
 * @param {string} message - 日志消息
 * @param {Object} [data] - 可选的数据对象，将被格式化输出
 * @returns {string} 格式化后的日志字符串
 */
export function formatLog(tag, message, data = null) {
    let logMessage = `[${tag}] ${message}`;
    
    if (data !== null && data !== undefined) {
        if (typeof data === 'object') {
            const dataStr = Object.entries(data)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', ');
            logMessage += ` | ${dataStr}`;
        } else {
            logMessage += ` | ${data}`;
        }
    }
    
    return logMessage;
}

/**
 * 格式化凭证过期时间日志
 * @param {string} tag - 日志标签，如 'Qwen', 'Kiro' 等
 * @param {number} expiryDate - 过期时间戳
 * @param {number} nearMinutes - 临近过期的分钟数
 * @returns {{message: string, isNearExpiry: boolean}} 格式化后的日志字符串和是否临近过期
 */
export function formatExpiryLog(tag, expiryDate, nearMinutes) {
    const currentTime = Date.now();
    const nearMinutesInMillis = nearMinutes * 60 * 1000;
    const thresholdTime = currentTime + nearMinutesInMillis;
    const isNearExpiry = expiryDate <= thresholdTime;
    
    const message = formatLog(tag, 'Checking expiry date', {
        'Expiry date': expiryDate,
        'Current time': currentTime,
        [`${nearMinutes} minutes from now`]: thresholdTime,
        'Is near expiry': isNearExpiry
    });
    
    return { message, isNearExpiry };
}

function normalizeIpAddress(ip) {
    if (!ip) return null;

    let normalized = String(ip).trim();
    if (!normalized) return null;

    // Clean up IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 -> 127.0.0.1)
    if (normalized.startsWith('::ffff:')) {
        normalized = normalized.substring('::ffff:'.length);
    }

    return normalized || null;
}

function parseTrustedProxyIps(value) {
    if (Array.isArray(value)) {
        return value
            .flatMap(item => parseTrustedProxyIps(item))
            .filter(Boolean);
    }

    if (typeof value !== 'string') {
        return [];
    }

    return value
        .split(',')
        .map(item => normalizeIpAddress(item))
        .filter(Boolean);
}

function isTrustedProxyIp(ip, trustedProxyIps) {
    const normalizedIp = normalizeIpAddress(ip);
    if (!normalizedIp) return false;

    return parseTrustedProxyIps(trustedProxyIps).some(trustedIp => trustedIp === normalizedIp);
}

/**
 * Get client IP address from request.
 *
 * x-forwarded-for is client-controlled unless the immediate peer is a trusted
 * reverse proxy. Keep TRUST_PROXY disabled by default for login rate limits.
 *
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {Object} [config] - Optional server configuration.
 * @returns {string} The client IP address.
 */
export function getClientIp(req, config = {}) {
    const socketIp = normalizeIpAddress(req.socket?.remoteAddress);

    if (config?.TRUST_PROXY === true && isTrustedProxyIp(socketIp, config.TRUSTED_PROXY_IPS)) {
        const forwarded = req.headers?.['x-forwarded-for'];
        const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        const forwardedIp = normalizeIpAddress(forwardedValue?.split(',')[0]);
        if (forwardedIp) {
            return forwardedIp;
        }
    }

    return socketIp || 'unknown';
}

/**
 * Reads the entire request body from an HTTP request.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {{ maxBytes?: number }} options - Optional body limits.
 * @returns {Promise<Object>} A promise that resolves with the parsed JSON request body.
 * @throws {Error} If the request body is not valid JSON.
 */
export function getRequestBody(req, options = {}) {
    return new Promise((resolve, reject) => {
        let body = '';
        let receivedBytes = 0;
        let settled = false;
        const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_REQUEST_BODY_MAX_BYTES;

        // 1. Quick check Content-Length header
        const headers = req.headers || {};
        const contentLength = parseInt(headers['content-length'] || '0', 10);
        if (!isNaN(contentLength) && contentLength > maxBytes) {
            req.resume(); // drain & discard
            const error = new Error(`Request body too large. Maximum size is ${maxBytes} bytes.`);
            error.statusCode = 413;
            error.code = 'BODY_TOO_LARGE';
            return reject(error);
        }

        const fail = (error) => {
            if (settled) return;
            settled = true;
            if (typeof req.destroy === 'function') {
                req.destroy();
            }
            reject(error);
        };

        const rejectTooLarge = (error) => {
            if (settled) return;
            settled = true;
            if (typeof req.resume === 'function') {
                req.resume();
            }
            reject(error);
        };

        req.on('data', chunk => {
            if (settled) return;
            receivedBytes += chunk.length;
            if (maxBytes && receivedBytes > maxBytes) {
                const error = new Error(`Request body too large. Maximum size is ${maxBytes} bytes.`);
                error.statusCode = 413;
                error.code = 'BODY_TOO_LARGE';
                rejectTooLarge(error);
                return;
            }
            body += chunk.toString();
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            if (!body) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Invalid JSON in request body."));
            }
        });
        req.on('error', err => {
            fail(err);
        });
    });
}

export async function logConversation(type, content, logMode, logFilename) {
    if (logMode === 'none') return;
    if (!content) return;

    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;

    if (logMode === 'console') {
        logger.info(logEntry);
    } else if (logMode === 'file') {
        try {
            // Append to the file
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            logger.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
        }
    }
}

/**
 * Checks if the request is authorized based on API key.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {URL} requestUrl - The parsed URL object.
 * @param {string} REQUIRED_API_KEY - The API key required for authorization.
 * @returns {boolean} True if authorized, false otherwise.
 */
export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key']; // Claude-specific header

    // Check for Bearer token in Authorization header (OpenAI style)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === REQUIRED_API_KEY) {
            return true;
        }
    }

    // Check for API key in URL query parameter (Gemini style)
    if (queryKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-goog-api-key header (Gemini style)
    if (googApiKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-api-key header (Claude style)
    if (claudeApiKey === REQUIRED_API_KEY) {
        return true;
    }

    logger.info(`[Auth] Unauthorized request denied. Bearer: "${authHeader ? 'present' : 'N/A'}", Query Key: "${queryKey}", x-goog-api-key: "${googApiKey}", x-api-key: "${claudeApiKey}"`);
    return false;
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 * This includes writing response headers, logging conversation, and logging auth token expiry.
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {Object} responsePayload - The actual response payload (string for unary, object for stream chunks).
 * @param {boolean} isStream - Whether the response is a stream.
 */
export async function handleUnifiedResponse(res, responsePayload, isStream, statusCode = 200) {
    const validatedStatusCode = ensureValidStatusCode(statusCode);
    if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Transfer-Encoding": "chunked" });
    } else {
        res.writeHead(validatedStatusCode, { 'Content-Type': 'application/json' });
    }

    if (isStream) {
        // Stream chunks are handled by the calling function that iterates the stream
    } else {
        res.end(responsePayload);
    }
}

function getPluginHookRequestId(config) {
    return config?._monitorRequestId || null;
}

/**
 * 创建一个通用的「上游空响应」错误（HTTP 200 但内容完全为空：无文本、无工具调用、无思考内容）。
 * 任何 provider 的 *-core.js 检测到这种情况时都可以抛出这个错误，以复用下面的空响应重试分支。
 * 标记为可切换凭证重试，且不计入凭证错误次数（这通常不是凭证本身的问题，可能是上游偶发静默无输出）。
 *
 * @param {string} providerLabel - 用于日志/错误信息的标签，如 'Kiro'、'Qwen' 等
 */
export function createEmptyUpstreamResponseError(providerLabel = 'Upstream') {
    const error = new Error(`[${providerLabel}] Upstream returned an empty response (no text, tool call, or thinking content).`);
    error.isEmptyUpstreamResponse = true;
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    return error;
}

/**
 * 针对上游「空响应」（error.isEmptyUpstreamResponse）计算是否应该重试，并在应该重试时尝试获取一个
 * 备用的服务实例。重试预算由 CONFIG.EMPTY_RESPONSE_MAX_RETRIES 控制，与凭证切换预算
 * （CREDENTIAL_SWITCH_MAX_RETRIES）完全独立计数，避免一次空回把凭证切换预算耗光。
 * 该机制不绑定具体 provider：任何 provider 抛出带 isEmptyUpstreamResponse 标记的错误都会走到这里。
 *
 * @param {string} [providerLabel='Upstream'] - 用于日志的 provider 标签，如 'Kiro'、'Qwen' 等
 * @returns {Promise<{retry: boolean, result?: object, emptyResponseRetry?: number}>}
 */
async function resolveEmptyUpstreamResponseRetry(CONFIG, model, attemptsMade, logPrefix, providerLabel = 'Upstream') {
    const emptyRetryMax = CONFIG?.EMPTY_RESPONSE_MAX_RETRIES ?? 2;
    const emptyRetryDelayMs = CONFIG?.EMPTY_RESPONSE_RETRY_DELAY_MS ?? 500;

    if (attemptsMade >= emptyRetryMax) {
        logger.error(`${logPrefix} ${providerLabel} empty response persisted after ${emptyRetryMax} retr${emptyRetryMax === 1 ? 'y' : 'ies'} (same request body). Giving up.`);
        return { retry: false };
    }

    logger.warn(`${logPrefix} ${providerLabel} empty response detected (no text/tool/thinking content). Retrying with the same request body (${attemptsMade + 1}/${emptyRetryMax})...`);
    if (emptyRetryDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, emptyRetryDelayMs));
    }

    try {
        // 动态导入以避免循环依赖
        const { getApiServiceWithFallback } = await import('../services/service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true });

        if (result && result.service) {
            logger.info(`${logPrefix} Retrying empty ${providerLabel} response with credential: ${result.uuid} (provider: ${result.actualProviderType})`);
            return { retry: true, result, emptyResponseRetry: attemptsMade + 1 };
        }

        logger.warn(`${logPrefix} No alternative credential available for empty-response retry.`);
        return { retry: false };
    } catch (retryError) {
        logger.error(`${logPrefix} Failed to get alternative service for empty-response retry:`, retryError.message);
        return { retry: false };
    }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
    let fullResponseText = '';
    let fullResponseJson = '';
    let fullOldResponseJson = '';
    let responseClosed = false;
    let anyDataSent = retryContext?.anyDataSent || false; // 跟踪是否已向客户端发送过任何数据
    
    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG;
    // isRetry 用于判断当前调用是否是某次重试的递归帧：既包括凭证切换重试（currentRetry），
    // 也包括上游空响应重试（emptyResponseRetry，参见 resolveEmptyUpstreamResponseRetry）。只有最外层（非重试）的调用帧才负责
    // 绑定/解绑客户端事件监听器、发送响应头、以及在 finally 中写入流结束标记 / res.end()。
    // 如果这里遗漏了 emptyResponseRetry，递归进去的重试帧会误以为自己是最外层，
    // 导致外层和内层重复对同一个 res 做收尾（重复 res.end()），从而抛出 "write after end"。
    const isRetry = currentRetry > 0 || (retryContext?.emptyResponseRetry ?? 0) > 0;
    
    // 使用共享的 clientDisconnected 状态（如果是重试，继承上层的状态）
    let clientDisconnected = retryContext?.clientDisconnected || { value: false };
    if (!isRetry) {
        clientDisconnected = { value: false }; // 使用对象引用，便于在递归中共享状态
    }

    // 监听客户端断开连接事件（命名函数，便于移除）
    const onClientClose = () => {
        clientDisconnected.value = true;
        logger.info('[Stream] Client disconnected, stopping stream processing');
    };
    
    const onClientError = (err) => {
        clientDisconnected.value = true;
        logger.error('[Stream] Response stream error:', err.message);
    };
    
    // 只在首次请求时注册事件监听器（避免重试时重复注册）
    if (!isRetry) {
        res.on('close', onClientClose);
        res.on('error', onClientError);
    }

    // 只在首次请求时发送响应头，重试时跳过（响应头已发送）
    if (!isRetry) {
        await handleUnifiedResponse(res, '', true);
    }

    let hasToolCall = false;
    let hasMessageStop = false; // 跟踪是否已经发送过结束标志（message_stop / done）

    try {
        // fs.writeFile('request'+Date.now()+'.json', JSON.stringify(requestBody));
        // The service returns a stream in its native format (toProvider).
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
        requestBody.model = model;
        const nativeStream = await service.generateContentStream(model, requestBody);
        
        // 如果提供者内部发生了模型回退（如 Antigravity 自动降级），同步更新本地 model 变量
        // 这确保了后续的监控钩子和统计插件记录的是实际使用的模型
        if (requestBody.model && requestBody.model !== model) {
            model = requestBody.model;
        }
        const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
        // 为每个请求生成唯一 ID，用于在单例 converter 中隔离并发流状态
        const streamRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

        for await (const nativeChunk of nativeStream) {
            // 检查客户端是否已断开连接
            if (clientDisconnected.value) {
                logger.info('[Stream] Stopping iteration due to client disconnect');
                break;
            }
            
            // Extract text for logging purposes
            const chunkText = extractResponseText(nativeChunk, toProvider);
            if (chunkText && !Array.isArray(chunkText)) {
                fullResponseText += chunkText;
            }

            // Convert the complete chunk object to the client's format (fromProvider), if necessary.
            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model, streamRequestId)
                : nativeChunk;

            // 监控钩子：流式响应分块
            const hookRequestId = getPluginHookRequestId(CONFIG);
            if (hookRequestId) {
                try {
                    const pluginManager = getPluginManager();
                    await pluginManager.executeHook('onStreamChunk', {
                        nativeChunk,
                        chunkToSend,
                        fromProvider,
                        toProvider,
                        model,
                        requestId: hookRequestId
                    });
                } catch (e) {}
            }

            if (!chunkToSend) {
                continue;
            }

            // 处理 chunkToSend 可能是数组或对象的情况
            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

            for (const chunk of chunksToSend) {
                // 再次检查客户端连接状态
                if (clientDisconnected.value) {
                    break;
                }
                
                // [FIX] 跟踪工具调用并在结束时修正 finish_reason
                // OpenAI 格式
                if (chunk.choices?.[0]?.delta?.tool_calls || chunk.choices?.[0]?.finish_reason === 'tool_calls') {
                    hasToolCall = true;
                }
                // Claude 格式
                if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
                    hasToolCall = true;
                }
                if (chunk.type === 'message_delta' && (chunk.delta?.stop_reason === 'tool_use' || chunk.stop_reason === 'tool_use')) {
                    hasToolCall = true;
                }
                // Gemini 格式
                if (chunk.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
                    hasToolCall = true;
                }

                // 如果之前有工具调用，且当前 chunk 是正常结束，修正为 tool_calls / tool_use / FINISH_REASON_TOOL_CALLS
                if (hasToolCall && needsConversion) {
                    if (chunk.choices?.[0]?.finish_reason === 'stop') {
                        chunk.choices[0].finish_reason = 'tool_calls';
                    } else if (chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'end_turn') {
                        chunk.delta.stop_reason = 'tool_use';
                    } else if (chunk.candidates?.[0]?.finishReason === 'STOP' || chunk.candidates?.[0]?.finishReason === 'stop') {
                        // 修正 Gemini 原生格式的结束原因
                        chunk.candidates[0].finishReason = 'TOOL_CALLS';
                    }
                }

                // 防止重复发送结束标志
                // OpenAI: choices[].finish_reason
                // Claude: message_stop
                // OpenAI Responses: done
                // Gemini: candidates[].finishReason（如 STOP / MAX_TOKENS / SAFETY 等）
                if (
                    chunk?.choices?.some(choice => choice?.finish_reason) ||
                    chunk?.type === 'message_stop' ||
                    chunk?.type === 'done' ||
                    chunk?.candidates?.some(candidate => candidate?.finishReason)
                ) {
                    hasMessageStop = true;
                }

                if (addEvent) {
                    // fullOldResponseJson += chunk.type+"\n";
                    // fullResponseJson += chunk.type+"\n";
                    if (!clientDisconnected.value && !res.writableEnded) {
                        try {
                            res.write(`event: ${chunk.type}\n`);
                            anyDataSent = true;
                        } catch (writeErr) {
                            logger.error('[Stream] Failed to write event:', writeErr.message);
                            clientDisconnected.value = true;
                            break;
                        }
                    }
                    // logger.info(`event: ${chunk.type}\n`);
                }

                // fullOldResponseJson += JSON.stringify(chunk)+"\n";
                // fullResponseJson += JSON.stringify(chunk)+"\n\n";
                if (!clientDisconnected.value && !res.writableEnded) {
                    try {
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        anyDataSent = true;
                    } catch (writeErr) {
                        logger.error('[Stream] Failed to write data:', writeErr.message);
                        clientDisconnected.value = true;
                        break;
                    }
                }
                // logger.info(`data: ${JSON.stringify(chunk)}\n`);
            }
        }

        // 上游流正常结束但一个字节都没发给客户端：这是「静默空响应」，不能算成功。
        // 直接抛出通用空响应错误，交给下面的 isEmptyUpstreamResponse 分支做小额重试；
        // 同时避免把实际没有产出的凭证标记为健康。
        // 客户端主动断开属于正常情况，不在此列。
        if (!anyDataSent && !clientDisconnected.value) {
            throw createEmptyUpstreamResponseError(customName ? `${toProvider}/${customName}` : toProvider);
        }

        // 流式请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            const customNameDisplay = customName ? `, ${customName}` : '';
            logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful stream request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }

    }  catch (error) {
        logger.error('\n[Server] Error during stream processing:', error.stack);
        
        // 如果客户端已断开，不需要发送错误响应
        if (clientDisconnected.value) {
            logger.info('[Stream] Skipping error response due to client disconnect');
            responseClosed = true;
            return;
        }
        
        // 如果已经发送了数据（包括 metadata），不进行重试（避免响应数据损坏或顺序错误）
        if (anyDataSent) {
            logger.info(`[Stream Retry] Cannot retry: data already sent to client`);
            // 直接发送错误并结束
            const errorPayload = createStreamErrorResponse(error, fromProvider);
            if (!res.writableEnded) {
                try {
                    res.write(errorPayload);
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write error response:', writeErr.message);
                }
            }
            responseClosed = true;
            return;
        }

        // 上游空响应（无文本/工具调用/思考内容）：使用独立的小额重试预算，
        // 不占用凭证切换预算（CREDENTIAL_SWITCH_MAX_RETRIES），重试沿用同一份 requestBody，
        // 不会让历史/token 变大。预算耗尽后直接返回明确错误，不再静默放行空的 end_turn。
        // 任何 provider 只要抛出带 isEmptyUpstreamResponse 标记的错误都会走到这个分支（目前 Kiro 在用）。
        if (error.isEmptyUpstreamResponse) {
            const attemptsMade = retryContext?.emptyResponseRetry ?? 0;
            const outcome = await resolveEmptyUpstreamResponseRetry(CONFIG, model, attemptsMade, '[Stream Retry]', toProvider);

            if (outcome.retry) {
                const { result, emptyResponseRetry } = outcome;
                const newRetryContext = {
                    ...retryContext,
                    CONFIG,
                    currentRetry,
                    maxRetries,
                    emptyResponseRetry,
                    clientDisconnected,
                    anyDataSent
                };

                return await handleStreamRequest(
                    res,
                    result.service,
                    result.actualModel || model,
                    requestBody,
                    fromProvider,
                    result.actualProviderType || toProvider,
                    PROMPT_LOG_MODE,
                    PROMPT_LOG_FILENAME,
                    providerPoolManager,
                    result.uuid,
                    result.serviceConfig?.customName || customName,
                    newRetryContext
                );
            }

            const giveUpError = new Error(`${toProvider} upstream returned an empty response after ${attemptsMade} retr${attemptsMade === 1 ? 'y' : 'ies'} with the same request. Please try again, or /clear your session if this keeps happening.`);
            giveUpError.status = 502;
            const errorPayload = createStreamErrorResponse(giveUpError, fromProvider);
            if (!clientDisconnected.value && !res.writableEnded) {
                try {
                    res.write(errorPayload);
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write error response:', writeErr.message);
                }
            }
            responseClosed = true;
            return;
        }
        
        // 获取状态码（用于日志记录，不再用于判断是否重试）
        const status = getErrorStatusCode(error);
        
        // 检查是否应该跳过错误计数（用于 429/5xx 等需要直接切换凭证的情况）
        const skipErrorCount = error.skipErrorCount === true;
        // 检查是否应该切换凭证（用于 429/5xx/402/403 等情况）
        const shouldSwitchCredential = error.shouldSwitchCredential === true;
        
        // 检查凭证是否已在底层被标记为不健康（避免重复标记）
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
        if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
            logger.info(`[Provider Pool] Applying 429 cooldown for ${toProvider} (${pooluuid}) until ${rateLimitRecoveryTime.toISOString()}`);
            providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
                uuid: pooluuid
            }, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
            credentialMarkedUnhealthy = true;
        }
        
        // 如果底层未标记，且不跳过错误计数，则在此处标记
        if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
            // 400 报错码通常是请求参数问题，不记录为提供商错误
            if (error.response?.status === 400) {
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status 400 (client error)`);
            } else {
                logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to stream error (status: ${status || 'unknown'})`);
                // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
                providerPoolManager.markProviderUnhealthy(toProvider, {
                    uuid: pooluuid
                }, error.message);
                credentialMarkedUnhealthy = true;
            }
        }
        
        // 如果需要切换凭证（无论是否标记不健康），都设置标记以触发重试
        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true; // 触发下面的重试逻辑
        }
        
        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            // 增加10秒内的随机等待时间，避免所有请求同时切换凭证
            const randomDelay = Math.floor(Math.random() * 10000); // 0-10000毫秒
            logger.info(`[Stream Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));
            
            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                // 使用 acquireSlot: true 以占用新凭证的并发插槽
                const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true });
                
                if (result && result.service) {
                    logger.info(`[Stream Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);
                    
                    // 使用新服务重试
                    const newRetryContext = {
                        ...retryContext,
                        CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries,
                        clientDisconnected,  // 传递断开状态
                        anyDataSent          // 传递数据发送状态
                    };
                    
                    // 递归调用，使用新的服务
                    return await handleStreamRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        requestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid,
                        result.serviceConfig?.customName || customName,
                        newRetryContext
                    );
                } else {
                    logger.info(`[Stream Retry] No healthy credential available for retry.`);
                }
            } catch (retryError) {
                logger.error(`[Stream Retry] Failed to get alternative service:`, retryError.message);
            }
        }

        // 使用新方法创建符合 fromProvider 格式的流式错误响应
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        if (!clientDisconnected.value && !res.writableEnded) {
            try {
                res.write(errorPayload);
                res.end();
            } catch (writeErr) {
                logger.error('[Stream] Failed to write error response:', writeErr.message);
            }
        }
        responseClosed = true;
    } finally {
        // 释放并发插槽
        if (providerPoolManager && pooluuid) {
            providerPoolManager.releaseSlot(toProvider, pooluuid);
        }

        // 只在首次请求时移除事件监听器（避免重试时误删）
        if (!isRetry) {
            res.off('close', onClientClose);
            res.off('error', onClientError);
        }
        
        // 只在非重试或重试失败时才发送结束标记
        // 如果是重试成功，递归调用会处理结束标记
        if (!responseClosed && !clientDisconnected.value && !isRetry) {
            // 根据客户端协议发送相应的流式结束标记
            const clientProtocol = getProtocolPrefix(fromProvider);
            if (!res.writableEnded) {
                try {
                    if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI) {
                        if (!hasMessageStop) {
                            res.write('data: [DONE]\n\n');
                            hasMessageStop = true;
                        }
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
                        // OpenAI Responses 以 response.completed/response.incomplete（或 error）作为结束事件。
                        // 连接关闭即表示流结束；不要再追加 `event: done` + `data: {}`，否则会触发下游类型校验失败（AI_TypeValidationError）。
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
                        if (!hasMessageStop) {
                            res.write('event: message_stop\n');
                            res.write('data: {"type":"message_stop"}\n\n');
                            hasMessageStop = true;
                        }
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
                        if (!hasMessageStop) {
                            res.write('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
                            hasMessageStop = true;
                        }
                    }
                    res.end();
                } catch (writeErr) {
                    logger.error('[Stream] Failed to write completion marker:', writeErr.message);
                }
            }
        }
        
        // 只在首次请求时记录日志（避免重试时重复记录）
        if (!isRetry) {
            await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        }
        // fs.writeFile('oldResponseChunk'+Date.now()+'.json', fullOldResponseJson);
        // fs.writeFile('responseChunk'+Date.now()+'.json', fullResponseJson);
    }
}


export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
    // 重试上下文：包含 CONFIG 和重试计数
    // maxRetries: 凭证切换最大次数（跨凭证），默认 5 次
    const maxRetries = retryContext?.maxRetries ?? 5;
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG;
    
    try{
        // The service returns the response in its native format (toProvider).
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
        requestBody.model = model;
        // fs.writeFile('oldRequest'+Date.now()+'.json', JSON.stringify(requestBody));
        const nativeResponse = await service.generateContent(model, requestBody);
        
        // 如果提供者内部发生了模型回退（如 Antigravity 自动降级），同步更新本地 model 变量
        // 这确保了后续的监控钩子和统计插件记录的是实际使用的模型
        if (requestBody.model && requestBody.model !== model) {
            model = requestBody.model;
        }
        
        const responseText = extractResponseText(nativeResponse, toProvider);

        // Convert the response back to the client's format (fromProvider), if necessary.
        let clientResponse = nativeResponse;
        if (needsConversion) {
            logger.info(`[Response Convert] Converting response from ${toProvider} to ${fromProvider}`);
            clientResponse = convertData(nativeResponse, 'response', toProvider, fromProvider, model);
        }

        // 监控钩子：非流式响应
        const hookRequestId = getPluginHookRequestId(CONFIG);
        if (hookRequestId) {
            try {
                const pluginManager = getPluginManager();
                await pluginManager.executeHook('onUnaryResponse', {
                    nativeResponse,
                    clientResponse,
                    fromProvider,
                    toProvider,
                    model,
                    requestId: hookRequestId
                });
            } catch (e) {}
        }

        //logger.info(`[Response] Sending response to client: ${JSON.stringify(clientResponse)}`);
        await handleUnifiedResponse(res, JSON.stringify(clientResponse), false);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        // fs.writeFile('oldResponse'+Date.now()+'.json', JSON.stringify(clientResponse));
        
        // 一元请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && pooluuid) {
            const customNameDisplay = customName ? `, ${customName}` : '';
            logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful unary request`);
            providerPoolManager.markProviderHealthy(toProvider, {
                uuid: pooluuid
            });
        }
    } catch (error) {
        logger.error('\n[Server] Error during unary processing:', error.stack);

        // 上游空响应（无文本/工具调用/思考内容）：使用独立的小额重试预算，
        // 不占用凭证切换预算（CREDENTIAL_SWITCH_MAX_RETRIES），重试沿用同一份 requestBody，
        // 不会让历史/token 变大。预算耗尽后直接返回明确错误，不再静默放行空响应。
        // 任何 provider 只要抛出带 isEmptyUpstreamResponse 标记的错误都会走到这个分支（目前 Kiro 在用）。
        if (error.isEmptyUpstreamResponse) {
            const attemptsMade = retryContext?.emptyResponseRetry ?? 0;
            const outcome = await resolveEmptyUpstreamResponseRetry(CONFIG, model, attemptsMade, '[Unary Retry]', toProvider);

            if (outcome.retry) {
                const { result, emptyResponseRetry } = outcome;
                const newRetryContext = {
                    ...retryContext,
                    CONFIG,
                    currentRetry,
                    maxRetries,
                    emptyResponseRetry
                };

                return await handleUnaryRequest(
                    res,
                    result.service,
                    result.actualModel || model,
                    requestBody,
                    fromProvider,
                    result.actualProviderType || toProvider,
                    PROMPT_LOG_MODE,
                    PROMPT_LOG_FILENAME,
                    providerPoolManager,
                    result.uuid,
                    result.serviceConfig?.customName || customName,
                    newRetryContext
                );
            }

            const giveUpError = new Error(`${toProvider} upstream returned an empty response after ${attemptsMade} retr${attemptsMade === 1 ? 'y' : 'ies'} with the same request. Please try again, or /clear your session if this keeps happening.`);
            giveUpError.status = 502;
            const errorResponse = createErrorResponse(giveUpError, fromProvider);
            await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, 502);
            return;
        }
        
        // 获取状态码（用于日志记录，不再用于判断是否重试）
        const status = getErrorStatusCode(error);
        
        // 检查是否应该跳过错误计数（用于 429/5xx 等需要直接切换凭证的情况）
        const skipErrorCount = error.skipErrorCount === true;
        // 检查是否应该切换凭证（用于 429/5xx/402/403 等情况）
        const shouldSwitchCredential = error.shouldSwitchCredential === true;
        
        // 检查凭证是否已在底层被标记为不健康（避免重复标记）
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        const rateLimitRecoveryTime = getRateLimitCooldownRecoveryTime(error, CONFIG);
        if (rateLimitRecoveryTime && providerPoolManager && pooluuid) {
            logger.info(`[Provider Pool] Applying 429 cooldown for ${toProvider} (${pooluuid}) until ${rateLimitRecoveryTime.toISOString()}`);
            providerPoolManager.markProviderUnhealthyWithRecoveryTime(toProvider, {
                uuid: pooluuid
            }, '429 Too Many Requests - short cooldown', rateLimitRecoveryTime);
            credentialMarkedUnhealthy = true;
        }
        
        // 如果底层未标记，且不跳过错误计数，则在此处标记
        if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
            // 400 报错码通常是请求参数问题，不记录为提供商错误
            if (error.response?.status === 400) {
                logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status 400 (client error)`);
            } else {
                logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to unary error (status: ${status || 'unknown'})`);
                // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
                providerPoolManager.markProviderUnhealthy(toProvider, {
                    uuid: pooluuid
                }, error.message);
                credentialMarkedUnhealthy = true;
            }
        }
        
        // 如果需要切换凭证（无论是否标记不健康），都设置标记以触发重试
        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true; // 触发下面的重试逻辑
        }
        
        // 凭证已被标记为不健康后，尝试切换到新凭证重试
        // 不再依赖状态码判断，只要凭证被标记不健康且可以重试，就尝试切换
        if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
            // 增加10秒内的随机等待时间，避免所有请求同时切换凭证
            const randomDelay = Math.floor(Math.random() * 10000); // 0-10000毫秒
            logger.info(`[Unary Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));
            
            try {
                // 动态导入以避免循环依赖
                const { getApiServiceWithFallback } = await import('../services/service-manager.js');
                // 使用 acquireSlot: true 以占用新凭证的并发插槽
                const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: true });
                
                if (result && result.service) {
                    logger.info(`[Unary Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);
                    
                    // 使用新服务重试
                    const newRetryContext = {
                        ...retryContext,
                        CONFIG,
                        currentRetry: currentRetry + 1,
                        maxRetries
                    };
                    
                    // 递归调用，使用新的服务
                    return await handleUnaryRequest(
                        res,
                        result.service,
                        result.actualModel || model,
                        requestBody,
                        fromProvider,
                        result.actualProviderType || toProvider,
                        PROMPT_LOG_MODE,
                        PROMPT_LOG_FILENAME,
                        providerPoolManager,
                        result.uuid,
                        result.serviceConfig?.customName || customName,
                        newRetryContext
                    );
                } else {
                    logger.info(`[Unary Retry] No healthy credential available for retry.`);
                }
            } catch (retryError) {
                logger.error(`[Unary Retry] Failed to get alternative service:`, retryError.message);
            }
        }

        // 使用新方法创建符合 fromProvider 格式的错误响应
        const errorResponse = createErrorResponse(error, fromProvider);
        const rawStatusCode = error.status || error.code || (error.response && error.response.status) || 500;
        const statusCode = ensureValidStatusCode(rawStatusCode);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false, statusCode);
    } finally {
        // 确保在请求结束或出错时释放插槽
        if (providerPoolManager && pooluuid) {
            providerPoolManager.releaseSlot(toProvider, pooluuid);
        }
    }
}

/**
 * Handles requests for listing available models. It fetches models from the
 * service, transforms them to the format expected by the client (OpenAI, Claude, etc.),
 * and sends the JSON response.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {Object} service - The API service instance.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_MODEL_LIST).
 * @param {Object} CONFIG - The server configuration object.
 * @param {Object} providerPoolManager - The provider pool manager instance.
 * @param {string} pooluuid - The selected provider UUID.
 */
export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid) {
    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];

    try {        
        if (!fromProvider) {
            throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
        }

        let clientModelList;

        const buildConfiguredModelListResponse = (models, providerType, listEndpointType) => {
            if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
                return {
                    object: 'list',
                    data: models.map(modelId => {
                        const customConfig = getCustomModelConfig(modelId, providerType);
                        const modelResponse = {
                            id: modelId,
                            object: 'model',
                            created: Math.floor(Date.now() / 1000),
                            owned_by: providerType
                        };
                        
                        // 注入自定义元数据
                        if (customConfig) {
                            if (customConfig.contextLength) modelResponse.context_length = customConfig.contextLength;
                            if (customConfig.maxTokens) modelResponse.max_tokens = customConfig.maxTokens;
                            if (customConfig.description) modelResponse.description = customConfig.description;
                        }
                        
                        return modelResponse;
                    })
                };
            }

            if (listEndpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
                return {
                    models: models.map(modelId => {
                        const customConfig = getCustomModelConfig(modelId, providerType);
                        const modelResponse = {
                            name: `models/${modelId}`,
                            baseModelId: modelId,
                            version: 'v1',
                            displayName: modelId,
                            description: `Model ${modelId} provided by ${providerType}`,
                            supportedGenerationMethods: ['generateContent', 'countTokens']
                        };
                        
                        if (customConfig) {
                            if (customConfig.contextLength) modelResponse.inputTokenLimit = customConfig.contextLength;
                            if (customConfig.maxTokens) modelResponse.outputTokenLimit = customConfig.maxTokens;
                            if (customConfig.description) modelResponse.description = customConfig.description;
                        }
                        
                        return modelResponse;
                    })
                };
            }

            return { data: [] };
        };

        // --- 核心逻辑: auto 路由模式下的模型聚合 ---
        if (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO && providerPoolManager) {
            logger.info(`[ModelList] Aggregating models for 'auto' mode...`);
            clientModelList = await providerPoolManager.getAllAvailableModels(endpointType);
        } else {
            // --- 单提供商逻辑 ---
            const toProvider = CONFIG.MODEL_PROVIDER;
            const pooledSupportedModels = getConfiguredSupportedModelsFromPool(providerPoolManager, toProvider);
            const configuredSupportedModels = pooledSupportedModels.length > 0
                ? pooledSupportedModels
                : getConfiguredSupportedModels(toProvider, CONFIG);

            if (usesManagedModelList(toProvider) && configuredSupportedModels.length > 0) {
                logger.info(`[ModelList] Returning configured supported models for ${toProvider}: ${configuredSupportedModels.join(', ')}`);
                clientModelList = buildConfiguredModelListResponse(configuredSupportedModels, toProvider, endpointType);
            } else {

            // service 可能未在上层预先注入（例如仅改了路径 provider 前缀），这里兜底获取
            let resolvedService = service;
            if (!resolvedService) {
                const { getApiService } = await import('../services/service-manager.js');
                resolvedService = await getApiService(CONFIG, null, { skipUsageCount: true });
            }

            if (!resolvedService || typeof resolvedService.listModels !== 'function') {
                throw new Error(`[ModelList] Service adapter is unavailable or does not implement listModels() for provider: ${toProvider}`);
            }

            // 1. Get the model list in the backend's native format.
            const nativeModelList = await resolvedService.listModels();

            // 2. Convert the model list to the client's expected format, if necessary.
            clientModelList = nativeModelList;
            if (!getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider))) {
                logger.info(`[ModelList Convert] Converting model list from ${toProvider} to ${fromProvider}`);
                clientModelList = convertData(nativeModelList, 'modelList', toProvider, fromProvider);
            } else {
                logger.info(`[ModelList Convert] Model list format matches. No conversion needed.`);
            }
            }

            const customEntries = getCustomModelEntriesForProvider(CONFIG, toProvider);
            clientModelList = appendCustomModelsToModelList(clientModelList, customEntries, toProvider, endpointType);
        }

        if (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO) {
            const customEntries = getCustomModelEntriesForProvider(CONFIG, null, { prefixProvider: true });
            clientModelList = appendCustomModelsToModelList(clientModelList, customEntries, MODEL_PROVIDER.AUTO, endpointType);
        }

        // logger.info(`[ModelList Response] Sending model list to client: ${JSON.stringify(clientModelList)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientModelList));
    } catch (error) {
        logger.error('\n[Server] Error during model list processing:', error.stack);
        // if (providerPoolManager && pooluuid && CONFIG.MODEL_PROVIDER !== MODEL_PROVIDER.AUTO) {
        //     // 如果是号池模式（且非 auto 模式），并且请求处理失败，则标记当前使用的提供者为不健康
        //     providerPoolManager.markProviderUnhealthy(CONFIG.MODEL_PROVIDER, {
        //         uuid: pooluuid
        //     }, error.message);
        // }
        handleError(res, error, CONFIG.MODEL_PROVIDER, fromProvider);
    }
}


/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the internal Gemini format,
 * logging, and dispatching to the appropriate stream or unary handler.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_CHAT).
 * @param {Object} CONFIG - The server configuration object.
 * @param {string} PROMPT_LOG_FILENAME - The prompt log filename.
 */
export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, requestPath = null) {
    const originalRequestBody = await getRequestBody(req, { maxBytes: CONFIG.REQUEST_BODY_MAX_BYTES });

    if (!originalRequestBody) {
        throw new Error("Request body is missing for content generation.");
    }

    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
        [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];
    // 使用实际的提供商类型（可能是 fallback 后的类型）
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;
    
    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // 2. Extract model and determine if the request is for streaming.
    let { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }
    
    // 2.1. 多候选模型路由：从 customModels + 直接支持中，按节点优先级选出最优路径
    const allCustomConfigs = getAllCustomModelConfigs(model, CONFIG.MODEL_PROVIDER);
    let selectedRouting = null;
    let selectedCustomConfig = null;
    let routeResolved = false;

    if (allCustomConfigs.length > 0 && providerPoolManager) {
        // 收集所有健康候选及其对应节点的最高优先级
        const candidates = [];
        for (const cfg of allCustomConfigs) {
            const routing = resolveCustomModelRouting(model, CONFIG.MODEL_PROVIDER, cfg);
            const targetProvider = routing.actualProvider;
            const targetModel = routing.actualModel;
            const priority = providerPoolManager.getBestPriorityForModel(targetProvider, targetModel);

            if (priority === null) {
                logger.info(`[Custom Model] Candidate '${cfg.id || cfg.alias}' -> ${targetProvider}:${targetModel} skipped (no healthy provider)`);
                continue;
            }
            candidates.push({ routing, cfg, priority, isDirect: false });
        }

        // 直接支持的 provider 也参与优先级比较
        const directPriority = providerPoolManager.getBestPriorityForModel(CONFIG.MODEL_PROVIDER, model);
        if (directPriority !== null) {
            candidates.push({ routing: null, cfg: null, priority: directPriority, isDirect: true });
        }

        // 按 priority 升序排序（数值越小优先级越高）
        if (candidates.length > 0) {
            candidates.sort((a, b) => a.priority - b.priority);
            const best = candidates[0];
            selectedRouting = best.routing;
            selectedCustomConfig = best.cfg;
            routeResolved = true;
            if (!best.isDirect) {
                logger.info(`[Custom Model] Selected '${best.cfg.id || best.cfg.alias}' -> ${best.routing.actualProvider}:${best.routing.actualModel} (priority: ${best.priority})`);
            } else {
                logger.info(`[Custom Model] Selected direct support: ${CONFIG.MODEL_PROVIDER}:${model} (priority: ${best.priority})`);
            }
        }
    }

    // 所有候选都不可用时，检查 currentProvider 直接支持该 model（兜底）
    if (!routeResolved && providerPoolManager) {
        if (providerPoolManager.hasHealthyProviderForModel(CONFIG.MODEL_PROVIDER, model)) {
            selectedRouting = null;
            selectedCustomConfig = null;
            routeResolved = true;
            logger.info(`[Custom Model] Fallback to direct support: ${CONFIG.MODEL_PROVIDER}:${model}`);
        }
    }

    // 非号池模式保持原有行为：取第一个 customModel
    if (!providerPoolManager && allCustomConfigs.length > 0) {
        selectedCustomConfig = allCustomConfigs[0];
        selectedRouting = resolveCustomModelRouting(model, CONFIG.MODEL_PROVIDER, selectedCustomConfig);
    }

    // 应用选中的路由
    CONFIG.customConfig = selectedCustomConfig || null;
    if (selectedRouting && selectedRouting.isCustomModel) {
        logger.info(`[Custom Model] Resolved '${model}' to actual model '${selectedRouting.actualModel}'`);

        if (selectedRouting.actualProvider && selectedRouting.actualProvider !== CONFIG.MODEL_PROVIDER) {
            CONFIG.MODEL_PROVIDER = selectedRouting.actualProvider;
            toProvider = selectedRouting.actualProvider;
            logger.info(`[Custom Model] Switched provider to '${CONFIG.MODEL_PROVIDER}' based on custom model config`);
        }

        if (selectedRouting.actualModel) {
            model = selectedRouting.actualModel;
        }
    }

    logger.info(`[Content Generation] Model: ${model}, Stream: ${isStream}`);

    let actualCustomName = CONFIG.customName;

    // 2.5. 根据模型选择服务适配器：
    // - service 缺失时（例如上游未预先注入）进行兜底选择
    // - 使用号池/AUTO 时按模型重选并支持 fallback
    // 注意：仅在号池场景开启 acquireSlot，占用并发名额或进入队列
    const shouldSelectByPool = providerPoolManager && (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO || (CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]));
    if (!service || shouldSelectByPool) {
        const { getApiServiceWithFallback } = await import('../services/service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model, { acquireSlot: shouldSelectByPool });

        service = result.service;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;
        actualCustomName = result.serviceConfig?.customName || CONFIG.customName;

        // 如果发生了模型级别的 fallback，需要更新请求使用的模型
        if (result.actualModel && result.actualModel !== model) {
            logger.info(`[Content Generation] Model Fallback: ${model} -> ${result.actualModel}`);
            model = result.actualModel;
        }

        if (result.isFallback) {
            logger.info(`[Content Generation] Fallback activated: ${CONFIG.MODEL_PROVIDER} -> ${toProvider} (uuid: ${actualUuid})`);
        } else {
            logger.info(`[Content Generation] Selected service adapter based on model: ${model}`);
        }
    }

    // 1. Convert request body from client format to backend format, if necessary.
    // 使用浅拷贝以避免直接变异 originalRequestBody，保持原始数据的纯净性以供后续钩子使用
    let processedRequestBody = { ...originalRequestBody };

    // 将 _monitorRequestId 注入到 requestBody 中，以便在 service 内部访问
    if (CONFIG._monitorRequestId) {
        processedRequestBody._monitorRequestId = CONFIG._monitorRequestId;
    }
    
    // 将 requestBaseUrl 注入到 requestBody 中，以便在转换器中使用
    if (CONFIG.requestBaseUrl) {
        processedRequestBody._requestBaseUrl = CONFIG.requestBaseUrl;
    }

    // fs.writeFile('originalRequestBody'+Date.now()+'.json', JSON.stringify(originalRequestBody));
    if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)) {
        logger.info(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
        const preConvertBody = processedRequestBody;
        processedRequestBody = convertData(preConvertBody, 'request', fromProvider, toProvider);

        // 保持以 _ 开头的内部属性（如 _monitorRequestId, _requestBaseUrl）
        Object.keys(preConvertBody).forEach(key => {
            if (key.startsWith('_') && processedRequestBody[key] === undefined) {
                processedRequestBody[key] = preConvertBody[key];
            }
        });
    } else {
        logger.info(`[Request Convert] Request format matches backend provider. No conversion needed.`);
    }
    
    // 为 forward provider 添加原始请求路径作为 endpoint
    if (requestPath && getProtocolPrefix(toProvider) === MODEL_PROTOCOL_PREFIX.FORWARD) {
        logger.info(`[Forward API] Request path: ${requestPath}`);
        processedRequestBody.endpoint = requestPath;
    }

    // 3. Apply system prompt from file if configured.
    processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
    await _manageSystemPrompt(processedRequestBody, toProvider);

    // 4. Log the incoming prompt (after potential conversion to the backend's format).
    const promptText = extractPromptText(processedRequestBody, toProvider);
    
    // 4.1. 应用自定义模型参数 (温度、最大长度等)
    if (selectedCustomConfig) {
        _applyCustomModelParameters(processedRequestBody, selectedCustomConfig, toProvider);
    }

    await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    
    // 5. Call the appropriate stream or unary handler, passing the provider info.
    // 创建重试上下文，包含 CONFIG 以便在认证错误时切换凭证重试
    // 凭证切换重试次数（默认 5），可在配置中自定义更大的值
    // 注意：这与底层的 429/5xx 重试（REQUEST_MAX_RETRIES）是不同层次的重试机制
    // - 底层重试：同一凭证遇到 429/5xx 时的重试
    // - 凭证切换重试：凭证被标记不健康后切换到其他凭证
    // 当没有不同的健康凭证可用时，重试会自动停止
    const credentialSwitchMaxRetries = CONFIG.CREDENTIAL_SWITCH_MAX_RETRIES || 5;
    const retryContext = { CONFIG, currentRetry: 0, maxRetries: credentialSwitchMaxRetries };
    
    if (isStream) {
        await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
    } else {
        await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
    }

    // 同步更新模型名称（如果处理器内部或提供者发生了回退）
    if (processedRequestBody.model && processedRequestBody.model !== model) {
        model = processedRequestBody.model;
    }

    // 执行插件钩子：内容生成后
    try {
        const pluginManager = getPluginManager();
        await pluginManager.executeHook('onContentGenerated', {
            ...CONFIG,
            originalRequestBody,
            processedRequestBody,
            fromProvider,
            toProvider,
            model,
            isStream
        });
    } catch (e) { /* 静默失败，不影响主流程 */ }
}

/**
 * Helper function to extract model and stream information from the request.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {Object} requestBody The parsed request body.
 * @param {string} fromProvider The type of endpoint being called.
 * @returns {{model: string, isStream: boolean}} An object containing the model name and stream status.
 */
function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

async function _applySystemPromptFromFile(config, requestBody, toProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(toProvider));
    return strategy.applySystemPromptFromFile(config, requestBody);
}

export async function _manageSystemPrompt(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    await strategy.manageSystemPrompt(requestBody);
}

// Helper functions for content extraction and conversion (from convert.js, but needed here)
export function extractResponseText(response, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractPromptText(requestBody);
}

/**
 * 应用自定义模型参数到请求体
 * @param {Object} requestBody - 处理后的请求体
 * @param {Object} customConfig - 自定义模型配置
 * @param {string} provider - 目标提供商
 */
function _applyCustomModelParameters(requestBody, customConfig, provider) {
    const protocol = getProtocolPrefix(provider);
    const hasConfiguredValue = (value) => value !== undefined && value !== null;

    // 参数映射表
    const mappings = {
        temperature: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'temperature',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.temperature'
        },
        maxTokens: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'max_tokens',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'max_output_tokens',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'max_tokens',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.maxOutputTokens'
        },
        topP: {
            [MODEL_PROTOCOL_PREFIX.OPENAI]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.CLAUDE]: 'top_p',
            [MODEL_PROTOCOL_PREFIX.GEMINI]: 'generationConfig.topP'
        }
    };

    // 处理嵌套路径 (例如 generationConfig.temperature)
    const setNestedProperty = (obj, path, value) => {
        const parts = path.split('.');
        let curr = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!curr[parts[i]]) curr[parts[i]] = {};
            curr = curr[parts[i]];
        }
        curr[parts[parts.length - 1]] = value;
        logger.debug(`[Custom Model] Applied nested parameter ${path}=${value}`);
    };

    // 应用配置
    Object.keys(mappings).forEach(key => {
        const value = customConfig[key];
        const targetPath = mappings[key][protocol];
        
        if (hasConfiguredValue(value) && targetPath) {
            if (targetPath.includes('.')) {
                setNestedProperty(requestBody, targetPath, value);
            } else {
                requestBody[targetPath] = value;
                logger.debug(`[Custom Model] Applied ${key}=${value} to request (${targetPath})`);
            }
        }
    });

    // 处理特殊的 contextLength (通常不直接发给 API，但可能被某些插件使用)
    // if (hasConfiguredValue(customConfig.contextLength)) {
    //     requestBody._contextLength = customConfig.contextLength;
    // }
}

export function handleError(res, error, provider = null, fromProvider = null, req = null) {
    const rawStatusCode = error.response?.status || error.statusCode || error.status || error.code || 500;
    const statusCode = ensureValidStatusCode(rawStatusCode);
    
    // 如果没有提供 fromProvider 但提供了 req，尝试从路径推断
    if (!fromProvider && req && req.url) {
        if (req.url.includes('/v1/messages')) fromProvider = MODEL_PROTOCOL_PREFIX.CLAUDE;
        else if (req.url.includes('/v1/chat/completions')) fromProvider = MODEL_PROTOCOL_PREFIX.OPENAI;
        else if (req.url.includes('/v1beta/models')) fromProvider = MODEL_PROTOCOL_PREFIX.GEMINI;
    }

    // 如果指定了客户端协议，则使用 createErrorResponse 创建符合该协议的错误响应
    if (fromProvider) {
        const errorResponse = createErrorResponse(error, fromProvider);
        if (!res.headersSent) {
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify(errorResponse));
        return;
    }

    const hasOriginalMessage = error.message && error.message.trim() !== '';
    let errorMessage = error.message;
    let suggestions = [];

    // 根据提供商获取适配的错误信息和建议
    const providerSuggestions = _getProviderSpecificSuggestions(statusCode, provider);
    
    // Provide detailed information and suggestions for different error types
    switch (statusCode) {
        case 401:
            errorMessage = 'Authentication failed. Please check your credentials.';
            suggestions = providerSuggestions.auth;
            break;
        case 403:
            errorMessage = 'Access forbidden. Insufficient permissions.';
            suggestions = providerSuggestions.permission;
            break;
        case 429:
            errorMessage = 'Too many requests. Rate limit exceeded.';
            suggestions = providerSuggestions.rateLimit;
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            errorMessage = 'Server error occurred. This is usually temporary.';
            suggestions = providerSuggestions.serverError;
            break;
        default:
            if (statusCode >= 400 && statusCode < 500) {
                errorMessage = `Client error (${statusCode}): ${error.message}`;
                suggestions = providerSuggestions.clientError;
            } else if (statusCode >= 500) {
                errorMessage = `Server error (${statusCode}): ${error.message}`;
                suggestions = providerSuggestions.serverError;
            }
    }

    errorMessage = hasOriginalMessage ? error.message.trim() : errorMessage;
    logger.error(`\n[Server] Request failed (${statusCode}): ${errorMessage}`);
    if (suggestions.length > 0) {
        logger.error('[Server] Suggestions:');
        suggestions.forEach((suggestion, index) => {
            logger.error(`  ${index + 1}. ${suggestion}`);
        });
    }
    logger.error('[Server] Full error details:', error.stack);

    // 检查响应流是否已关闭或结束
    if (res.writableEnded || res.destroyed) {
        logger.warn('[Server] Response already ended or destroyed, skipping error response');
        return;
    }

    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    }

    const errorPayload = {
        error: {
            message: errorMessage,
            code: statusCode,
            suggestions: suggestions,
            details: error.response?.data
        }
    };
    
    try {
        res.end(JSON.stringify(errorPayload));
    } catch (writeError) {
        logger.error('[Server] Failed to write error response:', writeError.message);
    }
}

/**
 * 根据提供商类型获取适配的错误建议
 * @param {number} statusCode - HTTP 状态码
 * @param {string|null} provider - 提供商类型
 * @returns {Object} 包含各类错误建议的对象
 */
function _getProviderSpecificSuggestions(statusCode, provider) {
    const protocolPrefix = provider ? getProtocolPrefix(provider) : null;
    
    // 默认/通用建议
    const defaultSuggestions = {
        auth: [
            'Verify your API key or credentials are valid',
            'Check if your credentials have expired',
            'Ensure the API key has the necessary permissions'
        ],
        permission: [
            'Check if your account has the necessary permissions',
            'Verify the API endpoint is accessible with your credentials',
            'Contact your administrator if permissions are restricted'
        ],
        rateLimit: [
            'The request has been automatically retried with exponential backoff',
            'If the issue persists, try reducing the request frequency',
            'Consider upgrading your API quota if available'
        ],
        serverError: [
            'The request has been automatically retried',
            'If the issue persists, try again in a few minutes',
            'Check the service status page for outages'
        ],
        clientError: [
            'Check your request format and parameters',
            'Verify the model name is correct',
            'Ensure all required fields are provided'
        ]
    };
    
    // 根据提供商返回特定建议
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            return {
                auth: [
                    'Verify your OAuth credentials are valid',
                    'Try re-authenticating by deleting the credentials file',
                    'Check if your Google Cloud project has the necessary permissions'
                ],
                permission: [
                    'Ensure your Google Cloud project has the Gemini API enabled',
                    'Check if your account has the necessary permissions',
                    'Verify the project ID is correct'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Google Cloud API quota'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Google Cloud status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Gemini model',
                    'Ensure all required fields are provided'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.OPENAI:
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            return {
                auth: [
                    'Verify your OpenAI API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the API key is correctly formatted (starts with sk-)'
                ],
                permission: [
                    'Check if your OpenAI account has access to the requested model',
                    'Verify your organization settings allow this operation',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your OpenAI usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check OpenAI status page (status.openai.com) for outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid OpenAI model',
                    'Ensure the message format is correct (role and content fields)'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            return {
                auth: [
                    'Verify your Anthropic API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the x-api-key header is correctly set'
                ],
                permission: [
                    'Check if your Anthropic account has access to the requested model',
                    'Verify your account is in good standing',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Anthropic usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Anthropic status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Claude model',
                    'Ensure the message format follows Anthropic API specifications'
                ]
            };
            
        default:
            return defaultSuggestions;
    }
}

/**
 * 从请求体中提取系统提示词。
 * @param {Object} requestBody - 请求体对象。
 * @param {string} provider - 提供商类型（'openai', 'gemini', 'claude'）。
 * @returns {string} 提取到的系统提示词字符串。
 */
export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            const openaiSystemMessage = requestBody.messages?.find(m => m.role === 'system' || m.role === 'developer');
            if (openaiSystemMessage?.content) {
                incomingSystemText = openaiSystemMessage.content;
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system message
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    incomingSystemText = userMessage.content;
                }
            }
            if (typeof incomingSystemText === 'object' && incomingSystemText !== null) {
                if (Array.isArray(incomingSystemText)) {
                    incomingSystemText = incomingSystemText
                        .map(item => (typeof item === 'string' ? item : item.text || JSON.stringify(item)))
                        .join('\n');
                } else {
                    incomingSystemText = JSON.stringify(incomingSystemText);
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
            if (geminiSystemInstruction?.parts) {
                incomingSystemText = geminiSystemInstruction.parts
                    .filter(p => p?.text)
                    .map(p => p.text)
                    .join('\n');
            } else if (requestBody.contents?.length > 0) {
                // Fallback to first user content if no system instruction
                const userContent = requestBody.contents[0];
                if (userContent?.parts) {
                    incomingSystemText = userContent.parts
                        .filter(p => p?.text)
                        .map(p => p.text)
                        .join('\n');
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system property
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    if (Array.isArray(userMessage.content)) {
                        incomingSystemText = userMessage.content.map(block => block.text).join('');
                    } else {
                        incomingSystemText = userMessage.content;
                    }
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES: {
            if (typeof requestBody.instructions === 'string') {
                incomingSystemText = requestBody.instructions;
            } else if (requestBody.instructions) {
                incomingSystemText = JSON.stringify(requestBody.instructions);
            } else if (Array.isArray(requestBody.input)) {
                const responsesSystemItem = requestBody.input.find(item =>
                    item?.role === 'system' ||
                    item?.role === 'developer' ||
                    item?.type === 'system' ||
                    item?.type === 'developer' ||
                    (item?.type === 'message' && (item?.role === 'system' || item?.role === 'developer'))
                );

                const content = responsesSystemItem?.content;
                if (typeof content === 'string') {
                    incomingSystemText = content;
                } else if (Array.isArray(content)) {
                    incomingSystemText = content
                        .map(part => typeof part === 'string' ? part : (part?.text || part?.content || JSON.stringify(part)))
                        .join('\n');
                } else if (content) {
                    incomingSystemText = JSON.stringify(content);
                }
            }
            break;
        }
        default:
            logger.warn(`[System Prompt] Unknown provider: ${provider}`);
            break;
    }
    return incomingSystemText;
}

/**
 * Generates an MD5 hash for a given object by first converting it to a JSON string.
 * @param {object} obj - The object to hash.
 * @returns {string} The MD5 hash of the object's JSON string representation.
 */
export function getMD5Hash(obj) {
    const jsonString = JSON.stringify(obj);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}

/**
 * 将日期转换为系统本地时间格式
 * @param {string|number} dateInput - 日期字符串或时间戳
 * @returns {string} 格式化后的时间字符串
 */
export function formatToLocal(dateInput) {
    try {
        if (!dateInput) return '--';
        // 处理数值型时间戳（秒 -> 毫秒）
        let finalInput = dateInput;
        if (typeof dateInput === 'number' && dateInput < 10000000000) {
            finalInput = dateInput * 1000;
        }
        const date = new Date(finalInput);
        if (isNaN(date.getTime())) return '--';
        
        return date.toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).replace(/\//g, '-');
    } catch (e) {
        return '--';
    }
}


/**
 * 创建符合 fromProvider 格式的错误响应（非流式）
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {Object} 格式化的错误响应对象
 */
function createErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const rawStatusCode = error.status || error.code || 500;
    const statusCode = ensureValidStatusCode(rawStatusCode);
    const errorMessage = error.message || "An error occurred during processing.";
    
    // 根据 HTTP 状态码映射错误类型
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };
    
    // 根据 HTTP 状态码映射 Gemini 的 status
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };
    
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 非流式错误格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)  // OpenAI 使用 code 字段作为核心判断
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API 非流式错误格式
            return {
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 非流式错误格式（外层有 type 标记）
            return {
                type: "error",  // 核心区分标记
                error: {
                    type: getErrorType(statusCode),  // Claude 使用 error.type 作为核心判断
                    message: errorMessage
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini 非流式错误格式（遵循 Google Cloud 标准）
            return {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)  // Gemini 使用 status 作为核心判断
                }
            };
            
        default:
            // 默认使用 OpenAI 格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)
                }
            };
    }
}

/**
 * 创建符合 fromProvider 格式的流式错误响应
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {string} 格式化的流式错误响应字符串
 */
function createStreamErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const rawStatusCode = error.status || error.code || 500;
    const statusCode = ensureValidStatusCode(rawStatusCode);
    const errorMessage = error.message || "An error occurred during streaming.";
    
    // 根据 HTTP 状态码映射错误类型
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };
    
    // 根据 HTTP 状态码映射 Gemini 的 status
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };
    
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 流式错误格式（SSE data 块）
            const openaiError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(openaiError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API 流式错误格式（SSE event + data）
            const responsesError = {
                id: `resp_${Date.now()}`,
                object: "error",
                created: Math.floor(Date.now() / 1000),
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            return `event: error\ndata: ${JSON.stringify(responsesError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 流式错误格式（SSE event + data）
            const claudeError = {
                type: "error",
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage
                }
            };
            return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini 流式错误格式
            // 注意：虽然 Gemini 原生使用 JSON 数组，但在我们的实现中已经转换为 SSE 格式
            // 所以这里也需要使用 data: 前缀，保持与正常流式响应一致
            const geminiError = {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)
                }
            };
            return `data: ${JSON.stringify(geminiError)}\n\n`;
            
        default:
            // 默认使用 OpenAI SSE 格式
            const defaultError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(defaultError)}\n\n`;
    }
}
