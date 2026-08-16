/**
 * iFlow API Service
 *
 * iFlow 是一个 AI 服务平台，提供 OpenAI 兼容的 API 接口。
 * 使用 Token 文件方式认证 - 从文件读取 API Key
 *
 * 支持的模型：
 * - Qwen 系列: qwen3-max, qwen3-coder-plus, qwen3-vl-plus, qwen3-235b 等
 * - Kimi 系列: kimi-k2, kimi-k2-0905
 * - DeepSeek 系列: deepseek-v3, deepseek-v3.2, deepseek-r1
 * - GLM 系列: glm-4.6
 *
 * 支持的特殊模型配置：
 * - GLM-4.x: 使用 chat_template_kwargs.enable_thinking
 * - Qwen thinking 模型: 内置推理能力
 * - DeepSeek R1: 内置推理能力
 */

import { atomicWriteFile } from '../../utils/file-lock.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import * as http from 'http';
import * as https from 'https';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { configureAxiosProxy } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER, formatExpiryLog, getRetryAfterMs } from '../../utils/common.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { getProviderModels, IFLOW_MANUAL_MODELS } from '../provider-models.js';

// iFlow API 端点
const IFLOW_API_BASE_URL = 'https://apis.iflow.cn/v1';
const IFLOW_USER_AGENT = 'iFlow-Cli';
const IFLOW_OAUTH_TOKEN_ENDPOINT = 'https://iflow.cn/oauth/token';
const IFLOW_USER_INFO_ENDPOINT = 'https://iflow.cn/api/oauth/getUserInfo';
const IFLOW_OAUTH_CLIENT_ID = '10009311001';
const IFLOW_OAUTH_CLIENT_SECRET = '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW';

// 默认模型列表
const IFLOW_MODELS = getProviderModels(MODEL_PROVIDER.IFLOW_API);

// 支持 thinking 的模型前缀
const THINKING_MODEL_PREFIXES = ['glm-', 'qwen3-235b-a22b-thinking', 'deepseek-r1'];

// ==================== Token 管理 ====================

/**
 * iFlow Token 存储类
 */
class IFlowTokenStorage {
    constructor(data = {}) {
        this.accessToken = data.accessToken || data.access_token || '';
        this.refreshToken = data.refreshToken || data.refresh_token || '';
        this.expiryDate = data.expiryDate || data.expiry_date || '';
        this.apiKey = data.apiKey || data.api_key || '';
        this.tokenType = data.tokenType || data.token_type || '';
        this.scope = data.scope || '';
    }

    /**
     * 转换为 JSON 对象
     */
    toJSON() {
        return {
            access_token: this.accessToken,
            refresh_token: this.refreshToken,
            expiry_date: this.expiryDate,
            token_type: this.tokenType,
            scope: this.scope,
            apiKey: this.apiKey
        };
    }

    /**
     * 从 JSON 对象创建实例
     */
    static fromJSON(json) {
        return new IFlowTokenStorage(json);
    }
}

/**
 * 从文件加载 Token
 * @param {string} filePath - Token 文件路径
 * @returns {Promise<IFlowTokenStorage|null>}
 */
async function loadTokenFromFile(filePath) {
    try {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(process.cwd(), filePath);
        
        const data = await fs.readFile(absolutePath, 'utf-8');
        const json = JSON.parse(data);
        
        // 记录加载的 token 信息
        const refreshToken = json.refreshToken || json.refresh_token || '';
        logger.info(`[iFlow] Token loaded from: ${filePath} (refresh_token: ${refreshToken ? refreshToken.substring(0, 8) + '...' : 'EMPTY'})`);
        
        return IFlowTokenStorage.fromJSON(json);
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn(`[iFlow] Token file not found: ${filePath}`);
            return null;
        }
        throw new Error(`[iFlow] Failed to load token from file: ${error.message}`);
    }
}

/**
 * 保存 Token 到文件
 * @param {string} filePath - Token 文件路径
 * @param {IFlowTokenStorage} tokenStorage - Token 存储对象
 */
