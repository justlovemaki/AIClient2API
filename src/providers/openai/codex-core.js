import { atomicWriteFile } from '../../utils/file-lock.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import crypto from 'crypto';
import {promises as fs} from 'fs';
import path from 'path';
import os from 'os';
import {refreshCodexTokensWithRetry} from '../../auth/oauth-handlers.js';
import {getProviderPoolManager} from '../../services/service-manager.js';
import {configureTLSSidecar, isTLSSidecarEnabledForProvider} from '../../utils/proxy-utils.js';
import {MODEL_PROVIDER, formatExpiryLog, normalizeProviderErrorMessage} from '../../utils/common.js';
import {getProxyConfigForProvider} from '../../utils/proxy-utils.js';
import {getProviderModels} from '../provider-models.js';
import {
    normalizeCodexInstructions,
    resolveCodexCacheIdentity,
    resolveCodexReasoningEffort,
    isCodexImageComplexityMessage,
    getCodexImageEffortRetryBody,
    canRecoverCodexImageRequest,
    getCodexGeneratedImages,
    isCodexIncompleteImageResponse,
    mergeCodexImageRecovery
} from './codex-request-utils.js';

const baseModels = getProviderModels(MODEL_PROVIDER.CODEX_API);
const fastModels = baseModels.map(m => `${m}-fast`);
const CODEX_MODELS = [...new Set([...baseModels, ...fastModels])];
const CODEX_VERSION = '0.166.0';
export const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol';
export const IMAGE_MODELS = new Set(['gpt-image-2']);

function normalizeCodexTerminalError(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    let errorBody = null;
    if (parsed.type === 'error') {
        errorBody = parsed.error && typeof parsed.error === 'object'
            ? parsed.error
            : { message: parsed.message || parsed.error || 'Codex API error' };
    } else if (parsed.type === 'response.failed') {
        errorBody = parsed.response?.error || parsed.error;
        if (!errorBody) {
            errorBody = { message: parsed.response?.error?.message || parsed.message || 'Codex response failed' };
        }
    }

    // Some tool failures are carried inside an otherwise successful Responses envelope.
    // Do not infer failure from assistant text or replace a successfully generated image.
    if (!errorBody) {
        const output = parsed.type === 'response.output_item.done' ? [parsed.item] : parsed.response?.output;
        if (Array.isArray(output) && !output.some(item => item?.type === 'image_generation_call' && item.result)) {
            errorBody = output.find(item => item?.type === 'image_generation_call'
                && isCodexImageComplexityMessage(item.error?.message))?.error;
        }
    }
    if (!errorBody) {
        return null;
    }

    if (typeof errorBody !== 'object') {
        errorBody = { message: String(errorBody) };
    }
    if (!errorBody.message) {
        errorBody.message = errorBody.code || errorBody.type || 'Codex API error';
    }
    return errorBody;
}

function createCodexTerminalError(parsed) {
    const errorBody = normalizeCodexTerminalError(parsed);
    if (!errorBody) {
        return null;
    }

    const error = new Error(`Codex API error: ${errorBody.message}`);
    error.response = {
        status: isCodexUsageLimitError(errorBody) || isCodexModelCapacityError(errorBody) ? 429 : 400,
        data: { error: errorBody }
    };
    if (shouldSwitchCodexCredential(errorBody)) {
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
    }
    if (isCodexUsageLimitError(errorBody)) {
        const retryAfterMs = parseCodexRetryAfterMs(errorBody);
        if (retryAfterMs !== null) {
            error.retryAfterMs = retryAfterMs;
        }
    }
    return error;
}

function shouldSwitchCodexCredential(errorBody) {
    const code = String(errorBody?.code || '').toLowerCase();
    const type = String(errorBody?.type || '').toLowerCase();
    return code === 'insufficient_quota' || type === 'insufficient_quota' || isCodexUsageLimitError(errorBody) || isCodexModelCapacityError(errorBody);
}

function isCodexUsageLimitError(errorBody) {
    return String(errorBody?.type || '').trim().toLowerCase() === 'usage_limit_reached';
}

function isCodexModelCapacityError(errorBody) {
    const msg = String(errorBody?.message || '').trim().toLowerCase();
    return msg.includes('selected model is at capacity') || msg.includes('model is at capacity. please try a different model');
}

function parseCodexRetryAfterMs(errorBody) {
    const resetsAt = Number(errorBody?.resets_at);
    if (Number.isFinite(resetsAt) && resetsAt > 0) {
        const delay = resetsAt * 1000 - Date.now();
        return delay > 0 ? delay : null;
    }
    const resetsInSeconds = Number(errorBody?.resets_in_seconds);
    if (Number.isFinite(resetsInSeconds) && resetsInSeconds > 0) {
        return resetsInSeconds * 1000;
    }
    return null;
}

function extractSSEData(line) {
    const trimmedLine = String(line || '').trim();
    if (!trimmedLine || trimmedLine.startsWith(':') || trimmedLine.startsWith('event:') || trimmedLine.startsWith('id:') || trimmedLine.startsWith('retry:')) {
        return null;
    }
    if (trimmedLine.startsWith('data:')) {
        return trimmedLine.slice(5).trim();
    }
    return trimmedLine;
}

/**
 * Codex API 服务类
 */
