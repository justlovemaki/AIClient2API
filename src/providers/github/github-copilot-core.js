import axios from 'axios';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CopilotClient } from '@github/copilot-sdk';
import logger from '../../utils/logger.js';
import { configureAxiosProxy, configureTLSSidecar, isTLSSidecarEnabledForProvider } from '../../utils/proxy-utils.js';
import { isRetryableNetworkError, MODEL_PROVIDER, getRetryAfterMs } from '../../utils/common.js';

const COPILOT_AUTO_TIERS = new Set(['efficiency', 'balance', 'intelligence']);

export function normalizeCopilotAutoTier(value, fallback = 'balance') {
    const tier = String(value || fallback).toLowerCase();
    if (!COPILOT_AUTO_TIERS.has(tier)) {
        throw new Error(`[GitHub Copilot] Invalid Auto tier '${tier}'. Use efficiency, balance, or intelligence.`);
    }
    return tier;
}

function messageContentToText(content, attachments) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

    return content.map((part, index) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;

        const imageUrl = part.image_url?.url || part.url;
        if (typeof imageUrl !== 'string') return '';
        const dataUrl = imageUrl.match(/^data:([^;,]+);base64,(.+)$/s);
        if (dataUrl) {
            attachments.push({
                type: 'blob',
                data: dataUrl[2],
                mimeType: dataUrl[1],
                displayName: `chat-image-${index + 1}`
            });
            return `[Image attachment ${index + 1}]`;
        }
        return `[Image URL: ${imageUrl}]`;
    }).filter(Boolean).join('\n');
}

function buildCopilotPrompt(requestBody) {
    const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
    const systemMessages = [];
    const conversation = [];
    const attachments = [];

    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const content = messageContentToText(message.content, attachments);
        if (message.role === 'system' || message.role === 'developer') {
            if (content) systemMessages.push(content);
            continue;
        }

        const role = String(message.role || 'user').toUpperCase();
        const toolName = message.name ? ` (${message.name})` : '';
        conversation.push(`${role}${toolName}:\n${content}`);
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            conversation.push(`ASSISTANT TOOL CALLS:\n${JSON.stringify(message.tool_calls)}`);
        }
    }

    return {
        systemPrompt: systemMessages.join('\n\n') || 'You are a helpful assistant. Answer the user directly.',
        prompt: conversation.join('\n\n') || 'Respond to the user.',
        attachments
    };
}

function createChatCompletion(content, outputTokens) {
    const response = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'auto',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
    };
    if (Number.isFinite(outputTokens)) {
        response.usage = { prompt_tokens: 0, completion_tokens: outputTokens, total_tokens: outputTokens };
    }
    return response;
}