async function saveTokenToFile(filePath, tokenStorage, uuid = null) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), filePath);

    try {
        // 确保目录存在
        const dir = path.dirname(absolutePath);
        await fs.mkdir(dir, { recursive: true });

        // 写入文件
        const json = tokenStorage.toJSON();

        // 验证关键字段是否存在
        if (!json.refresh_token || json.refresh_token.trim() === '') {
            logger.error('[iFlow] WARNING: Attempting to save token file with empty refresh_token!');
        }
        if (!json.apiKey || json.apiKey.trim() === '') {
            logger.error('[iFlow] WARNING: Attempting to save token file with empty apiKey!');
        }

        await atomicWriteFile(absolutePath, JSON.stringify(json, null, 2), { encoding: 'utf-8', mode: 0o600 });

        logger.info(`[iFlow] Token saved to: ${filePath} (refresh_token: ${json.refresh_token ? json.refresh_token.substring(0, 8) + '...' : 'EMPTY'})`);
    } catch (error) {
        throw new Error(`[iFlow] Failed to save token to file: ${error.message}`);
    }
}

// ==================== Token 刷新逻辑 ====================

/**
 * 使用 refresh_token 刷新 OAuth Token
 * @param {string} refreshToken - 刷新令牌
 * @param {Object} axiosInstance - axios 实例（可选，用于代理配置）
 * @returns {Promise<Object>} - 新的 Token 数据
 */
async function refreshOAuthTokens(refreshToken, axiosInstance = null) {
    if (!refreshToken || refreshToken.trim() === '') {
        throw new Error('[iFlow] refresh_token is empty');
    }
    
    logger.info('[iFlow] Refreshing OAuth tokens...');
    
    // 构建请求参数
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);
    params.append('client_id', IFLOW_OAUTH_CLIENT_ID);
    params.append('client_secret', IFLOW_OAUTH_CLIENT_SECRET);
    
    // 构建 Basic Auth header
    const basicAuth = Buffer.from(`${IFLOW_OAUTH_CLIENT_ID}:${IFLOW_OAUTH_CLIENT_SECRET}`).toString('base64');
    
    const requestConfig = {
        method: 'POST',
        url: IFLOW_OAUTH_TOKEN_ENDPOINT,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Authorization': `Basic ${basicAuth}`
        },
        data: params.toString(),
        timeout: 30000
    };
    
    try {
        const response = axiosInstance
            ? await axiosInstance.request(requestConfig)
            : await axios.request(requestConfig);
        
        const tokenResp = response.data;
        
        // logger.info('[iFlow] Token response:', JSON.stringify(tokenResp));
        if (!tokenResp.access_token) {
            logger.error('[iFlow] Token response:', JSON.stringify(tokenResp));
            throw new Error('[iFlow] Missing access_token in response');
        }
        
        // 计算过期时间（毫秒级时间戳）
        const expiresIn = tokenResp.expires_in || 3600;
        const expireTimestamp = Date.now() + expiresIn * 1000;
        
        const tokenData = {
            accessToken: tokenResp.access_token,
            refreshToken: tokenResp.refresh_token || refreshToken,
            tokenType: tokenResp.token_type || 'Bearer',
            scope: tokenResp.scope || '',
            expiryDate: expireTimestamp // 毫秒级时间戳
        };
        
        logger.info('[iFlow] OAuth tokens refreshed successfully');
        
        // 获取用户信息以获取 API Key
        const userInfo = await fetchUserInfo(tokenData.accessToken, axiosInstance);
        if (userInfo && userInfo.apiKey) {
            tokenData.apiKey = userInfo.apiKey;
            tokenData.email = userInfo.email || userInfo.phone || '';
        }
        
        return tokenData;
    } catch (error) {
        const status = error.response?.status;
        const data = error.response?.data;
        logger.error(`[iFlow] OAuth token refresh failed (Status: ${status}):`, data || error.message);
        throw error;
    }
}

/**
 * 获取用户信息（包含 API Key）
 * @param {string} accessToken - 访问令牌
 * @param {Object} axiosInstance - axios 实例（可选）
 * @returns {Promise<Object>} - 用户信息
 */
