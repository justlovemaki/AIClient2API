import { atomicWriteFile } from '../../utils/file-lock.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { getProviderModels } from '../provider-models.js';
import { 
    countTextTokens as countTextTokensUtil, 
    estimateInputTokens as estimateInputTokensUtil, 
    countTokensAnthropic as countTokensUtil,
    processContent as processContentUtil,
    getContentText as getContentTextUtil
} from '../../utils/token-utils.js';
import { configureAxiosProxy, configureTLSSidecar, isTLSSidecarEnabledForProvider } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER, formatExpiryLog, getNormalizedErrorResponseText, buildHttpErrorReason, normalizeProviderErrorMessage, createEmptyUpstreamResponseError } from '../../utils/common.js';
import { getProviderPoolManager } from '../../services/service-manager.js';

const KIRO_THINKING = {
    MIN_BUDGET_TOKENS: 1024,
    MAX_BUDGET_TOKENS: 24576,
    DEFAULT_BUDGET_TOKENS: 20000,
    START_TAG: '<thinking>',
    END_TAG: '</thinking>',
    MODE_TAG: '<thinking_mode>',
    MAX_LEN_TAG: '<max_thinking_length>',
    EFFORT_TAG: '<thinking_effort>',
};

const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
    BASE_RUNTIME_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
    DEFAULT_MODEL_NAME: 'claude-sonnet-4-5',
    AXIOS_TIMEOUT: 120000, // 2 minutes timeout for normal requests
    TOKEN_REFRESH_TIMEOUT: 15000, // 15 seconds timeout for token refresh (shorter to avoid blocking)
    USER_AGENT: 'KiroIDE',
    KIRO_VERSION: '0.11.63', //升级到新版本会导致aws用不了，需要找新接口
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
    TOTAL_CONTEXT_TOKENS: 200000, // Claude Sonnet 4.5 actual context is 200K
};

const KIRO_MAX_TOOL_NAME_LENGTH = 64;
let kiroThrottleQueue = Promise.resolve();
let kiroLastRequestStartedAt = 0;

function shortenKiroToolName(name) {
    const rawName = String(name || '');
    if (rawName.length <= KIRO_MAX_TOOL_NAME_LENGTH) {
        return rawName;
    }

    const hash = crypto.createHash('sha256').update(rawName).digest('hex').slice(0, 12);
    const prefixLength = KIRO_MAX_TOOL_NAME_LENGTH - hash.length - 1;
    return `${rawName.slice(0, prefixLength)}_${hash}`;
}

// Kiro/CodeWhisperer 的 generateAssistantResponse 在 tools 列表为空时会报 API 错误，
// 因此客户端没有提供任何可用工具时，注入这个占位工具来满足 API 要求。
// 描述里明确禁止调用它：否则模型（尤其被 agentic system prompt 引导时）会先说一句
// "我来读取文件…" 的开场白再去调用这个空操作工具，导致本轮在没有实质内容的情况下结束。
const KIRO_PLACEHOLDER_TOOL_NAME = 'no_tool_available';

// 判断一个 Anthropic 消息是否"实质为空"：没有非空文本，也没有工具调用/工具结果/图片/思考内容。
// 这类空轮次通常是客户端的占位或流式残留，塞进 Kiro 历史里既会撑大请求体、又可能触发 400，
// 之前的做法是填充 "Continue"，反而污染了上下文。
function isMeaningfulContentPart(part) {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'text') {
        return typeof part.text === 'string' && part.text.trim() !== '';
    }
    // tool_use / tool_result / image / thinking / redacted_thinking 及其它未知类型都视为有意义，避免误删数据
    return true;
}

function isEmptyAnthropicMessage(message) {
    if (!message) return true;
    const content = message.content;
    if (content == null) return true;
    if (typeof content === 'string') return content.trim() === '';
    if (Array.isArray(content)) {
        return content.length === 0 || !content.some(isMeaningfulContentPart);
    }
    return false;
}

function buildKiroPlaceholderTool() {
    return {
        toolSpecification: {
            name: KIRO_PLACEHOLDER_TOOL_NAME,
            description: 'Internal no-op placeholder. Never call this tool (or any tool) in this turn. Do not announce or promise actions such as reading files or running commands. Instead, write your full and complete answer directly as natural-language text in this single reply, based on the information already available to you.',
            inputSchema: {
                json: {
                    type: "object",
                    properties: {}
                }
            }
        }
    };
}

function buildKiroToolNameMaps(tools) {
    const aliasToOriginal = new Map();
    const originalToAlias = new Map();

    if (Array.isArray(tools)) {
        for (const tool of tools) {
            const originalName = tool?.name;
            if (!originalName) continue;
            const aliasName = shortenKiroToolName(originalName);
            originalToAlias.set(originalName, aliasName);
            if (aliasName !== originalName) {
                aliasToOriginal.set(aliasName, originalName);
            }
        }
    }

    return {
        aliasToOriginal,
        toKiroName: (name) => originalToAlias.get(name) || shortenKiroToolName(name),
        fromKiroName: (name) => aliasToOriginal.get(name) || name
    };
}

function restoreKiroToolCallNames(toolCalls, toolNameMaps) {
    if (!toolCalls || !toolNameMaps?.fromKiroName) {
        return toolCalls;
    }

    return toolCalls.map(toolCall => ({
        ...toolCall,
        function: {
            ...toolCall.function,
            name: toolNameMaps.fromKiroName(toolCall.function?.name)
        }
    }));
}

function getKiroRequestMinIntervalMs(config) {
    const value = Number(config?.KIRO_REQUEST_MIN_INTERVAL_MS);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function acquireKiroRequestSlot(config) {
    const minIntervalMs = getKiroRequestMinIntervalMs(config);
    if (minIntervalMs <= 0) {
        return () => {};
    }

    let releaseCurrent;
    const previous = kiroThrottleQueue.catch(() => {});
    kiroThrottleQueue = previous.then(() => new Promise(resolve => {
        releaseCurrent = resolve;
    }));

    await previous;

    const elapsedMs = Date.now() - kiroLastRequestStartedAt;
    const waitMs = Math.max(0, minIntervalMs - elapsedMs);
    if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    kiroLastRequestStartedAt = Date.now();

    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseCurrent();
    };
}

function normalizeKiroToolInput(input) {
    if (input === undefined || input === null) {
        return '';
    }
    if (typeof input === 'string') {
        return input;
    }
    if (typeof input === 'object') {
        try {
            return JSON.stringify(input);
        } catch (e) {
            return String(input);
        }
    }
    return String(input);
}

// Per-model context window sizes for accurate token estimation
const MODEL_CONTEXT_TOKENS = {
    "gpt-5.6-sol": 1000000,
    "gpt-5.6-terra": 1000000,
    "gpt-5.6-luna": 1000000,
    "claude-sonnet-5": 1000000,
    "claude-opus-5": 1000000,
    "claude-opus-4-8": 1000000,
    "claude-opus-4-7": 1000000,
    "claude-opus-4-6": 1000000,
    "claude-opus-4-5": 1000000,
    "claude-opus-4-5-20251101": 1000000,
    "claude-sonnet-4-6": 200000,
    "claude-sonnet-4-5": 200000,
    "claude-sonnet-4-5-20250929": 200000,
    "claude-haiku-4-5": 200000,
    "claude-haiku-4-5-20251001": 200000,
};

function normalizeContextLength(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function findCustomModelConfigForModel(model, config = {}) {
    const targetModel = typeof model === 'string'
        ? model.replace(/^[^:]+:/, '')
        : '';
    if (!targetModel) {
        return null;
    }

    const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
    return customModels.find(({ id, alias, actualModel } = {}) =>
        id === targetModel || alias === targetModel || actualModel === targetModel
    ) || null;
}

function getContextTokensForModel(model, config = {}, fallbackModel = null) {
    const customModelConfig = findCustomModelConfigForModel(model, config) ||
        findCustomModelConfigForModel(fallbackModel, config);
    const configuredModelContextLength = normalizeContextLength(customModelConfig?.contextLength);
    if (configuredModelContextLength !== null) {
        return configuredModelContextLength;
    }

    return MODEL_CONTEXT_TOKENS[model] || MODEL_CONTEXT_TOKENS[fallbackModel] || KIRO_CONSTANTS.TOTAL_CONTEXT_TOKENS;
}
// 从 provider-models.js 获取支持的模型列表
const KIRO_MODELS = getProviderModels(MODEL_PROVIDER.KIRO_API);

// 完整的模型映射表
const FULL_MODEL_MAPPING = {
    "gpt-5.6-sol":"gpt-5.6-sol",
    "gpt-5.6-terra":"gpt-5.6-terra",
    "gpt-5.6-luna":"gpt-5.6-luna",
    "claude-haiku-4-5":"claude-haiku-4.5",
    "claude-haiku-4-5-20251001":"claude-haiku-4.5",
    "claude-sonnet-5":"claude-sonnet-5",
    "claude-opus-5":"claude-opus-5",
    "claude-opus-4-8":"claude-opus-4.8",
    "claude-opus-4-7":"claude-opus-4.7",
    "claude-opus-4-6":"claude-opus-4.6",
    "claude-sonnet-4-6":"claude-sonnet-4.6",
    "claude-opus-4-5":"claude-opus-4.5",
    "claude-opus-4-5-20251101":"claude-opus-4.5",
    "claude-sonnet-4-5": "claude-sonnet-4.5",
    "claude-sonnet-4-5-20250929": "claude-sonnet-4.5"
};

// 只保留 KIRO_MODELS 中存在的模型映射
const MODEL_MAPPING = Object.fromEntries(
    Object.entries(FULL_MODEL_MAPPING).filter(([key]) => KIRO_MODELS.includes(key))
);

function resolveKiroModel(model, config = {}) {
    if (MODEL_MAPPING[model]) {
        return MODEL_MAPPING[model];
    }

    if (findCustomModelConfigForModel(model, config)) {
        return model;
    }

    if (config.MODEL_FALLBACK_ENABLED === false) {
        throw new Error(`[Kiro] 模型不存在: ${model}`);
    }

    return model;
}

const KIRO_AUTH_TOKEN_FILE = "kiro-auth-token.json";

/**
 * Kiro API Service - Node.js implementation based on the Python ki2api
 * Provides OpenAI-compatible API for Claude Sonnet 4 via Kiro/CodeWhisperer
 */

/**
 * 根据当前配置生成唯一的机器码（Machine ID）
 * 确保每个配置对应一个唯一且不变的 ID
 * @param {Object} credentials - 当前凭证信息
 * @returns {string} SHA256 格式的机器码
 */
function generateMachineIdFromConfig(credentials) {
    // 优先级：节点UUID > profileArn > clientId > fallback
    const uniqueKey = credentials.uuid || credentials.profileArn || credentials.clientId || "KIRO_DEFAULT_MACHINE";
    return crypto.createHash('sha256').update(uniqueKey).digest('hex');
}

/**
 * 实时获取系统配置信息，用于生成 User-Agent
 * @returns {Object} 包含 osName, nodeVersion 等信息
 */
function getSystemRuntimeInfo() {
    const osPlatform = os.platform();
    const osRelease = os.release();
    const nodeVersion = process.version.replace('v', '');
    
    let osName = osPlatform;
    if (osPlatform === 'win32') osName = `windows#${osRelease}`;
    else if (osPlatform === 'darwin') osName = `macos#${osRelease}`;
    else osName = `${osPlatform}#${osRelease}`;

    return {
        osName,
        nodeVersion
    };
}

// Helper functions for tool calls and JSON parsing

function isQuoteCharAt(text, index) {
    if (index < 0 || index >= text.length) return false;
    const ch = text[index];
    return ch === '"' || ch === "'" || ch === '`';
}

function findRealTag(text, tag, startIndex = 0) {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = text.indexOf(tag, searchStart);
        if (pos === -1) return -1;
        
        const hasQuoteBefore = isQuoteCharAt(text, pos - 1);
        const hasQuoteAfter = isQuoteCharAt(text, pos + tag.length);
        if (!hasQuoteBefore && !hasQuoteAfter) {
            return pos;
        }
        
        searchStart = pos + 1;
    }
}

function isWhitespaceOnly(text) {
    if (text === null || text === undefined) return true;
    return String(text).trim().length === 0;
}

/**
 * Find a "real" thinking end tag that is not quoted/backticked and is followed by '\n\n'.
 * This avoids prematurely closing a thinking block when the model mentions `</thinking>`
 * inside the thinking content.
 */
function findRealThinkingEndTag(buffer, startIndex = 0) {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = findRealTag(buffer, KIRO_THINKING.END_TAG, searchStart);
        if (pos === -1) return -1;
        const after = buffer.slice(pos + KIRO_THINKING.END_TAG.length);
        if (after.startsWith('\n\n')) return pos;
        searchStart = pos + 1;
    }
}

/**
 * Find a "real" thinking end tag only when it is at the buffer end (after it is whitespace only).
 * This is used for boundary-event scenarios (tool_use starts immediately after thinking, or stream end).
 */
function findRealThinkingEndTagAtBufferEnd(buffer, startIndex = 0) {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = findRealTag(buffer, KIRO_THINKING.END_TAG, searchStart);
        if (pos === -1) return -1;
        const after = buffer.slice(pos + KIRO_THINKING.END_TAG.length);
        if (isWhitespaceOnly(after)) return pos;
        searchStart = pos + 1;
    }
}

/**
 * 通用的括号匹配函数 - 支持多种括号类型
 * @param {string} text - 要搜索的文本
 * @param {number} startPos - 起始位置
 * @param {string} openChar - 开括号字符 (默认 '[')
 * @param {string} closeChar - 闭括号字符 (默认 ']')
 * @returns {number} 匹配的闭括号位置，未找到返回 -1
 */
function findMatchingBracket(text, startPos, openChar = '[', closeChar = ']') {
    if (!text || startPos >= text.length || text[startPos] !== openChar) {
        return -1;
    }

    let bracketCount = 1;
    let inString = false;
    let escapeNext = false;

    for (let i = startPos + 1; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }

        if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === openChar) {
                bracketCount++;
            } else if (char === closeChar) {
                bracketCount--;
                if (bracketCount === 0) {
                    return i;
                }
            }
        }
    }
    return -1;
}


/**
 * 尝试修复常见的 JSON 格式问题
 * @param {string} jsonStr - 可能有问题的 JSON 字符串
 * @returns {string} 修复后的 JSON 字符串
 */
function repairJson(jsonStr) {
    let repaired = jsonStr;
    // 移除尾部逗号
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    // 为未引用的键添加引号
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    // 确保字符串值被正确引用
    repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"');
    return repaired;
}

/**
 * 从损坏的 JSON 中提取关键凭证字段
 * 当标准 JSON 解析和 repairJson 都失败时使用
 * @param {string} content - 文件内容
 * @returns {Object|null} 提取的凭证对象或 null
 */
function extractCredentialsFromCorruptedJson(content) {
    const extracted = {};

    // 定义需要提取的关键字段及其正则模式
    const fieldPatterns = {
        refreshToken: /"refreshToken"\s*:\s*"([^"]+)"/,
        accessToken: /"accessToken"\s*:\s*"([^"]+)"/,
        clientId: /"clientId"\s*:\s*"([^"]+)"/,
        clientSecret: /"clientSecret"\s*:\s*"([^"]+)"/,
        profileArn: /"profileArn"\s*:\s*"([^"]+)"/,
        region: /"region"\s*:\s*"([^"]+)"/,
        authMethod: /"authMethod"\s*:\s*"([^"]+)"/,
        expiresAt: /"expiresAt"\s*:\s*"([^"]+)"/,
        startUrl: /"startUrl"\s*:\s*"([^"]+)"/,
    };

    for (const [field, pattern] of Object.entries(fieldPatterns)) {
        const match = content.match(pattern);
        if (match && match[1]) {
            extracted[field] = match[1];
        }
    }

    // 至少需要 refreshToken 或 accessToken 才算有效
    if (extracted.refreshToken || extracted.accessToken) {
        logger.info(`[Kiro Auth] Extracted ${Object.keys(extracted).length} fields from corrupted JSON: ${Object.keys(extracted).join(', ')}`);
        return extracted;
    }

    return null;
}