function createChatCompletionChunk(id, created, delta, finishReason = null) {
    return {
        id,
        object: 'chat.completion.chunk',
        created,
        model: 'auto',
        choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
}

// GitHub Copilot API Service
// GitHub Copilot uses OpenAI-compatible API endpoints but with GitHub-specific authentication
export class GitHubCopilotApiService {
    constructor(config) {
        this.config = config;
        this.baseUrl = config.GITHUB_COPILOT_BASE_URL || 'https://api.githubcopilot.com';
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_GITHUB ?? false;
        logger.info(`[GitHub Copilot] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        this.apiKey = config.GITHUB_COPILOT_API_KEY;
        this.sdkClientPromise = null;
        this.quotaCache = null;
        if (!this.apiKey) {
            logger.warn('[GitHub Copilot] No fine-grained personal access token found.');
        }

        const axiosConfig = {
            baseURL: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'AIClient2API'
            },
        };

        this.axiosInstance = axios.create(axiosConfig);
    }

    createSdkClient() {
        const safeId = String(this.config.uuid || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
        return new CopilotClient({
            gitHubToken: this.apiKey,
            useLoggedInUser: false,
            mode: 'empty',
            baseDirectory: path.join(os.tmpdir(), 'aiclient2api-copilot-sdk', safeId),
            logLevel: 'error'
        });
    }

    async getSdkClient() {
        if (!this.apiKey) {
            throw new Error('[GitHub Copilot] No fine-grained personal access token configured. Add one as GITHUB_COPILOT_API_KEY with the Copilot Requests permission.');
        }
        if (!this.sdkClientPromise) {
            const client = this.createSdkClient();
            this.sdkClientPromise = client.start().then(() => client).catch(async (error) => {
                this.sdkClientPromise = null;
                try {
                    await client.forceStop();
                } catch {}
                throw error;
            });
        }
        return this.sdkClientPromise;
    }

    async getQuota() {
        const now = Date.now();
        if (this.quotaCache && now - this.quotaCache.fetchedAt < 60000) {
            return { ...this.quotaCache.data };
        }

        const client = await this.getSdkClient();
        const result = await client.rpc.account.getQuota({ gitHubToken: this.apiKey });
        const quotaSnapshots = result?.quotaSnapshots || {};
        const quotaTypes = ['premium_interactions', 'chat', 'completions'];
        const quotaType = quotaTypes.find((type) => {
            const snapshot = quotaSnapshots[type];
            return snapshot && (snapshot.isUnlimitedEntitlement === true || Number(snapshot.entitlementRequests) > 0);
        }) || quotaTypes.find(type => quotaSnapshots[type]) || null;
        if (!quotaType) {
            const unavailable = {
                available: false,
                message: 'Copilot did not report a supported quota snapshot.'
            };
            this.quotaCache = { fetchedAt: now, data: unavailable };
            return { ...unavailable };
        }

        const snapshot = quotaSnapshots[quotaType];
        const isUnlimited = snapshot.isUnlimitedEntitlement === true || snapshot.entitlementRequests === -1;
        const remainingPercentage = Number(snapshot.remainingPercentage);
        const quota = {
            available: true,
            quotaType,
            usedRequests: Number(snapshot.usedRequests) || 0,
            entitlementRequests: Number(snapshot.entitlementRequests),
            remainingPercentage: isUnlimited || !Number.isFinite(remainingPercentage)
                ? null
                : Math.max(0, Math.min(100, remainingPercentage)),
            usedPercentage: isUnlimited || !Number.isFinite(remainingPercentage)
                ? null
                : Math.max(0, Math.min(100, 100 - remainingPercentage)),
            resetDate: snapshot.resetDate || null,
            isUnlimited
        };
        this.quotaCache = { fetchedAt: now, data: quota };
        return { ...quota };
    }

    async createAutoSession(requestBody, autoTier) {
        if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
            throw new Error('[GitHub Copilot] Auto mode via the Copilot SDK does not support OpenAI tool-call requests yet.');
        }

        const client = await this.getSdkClient();
        const { systemPrompt, prompt, attachments } = buildCopilotPrompt(requestBody);
        const session = await client.createSession({
            model: 'auto',
            capi: { autoTier },
            availableTools: [],
            systemMessage: { mode: 'append', content: systemPrompt }
        });
        return { client, session, prompt, attachments };
    }

    getAutoRequestContext(requestId, autoTier) {
        const safeRequestId = typeof requestId === 'string'
            ? requestId.replace(/[\r\n]/g, '').slice(0, 128)
            : 'unknown';
        const providerUuid = String(this.config.uuid || 'unknown').replace(/[\r\n]/g, '').slice(0, 128);
        return `provider=${providerUuid}, requestId=${safeRequestId}, model=auto, tier=${autoTier}`;
    }

    async cleanupSdkSession(client, session) {
        try {
            await session.disconnect();
        } catch (error) {
            logger.warn(`[GitHub Copilot SDK] Session disconnect failed: ${error.message}`);
        }
        try {
            await client.deleteSession(session.sessionId);
        } catch (error) {
            logger.warn(`[GitHub Copilot SDK] Session cleanup failed: ${error.message}`);
        }
    }

    async generateAutoContent(requestBody, requestId = null) {
        const startedAt = Date.now();
        let autoTier = 'invalid';
        let client;
        let session;
        let prompt;
        let attachments;
        try {
            autoTier = normalizeCopilotAutoTier(
                requestBody.auto_tier,
                this.config.GITHUB_COPILOT_AUTO_TIER || 'balance'
            );
            const context = this.getAutoRequestContext(requestId, autoTier);
            logger.info(`[GitHub Copilot SDK] Auto request started (${context})`);
            ({ client, session, prompt, attachments } = await this.createAutoSession(requestBody, autoTier));
            const response = await session.sendAndWait({ prompt, attachments });
            const outputTokens = response?.data?.outputTokens;
            logger.info(`[GitHub Copilot SDK] Auto request succeeded (${context}, durationMs=${Date.now() - startedAt}, outputTokens=${Number.isFinite(outputTokens) ? outputTokens : 'unknown'})`);
            return createChatCompletion(response?.data?.content || '', outputTokens);
        } catch (error) {
            const context = this.getAutoRequestContext(requestId, autoTier);
            logger.error(`[GitHub Copilot SDK] Auto request failed (${context}, durationMs=${Date.now() - startedAt}): ${error.message}`);
            throw error;
        } finally {
            if (client && session) {
                await this.cleanupSdkSession(client, session);
            }
        }
    }

    async *generateAutoContentStream(requestBody, requestId = null) {
        const startedAt = Date.now();
        let autoTier = 'invalid';
        let client;
        let session;
        let prompt;
        let attachments;
        let unsubscribe;
        let deltaStream;
        let hasDelta = false;
        let finalContent = '';

        try {
            autoTier = normalizeCopilotAutoTier(
                requestBody.auto_tier,
                this.config.GITHUB_COPILOT_AUTO_TIER || 'balance'
            );
            const context = this.getAutoRequestContext(requestId, autoTier);
            logger.info(`[GitHub Copilot SDK] Auto stream started (${context})`);
            ({ client, session, prompt, attachments } = await this.createAutoSession(requestBody, autoTier));
            const id = `chatcmpl-${randomUUID()}`;
            const created = Math.floor(Date.now() / 1000);
            deltaStream = new Readable({ objectMode: true, read() {} });
            unsubscribe = session.on((event) => {
                if (event.agentId) return;
                if (event.type === 'assistant.message_delta') {
                    hasDelta = true;
                    deltaStream.push(event.data.deltaContent);
                } else if (event.type === 'assistant.message') {
                    finalContent = event.data.content || '';
                } else if (event.type === 'session.idle') {
                    if (!hasDelta && finalContent) deltaStream.push(finalContent);
                    deltaStream.push(null);
                } else if (event.type === 'session.error') {
                    deltaStream.destroy(new Error(event.data.message));
                }
            });

            yield createChatCompletionChunk(id, created, { role: 'assistant' });
            const sendPromise = session.send({ prompt, attachments });
            sendPromise.catch(error => deltaStream.destroy(error));
            for await (const content of deltaStream) {
                if (content) {
                    yield createChatCompletionChunk(id, created, { content });
                }
            }
            await sendPromise;
            yield createChatCompletionChunk(id, created, {}, 'stop');
            logger.info(`[GitHub Copilot SDK] Auto stream succeeded (${context}, durationMs=${Date.now() - startedAt})`);
        } catch (error) {
            const context = this.getAutoRequestContext(requestId, autoTier);
            logger.error(`[GitHub Copilot SDK] Auto stream failed (${context}, durationMs=${Date.now() - startedAt}): ${error.message}`);
            throw error;
        } finally {
            unsubscribe?.();
            deltaStream?.destroy();
            if (client && session) {
                await this.cleanupSdkSession(client, session);
            }
        }
    }

    getAuthHeader() {
        return this.apiKey ? `Bearer ${this.apiKey}` : null;
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.GITHUB_COPILOT, this.baseUrl);
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.GITHUB_COPILOT, this.baseUrl);
    }

    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        try {
            const authHeader = this.getAuthHeader();
            if (!authHeader) {
                throw new Error('[GitHub Copilot] No fine-grained personal access token configured. Add one as GITHUB_COPILOT_API_KEY with the Copilot Requests permission.');
            }

            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: body,
                headers: {
                    'Authorization': authHeader
                }
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            const responseMessage = typeof data === 'string'
                ? data.trim()
                : data?.error?.message || data?.message;
            if (status && responseMessage) {
                error.message = `[GitHub Copilot API] HTTP ${status}: ${responseMessage}`;
            }

            // Check for retryable network errors
            const isNetworkError = isRetryableNetworkError(error);

            if (status === 401 || status === 403) {
                logger.error(`[GitHub Copilot API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[GitHub Copilot API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[GitHub Copilot API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[GitHub Copilot API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            // Handle network errors with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[GitHub Copilot API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`[GitHub Copilot API] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        const authHeader = this.getAuthHeader();
        if (!authHeader) {
            throw new Error('[GitHub Copilot] No fine-grained personal access token configured. Add one as GITHUB_COPILOT_API_KEY with the Copilot Requests permission.');
        }

        // GitHub Copilot streaming requires stream to be set to true
        const streamRequestBody = { ...body, stream: true };

        try {
            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: streamRequestBody,
                responseType: 'stream',
                headers: {
                    'Authorization': authHeader
                }
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);

            const stream = response.data;
            let buffer = '';

            for await (const chunk of stream) {
                buffer += chunk.toString();
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const jsonData = line.substring(6).trim();
                        if (jsonData === '[DONE]') {
                            return; // Stream finished
                        }
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            yield parsedChunk;
                        } catch (e) {
                            logger.warn("[GitHubCopilotApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
                        }
                    } else if (line === '') {
                        // Empty line, end of an event
                    }
                }
            }
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';

            // Check for retryable network errors
            const isNetworkError = isRetryableNetworkError(error);

            if (status === 401 || status === 403) {
                logger.error(`[GitHub Copilot API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[GitHub Copilot API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[GitHub Copilot API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[GitHub Copilot API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            // Handle network errors with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[GitHub Copilot API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`[GitHub Copilot API] Error calling streaming API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async generateContent(model, requestBody) {
        const requestId = requestBody._monitorRequestId || this.config._monitorRequestId || null;
        // Temporary storage for monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        if (String(model).toLowerCase() === 'auto') {
            return this.generateAutoContent(requestBody, requestId);
        }

        return this.callApi('/chat/completions', requestBody);
    }

    async *generateContentStream(model, requestBody) {
        const requestId = requestBody._monitorRequestId || this.config._monitorRequestId || null;
        // Temporary storage for monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        if (String(model).toLowerCase() === 'auto') {
            yield* this.generateAutoContentStream(requestBody, requestId);
            return;
        }

        yield* this.streamApi('/chat/completions', requestBody);
    }

    async listModels() {
        return { data: [{ id: 'auto', name: 'Auto', object: 'model', owned_by: 'github-copilot' }] };
    }
}