async function fetchUserInfo(accessToken, axiosInstance = null) {
    if (!accessToken || accessToken.trim() === '') {
        throw new Error('[iFlow] access_token is empty');
    }
    
    const url = `${IFLOW_USER_INFO_ENDPOINT}?accessToken=${encodeURIComponent(accessToken)}`;
    
    const requestConfig = {
        method: 'GET',
        url,
        headers: {
            'Accept': 'application/json'
        },
        timeout: 30000
    };
    
    try {
        const response = axiosInstance
            ? await axiosInstance.request(requestConfig)
            : await axios.request(requestConfig);
        
        const result = response.data;
        // logger.info('[iFlow] User info response:', JSON.stringify(result));
        if (!result.success) {
            throw new Error('[iFlow] User info request not successful');
        }
        
        if (!result.data || !result.data.apiKey) {
            throw new Error('[iFlow] Missing apiKey in user info response');
        }
        
        return {
            apiKey: result.data.apiKey,
            email: result.data.email || '',
            phone: result.data.phone || ''
        };
    } catch (error) {
        const status = error.response?.status;
        const data = error.response?.data;
        logger.error(`[iFlow] Fetch user info failed (Status: ${status}):`, data || error.message);
        throw error;
    }
}

// ==================== 请求处理工具函数 ====================

/**
 * 生成 UUID v4
 * @returns {string} - UUID 字符串
 */
function generateUUID() {
    return crypto.randomUUID();
}

/**
 * 创建 iFlow 签名
 * 签名格式: HMAC-SHA256(userAgent:sessionId:timestamp, apiKey)
 * @param {string} userAgent - User-Agent
 * @param {string} sessionID - Session ID
 * @param {number} timestamp - 时间戳（毫秒）
 * @param {string} apiKey - API Key
 * @returns {string} - 十六进制签名
 */
function createIFlowSignature(userAgent, sessionID, timestamp, apiKey) {
    if (!apiKey) {
        return '';
    }
    const payload = `${userAgent}:${sessionID}:${timestamp}`;
    const hmac = crypto.createHmac('sha256', apiKey);
    hmac.update(payload);
    return hmac.digest('hex');
}

/**
 * 检查模型是否支持 thinking 配置
 * @param {string} model - 模型名称
 * @returns {boolean}
 */
function isThinkingModel(model) {
    if (!model) return false;
    const lowerModel = model.toLowerCase();
    return THINKING_MODEL_PREFIXES.some(prefix => lowerModel.startsWith(prefix));
}

/**
 * 应用 iFlow 特定的 thinking 配置
 * 将 reasoning_effort 转换为模型特定的配置
 *
 * @param {Object} body - 请求体
 * @param {string} model - 模型名称
 * @returns {Object} - 处理后的请求体
 */
function applyIFlowThinkingConfig(body, model) {
    if (!body || !model) return body;
    
    const lowerModel = model.toLowerCase();
    const reasoningEffort = body.reasoning_effort;
    
    // 如果没有 reasoning_effort，直接返回
    if (reasoningEffort === undefined) return body;
    
    const enableThinking = reasoningEffort !== 'none' && reasoningEffort !== '';
    
    // 创建新对象，移除 reasoning_effort 和 thinking
    const newBody = { ...body };
    delete newBody.reasoning_effort;
    delete newBody.thinking;
    
    // GLM-4.x: 使用 chat_template_kwargs
    if (lowerModel.startsWith('glm-4')) {
        newBody.chat_template_kwargs = {
            ...(newBody.chat_template_kwargs || {}),
            enable_thinking: enableThinking
        };
        if (enableThinking) {
            newBody.chat_template_kwargs.clear_thinking = false;
        }
        return newBody;
    }
    
    // Qwen thinking 模型: 保持 thinking 配置
    if (lowerModel.includes('thinking')) {
        // Qwen thinking 模型默认启用 thinking，不需要额外配置
        return newBody;
    }
    
    // DeepSeek R1: 推理模型，不需要额外配置
    if (lowerModel.startsWith('deepseek-r1')) {
        return newBody;
    }
    
    return newBody;
}

/**
 * 保留消息历史中的 reasoning_content
 * 对于支持 thinking 的模型，保留 assistant 消息中的 reasoning_content
 *
 * 对于 GLM-4.6/4.7 和 MiniMax M2/M2.1，建议在消息历史中包含完整的 assistant
 * 响应（包括 reasoning_content）以保持更好的上下文连续性。
 *
 * @param {Object} body - 请求体
 * @param {string} model - 模型名称
 * @returns {Object} - 处理后的请求体
 */