/**
 * 解析单个工具调用文本
 * @param {string} toolCallText - 工具调用文本
 * @returns {Object|null} 解析后的工具调用对象或 null
 */
function parseSingleToolCall(toolCallText) {
    const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i;
    const nameMatch = toolCallText.match(namePattern);

    if (!nameMatch) {
        return null;
    }

    const functionName = nameMatch[1].trim();
    const argsStartMarker = "with args:";
    const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase());

    if (argsStartPos === -1) {
        return null;
    }

    const argsStart = argsStartPos + argsStartMarker.length;
    const argsEnd = toolCallText.lastIndexOf(']');

    if (argsEnd <= argsStart) {
        return null;
    }

    const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim();

    try {
        const repairedJson = repairJson(jsonCandidate);
        const argumentsObj = JSON.parse(repairedJson);

        if (typeof argumentsObj !== 'object' || argumentsObj === null) {
            return null;
        }

        const toolCallId = `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`;
        return {
            id: toolCallId,
            type: "function",
            function: {
                name: functionName,
                arguments: JSON.stringify(argumentsObj)
            }
        };
    } catch (e) {
        logger.error(`Failed to parse tool call arguments: ${e.message}`, jsonCandidate);
        return null;
    }
}

function parseBracketToolCalls(responseText) {
    if (!responseText || !responseText.includes("[Called")) {
        return null;
    }

    const toolCalls = [];
    const callPositions = [];
    let start = 0;
    while (true) {
        const pos = responseText.indexOf("[Called", start);
        if (pos === -1) {
            break;
        }
        callPositions.push(pos);
        start = pos + 1;
    }

    for (let i = 0; i < callPositions.length; i++) {
        const startPos = callPositions[i];
        let endSearchLimit;
        if (i + 1 < callPositions.length) {
            endSearchLimit = callPositions[i + 1];
        } else {
            endSearchLimit = responseText.length;
        }

        const segment = responseText.substring(startPos, endSearchLimit);
        const bracketEnd = findMatchingBracket(segment, 0);

        let toolCallText;
        if (bracketEnd !== -1) {
            toolCallText = segment.substring(0, bracketEnd + 1);
        } else {
            // Fallback: if no matching bracket, try to find the last ']' in the segment
            const lastBracket = segment.lastIndexOf(']');
            if (lastBracket !== -1) {
                toolCallText = segment.substring(0, lastBracket + 1);
            } else {
                continue; // Skip this one if no closing bracket found
            }
        }
        
        const parsedCall = parseSingleToolCall(toolCallText);
        if (parsedCall) {
            toolCalls.push(parsedCall);
        }
    }
    return toolCalls.length > 0 ? toolCalls : null;
}

function deduplicateToolCalls(toolCalls) {
    const seen = new Set();
    const uniqueToolCalls = [];

    for (const tc of toolCalls) {
        const key = `${tc.function.name}-${tc.function.arguments}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueToolCalls.push(tc);
        } else {
            logger.info(`Skipping duplicate tool call: ${tc.function.name}`);
        }
    }
    return uniqueToolCalls;
}

/**
 * Kiro 上游返回了 HTTP 200 但内容完全为空（无文本、无工具调用、无思考内容）时使用的错误。
 * 复用 common.js 中通用的 createEmptyUpstreamResponseError（error.isEmptyUpstreamResponse），
 * 以便与 handleStreamRequest / handleUnaryRequest 里 provider 无关的空响应重试分支对接。
 * 标记为可切换凭证重试，且不计入凭证错误次数（这不是凭证本身的问题，可能是历史/会话导致 Kiro 静默无输出）。
 */
function createKiroEmptyResponseError() {
    return createEmptyUpstreamResponseError('Kiro');
}

async function getKiroErrorResponsePreview(error, maxLength = 500) {
    try {
        const responseText = await getNormalizedErrorResponseText(error);
        return String(responseText || '').substring(0, maxLength);
    } catch (previewError) {
        // 错误日志绝不能覆盖真正的请求异常；无法格式化时只记录摘要失败。
        logger.warn(`[Kiro] Failed to format error response body: ${previewError?.message || 'unknown error'}`);
        return '';
    }
}

export class KiroApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), ".aws", "sso", "cache");
        this.credsBase64 = config.KIRO_OAUTH_CREDS_BASE64;
        this.apiKey = config.KIRO_API_KEY || (typeof process !== 'undefined' ? process.env.KIRO_API_KEY : null);
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_KIRO ?? false;
        this.uuid = config?.uuid; // 获取多节点配置的 uuid
        logger.info(`[Kiro] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        // this.accessToken = config.KIRO_ACCESS_TOKEN;
        // this.refreshToken = config.KIRO_REFRESH_TOKEN;
        // this.clientId = config.KIRO_CLIENT_ID;
        // this.clientSecret = config.KIRO_CLIENT_SECRET;
        // this.authMethod = KIRO_CONSTANTS.AUTH_METHOD_SOCIAL;
        // this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL;
        // this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL;
        // this.baseUrl = KIRO_CONSTANTS.BASE_URL;

        // Add kiro-oauth-creds-base64 and kiro-oauth-creds-file to config
        if (config.KIRO_OAUTH_CREDS_BASE64) {
            try {
                const decodedCreds = Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8');
                const parsedCreds = JSON.parse(decodedCreds);
                // Store parsedCreds to be merged in initializeAuth
                this.base64Creds = parsedCreds;
                logger.info('[Kiro] Successfully decoded Base64 credentials in constructor.');
            } catch (error) {
                logger.error(`[Kiro] Failed to parse Base64 credentials in constructor: ${error.message}`);
            }
        } else if (config.KIRO_OAUTH_CREDS_FILE_PATH) {
            this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH;
        }

        this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
        this.axiosInstance = null; // Initialize later in async method
        this.axiosSocialRefreshInstance = null;
        this._tokenRefreshPromise = null;
    }
 
    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Kiro] Initializing Kiro API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();
        
        // 根据当前加载的凭证生成唯一的 Machine ID
        const machineId = generateMachineIdFromConfig({
            uuid: this.uuid,
            profileArn: this.profileArn,
            clientId: this.clientId
        });
        const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;
        const { osName, nodeVersion } = getSystemRuntimeInfo();

        const axiosConfig = {
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'amz-sdk-invocation-id': uuidv4(),
                'amz-sdk-request': 'attempt=1; max=3',
                'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
                'x-amz-user-agent': 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI',
                'user-agent': 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 md/appVersion-2.10.0 app/AmazonQ-For-CLI',
                'Connection': 'close'
            },
        };
        
        this.axiosInstance = axios.create(axiosConfig);

        axiosConfig.headers = new Headers();
        axiosConfig.headers.set('Content-Type', KIRO_CONSTANTS.CONTENT_TYPE_JSON);
        this.axiosSocialRefreshInstance = axios.create(axiosConfig);
        this.isInitialized = true;
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API);
    }

/**
 * 加载凭证信息（不执行刷新）
 */
async loadCredentials() {
    // 获取凭证文件路径
    const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);

    // Helper to load credentials from a file
    const loadCredentialsFromFile = async (filePath) => {
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            try {
                return JSON.parse(fileContent);
            } catch (parseError) {
                logger.warn('[Kiro Auth] JSON parse failed, attempting repair...');
                try {
                    const repaired = repairJson(fileContent);
                    const result = JSON.parse(repaired);
                    logger.info('[Kiro Auth] JSON repair successful');
                    return result;
                } catch (repairError) {
                    logger.warn('[Kiro Auth] JSON repair failed, attempting field extraction...');
                    // 尝试从损坏的 JSON 中提取关键字段
                    const extracted = extractCredentialsFromCorruptedJson(fileContent);
                    if (extracted) {
                        logger.info('[Kiro Auth] Field extraction successful, credentials recovered');
                        return extracted;
                    }
                    logger.error('[Kiro Auth] All recovery methods failed:', repairError.message);
                    return null;
                }
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.debug(`[Kiro Auth] Credential file not found: ${filePath}`);
            } else {
                logger.warn(`[Kiro Auth] Failed to read credential file ${filePath}: ${error.message}`);
            }
            return null;
        }
    };

    try {
        let mergedCredentials = {};

        // Priority 1: Load from Base64 credentials if available
        if (this.base64Creds) {
            Object.assign(mergedCredentials, this.base64Creds);
            logger.info('[Kiro Auth] Successfully loaded credentials from Base64 (constructor).');
            this.base64Creds = null;
        }

        // 从文件加载
        const targetFilePath = tokenFilePath;
        const dirPath = path.dirname(targetFilePath);
        const targetFileName = path.basename(targetFilePath);

        logger.debug(`[Kiro Auth] Loading credentials from directory: ${dirPath}`);

        try {
            const targetCredentials = await loadCredentialsFromFile(targetFilePath);
            if (targetCredentials) {
                Object.assign(mergedCredentials, targetCredentials);
                logger.info(`[Kiro Auth] Successfully loaded OAuth credentials from ${targetFilePath}`);
            }

            const files = await fs.readdir(dirPath);
            for (const file of files) {
                if (file.endsWith('.json') && file !== targetFileName) {
                    const filePath = path.join(dirPath, file);
                    const credentials = await loadCredentialsFromFile(filePath);
                    if (credentials) {
                        credentials.expiresAt = mergedCredentials.expiresAt;
                        Object.assign(mergedCredentials, credentials);
                        logger.debug(`[Kiro Auth] Loaded Client credentials from ${file}`);
                    }
                }
            }
        } catch (error) {
            logger.warn(`[Kiro Auth] Error loading credentials from directory ${dirPath}: ${error.message}`);
        }

        // Apply loaded credentials. Force-refresh paths must not keep stale in-memory tokens.
        const applyCredential = (field) => {
            if (mergedCredentials[field] !== undefined && mergedCredentials[field] !== null) {
                this[field] = mergedCredentials[field];
            }
        };
        applyCredential('accessToken');
        applyCredential('refreshToken');
        applyCredential('clientId');
        applyCredential('clientSecret');
        applyCredential('authMethod');
        applyCredential('expiresAt');
        applyCredential('profileArn');
        applyCredential('region');
        applyCredential('idcRegion');
        if (this.apiKey || (typeof process !== 'undefined' && process.env.KIRO_API_KEY)) {
            this.accessToken = this.apiKey || process.env.KIRO_API_KEY;
        }

        if (!this.region) {
            this.region = this.idcRegion || 'us-east-1';
            logger.warn(`[Kiro Auth] Region not found in credentials. Using idcRegion/default: ${this.region}`);
        }

        // idcRegion 用于 REFRESH_IDC_URL，如果未设置则使用 region
        if (!this.idcRegion) {
            this.idcRegion = this.region;
        }

        const hasIdcClientCredentials = !!(this.clientId && this.clientSecret);
        const isSocialAuth = this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL ||
            (!this.authMethod && !hasIdcClientCredentials);

        let defaultBaseUrl = KIRO_CONSTANTS.BASE_URL;
        if (isSocialAuth) {
            defaultBaseUrl = KIRO_CONSTANTS.BASE_RUNTIME_URL;
        }

        this.refreshUrl = (this.config.KIRO_REFRESH_URL || KIRO_CONSTANTS.REFRESH_URL).replace("{{region}}", this.region);
        this.refreshIDCUrl = (this.config.KIRO_REFRESH_IDC_URL || KIRO_CONSTANTS.REFRESH_IDC_URL).replace("{{region}}", this.idcRegion);
        this.baseUrl = (this.config.KIRO_BASE_URL || defaultBaseUrl).replace("{{region}}", this.region);
    } catch (error) {
        logger.warn(`[Kiro Auth] Error during credential loading: ${error.message}`);
    }
}

async initializeAuth(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) {
        logger.debug('[Kiro Auth] Access token already available and not forced refresh.');
        return;
    }

    if (this._tokenRefreshPromise) {
        await this._tokenRefreshPromise;
        return;
    }

    const authOperation = (async () => {
        // Credential loading belongs to the single-flight operation. Otherwise,
        // a concurrent caller can reload an expired token while refresh is
        // writing the new token and overwrite the fresh in-memory value.
        await this.loadCredentials();

        // 只有在明确要求强制刷新，或者 AccessToken 确实缺失时，才执行刷新
        // 注意：在 V2 架构下，此方法主要由 PoolManager 的后台队列调用
        if (this.accessToken && this.accessToken.startsWith('ksk_')) return;
        if (forceRefresh || (!this.accessToken && this.refreshToken)) {
            if (!this.refreshToken) {
                throw new Error('No refresh token available to refresh access token.');
            }

            const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
            await this._doTokenRefresh(this.saveCredentialsToFile.bind(this), tokenFilePath);
        }

        if (!this.accessToken) {
            throw new Error('No access token available after initialization and refresh attempts.');
        }
    })();

    this._tokenRefreshPromise = authOperation;
    try {
        await authOperation;
    } finally {
        if (this._tokenRefreshPromise === authOperation) {
            this._tokenRefreshPromise = null;
        }
    }
}

/**
 * Helper to save credentials
 */
