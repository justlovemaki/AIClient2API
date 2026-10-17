/**
 * Grok Web API Service using WebSocket-based gateway
 * Main service class that orchestrates WebSocket connections
 */

import WebSocket from 'ws';
import logger from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { isRetryableNetworkError, normalizeProviderErrorMessage } from '../../utils/common.js';
import { getProxyConfigForProvider } from '../../utils/proxy-utils.js';
import { MODEL_PROVIDER } from '../../utils/common.js';
import { ConverterFactory } from '../../converters/ConverterFactory.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { GROK_WEB_MODELS, getModelMapping } from './web-config.js';
import { buildWebSocketHeaders, buildHttpHeaders, normalizeImageUrl, genStatsigId } from './web-headers.js';
import { convertMessagesToGrokFormat, buildStartConversationPayload, parseMessage, buildResponseChunk } from './web-payloads.js';

export class GrokWebApiService {
    constructor(config) {
        this.config = config;
        this.uuid = config.uuid;
        this.token = config.GROK_COOKIE_TOKEN;
        this.cfClearance = config.GROK_CF_CLEARANCE;
        this.cfBm = config.GROK_CF_BM;
        this.userAgent = config.GROK_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
        this.baseUrl = config.GROK_BASE_URL || 'https://grok.com';
        this.wsBaseUrl = this.baseUrl.replace(/^https:/, 'wss:');
        this.isInitialized = false;
        this.nsfwSetupDone = false;
        this.converter = ConverterFactory.getConverter('grok');
        if (this.converter && this.uuid) this.converter.setUuid(this.uuid);
        this.lastSyncAt = null;
        this.userID = null;
    }

    getMaxRequestRetries() {
        const requestMaxRetries = Number.parseInt(this.config.REQUEST_MAX_RETRIES, 10);
        return Number.isFinite(requestMaxRetries) && requestMaxRetries > 0 ? requestMaxRetries : 3;
    }

    async classifyApiError(error, context = 'request') {
        let status = error.response?.status;
        const originalErrorMessage = error.message || '';
        const isNetworkError = isRetryableNetworkError(error);

        if (!status && originalErrorMessage.includes('Unexpected server response:')) {
            const match = originalErrorMessage.match(/Unexpected server response: (\d+)/);
            if (match) status = parseInt(match[1], 10);
        }

        if (!status && originalErrorMessage.includes('Image rate limit exceeded')) {
            status = 429;
        }

        if (status) {
            await normalizeProviderErrorMessage(error, { status, context });
        }

        if (status === 401 || status === 403 || status === 429 || status === 502) {
            error.shouldSwitchCredential = true;
        } else if (isNetworkError) {
            error.shouldSwitchCredential = true;
            error.skipErrorCount = true;
        }

        return { status, errorCode: error.code, errorMessage: error.message || originalErrorMessage, isNetworkError };
    }

    async initialize() {
        if (this.isInitialized) return;
        try {
            this.userID = await this.fetchOrResolveUserID();
            if (!this.userID) {
                logger.warn('[Grok Web] Could not resolve user ID, will use placeholder');
                this.userID = 'web-user';
            }
            this.isInitialized = true;
            logger.info(`[Grok Web] Service initialized for ${this.uuid}, userID: ${this.userID}`);
        } catch (error) {
            logger.error('[Grok Web] Failed to initialize service:', error.message);
            throw error;
        }
    }

    async fetchOrResolveUserID() {
        if (this.config.GROK_USER_ID) return this.config.GROK_USER_ID;
        if (this.token && this.token.length > 100) {
            try {
                const tokenParts = this.token.split('.');
                if (tokenParts.length >= 2) {
                    const payload = Buffer.from(tokenParts[1], 'base64').toString('utf8');
                    const decoded = JSON.parse(payload);
                    if (decoded.userID || decoded.sub || decoded.id) {
                        return decoded.userID || decoded.sub || decoded.id;
                    }
                }
            } catch (e) { /* Token is not JWT */ }
        }
        return this.uuid || 'web-user';
    }

    getWebSocketUrl() {
        if (!this.userID) throw new Error('User ID not resolved. Call initialize() first.');
        return `${this.wsBaseUrl}/ws/mgw/?uid=${encodeURIComponent(this.userID)}`;
    }