function preserveReasoningContentInMessages(body, model) {
    if (!body || !model) return body;
    
    const lowerModel = model.toLowerCase();
    
    // 只对支持 thinking 且需要历史保留的模型应用
    const needsPreservation = lowerModel.startsWith('glm-4') ||
                              lowerModel.startsWith('minimax-m2');
    
    if (!needsPreservation) {
        return body;
    }
    
    const messages = body.messages;
    if (!Array.isArray(messages)) return body;
    
    // 检查是否有 assistant 消息包含 reasoning_content
    const hasReasoningContent = messages.some(msg =>
        msg.role === 'assistant' && msg.reasoning_content && msg.reasoning_content !== ''
    );
    
    // 如果 reasoning content 已经存在，说明消息格式正确
    // 客户端已经正确地在历史中保留了推理内容
    if (hasReasoningContent) {
        logger.debug(`[iFlow] reasoning_content found in message history for ${model}`);
    }
    
    return body;
}

/**
 * 确保 tools 数组存在（避免某些模型的问题）
 * 如果 tools 是空数组，添加一个占位工具
 * 
 * @param {Object} body - 请求体
 * @returns {Object} - 处理后的请求体
 */
function ensureToolsArray(body) {
    if (!body || !body.tools) return body;
    
    if (Array.isArray(body.tools) && body.tools.length === 0) {
        return {
            ...body,
            tools: [{
                type: 'function',
                function: {
                    name: 'noop',
                    description: 'Placeholder tool to stabilise streaming',
                    parameters: { type: 'object' }
                }
            }]
        };
    }
    
    return body;
}

/**
 * 预处理请求体
 * @param {Object} body - 原始请求体
 * @param {string} model - 模型名称
 * @returns {Object} - 处理后的请求体
 */
function preprocessRequestBody(body, model, config = {}) {
    // 确保模型名称有效，如果不存在则使用默认模型
    let targetModel = model;
    if (Array.isArray(IFLOW_MODELS) && IFLOW_MODELS.length > 0) {
        if (!IFLOW_MODELS.includes(model)) {
            if (config.MODEL_FALLBACK_ENABLED === false) {
                throw new Error(`[iFlow] 模型不存在: ${model}`);
            }
            logger.warn(`[iFlow] Model "${model}" not found in IFLOW_MODELS, defaulting to "${IFLOW_MODELS[0]}"`);
            targetModel = IFLOW_MODELS[0];
        }
    }

    let processedBody = { ...body };
    
    // 确保模型名称正确
    processedBody.model = targetModel;
    
    // 应用 iFlow thinking 配置
    processedBody = applyIFlowThinkingConfig(processedBody, targetModel);
    
    // 保留 reasoning_content
    processedBody = preserveReasoningContentInMessages(processedBody, targetModel);
    
    // 确保 tools 数组
    processedBody = ensureToolsArray(processedBody);
    
    return processedBody;
}

// ==================== API 服务 ====================

/**
 * iFlow API 服务类
 */
// 默认 Token 文件路径
const DEFAULT_TOKEN_FILE_PATH = path.join(os.homedir(), '.iflow', 'oauth_creds.json');