export class CodexApiService {
    constructor(config) {
        this.config = config;
        this.baseUrl = config.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex';
        this.accessToken = null;
        this.refreshToken = null;
        this.accountId = null;
        this.email = null;
        this.expiresAt = null;
        this.idToken = null;
        this.last_refresh = null;
        this.credsPath = null; // 记录本次加载/使用的凭据文件路径，确保刷新后写回同一文件
        this.accessTokenOnlyRefreshLogged = false;
        this.uuid = config.uuid; // 保存 uuid 用于号池管理
        this.isInitialized = false;

        this.imageGenTool = {type: 'image_generation', output_format: 'png'};
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, this.baseUrl);
    }

    /**
     * 初始化服务（加载凭据）
     */
    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Codex] Initializing Codex API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();

        this.isInitialized = true;
        logger.info(`[Codex] Initialization complete. Account: ${this.email || 'unknown'}`);
    }

    /**
     * 加载凭证信息（不执行刷新）
     */
    async loadCredentials() {
        const email = this.config.CODEX_EMAIL || 'default';

        try {
            let creds;
            let credsPath;

            // 如果指定了具体路径，直接读取
            if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
                credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
                const exists = await this.fileExists(credsPath);
                if (!exists) {
                    throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
                }
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            } else {
                // 从 configs/codex 目录扫描加载
                const projectDir = process.cwd();
                const targetDir = path.join(projectDir, 'configs', 'codex');
                const files = await fs.readdir(targetDir);
                const matchingFile = files
                    .filter(f => f.includes(`codex-${email}`) && f.endsWith('.json'))
                    .sort()
                    .pop(); // 获取最新的文件

                if (!matchingFile) {
                    throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
                }

                credsPath = path.join(targetDir, matchingFile);
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            }

            // 记录凭据路径，确保 refresh 时写回同一文件。
            this.credsPath = credsPath;

            this.idToken = creds.id_token || this.idToken;
            this.accessToken = creds.access_token;
            this.refreshToken = creds.refresh_token;
            this.accountId = creds.account_id;
            this.email = creds.email;
            this.last_refresh = creds.last_refresh || this.last_refresh;
            this.expiresAt = new Date(creds.expired); // 注意：字段名是 expired

            // 检查 token 是否需要刷新（异步触发，不阻塞加载）
            if (this.isExpiryDateNear()) {
                this.triggerBackgroundRefresh();
            }

            this.isInitialized = true;
            logger.info(`[Codex] Initialized with account: ${this.email}`);
        } catch (error) {
            logger.warn(`[Codex Auth] Failed to load credentials: ${error.message}`);
        }
    }

    /**
     * 初始化认证并执行必要刷新
     */
    async initializeAuth(forceRefresh = false) {
        // 检查 token 是否需要刷新
        const needsRefresh = forceRefresh;

        if (this.accessToken && !needsRefresh) {
            return;
        }

        // 首先执行基础凭证加载
        await this.loadCredentials();

        // 只有在明确要求刷新，或者 AccessToken 缺失时，才执行刷新
        // 注意：在 V2 架构下，此方法主要由 PoolManager 的后台队列调用
        if (needsRefresh || !this.accessToken) {
            if (!this.refreshToken) {
                if (this.accessToken) {
                    this.logAccessTokenOnlyRefreshSkipped();
                    return;
                }
                throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
            }
            logger.info('[Codex] Token expiring soon or refresh requested, refreshing...');
            await this.refreshAccessToken();
        }
    }

    /**
     * 后台异步刷新 token（不阻塞当前请求）
     */
    triggerBackgroundRefresh() {
        if (!this.refreshToken) {
            this.logAccessTokenOnlyRefreshSkipped();
            return;
        }

        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Codex] Token is near expiry, marking credential ${this.uuid} for background refresh`);
            poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, {
                uuid: this.uuid
            });
        }
    }

    logAccessTokenOnlyRefreshSkipped() {
        if (this.accessTokenOnlyRefreshLogged) return;
        this.accessTokenOnlyRefreshLogged = true;
        logger.warn('[Codex] Access-token-only credential cannot be refreshed because refresh_token is empty. Re-import or re-authenticate when it expires.');
    }

    /**
     * 生成内容（非流式）
     */
    async generateContent(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        let selectedModel = model;
        if (!CODEX_MODELS.includes(model)) {
            if (this.config.MODEL_FALLBACK_ENABLED === false) {
                throw new Error(`[Codex] 模型不存在: ${model}`);
            }
            const defaultModel = CODEX_MODELS.includes(CODEX_DEFAULT_MODEL) ? CODEX_DEFAULT_MODEL : CODEX_MODELS[0];
            logger.warn(`[Codex] Model '${model}' not found in supported list. Falling back to default: '${defaultModel}'`);
            selectedModel = defaultModel;
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则触发后台异步刷新
        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        const url = `${this.baseUrl}/responses`;
        let body = await this.prepareRequestBody(selectedModel, requestBody, true);
        const headers = this.buildHeaders(body.prompt_cache_key, true);
        let imageEffortRetried = false;

        while (true) {
            try {
                const config = {
                    headers,
                    responseType: 'text', // 确保以文本形式接收 SSE 流
                    timeout: 300000 // 5 分钟超时，适应慢速模型
                };

                const axiosRequestConfig = {
                    method: 'post',
                    url,
                    data: body,
                    ...config
                };
                this._applySidecar(axiosRequestConfig);

                const response = await axios.request(axiosRequestConfig);

                const parsed = this.parseNonStreamResponse(response.data);
                if (!imageEffortRetried && isCodexIncompleteImageResponse(parsed, body)) {
                    imageEffortRetried = true;
                    return mergeCodexImageRecovery(parsed, await this.recoverIncompleteImageResponse(body));
                }
                return parsed;
            } catch (error) {
                if (error.response?.status === 401) {
                    logger.info('[Codex] Received 401. Triggering background refresh...');
                    await normalizeProviderErrorMessage(error, { status: 401, context: 'non-stream' });

                    // 触发后台异步刷新
                    this.triggerBackgroundRefresh();
                    error.credentialMarkedUnhealthy = true;

                    // Mark error for credential switch without recording error count
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                    throw error;
                } else {
                    if (error.response?.status) {
                        await normalizeProviderErrorMessage(error, { status: error.response.status, context: 'non-stream' });
                    }
                    const retryBody = !imageEffortRetried && getCodexImageEffortRetryBody(error, body);
                    if (retryBody) {
                        imageEffortRetried = true;
                        body = retryBody;
                        logger.warn('[Codex] Image complexity error; retrying this request once with reasoning.effort=null (same credential).');
                        continue;
                    }
                    logger.error(`[Codex] Error calling non-stream API (Status: ${error.response?.status}, Code: ${error.code || 'N/A'}): ${error.message}`);
                    throw error;
                }
            }
        }
    }

    /**
     * 流式生成内容
     */
    async* generateContentStream(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        let selectedModel = model;
        if (!CODEX_MODELS.includes(model)) {
            if (this.config.MODEL_FALLBACK_ENABLED === false) {
                throw new Error(`[Codex] 模型不存在: ${model}`);
            }
            const defaultModel = CODEX_MODELS.includes(CODEX_DEFAULT_MODEL) ? CODEX_DEFAULT_MODEL : CODEX_MODELS[0];
            logger.warn(`[Codex] Model '${model}' not found in supported list. Falling back to default: '${defaultModel}'`);
            selectedModel = defaultModel;
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则触发后台异步刷新
        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        const url = `${this.baseUrl}/responses`;
        let body = await this.prepareRequestBody(selectedModel, requestBody, true);
        const headers = this.buildHeaders(body.prompt_cache_key, true);
        let imageEffortRetried = false;
        let emittedEvent = false;

        while (true) {
            try {
                const config = {
                    headers,
                    responseType: 'stream',
                    timeout: 300000 // 5 分钟超时
                };

                const axiosRequestConfig = {
                    method: 'post',
                    url,
                    data: body,
                    ...config
                };
                this._applySidecar(axiosRequestConfig);

                const response = await axios.request(axiosRequestConfig);

                // Buffer only a bounded bootstrap prelude, not text/reasoning/tool output.
                // An early parameter failure can then retry without leaking duplicate response IDs.
                const prelude = [];
                for await (const event of this.parseSSEStreamWithImageRecovery(response.data, body)) {
                    if (!emittedEvent && prelude.length < 16
                        && ['response.created', 'response.in_progress', 'response.queued'].includes(event.type)) {
                        prelude.push(event);
                        continue;
                    }
                    emittedEvent = true;
                    yield* prelude.splice(0);
                    yield event;
                }
                yield* prelude;
                return;
            } catch (error) {
                if (error.response?.status === 401) {
                    logger.info('[Codex] Received 401 during stream. Triggering background refresh...');
                    await normalizeProviderErrorMessage(error, { status: 401, context: 'stream' });

                    // 触发后台异步刷新
                    this.triggerBackgroundRefresh();
                    error.credentialMarkedUnhealthy = true;

                    // Mark error for credential switch without recording error count
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                    throw error;
                } else {
                    if (error.response?.status) {
                        await normalizeProviderErrorMessage(error, { status: error.response.status, context: 'stream' });
                    }
                    const retryBody = !emittedEvent && !imageEffortRetried && getCodexImageEffortRetryBody(error, body);
                    if (retryBody) {
                        imageEffortRetried = true;
                        body = retryBody;
                        logger.warn('[Codex] Early image complexity error; retrying this stream once with reasoning.effort=null (same credential).');
                        continue;
                    }
                    logger.error(`[Codex] Error calling streaming API (Status: ${error.response?.status}, Code: ${error.code || 'N/A'}):`, error.message);
                    throw error;
                }
            }
        }
    }

    /** Use the same image-only preparation as /v1/images, once an actual image call stalled. */
    async recoverIncompleteImageResponse(body) {
        logger.warn('[Codex] Completed response has unfinished image calls and zero image usage; recovering once with the image-only helper and reasoning.effort=null.');
        try {
            const imageTool = body.tools.find(tool => tool?.type === 'image_generation');
            const imageBody = await this.prepareRequestBody('gpt-image-2', {
                ...body,
                _imageSize: body._imageSize || imageTool?.size,
                tool_choice: { type: 'image_generation' },
                reasoning: { ...body.reasoning, effort: null }
            }, true);
            const config = {
                method: 'post', url: `${this.baseUrl}/responses`, data: imageBody,
                headers: this.buildHeaders(imageBody.prompt_cache_key, true),
                responseType: 'text', timeout: 300000
            };
            this._applySidecar(config);
            const response = await axios.request(config);
            const recovered = this.parseNonStreamResponse(response.data);
            const images = getCodexGeneratedImages(recovered.response);
            if (images.length === 0) {
                const error = new Error('Codex image recovery failed: the image-only request returned no image result.');
                error.response = { status: 502, data: { error: { message: error.message, code: 'image_generation_incomplete' } } };
                error.skipErrorCount = true;
                throw error;
            }
            for (const image of images) {
                image.id = image.id || `ig_${crypto.randomUUID()}`;
                image.status = 'completed';
            }
            return recovered;
        } catch (error) {
            // Never chain a second compatibility retry or a generic health-based replay
            // onto an image request whose delivery outcome may now be unknown.
            error.imageRecoveryAttempted = true;
            error.skipErrorCount = true;
            throw error;
        }
    }

    /**
     * Keep normal chat streaming. Only buffer the tail after a real image call starts,
     * so a failed image segment can be replaced without replaying earlier reasoning.
     */
    async* parseSSEStreamWithImageRecovery(stream, body) {
        if (!canRecoverCodexImageRequest(body)) {
            yield* this.parseSSEStream(stream);
            return;
        }
        let tail = [];
        let tailBytes = 0;
        let disabled = false;
        let lastSequence = -1;
        let completed = null;
        let textEmitted = false;
        const committedItems = new Set();
        const emitted = event => {
            lastSequence = Math.max(lastSequence + 1, event.sequence_number ?? -1);
            if (event.type === 'response.output_item.added' && event.item?.id) committedItems.add(event.item.id);
            if (event.type === 'response.output_text.delta' || event.item?.type === 'message') textEmitted = true;
            // Interleaved prefix events can overtake buffered tail events; keep wire order monotonic.
            return typeof event.sequence_number === 'number' && event.sequence_number !== lastSequence
                ? { ...event, sequence_number: lastSequence } : event;
        };
        for await (const event of this.parseSSEStream(stream)) {
            // Interleaved reasoning/text belonging to an already committed prefix must still close.
            if (tail.length && committedItems.has(event.item_id || event.item?.id)) {
                yield emitted(event);
                continue;
            }
            const eventType = String(event.type || '');
            const imageEvent = event.item?.type === 'image_generation_call'
                || eventType.startsWith('response.image_generation_call.');
            const terminalImageOnly = !textEmitted && isCodexIncompleteImageResponse(event, body);
            if (!disabled && (tail.length || imageEvent || terminalImageOnly)) {
                const imageDelivered = Boolean(event.partial_image_b64)
                    || getCodexGeneratedImages({ output: event.item ? [event.item] : event.response?.output }).length > 0;
                const hasOtherTool = (event.item?.type
                    && !['reasoning', 'message', 'image_generation_call'].includes(event.item.type))
                    || eventType.startsWith('response.function_call_arguments.');
                const bytes = imageDelivered ? 0 : Buffer.byteLength(JSON.stringify(event));
                if (imageDelivered || hasOtherTool || tailBytes + bytes > 1024 * 1024 || tail.length >= 512) {
                    // Do not duplicate delivered images, hide function calls or buffer without bound.
                    disabled = true;
                    for (const buffered of tail) yield emitted(buffered);
                    tail = [];
                } else {
                    tail.push(event);
                    tailBytes += bytes;
                    if (event.type === 'response.completed') completed = event;
                    continue;
                }
            }
            yield emitted(event);
        }
        if (!tail.length) return;
        if (!completed || !isCodexIncompleteImageResponse(completed, body)) {
            for (const event of tail) yield emitted(event);
            return;
        }

        const recovered = await this.recoverIncompleteImageResponse(body);
        const merged = mergeCodexImageRecovery(completed, recovered);
        const prefixLength = completed.response.output.findIndex(item => item.type === 'image_generation_call');
        for (const [index, image] of getCodexGeneratedImages(recovered.response).entries()) {
            const output_index = prefixLength + index;
            yield emitted({
                type: 'response.output_item.added', response_id: merged.response.id,
                output_index, sequence_number: lastSequence + 1,
                item: { id: image.id, type: 'image_generation_call', status: 'in_progress' }
            });
            yield emitted({
                type: 'response.output_item.done', response_id: merged.response.id,
                output_index, sequence_number: lastSequence + 1, item: image
            });
        }
        yield emitted({ ...merged, sequence_number: lastSequence + 1 });
    }

    /**
     * 构建请求头
     */
    buildHeaders(cacheId, stream = true) {
        const headers = {
            'version': CODEX_VERSION,
            'x-codex-beta-features': 'powershell_utf8',
            'x-oai-web-search-eligible': 'true',
            'authorization': `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'content-type': 'application/json',
            'user-agent': `codex-tui/${CODEX_VERSION} (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui; ${CODEX_VERSION})`,
            'originator': 'codex-tui',
            'host': 'chatgpt.com',
            'Connection': 'Keep-Alive'
        };

        // Codex 当前使用连字符形式的 session/thread 头维持缓存亲和性。
        // 同时保留旧下划线形式，兼容较老的 ChatGPT Codex 网关。
        if (cacheId) {
            const headerCacheId = this.toSafeCacheHeaderValue(cacheId);
            headers['session-id'] = headerCacheId;
            headers['thread-id'] = headerCacheId;
            headers['Conversation_id'] = headerCacheId;
            headers['Session_id'] = headerCacheId;
        }

        // 根据是否流式设置 Accept 头
        if (stream) {
            headers['accept'] = 'text/event-stream';
        } else {
            headers['accept'] = 'application/json';
        }

        return headers;
    }

    /**
     * 构建 Codex 管理类接口请求头
     */
    buildManagementHeaders() {
        return {
            'authorization': `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'oai-language': 'zh-CN',
            'originator': 'Codex Desktop',
            'accept': 'application/json',
            'sec-fetch-site': 'none',
            'sec-fetch-mode': 'no-cors',
            'sec-fetch-dest': 'empty',
            'priority': 'u=4, i'
        };
    }

    /**
     * 准备请求体
     */
    async prepareRequestBody(model, requestBody, stream) {
        // 提取 metadata 并从请求体中移除，避免透传到上游。
        // prompt_cache_key 是 Responses API 的正式顶层字段，必须保留。
        const metadata = requestBody.metadata || {};

        // 判断是否为 fast 模型并确定默认值
        const normalizedModel = String(model || '').trim();
        const isFastModel = /-fast$/i.test(normalizedModel);
        const upstreamModel = isFastModel ? normalizedModel.replace(/-fast$/i, '') : normalizedModel;
        const defaultServiceTier = isFastModel ? 'priority' : 'default';
        const defaultReasoningEffort = isFastModel ? 'xhigh' : 'medium';

        // 图像生成模型通过支持 image_generation 工具的 Codex 主模型实现。
        // CODEX_IMAGE_HELPER_MODEL 可在全局配置中设置，并由号池节点配置覆盖。
        const isImageModel = IMAGE_MODELS.has(upstreamModel);
        const configuredImageHelperModel = typeof this.config?.CODEX_IMAGE_HELPER_MODEL === 'string'
            ? this.config.CODEX_IMAGE_HELPER_MODEL.trim()
            : '';
        const imageHelperModel = configuredImageHelperModel || 'gpt-5.6-sol';
        if (isImageModel && /^gpt-image(?:-|$)/i.test(imageHelperModel)) {
            throw new Error('[Codex] CODEX_IMAGE_HELPER_MODEL must name a mainline model, not a gpt-image-* model.');
        }
        const effectiveUpstreamModel = isImageModel ? imageHelperModel : upstreamModel;

        const cleanedBody = {...requestBody};
        delete cleanedBody.metadata;
        delete cleanedBody.previous_response_id;
        delete cleanedBody.prompt_cache_retention;
        delete cleanedBody.safety_identifier;
        delete cleanedBody.stream_options;

        // Codex 接受顶层 instructions，但拒绝 input 中的 system/developer 消息。
        normalizeCodexInstructions(cleanedBody);

        // 【关键修复】确保传给上游的模型名称不带 -fast 后缀
        // 即使 originalRequestBody 中已经带了 model，这里也必须覆盖
        cleanedBody.model = effectiveUpstreamModel;

        if (isImageModel) {
            // 图像模型：强制使用 image_generation 工具，不加 web_search
            const imageToolConfig = {type: 'image_generation'};
            if (cleanedBody._imageSize) {
                imageToolConfig.size = cleanedBody._imageSize;
            }
            delete cleanedBody._imageSize;
            cleanedBody.tools = [imageToolConfig];
            // 服务器要求 instructions 非空
            if (!cleanedBody.instructions?.trim()) {
                cleanedBody.instructions = 'You are a helpful assistant.';
            }
            logger.info(`[Codex] Image model detected: ${upstreamModel} -> ${effectiveUpstreamModel} with image_generation tool${imageToolConfig.size ? `, size=${imageToolConfig.size}` : ''}`);
        } else {
            // 为普通 Codex 模型增加默认工具
            if (!cleanedBody.tools) {
                cleanedBody.tools = [];
            }
            if (Array.isArray(cleanedBody.tools)) {
                const hasWebSearch = cleanedBody.tools.some(t => t.type === 'web_search');
                if (!hasWebSearch) {
                    cleanedBody.tools.push({type: 'web_search'});
                }
                if (!upstreamModel.endsWith('spark')) {
                    const hasImageGen = cleanedBody.tools.some(t => t.type === 'image_generation');
                    if (!hasImageGen) {
                        cleanedBody.tools.push(this.imageGenTool);
                    }
                }
            }
        }

        if (isFastModel) {
            logger.info(`[Codex] Detected -fast model: ${normalizedModel} -> ${upstreamModel}, service_tier: ${cleanedBody.service_tier || defaultServiceTier}`);
        }

        // Preserve the client's cache lineage. The previous implementation always replaced
        // prompt_cache_key with a random UUID that expired after one hour, even when the client
        // supplied a stable key. That made long/image-bearing conversations repeatedly lose
        // upstream cache affinity.
        const cacheIdentity = resolveCodexCacheIdentity(cleanedBody, metadata);

        // 图片请求默认显式发送 null，规避上游可能把主模型 effort 当成图片 complexity 的问题。
        // 转换器不补默认值，因此这里仍能区分未设置与客户端显式指定的 effort。
        // 不要仅因 tools 中存在 image_generation 就覆盖 effort：普通 Chat 也默认附带该工具。
        let reasoningEffort = resolveCodexReasoningEffort(cleanedBody, isImageModel ? null : defaultReasoningEffort);
        if (isFastModel && !isImageModel && reasoningEffort !== null) {
            reasoningEffort = defaultReasoningEffort;
        }
        if (reasoningEffort === 'minimal') {
            reasoningEffort = 'none';
        }
        delete cleanedBody.reasoning_effort;

        // 注意：requestBody 已经去除了 metadata
        const result = {
            ...cleanedBody,
            store: cleanedBody.store ?? false,
            parallel_tool_calls: cleanedBody.parallel_tool_calls ?? true,
            include: cleanedBody.include || ['reasoning.encrypted_content'],
            service_tier: cleanedBody.service_tier || defaultServiceTier,
            reasoning: {
                ...cleanedBody.reasoning,
                effort: reasoningEffort,
                summary: cleanedBody.reasoning?.summary || 'auto',
            },
            stream,
            prompt_cache_key: cacheIdentity.key
        };

        delete result.messages;
        if (!result.instructions) {
            result.instructions = '';
        }
        if (!Array.isArray(result.tools) || result.tools.length === 0) {
            delete result.parallel_tool_calls;
        }

        if (result.service_tier !== 'priority') {
            delete result.service_tier;
        }

        // 监控钩子：内部请求转换
        if (this.config?._monitorRequestId) {
            try {
                const {getPluginManager} = await import('../../core/plugin-manager.js');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onInternalRequestConverted', {
                        requestId: this.config._monitorRequestId,
                        internalRequest: result,
                        converterName: 'prepareRequestBody'
                    });
                }
            } catch (e) {
                logger.error('[Codex] Error calling onInternalRequestConverted hook:', e.message);
            }
        }

        return result;
    }

    /**
     * 刷新访问令牌
     */
    async refreshAccessToken() {
        if (!this.refreshToken) {
            this.logAccessTokenOnlyRefreshSkipped();
            throw new Error('Cannot refresh Codex access-token-only credential without refresh_token.');
        }

        try {
            const newTokens = await refreshCodexTokensWithRetry(this.refreshToken, this.config);

            this.idToken = newTokens.id_token || this.idToken;
            this.accessToken = newTokens.access_token;
            this.refreshToken = newTokens.refresh_token;
            this.accountId = newTokens.account_id;
            this.email = newTokens.email;
            this.last_refresh = new Date().toISOString();

            // 关键修复：refreshCodexTokensWithRetry 返回字段名是 `expired`（ISO string），不是 `expire`
            const expiredValue = newTokens.expired || newTokens.expire || newTokens.expires_at || newTokens.expiresAt;
            const parsedExpiry = expiredValue ? new Date(expiredValue) : null;
            if (!parsedExpiry || Number.isNaN(parsedExpiry.getTime())) {
                // 如果上游没返回可解析的过期时间，保守处理：按 1h 有效期估算（避免 expiresAt 变成 NaN 导致永不刷新）
                this.expiresAt = new Date(Date.now() + 3600 * 1000);
                logger.warn('[Codex] Token refresh did not include a valid expiry time; falling back to 1h from now');
            } else {
                this.expiresAt = parsedExpiry;
            }

            // 保存更新的凭据
            await this.saveCredentials();

            // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, this.uuid);
            }
            logger.info('[Codex] Token refreshed successfully');
        } catch (error) {
            logger.error('[Codex] Failed to refresh token:', error.message);
            throw new Error('Failed to refresh Codex token. Please re-authenticate.');
        }
    }

    /**
     * 检查 token 是否即将过期
     */
    isExpiryDateNear() {
        if (!this.expiresAt) return true;
        const expiry = this.expiresAt.getTime();
        // 如果 expiresAt 是 Invalid Date（NaN），必须视为“接近过期/已过期”，否则刷新永远不会触发
        if (Number.isNaN(expiry)) {
            logger.warn('[Codex] expiresAt is invalid (NaN). Treating as near expiry to force refresh');
            return true;
        }
        const nearMinutes = 20;
        const {message, isNearExpiry} = formatExpiryLog('Codex', expiry, nearMinutes);
        logger.info(message);
        return isNearExpiry;
    }

    /**
     * 获取凭据文件路径
     */
    getCredentialsPath() {
        const email = this.config.CODEX_EMAIL || this.email || 'default';

        // 1) 优先使用配置中指定的路径（号池模式/显式配置）
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            return this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        }

        // 2) 如果本次是从 configs/codex 扫描加载的，务必写回同一文件
        if (this.credsPath) {
            return this.credsPath;
        }

        // 3) 兜底：写入 configs/codex（与 OAuth 保存默认目录保持一致，避免“读取 configs/codex、写入 .codex”导致永远读到旧 token）
        const projectDir = process.cwd();
        return path.join(projectDir, 'configs', 'codex', `${Date.now()}_codex-${email}_oauth_creds.json`);
    }

    /**
     * 保存凭据
     */
    async saveCredentials() {
        const credsPath = this.getCredentialsPath();
        const credsDir = path.dirname(credsPath);

        if (!this.expiresAt || Number.isNaN(this.expiresAt.getTime())) {
            throw new Error('Invalid expiresAt when saving Codex credentials');
        }

        await fs.mkdir(credsDir, {recursive: true});
        await atomicWriteFile(
            credsPath,
            JSON.stringify(
                {
                    id_token: this.idToken || '',
                    access_token: this.accessToken,
                    refresh_token: this.refreshToken,
                    account_id: this.accountId,
                    last_refresh: this.last_refresh || new Date().toISOString(),
                    email: this.email,
                    type: 'codex',
                    expired: this.expiresAt.toISOString()
                },
                null,
                2
            ),
            { encoding: 'utf8', mode: 0o600 }
        );

        // 更新缓存路径（例如首次无 credsPath 兜底生成了新文件）
        this.credsPath = credsPath;
    }

    /**
     * 检查文件是否存在
     */
    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 收集 Codex 输出项
     */
    collectCodexOutputItemDone(eventData, outputItemsByIndex, outputItemsFallback) {
        if (!eventData.item) {
            return;
        }
        if (eventData.output_index !== undefined) {
            outputItemsByIndex.set(eventData.output_index, eventData.item);
        } else {
            outputItemsFallback.push(eventData.item);
        }
    }

    /**
     * 修正 Codex 完成输出
     */
    patchCodexCompletedOutput(eventData, outputItemsByIndex, outputItemsFallback) {
        const response = eventData.response || {};
        const output = response.output;

        // A terminal envelope may omit a result already delivered by output_item.done.
        // Preserve it instead of mistaking the request for a zero-result image failure.
        if (Array.isArray(output)) {
            const completedImages = new Map(getCodexGeneratedImages({
                output: [...outputItemsByIndex.values(), ...outputItemsFallback]
            }).filter(item => item.id).map(item => [item.id, item]));
            for (const item of output) {
                if (item.type === 'image_generation_call' && !item.result && completedImages.has(item.id)) {
                    Object.assign(item, completedImages.get(item.id));
                }
            }
        }

        const shouldPatch = (!output || !Array.isArray(output) || output.length === 0) &&
            (outputItemsByIndex.size > 0 || outputItemsFallback.length > 0);

        if (!shouldPatch) {
            return eventData;
        }

        const items = [];
        // 按索引排序
        const sortedIndexes = Array.from(outputItemsByIndex.keys()).sort((a, b) => a - b);
        for (const idx of sortedIndexes) {
            items.push(outputItemsByIndex.get(idx));
        }
        // 添加 fallback 项
        items.push(...outputItemsFallback);

        if (!eventData.response) {
            eventData.response = {};
        }
        eventData.response.output = items;

        return eventData;
    }

    /**
     * 解析 SSE 流
     */
    async* parseSSEStream(stream) {
        let buffer = '';
        const outputItemsByIndex = new Map();
        const outputItemsFallback = [];

        for await (const chunk of stream) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整的行

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;
                const dataStr = extractSSEData(trimmedLine);

                if (dataStr && dataStr !== '[DONE]') {
                    try {
                        let parsed = JSON.parse(dataStr);

                        const terminalError = createCodexTerminalError(parsed);
                        if (terminalError) {
                            logger.error('[Codex] API returned terminal error in stream:', parsed.error || parsed.response?.error || parsed);
                            const error = terminalError;
                            throw error;
                        }

                        if (parsed.type === 'response.output_item.done') {
                            this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                        } else if (parsed.type === 'response.completed') {
                            parsed = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                        }

                        yield parsed;
                    } catch (e) {
                        if (e.message.startsWith('Codex API error')) {
                            throw e;
                        }
                        logger.error('[Codex] Failed to parse SSE data:', e.message);
                    }
                }
            }
        }

        // 处理剩余的 buffer
        const finalTrimmed = buffer.trim();
        if (finalTrimmed) {
            const dataStr = extractSSEData(finalTrimmed);

            if (dataStr && dataStr !== '[DONE]') {
                try {
                    let parsed = JSON.parse(dataStr);

                    const terminalError = createCodexTerminalError(parsed);
                    if (terminalError) {
                        logger.error('[Codex] API returned terminal error in final stream buffer:', parsed.error || parsed.response?.error || parsed);
                        const error = terminalError;
                        throw error;
                    }

                    if (parsed.type === 'response.output_item.done') {
                        this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                    } else if (parsed.type === 'response.completed') {
                        parsed = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                    }

                    yield parsed;
                } catch (e) {
                    if (e.message.startsWith('Codex API error')) {
                        throw e;
                    }
                    logger.error('[Codex] Failed to parse final SSE data:', e.message);
                }
            }
        }
    }

    /**
     * 解析非流式响应
     */
    parseNonStreamResponse(data) {
        // 确保 data 是字符串
        const responseText = typeof data === 'string' ? data : String(data);

        // 从 SSE 流中提取所有事件，累积 output
        const lines = responseText.split('\n');
        const outputItems = new Map(); // id -> output item
        const textDeltas = new Map(); // item_id -> accumulated text

        const outputItemsByIndex = new Map();
        const outputItemsFallback = [];

        let completedEvent = null;
        let imageGenerationAlreadySucceeded = false;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            if (trimmedLine.startsWith('event: ') || trimmedLine.startsWith('id: ') || trimmedLine.startsWith('retry: ')) {
                continue;
            }

            const jsonData = extractSSEData(trimmedLine);

            if (!jsonData || jsonData === '[DONE]') {
                continue;
            }

            try {
                let parsed = JSON.parse(jsonData);
                const imageOutput = parsed.type === 'response.output_item.done' ? [parsed.item] : parsed.response?.output;
                if (Array.isArray(imageOutput) && imageOutput.some(item => item?.type === 'image_generation_call' && item.result)) {
                    imageGenerationAlreadySucceeded = true;
                }
                if (Array.isArray(imageOutput) && imageOutput.some(item => item?.type === 'image_generation_call' && item.error)) {
                    const error = createCodexTerminalError(parsed);
                    if (error) throw error;
                }
                switch (parsed.type) {
                    case 'error':
                    case 'response.failed': {
                        logger.error('[Codex] API returned terminal error:', parsed.error || parsed.response?.error || parsed);
                        const error = createCodexTerminalError(parsed);
                        if (error) throw error;
                        break;
                    }
                    case 'response.output_item.added':
                        if (parsed.item) {
                            outputItems.set(parsed.item.id, parsed.item);
                        }
                        break;
                    case 'response.output_item.done':
                        this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                        break;
                    case 'response.output_text.delta':
                        if (parsed.item_id && parsed.delta) {
                            const existing = textDeltas.get(parsed.item_id) || '';
                            textDeltas.set(parsed.item_id, existing + parsed.delta);
                        }
                        break;
                    case 'response.output_text.done':
                        if (parsed.item_id && parsed.text) {
                            textDeltas.set(parsed.item_id, parsed.text);
                        }
                        break;
                    case 'response.completed':
                        completedEvent = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                        break;
                }
            } catch (e) {
                if (e.message.startsWith('Codex API error')) {
                    e.imageGenerationAlreadySucceeded = imageGenerationAlreadySucceeded;
                    throw e;
                }
                // 继续解析下一行
                logger.debug('[Codex] Failed to parse SSE line:', e.message);
            }
        }

        if (!completedEvent) {
            // 如果我们已经收集到了一些输出项或文本，尝试合成一个完成事件
            if (outputItems.size > 0 || textDeltas.size > 0 || outputItemsByIndex.size > 0 || outputItemsFallback.length > 0) {
                logger.warn('[Codex] No completed response found, but some output items were received. Synthesizing response.');

                // 构造一个模拟的 completed 事件
                completedEvent = {
                    type: 'response.completed',
                    response: {
                        id: 'synth_' + Date.now(),
                        status: 'completed',
                        object: 'response',
                        model: 'unknown',
                        output: []
                    }
                };

                // 使用 patchCodexCompletedOutput 填充输出
                completedEvent = this.patchCodexCompletedOutput(completedEvent, outputItemsByIndex, outputItemsFallback);

                // 如果 patch 后还是没输出，尝试直接从 outputItems 填充
                if (completedEvent.response.output.length === 0 && outputItems.size > 0) {
                    completedEvent.response.output = Array.from(outputItems.values());
                }
            } else {
                logger.error('[Codex] No completed response found in Codex response');
                // 记录前 1000 个字符用于调试
                const debugInfo = responseText.length > 1000 ? responseText.slice(0, 1000) + '...' : responseText;
                logger.debug('[Codex] Raw response data:', debugInfo);

                throw new Error('stream error: stream disconnected before completion: stream closed before response.completed');
            }
        }

        // 用累积的 delta 文本 & output_item.done 数据填充 output items 中缺失的内容
        if (completedEvent.response) {
            const output = completedEvent.response.output || [];

            for (const item of output) {
                if (item.type === 'message' && item.role === 'assistant') {
                    const accumulatedText = textDeltas.get(item.id);
                    if (accumulatedText !== undefined) {
                        if (!item.content || item.content.length === 0) {
                            item.content = [{type: 'output_text', text: accumulatedText}];
                        } else {
                            item.content = item.content.map(c => {
                                if (c.type === 'output_text' && !c.text) {
                                    return {...c, text: accumulatedText};
                                }
                                return c;
                            });
                        }
                    }
                }
            }

            // 如果 output 完全为空，从累积事件重建
            if (output.length === 0 && outputItems.size > 0) {
                for (const [id, item] of outputItems) {
                    const accumulatedText = textDeltas.get(id);
                    if (accumulatedText !== undefined && item.type === 'message') {
                        item.content = [{type: 'output_text', text: accumulatedText}];
                    }
                    output.push(item);
                }
                completedEvent.response.output = output;
            }
        }

        return completedEvent;
    }

    /**
     * 列出可用模型
     */
    async listModels() {
        return {
            object: 'list',
            data: CODEX_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'openai'
            }))
        };
    }

    toSafeCacheHeaderValue(cacheKey) {
        const value = String(cacheKey);
        // Node rejects non-Latin-1/control characters in header values. Keep ordinary client
        // UUIDs/keys unchanged; hash unusual values while retaining stable affinity.
        if (/^[\x21-\x7E]{1,256}$/.test(value)) {
            return value;
        }
        return `aic2a-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
    }

    /**
     * 获取使用限制信息（返回 API 原始数据）
     * @returns {Promise<Object>} 原始响应数据
     */
    async getUsageLimits() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const url = 'https://chatgpt.com/backend-api/wham/usage';
            const headers = this.buildManagementHeaders();

            const config = {
                headers,
                timeout: 30000
            };

            const axiosRequestConfig = {
                method: 'get',
                url,
                ...config
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(axiosRequestConfig);
            return {
                ...response.data,
                account: this.email
            };
        } catch (error) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during getUsageLimits. Triggering background refresh...');
                this.triggerBackgroundRefresh();
                error.credentialMarkedUnhealthy = true;
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
            }

            logger.error('[Codex] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 消耗一次 Codex 额度重置次数
     * @returns {Promise<Object>} 重置结果与最新用量
     */
    async resetUsageQuota() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const url = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';
            const headers = {
                ...this.buildManagementHeaders(),
                'content-type': 'application/json'
            };
            const body = {
                redeem_request_id: crypto.randomUUID()
            };

            const axiosRequestConfig = {
                method: 'post',
                url,
                data: body,
                headers,
                timeout: 30000
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(axiosRequestConfig);
            const latestUsage = await this.getUsageLimits();

            return {
                success: true,
                resetResult: response.data,
                usage: latestUsage,
                account: this.email
            };
        } catch (error) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during resetUsageQuota. Triggering background refresh...');
                this.triggerBackgroundRefresh();
                error.credentialMarkedUnhealthy = true;
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
            }

            logger.error('[Codex] Failed to reset usage quota:', error.message);
            throw error;
        }
    }
}