async saveCredentialsToFile(filePath, newData) {
    let existingData = {};
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        try {
            existingData = JSON.parse(fileContent);
        } catch (parseError) {
            logger.warn('[Kiro Auth] JSON parse failed, attempting repair...');
            try {
                const repaired = repairJson(fileContent);
                existingData = JSON.parse(repaired);
                logger.info('[Kiro Auth] JSON repair successful');
            } catch (repairError) {
                logger.warn('[Kiro Auth] JSON repair failed, attempting field extraction...');
                const extracted = extractCredentialsFromCorruptedJson(fileContent);
                if (extracted) {
                    existingData = extracted;
                    logger.info('[Kiro Auth] Field extraction successful');
                } else {
                    logger.error('[Kiro Auth] All recovery methods failed:', repairError.message);
                    existingData = {};
                }
            }
        }
    } catch (readError) {
        if (readError.code === 'ENOENT') {
            logger.debug(`[Kiro Auth] Token file not found, creating new one: ${filePath}`);
        } else {
            logger.warn(`[Kiro Auth] Could not read existing token file ${filePath}: ${readError.message}`);
        }
    }
    const mergedData = { ...existingData, ...newData };
    await atomicWriteFile(filePath, JSON.stringify(mergedData, null, 2), { encoding: 'utf8', mode: 0o600 });
    logger.info(`[Kiro Auth] Updated token file: ${filePath}`);
};

    /**
     * 执行实际的 token 刷新操作（内部方法）
     * @param {Function} saveCredentialsToFile - 保存凭证的函数
     * @param {string} tokenFilePath - 凭证文件路径
     */
    async _doTokenRefresh(saveCredentialsToFile, tokenFilePath) {
        try {
            const requestBody = {
                refreshToken: this.refreshToken,
            };

            const hasIdcClientCredentials = !!(this.clientId && this.clientSecret);
            const isSocialAuth = this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL ||
                (!this.authMethod && !hasIdcClientCredentials);
            if (!this.authMethod) {
                this.authMethod = isSocialAuth ? KIRO_CONSTANTS.AUTH_METHOD_SOCIAL : 'builder-id';
                logger.warn(`[Kiro Auth] authMethod missing in credentials. Inferred ${this.authMethod} from available fields.`);
            }

            let refreshUrl = this.refreshUrl;
            if (!isSocialAuth) {
                refreshUrl = this.refreshIDCUrl;
                if (!hasIdcClientCredentials) {
                    throw new Error('IDC refresh requires clientId and clientSecret.');
                }
                requestBody.clientId = this.clientId;
                requestBody.clientSecret = this.clientSecret;
                requestBody.grantType = 'refresh_token';
            }

            let response = null;
            // 使用更短的超时时间进行 token 刷新，避免阻塞其他请求
            const refreshConfig = { timeout: KIRO_CONSTANTS.TOKEN_REFRESH_TIMEOUT };
            
            const axiosConfig = {
                method: 'post',
                url: refreshUrl,
                data: requestBody,
                ...refreshConfig
            };
            this._applySidecar(axiosConfig);

            if (isSocialAuth) {
                response = await this.axiosSocialRefreshInstance.request(axiosConfig);
                logger.info('[Kiro Auth] Token refresh social response: ok');
            } else {
                response = await this.axiosInstance.request(axiosConfig);
                logger.info('[Kiro Auth] Token refresh idc response: ok');
            }

            if (response.data && response.data.accessToken) {
                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken || this.refreshToken;
                this.profileArn = response.data.profileArn || this.profileArn;
                const expiresIn = Number(response.data.expiresIn) || 3600;
                const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
                this.expiresAt = expiresAt;
                logger.info('[Kiro Auth] Access token refreshed successfully');

                const updatedTokenData = {
                    accessToken: this.accessToken,
                    refreshToken: this.refreshToken,
                    expiresAt: expiresAt,
                };
                if (this.profileArn) {
                    updatedTokenData.profileArn = this.profileArn;
                }
                await saveCredentialsToFile(tokenFilePath, updatedTokenData);

                // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, this.uuid);
                }
            } else {
                throw new Error('Invalid refresh response: Missing accessToken');
            }
        } catch (error) {
            logger.error('[Kiro Auth] Token refresh failed:', error.message);
            throw new Error(`Token refresh failed: ${error.message}`);
        }
    }


    /**
     * Count tokens for a given text using Claude's official tokenizer
     * Static version for use without instance
     */
    static countTextTokens(text) {
        return countTextTokensUtil(text);
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * Static version for use without instance
     */
    static countTokens(requestBody) {
        return countTokensUtil(requestBody);
    }

    /**
     * Calculate input tokens from request body
     * Static version for use without instance
     */
    static estimateInputTokens(requestBody) {
        return estimateInputTokensUtil(requestBody);
    }

    /**
     * Extract text content from OpenAI message format
     */
    getContentText(message) {
        return getContentTextUtil(message);
    }

    _extractTextAndImagesFromContent(content, totalMessages = null) {
        const result = { text: '', images: [], imageCount: 0 };
        const shouldKeepImages = totalMessages === null ? true : (totalMessages - 1) <= 5;
        if (Array.isArray(content)) {
            for (const part of content) {
                if (part.type === 'text') {
                    result.text += part.text || '';
                } else if (part.type === 'image' && part.source?.data) {
                    result.imageCount++;
                    if (shouldKeepImages) result.images.push({
                        format: part.source.media_type.split('/')[1],
                        source: { bytes: part.source.data }
                    });
                } else if (part.type === 'image_url' && part.image_url) {
                    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
                    if (imageUrl && imageUrl.startsWith('data:')) {
                        const [header, data] = imageUrl.split(',');
                        const mediaType = header.split(':')[1]?.split(';')[0] || 'image/jpeg';
                        result.imageCount++;
                        if (shouldKeepImages) result.images.push({
                            format: mediaType.split('/')[1] || 'jpeg',
                            source: { bytes: data }
                        });
                    }
                }
            }
            return result;
        }
        result.text = getContentTextUtil({ content });
        return result;
    }

    /**
     * 清洗 tool_use 的 input 对象，移除空字符串 key 等不合法字段
     * Kiro API 不接受空字符串 key 的 JSON 对象（如 {"": "value"}）
     */
    _sanitizeToolInput(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return input;
        }
        const sanitized = {};
        for (const [key, value] of Object.entries(input)) {
            if (key === '') {
                logger.info(`[Kiro] Removed empty-string key from tool input, value: ${String(value).substring(0, 100)}`);
                continue;
            }
            sanitized[key] = value;
        }
        return sanitized;
    }

    /**
     * 统一处理内容，将不同格式的内容转换为文本
     * @param {any} content - 内容对象或数组
     * @returns {string} 处理后的文本
     */
    processContent(content) {
        return processContentUtil(content);
    }

    _normalizeThinkingBudgetTokens(budgetTokens) {
        let value = Number(budgetTokens);
        if (!Number.isFinite(value) || value <= 0) {
            value = KIRO_THINKING.DEFAULT_BUDGET_TOKENS;
        }
        value = Math.floor(value);
        if (value < KIRO_THINKING.MIN_BUDGET_TOKENS) value = KIRO_THINKING.MIN_BUDGET_TOKENS;
        return Math.min(value, KIRO_THINKING.MAX_BUDGET_TOKENS);
    }

    _generateThinkingPrefix(thinking) {
        if (!thinking || typeof thinking !== 'object') return null;
        const type = String(thinking.type || '').toLowerCase().trim();

        if (type === 'enabled') {
            const budget = this._normalizeThinkingBudgetTokens(thinking.budget_tokens);
            return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
        }

        if (type === 'adaptive') {
            const effortRaw = typeof thinking.effort === 'string' ? thinking.effort : '';
            const effort = effortRaw.toLowerCase().trim();
            const normalizedEffort = (effort === 'low' || effort === 'medium' || effort === 'high') ? effort : 'high';
            return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${normalizedEffort}</thinking_effort>`;
        }

        return null;
    }

    _hasThinkingPrefix(text) {
        if (!text) return false;
        return text.includes(KIRO_THINKING.MODE_TAG) || text.includes(KIRO_THINKING.MAX_LEN_TAG) || text.includes(KIRO_THINKING.EFFORT_TAG);
    }

    _toClaudeContentBlocksFromKiroText(content) {
        const raw = content ?? '';
        if (!raw) return [];
        
        const startPos = findRealTag(raw, KIRO_THINKING.START_TAG);
        if (startPos === -1) {
            return [{ type: "text", text: raw }];
        }
        
        const before = raw.slice(0, startPos);
        let rest = raw.slice(startPos + KIRO_THINKING.START_TAG.length);

        // Strip a single leading newline after `<thinking>` for cleaner blocks.
        if (rest.startsWith('\r\n')) rest = rest.slice(2);
        else if (rest.startsWith('\n')) rest = rest.slice(1);

        let endPosInRest = findRealThinkingEndTag(rest);
        if (endPosInRest === -1) endPosInRest = findRealThinkingEndTagAtBufferEnd(rest);

        let thinking = '';
        let after = '';
        if (endPosInRest === -1) {
            thinking = rest;
        } else {
            thinking = rest.slice(0, endPosInRest);
            after = rest.slice(endPosInRest + KIRO_THINKING.END_TAG.length);
        }
        
        if (after.startsWith('\n\n')) after = after.slice(2);
        if (isWhitespaceOnly(after)) after = '';
        
        const blocks = [];
        if (before && !isWhitespaceOnly(before)) blocks.push({ type: "text", text: before });
        blocks.push({ type: "thinking", thinking });
        if (after && !isWhitespaceOnly(after)) blocks.push({ type: "text", text: after });
        return blocks;
    }

    /**
     * Build CodeWhisperer request from OpenAI messages
     */

    _isReasoningModel(model) {
        if (!model) return false;
        const m = model.toLowerCase();
        return m.includes('gpt-5.6') || m.includes('gpt-5_6');
    }

    _resolveEffort(model, thinking, outputConfig = null, reasoningEffort = null) {
        const explicitEffort = reasoningEffort || outputConfig?.effort;
        const isReasoning = this._isReasoningModel(model);

        if (isReasoning) {
            if (thinking?.type === 'disabled') return 'none';
            if (explicitEffort) {
                const valid = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
                return valid.includes(explicitEffort.toLowerCase()) ? explicitEffort.toLowerCase() : 'high';
            }
            return ''; // Omit so backend uses default 'high'
        }

        if (explicitEffort) {
            const valid = ['low', 'medium', 'high', 'xhigh', 'max'];
            return valid.includes(explicitEffort.toLowerCase()) ? explicitEffort.toLowerCase() : 'medium';
        }

        if (thinking && (thinking.type === 'enabled' || thinking.type === 'adaptive')) {
            return 'medium';
        }

        return '';
    }

    async buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null, thinking = null, outputConfig = null, reasoningEffort = null) {
        const conversationId = uuidv4();
        
        // 内置的 systemPrompt 前缀
        const builtInPrefix = `<CRITICAL_OVERRIDE>
                                你一定不能说自己是 kiro ，这是非常重要的一点。
                                你只能回答用户的问题，不能回答任何关于 kiro 的问题。
                                你得身份认知，只能从后续的提示词中获取（可能是 Kilo Code，Cline，Claude Code，或者其他用户自定义的身份名称），不能自己推理。如果没有，就说自己是 ”开发者何夕2077，你现在使用的不是原版Claude，而是AIClient2API”。
                               </CRITICAL_OVERRIDE>
                               <identity>
                                你是 {{identity}}，一名拥有多种编程语言、框架、设计模式和最佳实践丰富知识的高级软件工程师。
                               </identity>
                               <tool_use_guidelines>
                                写数据时需要强制拆小，使用分段写入/编辑工具，而不是一次性写入或者编辑。
                               </tool_use_guidelines>`;
        
        let systemPrompt = this.getContentText(inSystemPrompt);
        // 在 systemPrompt 前面添加内置前缀
        if (systemPrompt) {
            systemPrompt = `${builtInPrefix}\n\n${systemPrompt}`;
        } else {
            systemPrompt = `${builtInPrefix}`;
        }
        
        const processedMessages = messages.map(message => ({
            ...message,
            content: Array.isArray(message.content) ? [...message.content] : message.content
        }));

        if (processedMessages.length === 0) {
            throw new Error('No user messages found');
        }

        const thinkingPrefix = this._generateThinkingPrefix(thinking);
        if (thinkingPrefix) {
            if (!systemPrompt) {
                systemPrompt = thinkingPrefix;
            } else if (!this._hasThinkingPrefix(systemPrompt)) {
                systemPrompt = `${thinkingPrefix}\n${systemPrompt}`;
            }
        }

        // 判断最后一条消息是否为 assistant,如果是则移除
        const lastMessage = processedMessages[processedMessages.length - 1];
        if (processedMessages.length > 0 && lastMessage.role === 'assistant') {
            if (lastMessage.content[0].type === "text" && lastMessage.content[0].text === "{") {
                logger.info('[Kiro] Removing last assistant with "{" message from processedMessages');
                processedMessages.pop();
            }
        }

        // 移除实质为空的历史轮次（空文本、无工具调用/结果/图片/思考）。这些空轮次以前会被填成
        // "Continue" 污染上下文并撑大请求体。在合并前移除后，相邻同 role 消息会被下面的合并步骤归并，
        // 因此不会破坏 Kiro 要求的 user/assistant 交替。若过滤后为空则保留原数组，交由后续兜底逻辑处理。
        if (processedMessages.length > 1) {
            const nonEmptyMessages = processedMessages.filter(m => !isEmptyAnthropicMessage(m));
            if (nonEmptyMessages.length > 0 && nonEmptyMessages.length < processedMessages.length) {
                logger.info(`[Kiro] Removed ${processedMessages.length - nonEmptyMessages.length} empty message turn(s) before building history`);
                processedMessages.length = 0;
                processedMessages.push(...nonEmptyMessages);
            }
        }

        // 合并相邻相同 role 的消息
        const mergedMessages = [];
        for (let i = 0; i < processedMessages.length; i++) {
            const currentMsg = processedMessages[i];
            
            if (mergedMessages.length === 0) {
                mergedMessages.push(currentMsg);
            } else {
                const lastMsg = mergedMessages[mergedMessages.length - 1];
                
                // 判断当前消息和上一条消息是否为相同 role
                if (currentMsg.role === lastMsg.role) {
                    // 合并消息内容
                    if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
                        // 如果都是数组,合并数组内容
                        lastMsg.content.push(...currentMsg.content);
                    } else if (typeof lastMsg.content === 'string' && typeof currentMsg.content === 'string') {
                        // 如果都是字符串,用换行符连接
                        lastMsg.content += '\n' + currentMsg.content;
                    } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === 'string') {
                        // 上一条是数组,当前是字符串,添加为 text 类型
                        lastMsg.content.push({ type: 'text', text: currentMsg.content });
                    } else if (typeof lastMsg.content === 'string' && Array.isArray(currentMsg.content)) {
                        // 上一条是字符串,当前是数组,转换为数组格式
                        lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...currentMsg.content];
                    }
                    // logger.info(`[Kiro] Merged adjacent ${currentMsg.role} messages`);
                } else {
                    mergedMessages.push(currentMsg);
                }
            }
        }
        
        // 用合并后的消息替换原消息数组
        processedMessages.length = 0;
        processedMessages.push(...mergedMessages);

        const codewhispererModel = resolveKiroModel(model, this.config);
        const toolNameMaps = buildKiroToolNameMaps(tools);
        
        // 动态压缩 tools（保留全部工具，但过滤掉 web_search/websearch）
        let toolsContext = {};
        if (tools && Array.isArray(tools) && tools.length > 0) {
            // 过滤掉 web_search 或 websearch 工具（忽略大小写）
            const filteredTools = tools.filter(tool => {
                const name = (tool.name || '').toLowerCase();
                const shouldIgnore = name === 'web_search' || name === 'websearch';
                if (shouldIgnore) {
                    logger.info(`[Kiro] Ignoring tool: ${tool.name}`);
                }
                return !shouldIgnore;
            });
            
            if (filteredTools.length === 0) {
                // 所有工具都被过滤掉了，添加一个占位工具
                logger.info('[Kiro] All tools were filtered out, adding placeholder tool');
                toolsContext = { tools: [buildKiroPlaceholderTool()] };
            } else {
                const MAX_DESCRIPTION_LENGTH = 9216;

                let truncatedCount = 0;
                const kiroTools = filteredTools
                    .filter(tool => {
                        // 过滤掉描述为空的工具
                        if (!tool.description || tool.description.trim() === '') {
                            logger.info(`[Kiro] Ignoring tool with empty description: ${tool.name}`);
                            return false;
                        }
                        return true;
                    })
                    .map(tool => {
                        let desc = tool.description || "";
                        const originalLength = desc.length;
                        
                        if (desc.length > MAX_DESCRIPTION_LENGTH) {
                            desc = desc.substring(0, MAX_DESCRIPTION_LENGTH) + "...";
                            truncatedCount++;
                            logger.info(`[Kiro] Truncated tool '${tool.name}' description: ${originalLength} -> ${desc.length} chars`);
                        }
                        
                        const entry = {
                            toolSpecification: {
                                name: toolNameMaps.toKiroName(tool.name),
                                description: desc,
                                inputSchema: {
                                    json: tool.input_schema || {}
                                }
                            }
                        };
                        return tool.cache_control
                            ? [entry, { cachePoint: { type: "default" } }]
                            : [entry];
                    }).flat();
                
                if (truncatedCount > 0) {
                    logger.info(`[Kiro] Truncated ${truncatedCount} tool description(s) to max ${MAX_DESCRIPTION_LENGTH} chars`);
                }

                // 检查过滤后是否还有有效工具
                if (kiroTools.length === 0) {
                    logger.info('[Kiro] All tools were filtered out (empty descriptions), adding placeholder tool');
                    toolsContext = { tools: [buildKiroPlaceholderTool()] };
                } else {
                    toolsContext = { tools: kiroTools };
                }
            }
        } else {
            // tools 为空或长度为 0 时，自动添加一个占位工具
            logger.info('[Kiro] No tools provided, adding placeholder tool');
            toolsContext = { tools: [buildKiroPlaceholderTool()] };
        }

        const history = [];
        let startIndex = 0;

        let prependSystemToCurrentMessage = false;

        // Handle system prompt
        if (systemPrompt) {
            // Keep single-turn requests as a single current message. Duplicating the same user
            // payload into history and currentMessage can make Kiro reject large agent prompts.
            if (processedMessages[0].role === 'user' && processedMessages.length === 1) {
                prependSystemToCurrentMessage = true;
            } else if (processedMessages[0].role === 'user') {
                const firstUserPayload = this._extractTextAndImagesFromContent(processedMessages[0].content, processedMessages.length);
                const firstImagePlaceholder = firstUserPayload.imageCount > 0 && firstUserPayload.images.length === 0
                    ? `[此消息包含 ${firstUserPayload.imageCount} 张图片，已在历史记录中省略]`
                    : '';
                const firstHistoryMsg = {
                    userInputMessage: {
                        content: firstUserPayload.text
                            ? `${systemPrompt}\n\n${firstUserPayload.text}${firstImagePlaceholder ? `\n${firstImagePlaceholder}` : ''}`
                            : `${systemPrompt}${firstImagePlaceholder ? `\n${firstImagePlaceholder}` : ''}`,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                };
                if (firstUserPayload.images.length > 0) {
                    firstHistoryMsg.userInputMessage.images = firstUserPayload.images;
                }
                history.push(firstHistoryMsg);
                startIndex = 1; // Start processing from the second message
            } else {
                // If the first message is not a user message, or if there's no initial user message,
                // add system prompt as a standalone user message.
                history.push({
                    userInputMessage: {
                        content: systemPrompt,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
            }
        }

        // 保留最近 5 条历史消息中的图片
        const keepImageThreshold = 5;        
        for (let i = startIndex; i < processedMessages.length - 1; i++) {
            const message = processedMessages[i];
            // 计算当前消息距离最后一条消息的位置（从后往前数）
            const distanceFromEnd = (processedMessages.length - 1) - i;
            // 如果距离末尾不超过 5 条，则保留图片
            const shouldKeepImages = distanceFromEnd <= keepImageThreshold;
            
            if (message.role === 'user') {
                let userInputMessage = {
                    content: '',
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                };
                let imageCount = 0;
                let toolResults = [];
                let images = [];
                
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            userInputMessage.content += part.text;
                        } else if (part.type === 'tool_result') {
                            toolResults.push({
                                content: [{ text: this.getContentText(part.content) }],
                                status: 'success',
                                toolUseId: part.tool_use_id
                            });
                        } else if (part.type === 'image') {
                            if (shouldKeepImages) {
                                // 最近 5 条消息内的图片保留原始数据
                                images.push({
                                    format: part.source.media_type.split('/')[1],
                                    source: {
                                        bytes: part.source.data
                                    }
                                });
                            } else {
                                // 超过 5 条历史记录的图片只记录数量
                                imageCount++;
                            }
                        }
                    }
                } else {
                    userInputMessage.content = this.getContentText(message);
                }
                
                // 如果有保留的图片，添加到消息中
                if (images.length > 0) {
                    userInputMessage.images = images;
                    logger.info(`[Kiro] Kept ${images.length} image(s) in recent history message (distance from end: ${distanceFromEnd})`);
                }
                
                // 如果有被替换的图片，添加占位符说明
                if (imageCount > 0) {
                    const imagePlaceholder = `[此消息包含 ${imageCount} 张图片，已在历史记录中省略]`;
                    userInputMessage.content = userInputMessage.content
                        ? `${userInputMessage.content}\n${imagePlaceholder}`
                        : imagePlaceholder;
                    logger.info(`[Kiro] Replaced ${imageCount} image(s) with placeholder in old history message (distance from end: ${distanceFromEnd})`);
                }
                
                if (toolResults.length > 0) {
                    // 去重 toolResults - Kiro API 不接受重复的 toolUseId
                    const uniqueToolResults = [];
                    const seenIds = new Set();
                    for (const tr of toolResults) {
                        if (!seenIds.has(tr.toolUseId)) {
                            seenIds.add(tr.toolUseId);
                            uniqueToolResults.push(tr);
                        }
                    }
                    userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults };
                }

                // 兜底处理空 content（正常情况下空轮次已在合并前被过滤掉）：
                // 有工具结果/图片时 Kiro 仍要求 content 非空，填入最小必要说明；否则整条跳过，不污染上下文。
                if (!userInputMessage.content || userInputMessage.content.trim() === '') {
                    if (toolResults.length > 0) {
                        userInputMessage.content = 'Tool results provided.';
                    } else if (userInputMessage.images && userInputMessage.images.length > 0) {
                        userInputMessage.content = 'Image provided.';
                    } else {
                        continue;
                    }
                }

                history.push({ userInputMessage });
            } else if (message.role === 'assistant') {
                let assistantResponseMessage = {
                    content: ''
                };
                let toolUses = [];
                let thinkingText = '';
                
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            assistantResponseMessage.content += part.text;
                        } else if (part.type === 'thinking') {
                            thinkingText += (part.thinking ?? part.text ?? '');
                        } else if (part.type === 'tool_use') {
                            toolUses.push({
                                input: this._sanitizeToolInput(part.input),
                                name: toolNameMaps.toKiroName(part.name),
                                toolUseId: part.id
                            });
                        }
                    }
                } else {
                    assistantResponseMessage.content = this.getContentText(message);
                }

                if (thinkingText) {
                    assistantResponseMessage.content = assistantResponseMessage.content
                        ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${assistantResponseMessage.content}`
                        : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
                }

                // 只添加非空字段
                if (toolUses.length > 0) {
                    assistantResponseMessage.toolUses = toolUses;
                }

                // 兜底处理空 content（正常情况下空轮次已在合并前被过滤掉）：
                // 只有工具调用时保留（content 允许为空），完全空的助手轮次则跳过，不用 "Continue" 污染。
                if ((!assistantResponseMessage.content || assistantResponseMessage.content.trim() === '') && toolUses.length === 0) {
                    continue;
                }

                history.push({ assistantResponseMessage });
            }
        }

        // Build current message
        let currentMessage = processedMessages[processedMessages.length - 1];
        let currentContent = '';
        let currentToolResults = [];
        let currentToolUses = [];
        let currentImages = [];

        // 如果最后一条消息是 assistant，需要将其加入 history，然后创建一个 user 类型的 currentMessage
        // 因为 CodeWhisperer API 的 currentMessage 必须是 userInputMessage 类型
        if (currentMessage.role === 'assistant') {
            logger.info('[Kiro] Last message is assistant, moving it to history and creating user currentMessage');
            
            // 构建 assistant 消息并加入 history
            let assistantResponseMessage = {
                content: '',
                toolUses: []
            };
            let thinkingText = '';
            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        assistantResponseMessage.content += part.text;
                    } else if (part.type === 'thinking') {
                        thinkingText += (part.thinking ?? part.text ?? '');
                    } else if (part.type === 'tool_use') {
                        assistantResponseMessage.toolUses.push({
                            input: this._sanitizeToolInput(part.input),
                            name: toolNameMaps.toKiroName(part.name),
                            toolUseId: part.id
                        });
                    }
                }
            } else {
                assistantResponseMessage.content = this.getContentText(currentMessage);
            }
            if (thinkingText) {
                assistantResponseMessage.content = assistantResponseMessage.content
                    ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${assistantResponseMessage.content}`
                    : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
            }
            if (assistantResponseMessage.toolUses.length === 0) {
                delete assistantResponseMessage.toolUses;
            }
            history.push({ assistantResponseMessage });
            
            // 设置 currentContent 为 "Continue"，因为我们需要一个 user 消息来触发 AI 继续
            currentContent = 'Continue';
        } else {
            // 最后一条消息是 user，需要确保 history 最后一个元素是 assistantResponseMessage
            // Kiro API 要求 history 必须以 assistantResponseMessage 结尾
            if (history.length > 0) {
                const lastHistoryItem = history[history.length - 1];
                if (!lastHistoryItem.assistantResponseMessage) {
                    // 最后一个不是 assistantResponseMessage，需要补全一个空的
                    logger.info('[Kiro] History does not end with assistantResponseMessage, adding empty one');
                    history.push({
                        assistantResponseMessage: {
                            content: 'Continue'
                        }
                    });
                }
            }
            
            // 处理 user 消息
            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        currentContent += part.text;
                    } else if (part.type === 'tool_result') {
                        currentToolResults.push({
                            content: [{ text: this.getContentText(part.content) }],
                            status: 'success',
                            toolUseId: part.tool_use_id
                        });
                    } else if (part.type === 'tool_use') {
                        currentToolUses.push({
                            input: this._sanitizeToolInput(part.input),
                            name: toolNameMaps.toKiroName(part.name),
                            toolUseId: part.id
                        });
                    } else if (part.type === 'image') {
                        currentImages.push({
                            format: part.source.media_type.split('/')[1],
                            source: {
                                bytes: part.source.data
                            }
                        });
                    }
                }
            } else {
                currentContent = this.getContentText(currentMessage);
            }

            // Kiro API 要求 content 不能为空，即使有 toolResults
            if (!currentContent) {
                currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
            }

            if (prependSystemToCurrentMessage) {
                currentContent = currentContent
                    ? `${systemPrompt}\n\n${currentContent}`
                    : systemPrompt;
            }
        }

        const request = {
            conversationState: {
                agentTaskType: "vibe",
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId: conversationId,
                currentMessage: {} // Will be populated as userInputMessage
            }
        };
        
        // 只有当 history 非空时才添加（API 可能不接受空数组）
        if (history.length > 0) {
            request.conversationState.history = history;
        }

        // currentMessage 始终是 userInputMessage 类型
        // 注意：API 不接受 null 值，空字段应该完全不包含
        const userInputMessage = {
            content: currentContent,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        };

        // 只有当 images 非空时才添加
        if (currentImages && currentImages.length > 0) {
            userInputMessage.images = currentImages;
        }

        // 构建 userInputMessageContext，只包含非空字段
        const userInputMessageContext = {};
        if (currentToolResults.length > 0) {
            // 去重 toolResults - Kiro API 不接受重复的 toolUseId
            const uniqueToolResults = [];
            const seenToolUseIds = new Set();
            for (const tr of currentToolResults) {
                if (!seenToolUseIds.has(tr.toolUseId)) {
                    seenToolUseIds.add(tr.toolUseId);
                    uniqueToolResults.push(tr);
                }
            }
            userInputMessageContext.toolResults = uniqueToolResults;
        }
        if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
            userInputMessageContext.tools = toolsContext.tools;
        }

        // 只有当 userInputMessageContext 有内容时才添加
        if (Object.keys(userInputMessageContext).length > 0) {
            userInputMessage.userInputMessageContext = userInputMessageContext;
        }

        request.conversationState.currentMessage.userInputMessage = userInputMessage;

        const resolvedEffort = this._resolveEffort(codewhispererModel, thinking, outputConfig, reasoningEffort);
        if (resolvedEffort) {
            if (this._isReasoningModel(codewhispererModel)) {
                request.additionalModelRequestFields = {
                    reasoning: { effort: resolvedEffort }
                };
            } else {
                request.additionalModelRequestFields = {
                    output_config: { effort: resolvedEffort }
                };
            }
        }

        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            request.profileArn = this.profileArn;
        }

        Object.defineProperty(request, '_kiroToolNameMaps', {
            value: toolNameMaps,
            enumerable: false
        });

        // 监控钩子：内部请求转换
        if (this.config?._monitorRequestId) {
            try {
                const { getPluginManager } = await import('../../core/plugin-manager.js');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onInternalRequestConverted', {
                        requestId: this.config._monitorRequestId,
                        internalRequest: request,
                        converterName: 'buildCodewhispererRequest'
                    });
                }
            } catch (e) {
                logger.error('[Kiro] Error calling onInternalRequestConverted hook:', e.message);
            }
        }

        // fs.writeFile('claude-kiro-request'+Date.now()+'.json', JSON.stringify(request));
        return request;
    }

    parseEventStreamChunk(rawData, toolNameMaps = null) {
        const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        let fullContent = '';
        const toolCalls = [];
        let currentToolCallDict = null;
        // 记录被忽略的占位工具调用 id（详见 KIRO_PLACEHOLDER_TOOL_NAME 说明）
        const ignoredToolUseIds = new Set();
        // logger.info(`rawStr=${rawStr}`);

        // 改进的 SSE 事件解析：匹配 :message-typeevent 后面的 JSON 数据
        // 使用更精确的正则来匹配 SSE 格式的事件
        const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
        const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;
        
        // 首先尝试使用 SSE 格式解析
        let matches = [...rawStr.matchAll(sseEventRegex)];
        
        // 如果 SSE 格式没有匹配到，回退到旧的格式
        if (matches.length === 0) {
            matches = [...rawStr.matchAll(legacyEventRegex)];
        }

        for (const match of matches) {
            const potentialJsonBlock = match[1];
            if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) {
                continue;
            }

            // 尝试找到完整的 JSON 对象
            let searchPos = 0;
            while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
                const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
                try {
                    const eventData = JSON.parse(jsonCandidate);

                    // 优先处理结构化工具调用事件
                    if (eventData.name && eventData.toolUseId) {
                        if (eventData.name === KIRO_PLACEHOLDER_TOOL_NAME || ignoredToolUseIds.has(eventData.toolUseId)) {
                            // 占位工具调用：丢弃，不生成真实 tool_use
                            if (!ignoredToolUseIds.has(eventData.toolUseId)) {
                                logger.warn(`[Kiro] Model attempted to call placeholder tool '${KIRO_PLACEHOLDER_TOOL_NAME}'; dropping it (no real tools were available for this request).`);
                                ignoredToolUseIds.add(eventData.toolUseId);
                            }
                        } else {
                            if (!currentToolCallDict) {
                                currentToolCallDict = {
                                    id: eventData.toolUseId,
                                    type: "function",
                                    function: {
                                        name: toolNameMaps?.fromKiroName ? toolNameMaps.fromKiroName(eventData.name) : eventData.name,
                                        arguments: ""
                                    }
                                };
                            }
                            if (eventData.input) {
                                currentToolCallDict.function.arguments += normalizeKiroToolInput(eventData.input);
                            }
                            if (eventData.stop) {
                                try {
                                    const args = JSON.parse(currentToolCallDict.function.arguments);
                                    currentToolCallDict.function.arguments = JSON.stringify(args);
                                } catch (e) {
                                    logger.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                                }
                                toolCalls.push(currentToolCallDict);
                                currentToolCallDict = null;
                            }
                        }
                    } else if (!eventData.followupPrompt && eventData.content) {
                        // 处理内容，保留原始转义序列以便后续解析工具调用
                        fullContent += eventData.content;
                    }
                    break;
                } catch (e) {
                    // JSON 解析失败，继续寻找下一个可能的结束位置
                    continue;
                }
            }
        }
        
        // 如果还有未完成的工具调用，添加到列表中
        if (currentToolCallDict) {
            toolCalls.push(currentToolCallDict);
        }

        // 检查解析后文本中的 bracket 格式工具调用
        const bracketToolCalls = parseBracketToolCalls(fullContent);
        if (bracketToolCalls) {
            toolCalls.push(...bracketToolCalls);
            // 从响应文本中移除工具调用文本
            for (const tc of bracketToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullContent = fullContent.replace(pattern, '');
            }
            fullContent = fullContent.trim();
        }

        const uniqueToolCalls = restoreKiroToolCallNames(deduplicateToolCalls(toolCalls), toolNameMaps);
        return { content: fullContent || '', toolCalls: uniqueToolCalls };
    }
 

    /**
     * 调用 API 并处理错误重试
     */
    async callApi(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        // 处理不同格式的请求体（messages 或 contents）
        let messages = body.messages;
        if (!messages && body.contents) {
            // 将 Gemini 格式的 contents 转换为 messages 格式
            messages = body.contents.map(content => ({
                role: content.role || 'user',
                content: content.parts?.map(part => part.text).join('') || ''
            }));
        }
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new Error('No messages found in request body');
        }

        const requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking, body.output_config, body.reasoning_effort);

        try {
            const token = this.accessToken; // Use the already initialized token
            const headers = {
                'Authorization': `Bearer ${token}`,
                'amz-sdk-invocation-id': `${uuidv4()}`,
                'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
                'x-amz-user-agent': 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI',
                'user-agent': 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 md/appVersion-2.10.0 app/AmazonQ-For-CLI'
            };
            if (token && (token.startsWith('ksk_') || (this.apiKey && token === this.apiKey))) {
                headers['TokenType'] = 'API_KEY';
            }

            // 当 model 以 kiro-amazonq 开头时，使用 amazonQUrl，否则使用 baseUrl
            const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;
            const axiosConfig = {
                method: 'post',
                url: requestUrl,
                data: requestData,
                headers
            };
            this._applySidecar(axiosConfig);
            const releaseThrottle = await acquireKiroRequestSlot(this.config);
            let response;
            try {
                response = await this.axiosInstance.request(axiosConfig);
            } finally {
                releaseThrottle();
            }
            response._kiroToolNameMaps = requestData._kiroToolNameMaps;
            return response;
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // Handle 401 (Unauthorized) - refresh UUID first, then try to refresh token
            if (status === 401 && !isRetry) {
                logger.info('[Kiro] Received 401. Refreshing UUID and triggering background refresh via PoolManager...');
                await normalizeProviderErrorMessage(error, {
                    status: 401,
                    context: 'callApi',
                    suffix: 'triggering auto-refresh'
                });
                
                // 1. 先刷新 UUID
                const newUuid = this._refreshUuid();
                if (newUuid) {
                    logger.info(`[Kiro] UUID refreshed: ${this.uuid} -> ${newUuid}`);
                    this.uuid = newUuid;
                }
                
                // 标记当前凭证为不健康（会自动进入刷新队列）
                this._markCredentialNeedRefresh('401 Unauthorized - Triggering auto-refresh');
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
    
            // Handle 402 (Payment Required / Quota Exceeded) - verify usage and mark as unhealthy with recovery time
            if (status === 402 && !isRetry) {
                await this._handle402Error(error, 'callApi');
            }

            // Handle 403 (Forbidden). Most Kiro 403s are account/policy/quota/profile issues,
            // not expired access tokens, so do not blindly refresh.
            if (status === 403 && !isRetry) {
                this._handleForbiddenCredentialError(error, 'callApi');
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
            
            // Handle 429 (Too Many Requests) - wait baseDelay then switch credential
            if (status === 429) {
                logger.info(`[Kiro] Received 429 (Too Many Requests). Waiting ${baseDelay}ms before switching credential...`);
                await normalizeProviderErrorMessage(error, { status: 429, context: 'callApi' });
                await new Promise(resolve => setTimeout(resolve, baseDelay));
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 5xx server errors - wait baseDelay then switch credential
            if (status >= 500 && status < 600) {
                logger.info(`[Kiro] Received ${status} server error. Waiting ${baseDelay}ms before switching credential...`);
                await normalizeProviderErrorMessage(error, { status, context: 'callApi' });
                await new Promise(resolve => setTimeout(resolve, baseDelay));
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[Kiro] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, model, body, isRetry, retryCount + 1);
            }

            if (error.response && error.response.data) {
                const responseBodyPreview = await getKiroErrorResponsePreview(error);
                if (responseBodyPreview) {
                    logger.error('[Kiro] Error response body:', responseBodyPreview);
                }
            }
            logger.error(`[Kiro] API call failed (Status: ${status}, Code: ${errorCode}):`, error.message);
            throw error;
        }
    }

    async _isRefreshableForbidden(error) {
        const text = (await getNormalizedErrorResponseText(error)).toLowerCase();
        if (!text) return false;

        const nonRefreshablePatterns = [
            'temporarily is suspended',
            'temporarily suspended',
            'disabled',
            'violation of terms',
            'terms of service',
            'appeal',
            'quota',
            'limit exceeded',
            'payment required',
            'not authorized to access',
            'not allowed'
        ];
        if (nonRefreshablePatterns.some(pattern => text.includes(pattern))) {
            return false;
        }

        const tokenRelated = text.includes('token') ||
            text.includes('authorization') ||
            text.includes('authenticate') ||
            text.includes('credential');
        const refreshableAuthState = text.includes('expired') ||
            text.includes('invalid') ||
            text.includes('unauthorized');

        return tokenRelated && refreshableAuthState;
    }

    async _handleForbiddenCredentialError(error, context) {
        const responseText = await getNormalizedErrorResponseText(error);
        await this._applyForbiddenCredentialState(error, context, responseText);
    }

    _buildForbiddenReason(context, responseText, tokenRelated = false) {
        return buildHttpErrorReason(403, context, responseText, {
            suffix: tokenRelated ? 'token-related' : ''
        });
    }

    _buildNormalizedForbiddenError(error, responseText) {
        const responseSnippet = responseText ? responseText.substring(0, 500) : '';

        if (responseSnippet) {
            logger.warn(`[Kiro] 403 response body: ${responseSnippet}`);
        }

        return responseText ? {
            ...error,
            response: {
                ...error?.response,
                data: responseText
            }
        } : error;
    }

    async _applyForbiddenCredentialState(error, context, responseText) {
        const responseSnippet = responseText ? responseText.substring(0, 500) : '';
        if (responseSnippet) {
            logger.warn(`[Kiro] 403 response body (${context}): ${responseSnippet}`);
        }

        const normalizedError = this._buildNormalizedForbiddenError(error, responseText);

        if (await this._isRefreshableForbidden(normalizedError)) {
            const reason = this._buildForbiddenReason(context, responseText, true);
            logger.info(`[Kiro] Received token-related 403 in ${context}. Marking credential as needs refresh.`);
            this._markCredentialNeedRefresh(reason, error);
            error.message = reason;
        } else {
            const reason = this._buildForbiddenReason(context, responseText, false);
            logger.info(`[Kiro] Received non-refreshable 403 in ${context}. Marking credential as unhealthy without refresh.`);
            this._markCredentialUnhealthy(reason, error);
            error.message = reason;
        }
    }

    /**
     * Helper method to refresh the current credential's UUID
     * Used when encountering 401 errors to get a fresh identity
     * @returns {string|null} - The new UUID, or null if refresh failed
     * @private
     */
    _refreshUuid() {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            const newUuid = poolManager.refreshProviderUuid(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            });
            return newUuid;
        } else {
            logger.warn(`[Kiro] Cannot refresh UUID: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return null;
        }
    }

    /**
     * Helper method to mark the current credential as unhealthy
     * @param {string} reason - The reason for marking unhealthy
     * @param {Error} [error] - Optional error object to attach the marker to
     * @returns {boolean} - Whether the credential was successfully marked as unhealthy
     * @private
     */
    _markCredentialNeedRefresh(reason, error = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Kiro] Marking credential ${this.uuid} as needs refresh. Reason: ${reason}`);
            // 使用新的 markProviderNeedRefresh 方法代替 markProviderUnhealthyImmediately
            poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            });
            // Attach marker to error object to prevent duplicate marking in upper layers
            if (error) {
                error.credentialMarkedUnhealthy = true;
            }
            return true;
        } else {
            logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return false;
        }
    }
    
    /**
     * Helper method to mark the current credential as unhealthy
     * @param {string} reason - The reason for marking unhealthy
     * @param {Error} [error] - Optional error object to attach the marker to
     * @returns {boolean} - Whether the credential was successfully marked as unhealthy
     * @private
     */
    _markCredentialUnhealthy(reason, error = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Kiro] Marking credential ${this.uuid} as unhealthy. Reason: ${reason}`);
            poolManager.markProviderUnhealthyImmediately(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            }, reason);
            // Attach marker to error object to prevent duplicate marking in upper layers
            if (error) {
                error.credentialMarkedUnhealthy = true;
            }
            return true;
        } else {
            logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return false;
        }
    }

    /**
     * Helper method to mark the current credential as unhealthy with a scheduled recovery time
     * Used for quota exhaustion (402) where quota resets at a specific time (e.g., 1st of next month)
     * @param {string} reason - The reason for marking unhealthy
     * @param {Error} [error] - Optional error object to attach the marker to
     * @param {Date} [recoveryTime] - The time when the credential should be marked healthy again
     * @returns {boolean} - Whether the credential was successfully marked as unhealthy
     * @private
     */
    _markCredentialUnhealthyWithRecovery(reason, error = null, recoveryTime = null) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Kiro] Marking credential ${this.uuid} as unhealthy with recovery time. Reason: ${reason}, Recovery: ${recoveryTime?.toISOString()}`);
            poolManager.markProviderUnhealthyWithRecoveryTime(this.config.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API, {
                uuid: this.uuid
            }, reason, recoveryTime);
            // Attach marker to error object to prevent duplicate marking in upper layers
            if (error) {
                error.credentialMarkedUnhealthy = true;
            }
            return true;
        } else {
            logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
            return false;
        }
    }

    /**
     * 计算下月1日 00:00:00 UTC 时间
     * @returns {Date} 下月1日的 Date 对象
     * @private
     */
    _getNextMonthFirstDay() {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    }

    /**
     * 处理 402 错误（配额耗尽）
     * 验证用量限制并标记凭证为不健康，设置恢复时间为下月1日
     * @param {Error} error - 原始错误对象
     * @param {string} context - 错误发生的上下文（如 'callApi', 'stream'）
     * @throws {Error} 抛出带有切换凭证标记的错误
     * @private
     */
    async _handle402Error(error, context = 'unknown') {
        logger.info(`[Kiro] Received 402 (Quota Exceeded) in ${context}. Verifying usage limits...`);
        const { reason: verifiedReason } = await normalizeProviderErrorMessage(error, {
            status: 402,
            context,
            suffix: 'quota exceeded'
        });
        try {
            // Verify usage limits to confirm quota exhaustion
            const usageLimits = await this.getUsageLimits();
            const isQuotaExhausted = usageLimits?.usedCount >= usageLimits?.limitCount;
            
            logger.info(`[Kiro] Quota confirmed exhausted: ${usageLimits?.usedCount}/${usageLimits?.limitCount}`);
            // Calculate recovery time: 1st day of next month at 00:00:00 UTC
            const nextMonth = this._getNextMonthFirstDay();
            this._markCredentialUnhealthyWithRecovery(verifiedReason, error, nextMonth);
        } catch (usageError) {
            logger.warn('[Kiro] Failed to verify usage limits:', usageError.message);
            // If we can't verify, still mark as unhealthy with recovery time
            const nextMonth = this._getNextMonthFirstDay();
            const { reason: fallbackReason } = await normalizeProviderErrorMessage(error, {
                status: 402,
                context,
                suffix: 'quota exceeded (unverified)'
            });
            this._markCredentialUnhealthyWithRecovery(fallbackReason, error, nextMonth);
        }
        // Mark error for credential switch without recording error count
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
    }

    _processApiResponse(response) {
        const toolNameMaps = response?._kiroToolNameMaps;
        const rawResponseText = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);
        //logger.info(`[Kiro] Raw response length: ${rawResponseText.length}`);
        if (rawResponseText.includes("[Called")) {
            logger.info("[Kiro] Raw response contains [Called marker.");
        }

        // 1. Parse structured events and bracket calls from parsed content
        const parsedFromEvents = this.parseEventStreamChunk(rawResponseText, toolNameMaps);
        let fullResponseText = parsedFromEvents.content;
        let allToolCalls = [...parsedFromEvents.toolCalls]; // clone
        //logger.info(`[Kiro] Found ${allToolCalls.length} tool calls from event stream parsing.`);

        // 2. Crucial fix from Python example: Parse bracket tool calls from the original raw response
        const rawBracketToolCalls = parseBracketToolCalls(rawResponseText);
        if (rawBracketToolCalls) {
            //logger.info(`[Kiro] Found ${rawBracketToolCalls.length} bracket tool calls in raw response.`);
            allToolCalls.push(...restoreKiroToolCallNames(rawBracketToolCalls, toolNameMaps));
        }

        // 2.5. 兜底过滤：占位工具 no_tool_available 理论上只会走结构化事件分支（已在
        // parseEventStreamChunk 中忽略），这里再兜底一次，防止它以 bracket 文本格式
        // ("[Called no_tool_available with args: {}]") 漏网被当作真实工具调用转发出去。
        const beforePlaceholderFilter = allToolCalls.length;
        allToolCalls = allToolCalls.filter(tc => tc?.function?.name !== KIRO_PLACEHOLDER_TOOL_NAME);
        if (allToolCalls.length !== beforePlaceholderFilter) {
            logger.warn(`[Kiro] Dropped placeholder tool '${KIRO_PLACEHOLDER_TOOL_NAME}' call(s) from non-stream response (no real tools were available for this request).`);
        }

        // 3. Deduplicate all collected tool calls
        const uniqueToolCalls = deduplicateToolCalls(allToolCalls);
        //logger.info(`[Kiro] Total unique tool calls after deduplication: ${uniqueToolCalls.length}`);

        // 4. Clean up response text by removing all tool call syntax from the final text.
        // The text from parseEventStreamChunk is already partially cleaned.
        // We re-clean here with all unique tool calls to be certain.
        if (uniqueToolCalls.length > 0) {
            for (const tc of uniqueToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullResponseText = fullResponseText.replace(pattern, '');
            }
            fullResponseText = fullResponseText.trim();
        }
        
        // 5. Final content cleanup: convert escaped newlines to literal newlines
        fullResponseText = fullResponseText.replace(/(?<!\\)\\n/g, '\n');
        
        //logger.info(`[Kiro] Final response text after tool call cleanup: ${fullResponseText}`);
        //logger.info(`[Kiro] Final tool calls after deduplication: ${JSON.stringify(uniqueToolCalls)}`);
        return { responseText: fullResponseText, toolCalls: uniqueToolCalls };
    }

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }
        
        await this._prepareAccessTokenForRequest('generateContent');
        
        const finalModel = resolveKiroModel(model, this.config);
        logger.info(`[Kiro] Calling generateContent with model: ${finalModel}`);
        
        // Estimate input tokens before making the API call
        const inputTokens = this.estimateInputTokens(requestBody);
        
        const response = await this.callApi('', finalModel, requestBody);

        try {
            const { responseText, toolCalls } = this._processApiResponse(response);

            if (responseText === '' && toolCalls.length === 0) {
                logger.warn('[Kiro] Empty response detected in generateContent (no text/tool calls received from upstream); signalling for retry.');
                throw createKiroEmptyResponseError();
            }

            const thinkingType = requestBody?.thinking?.type;
            const thinkingRequested = typeof thinkingType === 'string' &&
                (thinkingType.toLowerCase() === 'enabled' || thinkingType.toLowerCase() === 'adaptive');
            const contentForClaude = thinkingRequested
                ? this._toClaudeContentBlocksFromKiroText(responseText)
                : responseText;
            return this.buildClaudeResponse(contentForClaude, false, 'assistant', model, toolCalls, inputTokens);
        } catch (error) {
            logger.error('[Kiro] Error in generateContent:', error);
            throw error;
        }
    }

    /**
     * 按 AWS Event Stream 标准帧格式解析（基于 Buffer）。
     * 帧格式: [4B totalLen][4B headersLen][4B preludeCRC][headers][payload][4B msgCRC]
     * 相比旧的 indexOf('{') shape-based 解析，这里按 totalLen 精确切帧，
     * 不会被帧头二进制里的 { 字节误导，彻底解决分片边界导致的卡死。
     * 输入 buffer 为 Buffer；返回 { events, remaining:Buffer }，events 格式与旧解析器一致。
     */
    parseAwsEventStreamBuffer(buffer) {
        const events = [];
        let offset = 0;

        while (true) {
            // 不足一个 prelude(12B)
            if (buffer.length - offset < 12) break;

            const totalLen = buffer.readUInt32BE(offset);
            const headersLen = buffer.readUInt32BE(offset + 4);

            // 帧头合法性检查：非法则丢一字节重新同步（容错）
            if (totalLen < 16 || totalLen > 16 * 1024 * 1024 ||
                headersLen > totalLen - 16) {
                offset += 1;
                continue;
            }

            // 整帧未到齐，等下一个 chunk（处理分片）
            if (buffer.length - offset < totalLen) break;

            const frameStart = offset;
            const headersStart = frameStart + 12;
            const payloadStart = headersStart + headersLen;
            const payloadEnd = frameStart + totalLen - 4; // 末4字节是 msg CRC

            // 从帧头读取权威的 :event-type（type-based 分发的依据）
            const eventType = this._readEventTypeHeader(buffer, headersStart, headersLen);
            const payloadStr = buffer.slice(payloadStart, payloadEnd).toString('utf8');
            offset += totalLen; // 消费这一帧

            let parsed;
            try {
                parsed = JSON.parse(payloadStr);
            } catch (e) {
                // payload 非法 JSON（理论上不应发生），跳过该帧
                logger.warn('[Kiro] Frame payload not valid JSON, skipped: ' + payloadStr.slice(0, 120));
                continue;
            }

            // 事件分类：优先按上游声明的 :event-type 分发（type-based）。
            switch (eventType) {
                case 'assistantResponseEvent':
                    if (parsed.content !== undefined && !parsed.followupPrompt) {
                        events.push({ type: 'content', data: parsed.content });
                    }
                    break;
                case 'reasoningContentEvent':
                    // 思考流，payload 为 {"text":"..."}
                    if (parsed.text !== undefined) {
                        events.push({ type: 'reasoning', data: parsed.text });
                    }
                    break;
                case 'toolUseEvent':
                    // 工具调用：同一个 event-type 下含开始/续传/结束三种，按 payload 字段区分
                    if (parsed.name && parsed.toolUseId) {
                        events.push({
                            type: 'toolUse',
                            data: {
                                name: parsed.name,
                                toolUseId: parsed.toolUseId,
                                input: normalizeKiroToolInput(parsed.input),
                                stop: parsed.stop || false
                            }
                        });
                    } else if (parsed.input !== undefined && !parsed.name) {
                        events.push({
                            type: 'toolUseInput',
                            data: {
                                toolUseId: parsed.toolUseId,
                                input: normalizeKiroToolInput(parsed.input)
                            }
                        });
                    } else if (parsed.stop !== undefined) {
                        events.push({ type: 'toolUseStop', data: { stop: parsed.stop } });
                    }
                    break;
                default:
                    // 无 event-type 头或未知类型：回退到基于 payload 字段的判断（兼容性兵底）。
                    if (parsed.contextUsagePercentage !== undefined) {
                        events.push({ type: 'contextUsage', data: { contextUsagePercentage: parsed.contextUsagePercentage } });
                    } else if (parsed.content !== undefined && !parsed.followupPrompt) {
                        events.push({ type: 'content', data: parsed.content });
                    } else if (parsed.text !== undefined) {
                        events.push({ type: 'reasoning', data: parsed.text });
                    } else if (parsed.name && parsed.toolUseId) {
                        events.push({ type: 'toolUse', data: { name: parsed.name, toolUseId: parsed.toolUseId, input: normalizeKiroToolInput(parsed.input), stop: parsed.stop || false } });
                    } else if (parsed.input !== undefined && !parsed.name) {
                        events.push({ type: 'toolUseInput', data: { toolUseId: parsed.toolUseId, input: normalizeKiroToolInput(parsed.input) } });
                    } else if (parsed.stop !== undefined) {
                        events.push({ type: 'toolUseStop', data: { stop: parsed.stop } });
                    }
                    // {"signature":...} 签名事件、metering 等无内容意义的类型：静默忽略
                    break;
            }
        }

        return { events, remaining: buffer.slice(offset) };
    }

    /**
     * 从 AWS Event Stream 帧的 headers 区读取 :event-type 的值。
     * header 格式: [1B nameLen][name][1B valueType][...]，string 类型(7) 为 [2B valueLen][value]。
     * 解析失败或无此头时返回 null（调用方会回退到 payload 字段判断）。
     */
    _readEventTypeHeader(buffer, start, headersLen) {
        try {
            let p = start;
            const end = start + headersLen;
            while (p < end) {
                const nameLen = buffer.readUInt8(p); p += 1;
                const name = buffer.slice(p, p + nameLen).toString('utf8'); p += nameLen;
                const valueType = buffer.readUInt8(p); p += 1;
                if (valueType === 7) {
                    // string: [2B len][value]
                    const valueLen = buffer.readUInt16BE(p); p += 2;
                    const value = buffer.slice(p, p + valueLen).toString('utf8'); p += valueLen;
                    if (name === ':event-type') return value;
                } else {
                    // 遇到非 string 类型的头（kiro 帧头均为 string），为安全起见中断
                    break;
                }
            }
        } catch (e) { /* 解析失败回退 */ }
        return null;
    }


    /**
     * 真正的流式 API 调用 - 使用 responseType: 'stream'
     */
    async * streamApiReal(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        // 处理不同格式的请求体（messages 或 contents）
        let messages = body.messages;
        if (!messages && body.contents) {
            // 将 Gemini 格式的 contents 转换为 messages 格式
            messages = body.contents.map(content => ({
                role: content.role || 'user',
                content: content.parts?.map(part => part.text).join('') || ''
            }));
        }
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            throw new Error('No messages found in request body');
        }

        const requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking, body.output_config, body.reasoning_effort);
        const toolNameMaps = requestData._kiroToolNameMaps;

        const token = this.accessToken;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'amz-sdk-invocation-id': `${uuidv4()}`,
            'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
            'x-amz-user-agent': 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI',
            'user-agent': 'aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17593 os/linux lang/rust/1.92.0 md/appVersion-2.10.0 app/AmazonQ-For-CLI'
        };
        if (token && (token.startsWith('ksk_') || (this.apiKey && token === this.apiKey))) {
            headers['TokenType'] = 'API_KEY';
        }

        const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;

        let stream = null;
        let releaseThrottle = () => {};
        // catch 需要根据该状态判断能否安全地从头重试，因此必须与 try/catch 同级。
        // 一旦产出过内容，流中途断线就不能重发（会导致内容重复/错位）。
        let hasYieldedContent = false;
        try {
            const axiosConfig = {
                method: 'post',
                url: requestUrl,
                data: requestData,
                headers,
                responseType: 'stream'
            };
            this._applySidecar(axiosConfig);
            releaseThrottle = await acquireKiroRequestSlot(this.config);
            const response = await this.axiosInstance.request(axiosConfig);

            stream = response.data;
            let buffer = Buffer.alloc(0);
            let lastContentEvent = null;  // 用于检测连续重复的 content 事件

            for await (const chunk of stream) {
                const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                buffer = buffer.length === 0 ? chunkBuf : Buffer.concat([buffer, chunkBuf]);
                
                // 按 AWS 标准帧格式解析缓冲区中的事件
                const { events, remaining } = this.parseAwsEventStreamBuffer(buffer);
                buffer = remaining;
                
                // yield 所有事件，但过滤连续完全相同的 content 事件（Kiro API 有时会重复发送）
                for (const event of events) {
                    if (event.type === 'content' && event.data) {
                        // 检查是否与上一个 content 事件完全相同
                        if (lastContentEvent === event.data) {
                            // 跳过重复的内容
                            continue;
                        }
                        lastContentEvent = event.data;
                        hasYieldedContent = true;
                        yield { type: 'content', content: event.data };
                    } else if (event.type === 'reasoning') {
                        hasYieldedContent = true;
                        yield { type: 'reasoning', reasoning: event.data };
                    } else if (event.type === 'toolUse') {
                        hasYieldedContent = true;
                        const toolUse = {
                            ...event.data,
                            name: toolNameMaps?.fromKiroName ? toolNameMaps.fromKiroName(event.data?.name) : event.data?.name
                        };
                        yield { type: 'toolUse', toolUse };
                    } else if (event.type === 'toolUseInput') {
                        hasYieldedContent = true;
                        yield { type: 'toolUseInput', input: event.data.input };
                    } else if (event.type === 'toolUseStop') {
                        yield { type: 'toolUseStop', stop: event.data.stop };
                    } else if (event.type === 'contextUsage') {
                        yield { type: 'contextUsage', contextUsagePercentage: event.data.contextUsagePercentage };
                    }
                }
            }
        } catch (error) {
            // 确保出错时关闭流
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
            
            const status = error.response?.status;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // Handle 401 (Unauthorized) - try to refresh token first
            if (status === 401 && !isRetry) {
                logger.info('[Kiro] Received 401 in stream. Triggering background refresh via PoolManager...');
                await normalizeProviderErrorMessage(error, {
                    status: 401,
                    context: 'stream',
                    suffix: 'triggering auto-refresh'
                });
                
                // 1. 先刷新 UUID
                const newUuid = this._refreshUuid();
                if (newUuid) {
                    logger.info(`[Kiro] UUID refreshed: ${this.uuid} -> ${newUuid}`);
                    this.uuid = newUuid;
                }
                // 标记当前凭证为不健康（会自动进入刷新队列）
                this._markCredentialNeedRefresh('401 Unauthorized in stream - Triggering auto-refresh');
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
            
            // Handle 402 (Payment Required / Quota Exceeded) - verify usage and mark as unhealthy with recovery time
            if (status === 402 && !isRetry) {
                await this._handle402Error(error, 'stream');
            }

            // Handle 403 (Forbidden). Most Kiro 403s are account/policy/quota/profile issues,
            // not expired access tokens, so do not blindly refresh.
            if (status === 403 && !isRetry) {
                await this._handleForbiddenCredentialError(error, 'stream');
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }
            
            // Handle 429 (Too Many Requests) - wait baseDelay then switch credential
            if (status === 429) {
                logger.info(`[Kiro] Received 429 (Too Many Requests) in stream. Waiting ${baseDelay}ms before switching credential...`);
                await normalizeProviderErrorMessage(error, { status: 429, context: 'stream' });
                await new Promise(resolve => setTimeout(resolve, baseDelay));
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle 5xx server errors - wait baseDelay then switch credential
            if (status >= 500 && status < 600) {
                logger.info(`[Kiro] Received ${status} server error in stream. Waiting ${baseDelay}ms before switching credential...`);
                await normalizeProviderErrorMessage(error, { status, context: 'stream' });
                await new Promise(resolve => setTimeout(resolve, baseDelay));
                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            // 只在尚未产出任何内容时才从头重试：若已经 yield 过内容，
            // 从头重发会导致已发送部分与重试响应重复/错位，故中途断线不重试。
            if (isNetworkError && retryCount < maxRetries && !hasYieldedContent) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[Kiro] Network error (${errorIdentifier}) in stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApiReal(method, model, body, isRetry, retryCount + 1);
                return;
            }
            if (isNetworkError && hasYieldedContent) {
                logger.warn(`[Kiro] Network error (${errorCode || 'stream'}) after content already sent; not retrying to avoid duplication. Ending stream.`);
            }

            if (error.response && error.response.data) {
                const responseBodyPreview = await getKiroErrorResponsePreview(error);
                if (responseBodyPreview) {
                    logger.error('[Kiro] Stream error response body:', responseBodyPreview);
                }
            }
            logger.error(`[Kiro] Stream API call failed (Status: ${status}, Code: ${errorCode}):`,  error.message);
            throw error;
        } finally {
            releaseThrottle();
            // 确保流被关闭，释放资源
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
        }
    }

    // 保留旧的非流式方法用于 generateContent
    async streamApi(method, model, body, isRetry = false, retryCount = 0) {
        try {
            return await this.callApi(method, model, body, isRetry, retryCount);
        } catch (error) {
            logger.error('[Kiro] Error calling API:', error);
            throw error;
        }
    }

    // 真正的流式传输实现（内部原始生成器：立即产出 message_start，随后产出实时事件）
    //
    // 注意：这个方法本身不对外暴露——对外的 generateContentStream 是下面的薄包装，
    // 它会缓存这里第一次产出的 message_start，直到确认收到过至少一个有意义的事件
    // （文本/工具调用/思考）才真正转发给调用方。这样即使这里在流结束前检测到
    // 完全空的响应并抛错，调用方也从未收到过任何数据，可以安全地整体重试。
    async * _generateContentStreamRaw(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }
        
        await this._prepareAccessTokenForRequest('generateContentStream');
        
        const finalModel = resolveKiroModel(model, this.config);
        logger.info(`[Kiro] Calling generateContentStream with model: ${finalModel} (real streaming)`);

        let inputTokens = 0;
        let contextUsagePercentage = null;
        const messageId = `${uuidv4()}`;

        const thinkingType = requestBody?.thinking?.type;
        const thinkingRequested = typeof thinkingType === 'string' &&
            (thinkingType.toLowerCase() === 'enabled' || thinkingType.toLowerCase() === 'adaptive');

        const streamState = {
            thinkingRequested,
            buffer: '',
            pendingTextBeforeThinking: '',
            inThinking: false,
            thinkingExtracted: false,
            thinkingBlockIndex: null,
            textBlockIndex: null,
            nextBlockIndex: 0,
            stoppedBlocks: new Set(),
            stripThinkingLeadingNewline: false,
            stripTextLeadingNewlinesAfterThinking: false,
            hasVisibleText: false,
            hasThinkingContent: false,
        };

        const ensureBlockStart = (blockType) => {
            if (blockType === 'thinking') {
                if (streamState.thinkingBlockIndex != null &&
                    !streamState.stoppedBlocks.has(streamState.thinkingBlockIndex)) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.thinkingBlockIndex = idx;
                return [{
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "thinking", thinking: "" }
                }];
            }
            if (blockType === 'text') {
                if (streamState.textBlockIndex != null &&
                    !streamState.stoppedBlocks.has(streamState.textBlockIndex)) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.textBlockIndex = idx;
                return [{
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "text", text: "" }
                }];
            }
            return [];
        };

        const stopBlock = (index) => {
            if (index == null) return [];
            if (streamState.stoppedBlocks.has(index)) return [];
            streamState.stoppedBlocks.add(index);
            return [{ type: "content_block_stop", index }];
        };

        const createTextDeltaEvents = (text) => {
            if (!text) return [];
            if (!isWhitespaceOnly(text)) {
                streamState.hasVisibleText = true;
            }
            const events = [];
            // Anthropic 内容块不能重叠；正文开始前先关闭仍处于打开状态的思考块。
            events.push(...stopBlock(streamState.thinkingBlockIndex));
            events.push(...ensureBlockStart('text'));
            // 将转义的换行符转换为真实换行符，确保流式输出显示正常
            const decodedText = text.replace(/(?<!\\)\\n/g, '\n');
            events.push({
                type: "content_block_delta",
                index: streamState.textBlockIndex,
                delta: { type: "text_delta", text: decodedText }
            });
            return events;
        };

        const createThinkingDeltaEvents = (thinking) => {
            if (thinking) {
                streamState.hasThinkingContent = true;
            }
            const events = [];
            // 兼容内联 <thinking> 出现在正文后的情况，保证任一时刻只有一个内容块打开。
            events.push(...stopBlock(streamState.textBlockIndex));
            events.push(...ensureBlockStart('thinking'));
            // 将转义的换行符转换为真实换行符
            const decodedThinking = thinking.replace(/(?<!\\)\\n/g, '\n');
            events.push({
                type: "content_block_delta",
                index: streamState.thinkingBlockIndex,
                delta: { type: "thinking_delta", thinking: decodedThinking }
            });
            return events;
        };

        function* pushEvents(events) {
            for (const ev of events) {
                yield ev;
            }
        }

        try {
            let totalContent = '';
            let outputTokens = 0;
            const toolCalls = [];
            let currentToolCall = null; // 用于累积结构化工具调用
            const toolUseBlockIndexes = new Map(); // toolUseId -> content block index
            // 记录被忽略的占位工具调用 id（详见 KIRO_PLACEHOLDER_TOOL_NAME 说明）
            const ignoredToolUseIds = new Set();

            const estimatedInputTokens = this.estimateInputTokens(requestBody);

            // 1. 先发送 message_start 事件
            yield {
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    model: model,
                    usage: {
                        input_tokens: estimatedInputTokens,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0
                    },
                    content: []
                }
            };

            // 2. 流式接收并发送每个 content_block_delta
            for await (const event of this.streamApiReal('', finalModel, requestBody)) {
                if (event.type === 'contextUsage' && event.contextUsagePercentage) {
                    // 捕获上下文使用百分比（包含输入和输出的总使用量）
                    contextUsagePercentage = event.contextUsagePercentage;
                } else if (event.type === 'reasoning' && event.reasoning) {
                    // 原生 reasoning 流（reasoningContentEvent）：直接走 thinking 输出通道，
                    // 不经过 <thinking> 标签扫描（新模型的思考不再内联在 content 标签里）。
                    totalContent += event.reasoning;
                    yield* pushEvents(createThinkingDeltaEvents(event.reasoning));
                    continue;
                } else if (event.type === 'content' && event.content) {
                    totalContent += event.content;

                    if (!thinkingRequested) {
                        streamState.buffer += event.content;
                        // 确保不切断转义序列 \\n（如果以 \ 结尾，可能后面跟着 n）
                        if (streamState.buffer.endsWith('\\')) {
                            continue;
                        }
                        yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                        streamState.buffer = '';
                        continue;
                    }

                    streamState.buffer += event.content;
                    const events = [];

                    while (streamState.buffer.length > 0) {
                        if (!streamState.inThinking && !streamState.thinkingExtracted) {
                            const startPos = findRealTag(streamState.buffer, KIRO_THINKING.START_TAG);
                            if (startPos !== -1) {
                                const before = streamState.buffer.slice(0, startPos);
                                const beforeCombined = `${streamState.pendingTextBeforeThinking}${before}`;
                                // Avoid creating meaningless text blocks before thinking.
                                if (beforeCombined && !isWhitespaceOnly(beforeCombined)) {
                                    events.push(...createTextDeltaEvents(beforeCombined));
                                }
                                streamState.pendingTextBeforeThinking = '';

                                streamState.buffer = streamState.buffer.slice(startPos + KIRO_THINKING.START_TAG.length);
                                streamState.inThinking = true;
                                streamState.stripThinkingLeadingNewline = true;
                                continue;
                            }

                            const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.START_TAG.length);
                            if (safeLen > 0) {
                                const safeText = streamState.buffer.slice(0, safeLen);
                                if (safeText) {
                                    if (isWhitespaceOnly(safeText)) {
                                        // Buffer whitespace until we know whether a thinking block appears.
                                        // This prevents a leading text block from being created before thinking.
                                        const maxKeep = 1024;
                                        const remaining = maxKeep - streamState.pendingTextBeforeThinking.length;
                                        if (remaining > 0) {
                                            streamState.pendingTextBeforeThinking += safeText.slice(0, remaining);
                                        }
                                    } else {
                                        const combined = `${streamState.pendingTextBeforeThinking}${safeText}`;
                                        streamState.pendingTextBeforeThinking = '';
                                        events.push(...createTextDeltaEvents(combined));
                                    }
                                }
                                streamState.buffer = streamState.buffer.slice(safeLen);
                            }
                            break;
                        }

                        if (streamState.inThinking) {
                            // Strip a single leading newline after `<thinking>` (may be split across chunks).
                            if (streamState.stripThinkingLeadingNewline) {
                                if (streamState.buffer.startsWith('\r\n')) {
                                    streamState.buffer = streamState.buffer.slice(2);
                                    streamState.stripThinkingLeadingNewline = false;
                                } else if (streamState.buffer.startsWith('\n')) {
                                    streamState.buffer = streamState.buffer.slice(1);
                                    streamState.stripThinkingLeadingNewline = false;
                                } else if (streamState.buffer.length > 0) {
                                    streamState.stripThinkingLeadingNewline = false;
                                }
                            }

                            let endPos = findRealThinkingEndTag(streamState.buffer);
                            if (endPos === -1) endPos = findRealThinkingEndTagAtBufferEnd(streamState.buffer);
                            if (endPos !== -1) {
                                const thinkingPart = streamState.buffer.slice(0, endPos);
                                if (thinkingPart) events.push(...createThinkingDeltaEvents(thinkingPart));

                                streamState.buffer = streamState.buffer.slice(endPos + KIRO_THINKING.END_TAG.length);
                                streamState.inThinking = false;
                                streamState.thinkingExtracted = true;
                                streamState.stripThinkingLeadingNewline = false;

                                events.push(...createThinkingDeltaEvents(""));
                                events.push(...stopBlock(streamState.thinkingBlockIndex));

                                // Strip '\n\n' after the end tag once we switch back to text (may arrive in next chunk).
                                streamState.stripTextLeadingNewlinesAfterThinking = true;
                                continue;
                            }

                            const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.END_TAG.length);
                            if (safeLen > 0) {
                                const safeThinking = streamState.buffer.slice(0, safeLen);
                                if (safeThinking) events.push(...createThinkingDeltaEvents(safeThinking));
                                streamState.buffer = streamState.buffer.slice(safeLen);
                            }
                            break;
                        }

                        if (streamState.thinkingExtracted) {
                            let rest = streamState.buffer;
                            streamState.buffer = '';
                            if (streamState.stripTextLeadingNewlinesAfterThinking) {
                                if (rest.startsWith('\r\n\r\n')) rest = rest.slice(4);
                                else if (rest.startsWith('\n\n')) rest = rest.slice(2);
                                streamState.stripTextLeadingNewlinesAfterThinking = false;
                            }
                            if (rest) events.push(...createTextDeltaEvents(rest));
                            break;
                        }
                    }

                    yield* pushEvents(events);
                } else if (event.type === 'toolUse') {
                    const tc = event.toolUse;

                    // 占位工具 no_tool_available 被"调用"：整条丢弃，不生成任何 tool_use 内容块，
                    // 也不计入 totalContent，避免把这个空操作工具调用转发给客户端导致本轮无实质输出。
                    if (tc.name === KIRO_PLACEHOLDER_TOOL_NAME || (tc.toolUseId && ignoredToolUseIds.has(tc.toolUseId))) {
                        if (tc.toolUseId && !ignoredToolUseIds.has(tc.toolUseId)) {
                            logger.warn(`[Kiro] Model attempted to call placeholder tool '${KIRO_PLACEHOLDER_TOOL_NAME}'; dropping it (no real tools were available for this request).`);
                            ignoredToolUseIds.add(tc.toolUseId);
                        }
                        continue;
                    }

                    const toolEvents = [];

                    // 统计工具调用的内容到 totalContent（用于 token 计算）
                    if (tc.name) totalContent += tc.name;
                    if (tc.input) totalContent += tc.input;

                    // 工具调用事件（包含 name 和 toolUseId）
                    if (tc.name && tc.toolUseId) {
                        // 工具块开始前关闭当前文本/思考块，避免 Anthropic 内容块重叠。
                        toolEvents.push(...stopBlock(streamState.textBlockIndex));
                        toolEvents.push(...stopBlock(streamState.thinkingBlockIndex));

                        // 同一工具调用续传
                        if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
                            currentToolCall.input += tc.input || '';
                        } else {
                            // 切换到新的工具调用前，先收尾旧调用
                            if (currentToolCall) {
                                const prevBlockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                                let parsedInput = currentToolCall.input;
                                try {
                                    parsedInput = JSON.parse(currentToolCall.input);
                                } catch (e) {
                                    // input 不是有效 JSON，保持原样
                                }
                                toolCalls.push({
                                    toolUseId: currentToolCall.toolUseId,
                                    name: currentToolCall.name,
                                    input: parsedInput
                                });
                                if (prevBlockIndex != null) {
                                    toolEvents.push({ type: "content_block_stop", index: prevBlockIndex });
                                    toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                                }
                            }

                            const blockIndex = streamState.nextBlockIndex++;
                            toolUseBlockIndexes.set(tc.toolUseId, blockIndex);
                            toolEvents.push({
                                type: "content_block_start",
                                index: blockIndex,
                                content_block: {
                                    type: "tool_use",
                                    id: tc.toolUseId || `tool_${uuidv4()}`,
                                    name: tc.name,
                                    input: {}
                                }
                            });

                            currentToolCall = {
                                toolUseId: tc.toolUseId,
                                name: tc.name,
                                input: ''
                            };
                            currentToolCall.input += tc.input || '';
                        }

                        // 实时向前端推送工具参数增量
                        if (tc.input) {
                            const blockIndex = toolUseBlockIndexes.get(tc.toolUseId);
                            if (blockIndex != null) {
                                toolEvents.push({
                                    type: "content_block_delta",
                                    index: blockIndex,
                                    delta: {
                                        type: "input_json_delta",
                                        partial_json: tc.input
                                    }
                                });
                            }
                        }

                        // 如果这个事件包含 stop，立即结束当前工具块
                        if (tc.stop && currentToolCall) {
                            let parsedInput = currentToolCall.input;
                            try {
                                parsedInput = JSON.parse(currentToolCall.input);
                            } catch (e) {
                                // input 不是有效 JSON，保持原样
                            }
                            toolCalls.push({
                                toolUseId: currentToolCall.toolUseId,
                                name: currentToolCall.name,
                                input: parsedInput
                            });

                            const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                            if (blockIndex != null) {
                                toolEvents.push({ type: "content_block_stop", index: blockIndex });
                                toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                            }
                            currentToolCall = null;
                        }
                    }

                    if (toolEvents.length > 0) {
                        yield* pushEvents(toolEvents);
                    }
                } else if (event.type === 'toolUseInput') {
                    // 工具调用的 input 续传事件
                    const inputDelta = normalizeKiroToolInput(event.input);
                    // 统计 input 内容到 totalContent（用于 token 计算）
                    if (inputDelta) {
                        totalContent += inputDelta;
                    }
                    if (currentToolCall) {
                        currentToolCall.input += inputDelta;
                        const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                        if (blockIndex != null && inputDelta) {
                            yield* pushEvents([{
                                type: "content_block_delta",
                                index: blockIndex,
                                delta: {
                                    type: "input_json_delta",
                                    partial_json: inputDelta
                                }
                            }]);
                        }
                    }
                } else if (event.type === 'toolUseStop') {
                    // 工具调用结束事件
                    if (currentToolCall && event.stop) {
                        let parsedInput = currentToolCall.input;
                        try {
                            parsedInput = JSON.parse(currentToolCall.input);
                        } catch (e) {
                            // input 不是有效 JSON，保持原样
                        }
                        toolCalls.push({
                            toolUseId: currentToolCall.toolUseId,
                            name: currentToolCall.name,
                            input: parsedInput
                        });

                        const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                        if (blockIndex != null) {
                            yield* pushEvents([{ type: "content_block_stop", index: blockIndex }]);
                            toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                        }
                        currentToolCall = null;
                    }
                }
            }
            
            // 处理未完成的工具调用（如果流提前结束）
            if (currentToolCall) {
                let parsedInput = currentToolCall.input;
                try {
                    parsedInput = JSON.parse(currentToolCall.input);
                } catch (e) {}
                toolCalls.push({
                    toolUseId: currentToolCall.toolUseId,
                    name: currentToolCall.name,
                    input: parsedInput
                });
                const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                if (blockIndex != null) {
                    yield* pushEvents([{ type: "content_block_stop", index: blockIndex }]);
                    toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                }
                currentToolCall = null;
            }

            if (thinkingRequested && (streamState.inThinking || streamState.buffer || streamState.pendingTextBeforeThinking)) {
                if (streamState.inThinking) {
                    logger.warn('[Kiro] Incomplete thinking tag at stream end');
                    // Strip a single leading newline after `<thinking>` if we haven't yet.
                    if (streamState.stripThinkingLeadingNewline) {
                        if (streamState.buffer.startsWith('\r\n')) streamState.buffer = streamState.buffer.slice(2);
                        else if (streamState.buffer.startsWith('\n')) streamState.buffer = streamState.buffer.slice(1);
                        streamState.stripThinkingLeadingNewline = false;
                    }
                    yield* pushEvents(createThinkingDeltaEvents(streamState.buffer));
                    streamState.buffer = '';
                    yield* pushEvents(createThinkingDeltaEvents(""));
                    yield* pushEvents(stopBlock(streamState.thinkingBlockIndex));
                } else if (!streamState.thinkingExtracted) {
                    const remaining = `${streamState.pendingTextBeforeThinking}${streamState.buffer}`;
                    streamState.pendingTextBeforeThinking = '';
                    if (remaining) yield* pushEvents(createTextDeltaEvents(remaining));
                    streamState.buffer = '';
                } else {
                    let remaining = streamState.buffer;
                    streamState.buffer = '';
                    if (streamState.stripTextLeadingNewlinesAfterThinking) {
                        if (remaining.startsWith('\r\n\r\n')) remaining = remaining.slice(4);
                        else if (remaining.startsWith('\n\n')) remaining = remaining.slice(2);
                        streamState.stripTextLeadingNewlinesAfterThinking = false;
                    }
                    if (remaining) yield* pushEvents(createTextDeltaEvents(remaining));
                    streamState.buffer = '';
                }
            } else if (!thinkingRequested && streamState.buffer) {
                // 处理非思考模式下剩余的缓冲区数据
                yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                streamState.buffer = '';
            }

            // 原生 reasoningContentEvent 没有 </thinking> 标签；流尾必须显式关闭其 thinking 块。
            // 若接下来需要为纯思考响应补最小文本块，也要先完成这个 stop。
            yield* pushEvents(stopBlock(streamState.thinkingBlockIndex));

            const emittedOnlyThinking = thinkingRequested &&
                streamState.hasThinkingContent &&
                !streamState.hasVisibleText &&
                toolCalls.length === 0;
            if (emittedOnlyThinking) {
                logger.warn('[Kiro Stream] Thinking-only response received; emitting minimal text block and max_tokens stop_reason');
                yield* pushEvents(createTextDeltaEvents(' '));
            }

            // 真正的空响应：没有文本、没有工具调用、也没有思考内容——Kiro 上游静默地什么都没生成。
            // 不再伪造一次成功的 end_turn，而是抛出可重试的错误，交给上层的凭证切换重试逻辑处理。
            if (totalContent === '' && toolCalls.length === 0 && !emittedOnlyThinking) {
                logger.warn('[Kiro Stream] Empty response detected (no content/toolUse/thinking events received from upstream); signalling for retry.');
                throw createKiroEmptyResponseError();
            }

            yield* pushEvents(stopBlock(streamState.textBlockIndex));

            // 检查文本内容中的 bracket 格式工具调用
            const bracketToolCalls = parseBracketToolCalls(totalContent);
            if (bracketToolCalls && bracketToolCalls.length > 0) {
                for (const btc of bracketToolCalls) {
                    toolCalls.push({
                        toolUseId: btc.id || `tool_${uuidv4()}`,
                        name: btc.function.name,
                        input: JSON.parse(btc.function.arguments || '{}')
                    });
                }
            }

            // 3. 工具调用在流中实时发送，这里不再批量补发

            // 计算 output tokens
            const contentBlocksForCount = thinkingRequested
                ? this._toClaudeContentBlocksFromKiroText(totalContent)
                : [{ type: "text", text: totalContent }];
            const plainForCount = contentBlocksForCount
                .map(b => (b.type === 'thinking' ? (b.thinking ?? '') : (b.text ?? '')))
                .join('');
            outputTokens = this.countTextTokens(plainForCount);

            for (const tc of toolCalls) {
                outputTokens += this.countTextTokens(JSON.stringify(tc.input || {}));
            }

            // 计算 input tokens
            // contextUsagePercentage 是包含输入和输出的总使用量百分比
            // 总 token = TOTAL_CONTEXT_TOKENS * contextUsagePercentage / 100
            // input token = 总 token - output token
            if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
                const contextTokens = getContextTokensForModel(model, this.config, finalModel);
                const totalTokens = Math.round(contextTokens * contextUsagePercentage / 100);
                inputTokens = Math.max(0, totalTokens - outputTokens);
                logger.info(`[Kiro] Token calculation from contextUsagePercentage: total=${totalTokens}, output=${outputTokens}, input=${inputTokens}`);
            } else {
                logger.warn('[Kiro Stream] contextUsagePercentage not received, using estimation');
                inputTokens = estimatedInputTokens;
            }

            // 4. 发送 message_delta 事件
            yield {
                type: "message_delta",
                delta: { stop_reason: toolCalls.length > 0 ? "tool_use" : (emittedOnlyThinking ? "max_tokens" : "end_turn") },
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                }
            };

            // 5. 发送 message_stop 事件
            yield { type: "message_stop" };

        } catch (error) {
            if (!error.isEmptyUpstreamResponse) {
                logger.error('[Kiro] Error in streaming generation:', error?.stack || error?.message || String(error));
            }
            throw error;
        }
    }

    // 对外暴露的流式生成入口：包装 _generateContentStreamRaw，缓存其第一个产出的
    // message_start 事件，直到确认后续确实产出过内容才转发出去。
    //
    // 效果：
    // - 正常有内容的响应：几乎零延迟地把 message_start 和第一个真实事件一起放行，
    //   真实流式体验不受影响。
    // - 完全空的响应：_generateContentStreamRaw 在结束前会抛出
    //   isEmptyUpstreamResponse 错误而不产出第二个事件；此时 message_start 从未被
    //   转发给调用方，调用方（handleStreamRequest）尚未向客户端写入任何数据，
    //   可以安全地整体重试（不会出现同一个 SSE 响应里出现两个 message_start）。
    async * generateContentStream(model, requestBody) {
        const rawGenerator = this._generateContentStreamRaw(model, requestBody);

        const first = await rawGenerator.next();
        if (first.done) {
            return;
        }

        // first.value 预期是 message_start；先缓存，等确认有后续真实事件再一起放行。
        const pendingMessageStart = first.value;
        let flushedMessageStart = false;

        while (true) {
            const { value, done } = await rawGenerator.next();
            if (done) break;

            if (!flushedMessageStart) {
                yield pendingMessageStart;
                flushedMessageStart = true;
            }
            yield value;
        }
    }

    /**
     * Count tokens for a given text using Claude's official tokenizer
     */
    countTextTokens(text) {
        return KiroApiService.countTextTokens(text);
    }

    /**
     * Calculate input tokens from request body using Claude's official tokenizer
     */
    estimateInputTokens(requestBody) {
        return KiroApiService.estimateInputTokens(requestBody);
    }

    /**
     * Build Claude compatible response object
     */
    buildClaudeResponse(content, isStream = false, role = 'assistant', model, toolCalls = null, inputTokens = 0) {
        const messageId = `${uuidv4()}`;

        if (isStream) {
            // Kiro API is "pseudo-streaming", so we'll send a few events to simulate
            // a full Claude stream, but the content/tool_calls will be sent in one go.
            const events = [];

            // 1. message_start event
            events.push({
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: role,
                    model: model,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: 0 // Will be updated in message_delta
                    },
                    content: [] // Content will be streamed via content_block_delta
                }
            });
 
            let totalOutputTokens = 0;
            let stopReason = "end_turn";

            if (content) {
                // If there are tool calls AND content, the content block index should be after tool calls
                const contentBlockIndex = (toolCalls && toolCalls.length > 0) ? toolCalls.length : 0;

                // 2. content_block_start for text
                events.push({
                    type: "content_block_start",
                    index: contentBlockIndex,
                    content_block: {
                        type: "text",
                        text: "" // Initial empty text
                    }
                });
                // 3. content_block_delta for text
                events.push({
                    type: "content_block_delta",
                    index: contentBlockIndex,
                    delta: {
                        type: "text_delta",
                        text: content
                    }
                });
                // 4. content_block_stop
                events.push({
                    type: "content_block_stop",
                    index: contentBlockIndex
                });
                totalOutputTokens += this.countTextTokens(content);
                // If there are tool calls, the stop reason remains "tool_use".
                // If only content, it's "end_turn".
                if (!toolCalls || toolCalls.length === 0) {
                    stopReason = "end_turn";
                }
            }

            if (toolCalls && toolCalls.length > 0) {
                toolCalls.forEach((tc, index) => {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object, need to parse it
                        const args = tc.function.arguments;
                        inputObject = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        logger.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    // 2. content_block_start for each tool_use
                    events.push({
                        type: "content_block_start",
                        index: index,
                        content_block: {
                            type: "tool_use",
                            id: tc.id,
                            name: tc.function.name,
                            input: {} // input is streamed via input_json_delta
                        }
                    });

                    // 3. content_block_delta for each tool_use
                    // Since Kiro is not truly streaming, we send the full arguments as one delta.
                    events.push({
                        type: "content_block_delta",
                        index: index,
                        delta: {
                            type: "input_json_delta",
                            partial_json: JSON.stringify(inputObject)
                        }
                    });

                    // 4. content_block_stop for each tool_use
                    events.push({
                        type: "content_block_stop",
                        index: index
                    });
                    totalOutputTokens += this.countTextTokens(JSON.stringify(inputObject));
                });
                stopReason = "tool_use"; // If there are tool calls, the stop reason is tool_use
            }

            // 5. message_delta with appropriate stop reason
            events.push({
                type: "message_delta",
                delta: {
                    stop_reason: stopReason,
                    stop_sequence: null,
                },
                usage: { output_tokens: totalOutputTokens }
            });

            // 6. message_stop event
            events.push({
                type: "message_stop"
            });

            return events; // Return an array of events for streaming
        } else {
            // Non-streaming response (full message object)
            const contentArray = [];
            let outputTokens = 0;

            // 1) Content blocks (text/thinking) first.
            let hasTextContent = false;
            let hasThinkingContent = false;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (!block || typeof block !== 'object') continue;
                    if (block.type === 'text' && typeof block.text === 'string') {
                        contentArray.push({ type: 'text', text: block.text });
                        outputTokens += this.countTextTokens(block.text);
                        if (!isWhitespaceOnly(block.text)) hasTextContent = true;
                    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                        contentArray.push({ type: 'thinking', thinking: block.thinking });
                        outputTokens += this.countTextTokens(block.thinking);
                        if (block.thinking) hasThinkingContent = true;
                    } else if (typeof block.text === 'string' && block.text) {
                        // Best-effort fallback for unknown blocks carrying plain text.
                        contentArray.push({ type: 'text', text: block.text });
                        outputTokens += this.countTextTokens(block.text);
                        if (!isWhitespaceOnly(block.text)) hasTextContent = true;
                    }
                }
            } else if (content) {
                contentArray.push({ type: "text", text: content });
                outputTokens += this.countTextTokens(content);
                if (!isWhitespaceOnly(content)) hasTextContent = true;
            }

            // 2) Append tool_use blocks (if any).
            let stopReason = "end_turn";
            if (toolCalls && toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object, need to parse it
                        const args = tc.function.arguments;
                        inputObject = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        logger.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    contentArray.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: inputObject
                    });
                    outputTokens += this.countTextTokens(tc.function.arguments);
                }
                stopReason = "tool_use"; // Set stop_reason to "tool_use" when toolCalls exist
            }

            if (hasThinkingContent && !hasTextContent && (!toolCalls || toolCalls.length === 0)) {
                contentArray.push({ type: 'text', text: ' ' });
                outputTokens += this.countTextTokens(' ');
                stopReason = "max_tokens";
            }

            return {
                id: messageId,
                type: "message",
                role: role,
                model: model,
                stop_reason: stopReason,
                stop_sequence: null,
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens
                },
                content: contentArray
            };
        }
    }

    /**
     * List available models
     */
    async listModels() {
        const models = KIRO_MODELS.map(id => ({
            name: id
        }));
        
        return { models: models };
    }

    /**
     * Checks if the token is completely expired (cannot be used at all).
     * @returns {boolean} - True if token is expired, false otherwise.
     */
    isTokenExpired() {
        try {
            if (!this.expiresAt) return true;
            const expirationTime = new Date(this.expiresAt);
            const expirationMs = expirationTime.getTime();
            if (!Number.isFinite(expirationMs)) return true;
            const currentTime = new Date();
            // 给 30 秒缓冲，避免请求过程中过期
            const bufferMs = 30 * 1000;
            return expirationMs <= (currentTime.getTime() + bufferMs);
        } catch (error) {
            logger.error(`[Kiro] Error checking token expiry: ${error.message}`);
            return true; // Treat as expired if parsing fails
        }
    }

    async _prepareAccessTokenForRequest(context) {
        if (this.isTokenExpired()) {
            logger.info(`[Kiro] Token expired before ${context}, refreshing synchronously...`);
            await this.initializeAuth(true);
            return;
        }

        if (this.isExpiryDateNear()) {
            logger.info('[Kiro] Token is near expiry, marking credential as need refresh...');
            this._markCredentialNeedRefresh(`Token near expiry in ${context}`);
        }
    }

    /**
     * Checks if the given expiresAt timestamp is within 10 minutes from now (needs refresh soon).
     * @returns {boolean} - True if expiresAt is less than 10 minutes from now, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const expirationTime = new Date(this.expiresAt);
            const nearMinutes = 30;
            const { message, isNearExpiry } = formatExpiryLog('Kiro', expirationTime.getTime(), nearMinutes);
            logger.info(message);
            return isNearExpiry;
        } catch (error) {
            logger.error(`[Kiro] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`);
            return false; // Treat as expired if parsing fails
        }
    }

    /**
     * 后台异步刷新 token（不阻塞当前请求）
     */
    triggerBackgroundRefresh() {
        logger.info('[Kiro] Background token refresh started...');
        this.initializeAuth(true).then(() => {
            logger.info('[Kiro] Background token refresh completed successfully');
        }).catch((error) => {
            logger.error('[Kiro] Background token refresh failed:', error.message);
            // 后台刷新失败不抛出错误，下次请求会重试
        });
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * POST /v1/messages/count_tokens
     * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
     * @returns {Object} { input_tokens: number }
     */
    countTokens(requestBody) {
        return KiroApiService.countTokens(requestBody);
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();

        // Token 刷新策略：
        // 1. 已过期 → 必须等待刷新
        // 2. 即将过期但还能用 → 后台异步刷新，不阻塞当前请求
        // if (this.isTokenExpired()) {
        //     logger.info('[Kiro] Token is expired, must refresh before getUsageLimits request...');
        //     await this.initializeAuth(true);
        // } else if (this.isExpiryDateNear()) {
        //     logger.info('[Kiro] Token is near expiry, triggering background refresh...');
        //     this.triggerBackgroundRefresh();
        // }
        
        // 内部固定的资源类型
        const resourceType = 'AGENTIC_REQUEST';
        
        // 构建请求 URL
        let usageLimitsUrl = this.baseUrl;
        usageLimitsUrl = usageLimitsUrl.replace('generateAssistantResponse', 'getUsageLimits');
        const params = new URLSearchParams({
            isEmailRequired: 'true',
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
            resourceType: resourceType
        });
         if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) {
            params.append('profileArn', this.profileArn);
        }
        const fullUrl = `${usageLimitsUrl}?${params.toString()}`;

        // 动态生成 headers
        const machineId = generateMachineIdFromConfig({
            uuid: this.uuid,
            profileArn: this.profileArn,
            clientId: this.clientId
        });
        const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;
        const { osName, nodeVersion } = getSystemRuntimeInfo();

        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            'x-amz-user-agent': `aws-sdk-js/1.0.34 KiroIDE-${kiroVersion}-${machineId}`,
            'user-agent': `aws-sdk-js/1.0.34 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${kiroVersion}-${machineId}`,
            'amz-sdk-invocation-id': uuidv4(),
            'amz-sdk-request': 'attempt=1; max=1',
            'Connection': 'close'
        };
        if (this.accessToken && (this.accessToken.startsWith('ksk_') || (this.apiKey && this.accessToken === this.apiKey))) {
            headers['TokenType'] = 'API_KEY';
        }

        const axiosConfig = {
            method: 'get',
            url: fullUrl,
            headers
        };
        this._applySidecar(axiosConfig);

        try {
            const response = await this.axiosInstance.request(axiosConfig);
            logger.info('[Kiro] Usage limits fetched successfully');
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            
            // 从响应体中提取错误信息
            let errorMessage = error.message;
            if (error.response?.data) {
                // 尝试从响应体中获取错误描述
                const responseData = error.response.data;
                if (typeof responseData === 'string') {
                    errorMessage = responseData;
                } else if (responseData.message) {
                    errorMessage = responseData.message;
                } else if (responseData.error) {
                    errorMessage = typeof responseData.error === 'string' ? responseData.error : responseData.error.message || JSON.stringify(responseData.error);
                }
            }
            
            // 构建包含状态码和错误描述的错误信息
            const formattedError = status
                ? new Error(`API call failed: ${status} - ${errorMessage}`)
                : new Error(`API call failed: ${errorMessage}`);
            
            // 对于用量查询，401/403 错误直接标记凭证为不健康，不重试
            if (status === 401) {
                logger.info('[Kiro] Received 401 on getUsageLimits. Marking credential as unhealthy (no retry)...');
                this._markCredentialNeedRefresh('401 Unauthorized on usage query', formattedError);
                throw formattedError;
            }
            
            if (status === 403) {
                this._handleForbiddenCredentialError(error, 'usage query');
                formattedError.credentialMarkedUnhealthy = true;
                throw formattedError;
            }
            
            logger.error('[Kiro] Failed to fetch usage limits:', formattedError.message, error);
            throw formattedError;
        }
    }
}