export class IFlowApiService {
    constructor(config) {
        this.config = config;
        this.apiKey = null;
        this.baseUrl = config.IFLOW_BASE_URL || IFLOW_API_BASE_URL;
        this.tokenFilePath = config.IFLOW_TOKEN_FILE_PATH || DEFAULT_TOKEN_FILE_PATH;
        this.uuid = config.uuid; // 保存 uuid 用于缓存管理
        this.isInitialized = false;
        this.tokenStorage = null;

        // 配置 HTTP/HTTPS agent
        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });

        const axiosConfig = {
            baseURL: this.baseUrl,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': IFLOW_USER_AGENT,
            },
        };

        // 配置自定义代理
        configureAxiosProxy(axiosConfig, config, 'openai-iflow');

        this.axiosInstance = axios.create(axiosConfig);
    }

    /**
     * 初始化服务
     */
    async initialize() {
        if (this.isInitialized) return;
        
        logger.info('[iFlow] Initializing iFlow API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();
        
        this.isInitialized = true;
        logger.info('[iFlow] Initialization complete.');
    }

    /**
     * 加载凭证信息（不执行刷新）
     */
    async loadCredentials() {
        try {
            // 从文件加载
            this.tokenStorage = await loadTokenFromFile(this.tokenFilePath);
            if (this.tokenStorage && this.tokenStorage.apiKey) {
                this.apiKey = this.tokenStorage.apiKey;
                // 更新 axios 实例的 Authorization header
                this.axiosInstance.defaults.headers['Authorization'] = `Bearer ${this.apiKey}`;
                logger.info('[iFlow Auth] Credentials loaded successfully from file');
            }
        } catch (error) {
            logger.warn(`[iFlow Auth] Failed to load credentials from file: ${error.message}`);
        }
    }

    /**
     * 初始化认证并执行必要刷新
     * @param {boolean} forceRefresh - 是否强制刷新 Token
     */
    async initializeAuth(forceRefresh = false) {
        // 首先执行基础凭证加载
        await this.loadCredentials();

        // 如果已有 API Key 且不强制刷新且未过期，直接返回
        if (this.apiKey && !forceRefresh) return;

        // 从 Token 文件加载 API Key
        if (!this.tokenFilePath) {
            throw new Error('[iFlow] IFLOW_TOKEN_FILE_PATH is required.');
        }

        try {
            // 从文件加载
            if (!this.tokenStorage) {
                this.tokenStorage = await loadTokenFromFile(this.tokenFilePath);
                logger.info('[iFlow Auth] Loaded credentials from file');
            }

            if (this.tokenStorage && this.tokenStorage.apiKey) {
                this.apiKey = this.tokenStorage.apiKey;
                logger.info('[iFlow Auth] Authentication configured successfully from file.');

                if (forceRefresh) {
                    logger.info('[iFlow Auth] Forcing token refresh...');
                    await this._refreshOAuthTokens();
                    logger.info('[iFlow Auth] Token refreshed and saved successfully.');

                    // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
                    const poolManager = getProviderPoolManager();
                    if (poolManager && this.uuid) {
                        poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.IFLOW_API, this.uuid);
                    }
                }
            } else {
                throw new Error('[iFlow] No refresh token available in credentials.');
            }
        } catch (error) {
            logger.error('[iFlow Auth] Failed to initialize authentication:', error.message);
            throw new Error(`[iFlow Auth] Failed to load OAuth credentials.`);
        }
    }

    /**
     * 检查是否需要刷新 Token 并执行刷新
     * @returns {Promise<boolean>} - 是否执行了刷新
     */
    async _checkAndRefreshTokenIfNeeded() {
        if (!this.tokenStorage) {
            return false;
        }

        // 检查是否有 refresh_token
        if (!this.tokenStorage.refreshToken || this.tokenStorage.refreshToken.trim() === '') {
            logger.info('[iFlow] No refresh_token available, skipping token refresh check');
            return false;
        }

        // 使用 isExpiryDateNear 检查过期时间
        // if (!this.isExpiryDateNear()) {
        //     logger.info('[iFlow] Token is valid, no refresh needed');
        //     return false;
        // }

        logger.info('[iFlow] Token is expiring soon, attempting refresh...');

        try {
            await this._refreshOAuthTokens();
            return true;
        } catch (error) {
            logger.error('[iFlow] Token refresh failed:', error.message);
            // 刷新失败不抛出异常，继续使用现有 Token
            return false;
        }
    }

    /**
     * 使用 refresh_token 刷新 OAuth Token
     * @returns {Promise<void>}
     */
    async _refreshOAuthTokens() {
        if (!this.tokenStorage || !this.tokenStorage.refreshToken) {
            throw new Error('[iFlow] No refresh_token available');
        }
        
        const oldAccessToken = this.tokenStorage.accessToken;
        if (oldAccessToken) {
            logger.info(`[iFlow] Refreshing access token, old: ${this._maskToken(oldAccessToken)}`);
        }
        
        // 调用刷新函数
        const oldRefreshToken = this.tokenStorage.refreshToken;
        const tokenData = await refreshOAuthTokens(oldRefreshToken, this.axiosInstance);
        
        // 更新 tokenStorage - 必须更新 refreshToken，因为 OAuth 服务器可能返回新的 refresh_token
        this.tokenStorage.accessToken = tokenData.accessToken;
        // 始终更新 refreshToken，即使服务器没有返回新的（tokenData.refreshToken 会回退到旧值）
        this.tokenStorage.refreshToken = tokenData.refreshToken;
        
        // 记录 refresh_token 是否发生变化
        if (tokenData.refreshToken !== oldRefreshToken) {
            logger.info(`[iFlow] refresh_token has been rotated (old: ${this._maskToken(oldRefreshToken)}, new: ${this._maskToken(tokenData.refreshToken)})`);
        }
        if (tokenData.apiKey) {
            this.tokenStorage.apiKey = tokenData.apiKey;
            this.apiKey = tokenData.apiKey;
        }
        this.tokenStorage.expiryDate = tokenData.expiryDate;
        this.tokenStorage.tokenType = tokenData.tokenType || 'Bearer';
        this.tokenStorage.scope = tokenData.scope || '';
        if (tokenData.email) {
            this.tokenStorage.email = tokenData.email;
        }
        
        // 更新 axios 实例的 Authorization header
        this.axiosInstance.defaults.headers['Authorization'] = `Bearer ${this.apiKey}`;
        
        // 保存到文件
        await saveTokenToFile(this.tokenFilePath, this.tokenStorage, this.uuid);
        
        logger.info(`[iFlow] Token refresh successful, new: ${this._maskToken(tokenData.accessToken)}`);
    }

    /**
     * 掩码 Token（只显示前后几个字符）
     * @param {string} token - Token 字符串
     * @returns {string} - 掩码后的 Token
     */
    _maskToken(token) {
        if (!token || token.length < 10) {
            return '***';
        }
        return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
    }

    /**
     * 手动刷新 Token（供外部调用）
     * @returns {Promise<boolean>} - 是否刷新成功
     */
    async refreshToken() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        
        try {
            await this._refreshOAuthTokens();
            return true;
        } catch (error) {
            logger.error('[iFlow] Manual token refresh failed:', error.message);
            return false;
        }
    }

    /**
     * Checks if the given expiry date is within the threshold from now or already expired.
     * @returns {boolean} True if the expiry date is within the threshold or already expired, false otherwise.
     */
    isExpiryDateNear() {
        try {
            if (!this.tokenStorage || !this.tokenStorage.expiryDate) {
                return false;
            }
            
            // 授权文件时效48小时，判断是否过期或接近过期 （45小时）
            const cronNearMinutes = 60 * 45;
            
            // 解析过期时间
            let expireTime;
            const expireValue = this.tokenStorage.expiryDate;
            
            // 检查是否为数字（毫秒时间戳）
            if (typeof expireValue === 'number') {
                expireTime = expireValue;
            } else if (typeof expireValue === 'string') {
                // 检查是否为纯数字字符串（毫秒时间戳）
                if (/^\d+$/.test(expireValue)) {
                    expireTime = parseInt(expireValue, 10);
                } else if (expireValue.includes('T')) {
                    // ISO 8601 格式
                    expireTime = new Date(expireValue).getTime();
                } else {
                    // 格式：2006-01-02 15:04
                    expireTime = new Date(expireValue.replace(' ', 'T') + ':00').getTime();
                }
            } else {
                logger.error(`[iFlow] Invalid expiry date type: ${typeof expireValue}`);
                return false;
            }
            
            if (isNaN(expireTime)) {
                logger.error(`[iFlow] Error parsing expiry date: ${expireValue}`);
                return false;
            }
            
            const { message, isNearExpiry } = formatExpiryLog('iFlow', expireTime, cronNearMinutes);
            logger.info(message);
            
            return isNearExpiry;
        } catch (error) {
            logger.error(`[iFlow] Error checking expiry date: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取请求头
     * @param {boolean} stream - 是否为流式请求
     * @returns {Object} - 请求头
     */
    _getHeaders(stream = false) {
        // 生成 session-id
        const sessionID = 'session-' + generateUUID();
        
        // 生成时间戳（毫秒）
        const timestamp = Date.now();
        
        // 生成签名
        const signature = createIFlowSignature(IFLOW_USER_AGENT, sessionID, timestamp, this.apiKey);
        
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'User-Agent': IFLOW_USER_AGENT,
            'session-id': sessionID,
            'x-iflow-timestamp': timestamp.toString(),
        };
        
        // 只有在签名生成成功时才添加
        if (signature) {
            headers['x-iflow-signature'] = signature;
        }
        
        if (stream) {
            headers['Accept'] = 'text/event-stream';
        } else {
            headers['Accept'] = 'application/json';
        }
        
        return headers;
    }

    /**
     * 调用 API
     */
    async callApi(endpoint, body, model, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        // 预处理请求体
        const processedBody = preprocessRequestBody(body, model, this.config);

        try {
            const response = await this.axiosInstance.post(endpoint, processedBody, {
                headers: this._getHeaders(false)
            });
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // Handle 401/400 - refresh auth and retry once
            if ((status === 400 || status === 401) && !isRetry) {
                logger.info(`[iFlow] Received ${status}. Triggering background refresh via PoolManager...`);
                
                // 标记当前凭证为不健康（会自动进入刷新队列）
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    logger.info(`[iFlow] Marking credential ${this.uuid} as needs refresh. Reason: ${status} Unauthorized`);
                    poolManager.markProviderNeedRefresh(MODEL_PROVIDER.IFLOW_API, {
                        uuid: this.uuid
                    });
                    error.credentialMarkedUnhealthy = true;
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            if (status === 401 || status === 403) {
                logger.error(`[iFlow] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[iFlow] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[iFlow] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, model, isRetry, retryCount + 1);
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[iFlow] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, model, isRetry, retryCount + 1);
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[iFlow] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, model, isRetry, retryCount + 1);
            }

            logger.error(`[iFlow] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    /**
     * 流式调用 API
     *
     * - 使用大缓冲区处理长行
     * - 逐行处理 SSE 数据
     * - 正确处理 data: 前缀和 [DONE] 标记
     */
    async *streamApi(endpoint, body, model, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;

        // 预处理请求体并设置 stream: true
        const processedBody = preprocessRequestBody({ ...body, stream: true }, model, this.config);

        try {
            const response = await this.axiosInstance.post(endpoint, processedBody, {
                responseType: 'stream',
                headers: this._getHeaders(true)
            });

            const stream = response.data;
            let buffer = '';

            for await (const chunk of stream) {
                // 将 chunk 转换为字符串并追加到缓冲区
                buffer += chunk.toString();
                
                // 逐行处理
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    // 提取一行（不包含换行符）
                    const line = buffer.substring(0, newlineIndex);
                    buffer = buffer.substring(newlineIndex + 1);
                    
                    // 去除行首尾空白（处理 \r\n 情况）
                    const trimmedLine = line.trim();
                    
                    // 跳过空行（SSE 格式中的分隔符）
                    if (trimmedLine === '') {
                        continue;
                    }

                    // 处理 SSE data: 前缀
                    if (trimmedLine.startsWith('data:')) {
                        // 提取 data: 后的内容（注意：data: 后可能有空格也可能没有）
                        let jsonData = trimmedLine.substring(5);
                        // 去除前导空格
                        if (jsonData.startsWith(' ')) {
                            jsonData = jsonData.substring(1);
                        }
                        jsonData = jsonData.trim();
                        
                        // 检查流结束标记
                        if (jsonData === '[DONE]') {
                            return; // 流结束
                        }
                        
                        // 跳过空数据
                        if (jsonData === '') {
                            continue;
                        }
                        
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            yield parsedChunk;
                        } catch (e) {
                            // JSON 解析失败，记录警告但继续处理
                            logger.warn("[iFlow] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData.substring(0, 200));
                        }
                    }
                    // 忽略其他 SSE 字段（如 event:, id:, retry: 等）
                }
            }
            
            // 处理缓冲区中剩余的数据（如果有的话）
            if (buffer.trim() !== '') {
                const trimmedLine = buffer.trim();
                if (trimmedLine.startsWith('data:')) {
                    let jsonData = trimmedLine.substring(5);
                    if (jsonData.startsWith(' ')) {
                        jsonData = jsonData.substring(1);
                    }
                    jsonData = jsonData.trim();
                    
                    if (jsonData !== '[DONE]' && jsonData !== '') {
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            yield parsedChunk;
                        } catch (e) {
                            logger.warn("[iFlow] Failed to parse final stream chunk JSON:", e.message);
                        }
                    }
                }
            }
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            
            // 检查是否为可重试的网络错误
            const isNetworkError = isRetryableNetworkError(error);
            
            // Handle 401/400 during stream - refresh auth and retry once
            if ((status === 400 || status === 401) && !isRetry) {
                logger.info(`[iFlow] Received ${status} during stream. Triggering background refresh via PoolManager...`);
                
                // 标记当前凭证为不健康（会自动进入刷新队列）
                const poolManager = getProviderPoolManager();
                if (poolManager && this.uuid) {
                    logger.info(`[iFlow] Marking credential ${this.uuid} as needs refresh. Reason: ${status} Unauthorized in stream`);
                    poolManager.markProviderNeedRefresh(MODEL_PROVIDER.IFLOW_API, {
                        uuid: this.uuid
                    });
                    error.credentialMarkedUnhealthy = true;
                }

                // Mark error for credential switch without recording error count
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
                throw error;
            }

            if (status === 401 || status === 403) {
                logger.error(`[iFlow] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[iFlow] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[iFlow] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, model, isRetry, retryCount + 1);
                    return;
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[iFlow] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, model, isRetry, retryCount + 1);
                return;
            }

            // Handle network errors (ECONNRESET, ETIMEDOUT, etc.) with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[iFlow] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, model, isRetry, retryCount + 1);
                return;
            }

            logger.error(`[iFlow] Error calling streaming API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    /**
     * 生成内容
     */
    async generateContent(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }
        
        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[iFlow] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(MODEL_PROVIDER.IFLOW_API, {
                    uuid: this.uuid
                });
            }
        }
        
        return this.callApi('/chat/completions', requestBody, model);
    }

    /**
     * 流式生成内容
     */
    async *generateContentStream(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }
        
        // 检查 token 是否即将过期，如果是则推送到刷新队列
        if (this.isExpiryDateNear()) {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                logger.info(`[iFlow] Token is near expiry, marking credential ${this.uuid} for refresh`);
                poolManager.markProviderNeedRefresh(MODEL_PROVIDER.IFLOW_API, {
                    uuid: this.uuid
                });
            }
        }
        
        yield* this.streamApi('/chat/completions', requestBody, model);
    }

    /**
     * 列出可用模型
     */
    async listModels() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        
        // 需要手动添加的模型列表
        const manualModels = IFLOW_MANUAL_MODELS;
        
        try {
            const response = await this.axiosInstance.get('/models', {
                headers: this._getHeaders(false)
            });
            
            // 检查返回数据中是否包含手动添加的模型，如果没有则添加
            const modelsData = response.data;
            if (modelsData && modelsData.data && Array.isArray(modelsData.data)) {
                for (const modelId of manualModels) {
                    const hasModel = modelsData.data.some(model => model.id === modelId);
                    if (!hasModel) {
                        // 添加模型到返回列表
                        modelsData.data.push({
                            id: modelId,
                            object: 'model',
                            created: Math.floor(Date.now() / 1000),
                            owned_by: 'iflow'
                        });
                        logger.info(`[iFlow] Added ${modelId} to models list`);
                    }
                }
            }
            
            return modelsData;
        } catch (error) {
            logger.warn('[iFlow] Failed to fetch models from API, using default list:', error.message);
            // 返回默认模型列表，确保包含手动添加的模型
            const defaultModels = [...IFLOW_MODELS];
            for (const modelId of manualModels) {
                if (!defaultModels.includes(modelId)) {
                    defaultModels.push(modelId);
                }
            }
            return {
                object: 'list',
                data: defaultModels.map(id => ({
                    id,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'iflow'
                }))
            };
        }
    }

}

export {
    IFLOW_MODELS,
    IFLOW_USER_AGENT,
    IFlowTokenStorage,
    loadTokenFromFile,
    saveTokenToFile,
    refreshOAuthTokens,
    fetchUserInfo,
    isThinkingModel,
    applyIFlowThinkingConfig,
    preserveReasoningContentInMessages,
    ensureToolsArray,
    preprocessRequestBody,
};