    buildWebSocketHeaders() {
        return buildWebSocketHeaders(this.token, this.cfClearance, this.cfBm, this.baseUrl, this.userAgent);
    }

    buildHeaders() {
        return buildHttpHeaders(this.token, this.cfClearance, this.cfBm, this.baseUrl, this.userAgent);
    }

    _normalizeImageUrl(url) {
        return normalizeImageUrl(url);
    }

    _getModelMapping(modelId) {
        return getModelMapping(modelId);
    }

    async _httpRequest(options) {
        const { method = 'post', url, data = {}, headers = this.buildHeaders(), timeout = 15000, responseType, ...otherOptions } = options;
        const axiosConfig = { method, url, headers, data, timeout, ...otherOptions };
        if (responseType) axiosConfig.responseType = responseType;
        const proxyConfig = getProxyConfigForProvider(this.config, MODEL_PROVIDER.GROK_WEB);
        if (proxyConfig) {
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
            axiosConfig.httpAgent = proxyConfig.httpAgent;
        }
        const axios = (await import('axios')).default;
        return await axios(axiosConfig);
    }

    async setupNsfw() {
        if (this.nsfwSetupDone) return;
        try {
            await this.acceptTos();
            await this.setBirthDate();
            await this.enableNsfwAccount();
            this.nsfwSetupDone = true;
            logger.info(`[Grok Web NSFW] Account-level NSFW setup completed for ${this.uuid}`);
        } catch (error) {
            logger.warn(`[Grok Web NSFW] Failed to setup account-level NSFW: ${error.message}`);
        }
    }

    async acceptTos() {
        try {
            await this._httpRequest({ url: `${this.baseUrl}/rest/app-chat/accept-tos`, method: 'post' });
        } catch (e) {
            logger.debug(`[Grok Web TOS] ${e.message}`);
        }
    }

    async setBirthDate() {
        try {
            await this._httpRequest({ url: `${this.baseUrl}/rest/app-chat/set-birth-date`, method: 'post', data: { "birthDate": "1990-01-01" } });
        } catch (e) {
            logger.debug(`[Grok Web Birth] ${e.message}`);
        }
    }

    async enableNsfwAccount() {
        const name = Buffer.from("always_show_nsfw_content");
        const inner = Buffer.concat([Buffer.from([0x0a, name.length]), name]);
        const protobuf = Buffer.concat([Buffer.from([0x0a, 0x02, 0x10, 0x01, 0x12, inner.length]), inner]);
        const headers = { ...this.buildHeaders(), 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', 'x-user-agent': 'connect-es/2.1.1', 'referer': `${this.baseUrl}/?_s=data` };
        try {
            await this._httpRequest({ url: `${this.baseUrl}/auth_mgmt.AuthManagement/UpdateUserFeatureControls`, method: 'post', headers, data: protobuf, responseType: 'arraybuffer' });
        } catch (e) {
            logger.debug(`[Grok Web NSFW] ${e.message}`);
        }
    }

    async generateContent(model, requestBody) {
        const maxRetries = this.getMaxRequestRetries();
        let lastError = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = (lastError?.response?.headers?.['retry-after'] || 5) * 1000;
                    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
                }
                if (!this.nsfwSetupDone) await this.setupNsfw();

                const messages = [];
                for await (const chunk of this.generateContentStream(model, requestBody)) {
                    if (chunk) messages.push(chunk);
                }
                if (messages.length > 0) return messages[messages.length - 1];
                throw new Error('No response received from Grok Web');

            } catch (error) {
                lastError = error;
                const { status } = await this.classifyApiError(error, 'generateContent');
                if (attempt === maxRetries || !error.shouldSwitchCredential) throw error;
                logger.warn(`[Grok Web] Attempt ${attempt + 1} failed, will retry... Error: ${error.message}`);
            }
        }
        throw lastError;
    }

    async *generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        const proxyConfig = getProxyConfigForProvider(this.config, MODEL_PROVIDER.GROK_WEB);
        const agent = proxyConfig?.httpsAgent;
        const wsUrl = this.getWebSocketUrl();
        const headers = this.buildWebSocketHeaders();

        const ws = new WebSocket(wsUrl, { headers, agent, handshakeTimeout: 30000, rejectUnauthorized: false });
        const messageQueue = [];
        let messageResolver = null;
        let isDone = false;
        let hasError = false;

        ws.on('open', () => logger.debug('[Grok Web] WebSocket connected'));
        ws.on('message', (data) => {
            try {
                const msg = parseMessage(data);
                if (msg) { messageQueue.push(msg); if (messageResolver) { messageResolver(); messageResolver = null; } }
            } catch (e) { logger.error(`[Grok Web] Failed to parse message:`, e.message); }
        });
        ws.on('close', () => { isDone = true; if (messageResolver) { messageResolver(); messageResolver = null; } });
        ws.on('error', () => { hasError = true; isDone = true; if (messageResolver) { messageResolver(); messageResolver = null; } });

        await new Promise((resolve, reject) => {
            const check = () => {
                if (ws.readyState === WebSocket.OPEN) return resolve();
                if (hasError) return reject(new Error('WebSocket connection failed'));
                setTimeout(check, 100);
            };
            check();
        });

        const conversationId = `conv_${uuidv4()}`;
        const clientEventId = `evt_${uuidv4()}`;
        const grokMessages = convertMessagesToGrokFormat(requestBody.messages || []);
        const payload = buildStartConversationPayload(conversationId, clientEventId, grokMessages);
        ws.send(JSON.stringify(payload));

        const collected = { message: '', tool_calls: [], usage: null };

        try {
            while (!isDone || messageQueue.length > 0) {
                if (messageQueue.length === 0 && !isDone) {
                    await new Promise(r => messageResolver = r);
                }
                while (messageQueue.length > 0) {
                    const msg = messageQueue.shift();
                    const converted = this.convertGrokWebResponse(msg, collected);
                    if (converted) yield converted;
                }
            }
        } finally {
            if (ws.readyState === WebSocket.OPEN) ws.close();
        }
    }

    convertGrokWebResponse(msg, collected) {
        if (!collected) collected = { message: '', tool_calls: [], usage: null };
        try {
            if (msg.event) {
                const event = msg.event;
                if (event.type === 'message' && event.message) {
                    const message = event.message;
                    if (message.content) {
                        if (typeof message.content === 'string') {
                            collected.message += message.content;
                        } else if (Array.isArray(message.content)) {
                            for (const item of message.content) {
                                if (item.type === 'text' && item.text) collected.message += item.text;
                            }
                        }
                    }
                    if (message.usage) collected.usage = message.usage;
                    return buildResponseChunk(collected, false);
                }
                if (event.type === 'done') return buildResponseChunk(collected, true);
            }
            if (msg.token) { collected.message += msg.token; return buildResponseChunk(collected, false); }
            if (msg.message) {
                if (typeof msg.message === 'string') collected.message += msg.message;
                else if (msg.message.content) collected.message += msg.message.content;
                return buildResponseChunk(collected, false);
            }
        } catch (e) { logger.error(`[Grok Web] Error converting response:`, e.message); }
        return null;
    }

    async listModels() {
        return GROK_WEB_MODELS;
    }

    async getUsageLimits() {
        try {
            const response = await this._httpRequest({
                url: `${this.baseUrl}/rest/rate-limits`,
                method: 'post',
                data: { "requestKind": "DEFAULT", "modelName": "fast" },
                timeout: 30000
            });
            this.lastSyncAt = Date.now();
            this.config.lastHealthCheckTime = new Date().toISOString();
            return response.data;
        } catch (error) {
            logger.warn('[Grok Web] Failed to get usage limits:', error.message);
            return {};
        }
    }

    isExpiryDateNear() {
        if (!this.lastSyncAt) return true;
        return (Date.now() - this.lastSyncAt) > (this.config.CRON_NEAR_MINUTES || 15) * 60 * 1000;
    }

    async refreshToken() {
        try {
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.GROK_WEB, this.uuid);
            }
            return true;
        } catch (error) {
            logger.error('[Grok Web] Failed to refresh token:', error.message);
            throw new Error(`Failed to refresh token: ${error.message}`);
        }
    }
}
