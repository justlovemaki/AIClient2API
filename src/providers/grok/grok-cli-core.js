import { atomicWriteFile } from '../../utils/file-lock.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { refreshGrokCliTokensWithRetry } from '../../auth/oauth-handlers.js';
import { getProviderPoolManager } from '../../services/service-manager.js';
import { configureTLSSidecar } from '../../utils/proxy-utils.js';
import { MODEL_PROVIDER, formatExpiryLog, getRetryAfterMs, normalizeProviderErrorMessage } from '../../utils/common.js';
import { getProviderModels } from '../provider-models.js';
import { isGrokCliQualityModel, resolveGrokCliQualityModel } from './grok-cli-models.js';

const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const GROK_CLI_DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const XAI_DEFAULT_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth/token';
const GROK_CLI_DEFAULT_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const GROK_CLI_DEFAULT_SUBSCRIPTIONS_URL = 'https://grok.com/rest/subscriptions';
const GROK_CLI_CLIENT_VERSION = '1.0.13';
const XAI_REDIRECT_URI = 'http://127.0.0.1:56121/callback';
const GROK_CLI_DEFAULT_MODEL = 'grok-3-mini';
const GROK_CLI_MODELS = getProviderModels(MODEL_PROVIDER.GROK_CLI || 'grok-cli-oauth');
const GROK_CLI_IMAGE_MODELS = new Set([
    'grok-imagine-image-quality',
    'grok-imagine-image',
    'grok-imagine-image-pro'
]);
const GROK_CLI_VIDEO_MODELS = new Set([
    'grok-imagine-video',
    'grok-imagine-video-1.5-preview',
    'grok-imagine-video-1.5-2026-05-30'
]);
const GROK_CLI_MEDIA_MODEL_PREFIXES = new Set(['', 'xai', 'x-ai', 'grok']);
const XAI_IMAGES_GENERATIONS_PATH = '/images/generations';
const XAI_IMAGES_EDITS_PATH = '/images/edits';
const XAI_IMAGES_DEFAULT_ASPECT_RATIO = '1:1';
const XAI_IMAGES_DEFAULT_RESOLUTION = '1k';
const XAI_VIDEOS_GENERATIONS_PATH = '/videos/generations';
const XAI_VIDEOS_EDITS_PATH = '/videos/edits';
const XAI_VIDEOS_EXTENSIONS_PATH = '/videos/extensions';
const XAI_VIDEOS_DEFAULT_SECONDS = 4;
const XAI_VIDEOS_DEFAULT_SIZE = '720x1280';
const XAI_VIDEOS_DEFAULT_RESOLUTION = '720p';
const XAI_VIDEOS_MAX_REFERENCES = 7;
const XAI_VIDEO_POLL_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const XAI_VIDEO_POLL_DEFAULT_INTERVAL_MS = 5000;
const XAI_DEFAULT_BUILTIN_TOOLS = ['web_search', 'x_search', 'code_interpreter', 'collections_search', 'attachment_search'];
const XAI_BUILTIN_TOOL_NAME_ALIASES = new Map([
    ['web_search_preview', 'web_search'],
    ['web_search_preview_2025_03_11', 'web_search'],
    ['code_execution', 'code_interpreter'],
    ['file_search', 'file_search'],
    ...XAI_DEFAULT_BUILTIN_TOOLS.map(name => [name, name])
]);
const XAI_SUPPORTED_TOOL_TYPES = new Set([
    'function',
    'web_search',
    'web_search_preview',
    'web_search_preview_2025_03_11',
    'x_search',
    'code_interpreter',
    'code_execution',
    'file_search',
    'collections_search',
    'attachment_search'
]);

function parseExpiry(value) {
    if (!value) return null;
    if (typeof value === 'number') {
        return new Date(value < 10000000000 ? value * 1000 : value);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return new Date(numeric < 10000000000 ? numeric * 1000 : numeric);
    }
    return null;
}

function parseJwtClaims(token) {
    if (!token) return {};
    try {
        const parts = String(token).split('.');
        if (parts.length !== 3) return {};
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return {};
    }
}

function moneyValue(value) {
    if (value == null) return undefined;
    if (typeof value === 'number') return value;
    return value.val;
}

function percentValue(value) {
    if (value == null) return undefined;
    return Math.round(value * 100) / 100;
}

function formatPtReset(iso) {
    if (!iso) return undefined;

    // Grok CLI TUI uses a fixed UTC-8 "PT" label here, not daylight-adjusted PDT.
    const utcMs = new Date(iso).getTime();
    if (Number.isNaN(utcMs)) return undefined;

    const fixedPt = new Date(utcMs - 8 * 60 * 60 * 1000);
    const month = fixedPt.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const day = fixedPt.toLocaleString('en-US', { day: 'numeric', timeZone: 'UTC' });
    const hour = fixedPt.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'UTC' });
    const minute = fixedPt.toLocaleString('en-US', { minute: '2-digit', timeZone: 'UTC' });

    return `${month} ${day}, ${hour}:${minute} PT`;
}

function normalizeSubscriptionTier(tier) {
    switch (tier) {
        case 'SUBSCRIPTION_TIER_X_PREMIUM_PLUS':
            return 'X Premium+';
        case 'SUBSCRIPTION_TIER_X_PREMIUM':
            return 'X Premium';
        case 'SUBSCRIPTION_TIER_SUPERGROK':
            return 'SuperGrok';
        case 'SUBSCRIPTION_TIER_SUPERGROK_HEAVY':
            return 'SuperGrok Heavy';
        default:
            return tier;
    }
}

function isActiveSubscription(status) {
    return status === 'SUBSCRIPTION_STATUS_ACTIVE' || status === 'SubscriptionStatusActive';
}

function tierContains(tier, needle) {
    return String(tier || '').replace(/_/g, '').toLowerCase().includes(needle.toLowerCase());
}

function resolveGrokAccountTier(subscriptions) {
    const active = Array.isArray(subscriptions?.subscriptions)
        ? subscriptions.subscriptions.filter(item => isActiveSubscription(item.status))
        : [];

    const hasMax =
        active.some(item => item.enterprise || item.eapi || item.braintree) ||
        active.some(item => tierContains(item.tier, 'SuperGrokPro') || tierContains(item.tier, 'SuperGrokHeavy'));
    if (hasMax) return 'SuperGrok Heavy';

    const hasSuperGrok =
        active.some(item => tierContains(item.tier, 'GrokPro')) ||
        active.some(item => tierContains(item.tier, 'XPremiumPlus'));
    if (hasSuperGrok) return 'SuperGrok';

    const hasLite = active.some(item => tierContains(item.tier, 'SuperGrokLite'));
    if (hasLite) return 'SuperGrok Lite';

    return active.length > 0 ? 'Free' : undefined;
}

function summarizeBillingUsage(data = {}, subscriptions = undefined) {
    const config = data.config || data || {};
    const currentPeriod = config.currentPeriod || {};
    const periodEnd = currentPeriod.end || config.billingPeriodEnd;
    const activeSubscription = subscriptions?.subscriptions?.find(item => isActiveSubscription(item.status)) || subscriptions?.subscriptions?.[0];
    const rawSubscriptionTier = config.subscription_tier || activeSubscription?.tier;
    const grokAccountTier = resolveGrokAccountTier(subscriptions);
    const subscriptionTier = grokAccountTier || normalizeSubscriptionTier(rawSubscriptionTier);

    return {
        periodType: currentPeriod.type,
        periodStart: currentPeriod.start || config.billingPeriodStart,
        periodEnd,
        nextResetPt: formatPtReset(periodEnd),
        weeklyLimitPercent: percentValue(config.creditUsagePercent),
        onDemandUsed: moneyValue(config.onDemandUsed),
        onDemandCap: moneyValue(config.onDemandCap),
        prepaidBalance: moneyValue(config.prepaidBalance),
        topUpMethod: config.topUpMethod,
        grokAccountTier,
        rawSubscriptionTier,
        subscriptionTier,
        subscriptionStatus: activeSubscription?.status,
        unifiedBillingUser: config.isUnifiedBillingUser,
        products: Array.isArray(config.productUsage)
            ? config.productUsage.map(item => ({
                product: item.product,
                usagePercent: percentValue(item.usagePercent)
            }))
            : []
    };
}

function sanitizeCredentialFilenamePart(value) {
    const sanitized = String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120);

    return sanitized || 'default';
}

function normalizeBaseUrl(baseUrl) {
    const value = String(baseUrl || XAI_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    return value || XAI_DEFAULT_BASE_URL;
}

function modelSupportsReasoning(model) {
    const name = String(model || '').toLowerCase();
    return name.includes('reasoning') ||
        name.includes('grok-3-mini') ||
        name.includes('grok-4.3') ||
        name.includes('grok-4.5') ||
        name.includes('grok-4.6') ||
        name.includes('grok-build') ||
        name.includes('multi-agent');
}

function modelSupportsAgenticTools(model) {
    const name = String(model || '').toLowerCase();
    return name.includes('grok-4') ||
        name.includes('grok-build') ||
        name.includes('multi-agent') ||
        name.includes('reasoning');
}

function parseBooleanOption(value, fallback = null) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
    return fallback;
}

function parseStringList(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value
            .flatMap(item => parseStringList(item))
            .filter(Boolean);
    }
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function splitGrokCliMediaModel(model) {
    const value = String(model || '').trim().toLowerCase();
    const slashIndex = value.lastIndexOf('/');
    if (slashIndex >= 0 && slashIndex < value.length - 1) {
        return {
            prefix: value.slice(0, slashIndex).trim(),
            baseModel: value.slice(slashIndex + 1).trim()
        };
    }
    return { prefix: '', baseModel: value };
}

function normalizeGrokCliMediaModel(model) {
    const { prefix, baseModel } = splitGrokCliMediaModel(model);
    if (!GROK_CLI_MEDIA_MODEL_PREFIXES.has(prefix)) {
        return String(model || '').trim().toLowerCase();
    }
    return baseModel;
}

function isGrokCliImageModel(model) {
    return GROK_CLI_IMAGE_MODELS.has(normalizeGrokCliMediaModel(model));
}

function isGrokCliVideoModel(model) {
    return GROK_CLI_VIDEO_MODELS.has(normalizeGrokCliMediaModel(model));
}

function isGrokCliImageToVideoOnlyModel(model) {
    const name = normalizeGrokCliMediaModel(model);
    return name === 'grok-imagine-video-1.5-preview' ||
        name === 'grok-imagine-video-1.5-2026-05-30';
}

function extractTextFromImageContent(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (!part) return '';
                if (typeof part === 'string') return part;
                if (typeof part.text === 'string') return part.text;
                if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
                    return part.text || '';
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    if (typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
        if (typeof content.content === 'string') return content.content;
        if (Array.isArray(content.content)) return extractTextFromImageContent(content.content);
    }

    return '';
}

function normalizeGrokCliModelAlias(model) {
    const value = String(model || '').trim();
    const lowerValue = value.toLowerCase();
    const aliases = {
        grok3: 'grok-3',
        'grok 3': 'grok-3',
        grok3mini: 'grok-3-mini',
        'grok3-mini': 'grok-3-mini',
        'grok 3 mini': 'grok-3-mini'
    };
    return aliases[lowerValue] || lowerValue;
}

function normalizeGrokCliTextModel(model) {
    const rawModel = String(model || '').trim();
    if (!rawModel) return rawModel;

    const { prefix, baseModel } = splitGrokCliMediaModel(rawModel);
    if (prefix && GROK_CLI_MEDIA_MODEL_PREFIXES.has(prefix)) {
        return normalizeGrokCliModelAlias(baseModel);
    }

    return normalizeGrokCliModelAlias(rawModel);
}

function normalizeFileUrlValue(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        return value.url || value.file_url || value.fileUrl || '';
    }
    return '';
}

function convertOpenAIContentPartToResponses(part, role) {
    if (!part) return null;

    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    if (typeof part === 'string') {
        return { type: textType, text: part };
    }

    if (typeof part !== 'object') return null;

    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
        const text = part.text ?? part.content;
        if (typeof text !== 'string') return null;
        return {
            type: part.type === 'text' ? textType : part.type,
            text
        };
    }

    if (part.type === 'image_url' || part.type === 'input_image') {
        const imageUrl = part.image_url || part.image;
        if (!imageUrl) return null;
        return {
            type: 'input_image',
            image_url: imageUrl
        };
    }

    if (part.image_url || part.image) {
        return {
            type: 'input_image',
            image_url: part.image_url || part.image
        };
    }

    if (part.type === 'file' || part.type === 'input_file') {
        const fileId = part.file_id || part.fileId || part.id;
        const fileUrl = normalizeFileUrlValue(part.file_url || part.fileUrl || part.url);
        if (fileId) {
            return {
                type: 'input_file',
                file_id: fileId
            };
        }
        if (fileUrl) {
            return {
                type: 'input_file',
                file_url: fileUrl
            };
        }
    }

    if (part.file_id || part.fileId || part.file_url || part.fileUrl) {
        const fileId = part.file_id || part.fileId;
        const fileUrl = normalizeFileUrlValue(part.file_url || part.fileUrl || part.url);
        if (fileId) return { type: 'input_file', file_id: fileId };
        if (fileUrl) return { type: 'input_file', file_url: fileUrl };
    }

    return null;
}

function convertOpenAIMessagesToResponsesInput(messages = []) {
    const input = [];
    const instructions = [];

    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;

        const role = message.role || 'user';
        if (role === 'system' || role === 'developer') {
            const text = extractTextFromImageContent(message.content).trim();
            if (text) instructions.push(text);
            continue;
        }

        if (role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.tool_call_id || message.call_id,
                output: typeof message.content === 'string'
                    ? message.content
                    : extractTextFromImageContent(message.content)
            });
            continue;
        }

        if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
                input.push({
                    type: 'function_call',
                    call_id: toolCall.id,
                    name: toolCall.function?.name,
                    arguments: toolCall.function?.arguments || ''
                });
            }
        }

        const rawContent = Array.isArray(message.content) ? message.content : [message.content];
        const content = rawContent
            .map(part => convertOpenAIContentPartToResponses(part, role))
            .filter(Boolean);
        if (Array.isArray(message.attachments)) {
            const attachments = message.attachments
                .map(attachment => convertOpenAIContentPartToResponses({
                    type: 'input_file',
                    file_id: attachment?.file_id || attachment?.fileId || attachment?.id,
                    file_url: attachment?.file_url || attachment?.fileUrl || attachment?.url
                }, role))
                .filter(Boolean);
            content.push(...attachments);
        }

        if (content.length > 0) {
            input.push({
                type: 'message',
                role,
                content
            });
        }
    }

    return {
        input,
        instructions: instructions.join('\n')
    };
}

function extractImagePrompt(requestBody = {}) {
    if (typeof requestBody.prompt === 'string' && requestBody.prompt.trim()) {
        return requestBody.prompt.trim();
    }

    if (requestBody.prompt && typeof requestBody.prompt === 'object') {
        const text = extractTextFromImageContent(requestBody.prompt).trim();
        if (text) return text;
    }

    if (typeof requestBody.input === 'string' && requestBody.input.trim()) {
        return requestBody.input.trim();
    }

    if (Array.isArray(requestBody.input)) {
        const text = requestBody.input
            .map(item => {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (item.type === 'message') return extractTextFromImageContent(item.content);
                return extractTextFromImageContent(item);
            })
            .filter(Boolean)
            .join('\n')
            .trim();
        if (text) return text;
    }

    if (Array.isArray(requestBody.messages)) {
        const text = requestBody.messages
            .map(message => extractTextFromImageContent(message?.content))
            .filter(Boolean)
            .join('\n')
            .trim();
        if (text) return text;
    }

    return '';
}

function getXaiProviderOptions(requestBody = {}) {
    return requestBody.providerOptions?.xai ||
        requestBody.provider_options?.xai ||
        requestBody.providerOptions?.xAI ||
        requestBody.provider_options?.xAI ||
        {};
}

function getGrokCliCollectionIds(config = {}, requestBody = {}) {
    const xaiOptions = getXaiProviderOptions(requestBody);
    return parseStringList(
        requestBody.vector_store_ids ||
        requestBody.vectorStoreIds ||
        requestBody.collection_ids ||
        requestBody.collectionIds ||
        requestBody.source?.vector_store_ids ||
        requestBody.source?.vectorStoreIds ||
        requestBody.source?.collection_ids ||
        requestBody.source?.collectionIds ||
        xaiOptions.vector_store_ids ||
        xaiOptions.vectorStoreIds ||
        xaiOptions.collection_ids ||
        xaiOptions.collectionIds ||
        xaiOptions.source?.vector_store_ids ||
        xaiOptions.source?.vectorStoreIds ||
        xaiOptions.source?.collection_ids ||
        xaiOptions.source?.collectionIds ||
        config.GROK_CLI_VECTOR_STORE_IDS ||
        config.GROK_CLI_COLLECTION_IDS ||
        config.XAI_VECTOR_STORE_IDS ||
        config.XAI_COLLECTION_IDS
    );
}

function shouldEnableDefaultGrokCliTools(config = {}, requestBody = {}, model = '') {
    const xaiOptions = getXaiProviderOptions(requestBody);
    const explicit = parseBooleanOption(
        requestBody.enable_builtin_tools ??
        requestBody.enableBuiltinTools ??
        requestBody.grok_cli_enable_builtin_tools ??
        xaiOptions.enable_builtin_tools ??
        xaiOptions.enableBuiltinTools ??
        config.GROK_CLI_ENABLE_BUILTIN_TOOLS ??
        config.XAI_ENABLE_BUILTIN_TOOLS,
        null
    );
    const disabled = parseBooleanOption(
        requestBody.disable_builtin_tools ??
        requestBody.disableBuiltinTools ??
        xaiOptions.disable_builtin_tools ??
        xaiOptions.disableBuiltinTools ??
        config.GROK_CLI_DISABLE_BUILTIN_TOOLS ??
        config.XAI_DISABLE_BUILTIN_TOOLS,
        false
    );

    if (disabled) return false;
    if (explicit !== null) return explicit;
    return modelSupportsAgenticTools(model);
}

function normalizeGrokCliTool(tool = {}) {
    if (!tool || typeof tool !== 'object') return null;
    const type = String(tool.type || '').trim().toLowerCase();
    if (!XAI_SUPPORTED_TOOL_TYPES.has(type)) return null;

    if (type === 'function') {
        const func = tool.function && typeof tool.function === 'object' ? tool.function : tool;
        const name = func.name || tool.name;
        if (!name) return null;

        const normalized = {
            type: 'function',
            name,
            description: func.description || tool.description || '',
            parameters: func.parameters || tool.parameters || func.input_schema || tool.input_schema || {
                type: 'object',
                properties: {}
            }
        };
        if (func.strict !== undefined || tool.strict !== undefined) {
            normalized.strict = func.strict ?? tool.strict;
        }
        return normalized;
    }

    if (type === 'web_search_preview' || type === 'web_search_preview_2025_03_11') {
        const normalized = { ...tool, type: 'web_search' };
        delete normalized.external_web_access;
        return normalized;
    }
    if (type === 'web_search') {
        const normalized = { ...tool, type: 'web_search' };
        delete normalized.external_web_access;
        return normalized;
    }
    if (type === 'code_execution') return { ...tool, type: 'code_interpreter' };

    if (type === 'collections_search' || type === 'file_search') {
        const vectorStoreIds = parseStringList(
            tool.vector_store_ids ||
            tool.vectorStoreIds ||
            tool.collection_ids ||
            tool.collectionIds ||
            tool.source?.vector_store_ids ||
            tool.source?.vectorStoreIds ||
            tool.source?.collection_ids ||
            tool.source?.collectionIds
        );
        if (vectorStoreIds.length === 0) return null;

        const normalized = {
            ...tool,
            type: 'file_search',
            vector_store_ids: vectorStoreIds
        };
        delete normalized.collection_ids;
        delete normalized.collectionIds;
        delete normalized.vectorStoreIds;
        delete normalized.source;
        return normalized;
    }

    // xAI attaches this server-side tool implicitly when input_file parts are present.
    if (type === 'attachment_search') return null;

    return { ...tool, type };
}

function normalizeGrokCliToolChoice(toolChoice) {
    if (toolChoice === undefined) return undefined;
    if (toolChoice === null) return null;
    if (typeof toolChoice === 'string') return toolChoice;
    if (typeof toolChoice !== 'object') return undefined;

    const type = String(toolChoice.type || '').trim().toLowerCase();
    if (!type) return undefined;

    if (type === 'allowed_tools' && Array.isArray(toolChoice.tools)) {
        const tools = toolChoice.tools
            .map(tool => normalizeGrokCliTool(tool))
            .filter(Boolean);
        return tools.length > 0 ? { ...toolChoice, type: 'allowed_tools', tools } : null;
    }

    if (type === 'function') {
        const name = toolChoice.name || toolChoice.function?.name;
        return name ? { type: 'function', name } : null;
    }

    const normalized = normalizeGrokCliTool({ ...toolChoice, type });
    if (!normalized) return null;
    return { ...toolChoice, type: normalized.type };
}

function buildGrokCliTools(config = {}, requestBody = {}, model = '') {
    const toolsByType = new Map();
    const toolNames = new Set();
    const addTool = tool => {
        const normalized = normalizeGrokCliTool(tool);
        if (!normalized) return;
        const key = normalized.type === 'function'
            ? `function:${normalized.name || normalized.function?.name || crypto.randomUUID()}`
            : normalized.type;
        const toolName = normalized.type === 'function'
            ? String(normalized.name || normalized.function?.name || '').trim()
            : XAI_BUILTIN_TOOL_NAME_ALIASES.get(normalized.type) || normalized.type;
        if (toolName && toolNames.has(toolName)) {
            logger.warn(`[Grok CLI] Dropping duplicate tool name '${toolName}' to avoid xAI 400 Duplicate tool names error.`);
            return;
        }
        if (!toolsByType.has(key)) {
            toolsByType.set(key, normalized);
            if (toolName) toolNames.add(toolName);
        }
    };

    if (Array.isArray(requestBody.tools)) {
        requestBody.tools.forEach(tool => addTool(tool));
    }

    if (shouldEnableDefaultGrokCliTools(config, requestBody, model)) {
        const requestedDefaults = parseStringList(
            requestBody.default_builtin_tools ||
            requestBody.defaultBuiltinTools ||
            getXaiProviderOptions(requestBody).default_builtin_tools ||
            getXaiProviderOptions(requestBody).defaultBuiltinTools ||
            config.GROK_CLI_DEFAULT_BUILTIN_TOOLS ||
            config.XAI_DEFAULT_BUILTIN_TOOLS
        );
        const defaultTypes = requestedDefaults.length > 0 ? requestedDefaults : XAI_DEFAULT_BUILTIN_TOOLS;
        defaultTypes.forEach(type => addTool({ type }));

        const collectionIds = getGrokCliCollectionIds(config, requestBody);
        if (collectionIds.length > 0) {
            addTool({
                type: 'file_search',
                vector_store_ids: collectionIds,
                max_num_results: parsePositiveInteger(
                    requestBody.max_num_results ||
                    requestBody.maxNumResults ||
                    getXaiProviderOptions(requestBody).max_num_results ||
                    getXaiProviderOptions(requestBody).maxNumResults ||
                    config.GROK_CLI_COLLECTION_MAX_RESULTS ||
                    config.XAI_COLLECTION_MAX_RESULTS
                ) || 10
            });
        }
    }

    return Array.from(toolsByType.values());
}

function addImageReference(refs, imageRef) {
    if (!imageRef) return;

    if (typeof imageRef === 'string') {
        refs.push({ type: 'image_url', url: imageRef });
        return;
    }

    if (Array.isArray(imageRef)) {
        imageRef.forEach(item => addImageReference(refs, item));
        return;
    }

    if (typeof imageRef !== 'object') return;

    if (typeof imageRef.url === 'string') {
        refs.push({ type: imageRef.type || 'image_url', url: imageRef.url });
        return;
    }

    if (typeof imageRef.image_url === 'string') {
        refs.push({ type: 'image_url', url: imageRef.image_url });
        return;
    }

    if (imageRef.image_url && typeof imageRef.image_url === 'object') {
        addImageReference(refs, imageRef.image_url);
        return;
    }

    if (imageRef.image) {
        addImageReference(refs, imageRef.image);
    }
}

function collectImageReferencesFromContent(refs, content) {
    if (!content) return;

    if (Array.isArray(content)) {
        content.forEach(part => collectImageReferencesFromContent(refs, part));
        return;
    }

    if (typeof content !== 'object') return;

    if (content.type === 'image_url' || content.type === 'input_image') {
        addImageReference(refs, content.image_url || content.image || content);
        return;
    }

    if (content.image_url || content.image) {
        addImageReference(refs, content.image_url || content.image);
        return;
    }

    if (content.content) {
        collectImageReferencesFromContent(refs, content.content);
    }
}

function extractImageReferences(requestBody = {}) {
    const refs = [];
    const xaiOptions = getXaiProviderOptions(requestBody);

    addImageReference(refs, requestBody.image);
    addImageReference(refs, requestBody.image_url);
    addImageReference(refs, requestBody.images);
    addImageReference(refs, requestBody.reference_image);
    addImageReference(refs, requestBody.reference_image_url);
    addImageReference(refs, requestBody.reference_images);
    addImageReference(refs, requestBody.reference_image_urls);
    addImageReference(refs, requestBody.input_reference?.image_url);
    addImageReference(refs, requestBody.input_reference?.imageUrl);
    addImageReference(refs, requestBody.inputReference?.image_url);
    addImageReference(refs, requestBody.inputReference?.imageUrl);
    addImageReference(refs, requestBody['input_reference.image_url']);
    addImageReference(refs, requestBody['input_reference[image_url]']);
    addImageReference(refs, requestBody.prompt?.image);
    addImageReference(refs, requestBody.prompt?.images);
    addImageReference(refs, xaiOptions.image);
    addImageReference(refs, xaiOptions.imageUrl);
    addImageReference(refs, xaiOptions.inputReference?.image_url);
    addImageReference(refs, xaiOptions.inputReference?.imageUrl);
    addImageReference(refs, xaiOptions.referenceImage);
    addImageReference(refs, xaiOptions.referenceImageUrl);
    addImageReference(refs, xaiOptions.referenceImages);
    addImageReference(refs, xaiOptions.referenceImageUrls);

    if (Array.isArray(requestBody.messages)) {
        requestBody.messages.forEach(message => collectImageReferencesFromContent(refs, message?.content));
    }

    if (Array.isArray(requestBody.input)) {
        requestBody.input.forEach(item => collectImageReferencesFromContent(refs, item));
    }

    const seen = new Set();
    return refs.filter(ref => {
        const url = String(ref?.url || '').trim();
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
    });
}

function addVideoReference(refs, videoRef) {
    if (!videoRef) return;

    if (typeof videoRef === 'string') {
        refs.push({ url: videoRef });
        return;
    }

    if (Array.isArray(videoRef)) {
        videoRef.forEach(item => addVideoReference(refs, item));
        return;
    }

    if (typeof videoRef !== 'object') return;

    if (typeof videoRef.url === 'string') {
        refs.push({ url: videoRef.url });
        return;
    }

    if (typeof videoRef.video_url === 'string') {
        refs.push({ url: videoRef.video_url });
        return;
    }

    if (videoRef.video_url && typeof videoRef.video_url === 'object') {
        addVideoReference(refs, videoRef.video_url);
        return;
    }

    if (videoRef.video) {
        addVideoReference(refs, videoRef.video);
    }
}

function collectVideoReferencesFromContent(refs, content) {
    if (!content) return;

    if (Array.isArray(content)) {
        content.forEach(part => collectVideoReferencesFromContent(refs, part));
        return;
    }

    if (typeof content !== 'object') return;

    if (content.type === 'video_url' || content.type === 'input_video') {
        addVideoReference(refs, content.video_url || content.video || content);
        return;
    }

    if (content.video_url || content.video) {
        addVideoReference(refs, content.video_url || content.video);
        return;
    }

    if (content.content) {
        collectVideoReferencesFromContent(refs, content.content);
    }
}

function extractVideoReferences(requestBody = {}) {
    const refs = [];
    const xaiOptions = getXaiProviderOptions(requestBody);

    addVideoReference(refs, requestBody.video);
    addVideoReference(refs, requestBody.video_url);
    addVideoReference(refs, requestBody.videos);
    addVideoReference(refs, requestBody.prompt?.video);
    addVideoReference(refs, requestBody.prompt?.videoUrl);
    addVideoReference(refs, xaiOptions.video);
    addVideoReference(refs, xaiOptions.videoUrl);

    if (Array.isArray(requestBody.messages)) {
        requestBody.messages.forEach(message => collectVideoReferencesFromContent(refs, message?.content));
    }

    if (Array.isArray(requestBody.input)) {
        requestBody.input.forEach(item => collectVideoReferencesFromContent(refs, item));
    }

    const seen = new Set();
    return refs.filter(ref => {
        const url = String(ref?.url || '').trim();
        if (!url || seen.has(url)) return false;
        seen.add(url);
        return true;
    });
}

function toXaiMediaReference(ref) {
    const url = String(ref?.url || '').trim();
    return url ? { url } : null;
}

function extractInputReferenceImage(requestBody = {}) {
    const xaiOptions = getXaiProviderOptions(requestBody);
    const inputReference = requestBody.input_reference ||
        requestBody.inputReference ||
        xaiOptions.input_reference ||
        xaiOptions.inputReference ||
        {};
    const fileId = inputReference.file_id ||
        inputReference.fileId ||
        requestBody['input_reference.file_id'] ||
        requestBody['input_reference[file_id]'];
    if (fileId) {
        throw new Error('input_reference.file_id is not supported for Grok CLI video generation; use input_reference.image_url');
    }

    const imageUrl = inputReference.image_url ||
        inputReference.imageUrl ||
        requestBody['input_reference.image_url'] ||
        requestBody['input_reference[image_url]'];
    if (!imageUrl) return null;
    const refs = [];
    addImageReference(refs, imageUrl);
    return refs.map(toXaiMediaReference).filter(Boolean)[0] || null;
}

function extractExplicitVideoReferenceImages(requestBody = {}) {
    const refs = [];
    const xaiOptions = getXaiProviderOptions(requestBody);
    addImageReference(refs, requestBody.reference_images);
    addImageReference(refs, requestBody.reference_image_urls);
    addImageReference(refs, xaiOptions.referenceImages);
    addImageReference(refs, xaiOptions.referenceImageUrls);
    return refs.map(toXaiMediaReference).filter(Boolean);
}

function parseImageSize(size) {
    const match = String(size || '').trim().match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    return { width, height };
}

function mapImageSizeToAspectRatio(size) {
    const parsed = parseImageSize(size);
    if (!parsed) return null;

    const ratio = parsed.width / parsed.height;
    const knownRatios = [
        ['1:1', 1],
        ['16:9', 16 / 9],
        ['9:16', 9 / 16],
        ['4:3', 4 / 3],
        ['3:4', 3 / 4],
        ['3:2', 3 / 2],
        ['2:3', 2 / 3],
        ['2:1', 2],
        ['1:2', 1 / 2]
    ];
    const [closest, closestRatio] = knownRatios.reduce((best, current) =>
        Math.abs(current[1] - ratio) < Math.abs(best[1] - ratio) ? current : best
    );

    return Math.abs(closestRatio - ratio) <= 0.05 ? closest : null;
}

function mapImageSizeToResolution(size) {
    const parsed = parseImageSize(size);
    if (!parsed) return null;
    return Math.max(parsed.width, parsed.height) > 1024 ? '2k' : '1k';
}

function normalizeImageAspectRatio(value, fallback = '') {
    switch (String(value || '').trim().toLowerCase()) {
        case '1:1':
        case 'square':
            return '1:1';
        case '16:9':
        case 'landscape':
            return '16:9';
        case '9:16':
        case 'portrait':
            return '9:16';
        case '4:3':
            return '4:3';
        case '3:4':
            return '3:4';
        case '3:2':
            return '3:2';
        case '2:3':
            return '2:3';
        default:
            return fallback;
    }
}

function normalizeImageResolution(value, size = '', fallback = '') {
    switch (String(value || '').trim().toLowerCase()) {
        case '1k':
            return '1k';
        case '2k':
            return '2k';
        default:
            return mapImageSizeToResolution(size) || fallback;
    }
}

function normalizeImageResponseFormat(value) {
    return String(value || '').trim().toLowerCase() === 'url' ? 'url' : 'b64_json';
}

function getImageMimeType(item = {}) {
    const raw = String(item.mime_type || item.mimeType || item.output_format || item.outputFormat || '').trim().toLowerCase();
    if (raw.includes('/')) return raw;
    switch (raw) {
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'webp':
            return 'image/webp';
        case 'png':
        default:
            return 'image/png';
    }
}

function getImageOutputFormat(mimeType = '') {
    const normalized = String(mimeType || '').trim().toLowerCase();
    if (normalized.includes('/')) {
        return normalized.split('/').pop() || 'png';
    }
    return normalized || 'png';
}

function normalizeImageBase64(value = '') {
    const raw = String(value || '').trim();
    const dataUrlMatch = raw.match(/^data:([^;,]+);base64,(.+)$/i);
    if (dataUrlMatch) {
        return {
            mimeType: dataUrlMatch[1] || 'image/png',
            b64: dataUrlMatch[2] || ''
        };
    }
    return {
        mimeType: '',
        b64: raw
    };
}

function imageDataUrl(b64 = '', mimeType = 'image/png') {
    const cleanB64 = String(b64 || '').trim();
    if (!cleanB64) return '';
    return `data:${mimeType || 'image/png'};base64,${cleanB64}`;
}

function mapVideoSizeOptions(size) {
    const value = String(size || XAI_VIDEOS_DEFAULT_SIZE).trim();
    switch (value) {
        case '720x1280':
        case '1024x1792':
            return { size: value, aspectRatio: '9:16', resolution: XAI_VIDEOS_DEFAULT_RESOLUTION };
        case '1280x720':
        case '1792x1024':
            return { size: value, aspectRatio: '16:9', resolution: XAI_VIDEOS_DEFAULT_RESOLUTION };
        default:
            throw new Error('size must be one of 720x1280, 1280x720, 1024x1792, or 1792x1024');
    }
}

function normalizeVideoAspectRatio(value, fallback = '') {
    switch (String(value || '').trim().toLowerCase()) {
        case '1:1':
        case 'square':
            return '1:1';
        case '16:9':
        case 'landscape':
            return '16:9';
        case '9:16':
        case 'portrait':
            return '9:16';
        case '4:3':
            return '4:3';
        case '3:4':
            return '3:4';
        case '3:2':
            return '3:2';
        case '2:3':
            return '2:3';
        default:
            return fallback;
    }
}

function normalizeVideoResolution(value, fallback = '') {
    switch (String(value || '').trim().toLowerCase()) {
        case '480p':
            return '480p';
        case '720p':
            return '720p';
        default:
            return fallback;
    }
}

function parsePositiveInteger(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeVideoDuration(value, fallback = XAI_VIDEOS_DEFAULT_SECONDS) {
    let duration = parsePositiveInteger(value);
    if (!duration) {
        duration = fallback;
    }
    if (duration < 1) return 1;
    if (duration > 15) return 15;
    return duration;
}

function resolveVideoEndpointMode(requestBody = {}, endpointMode = null) {
    if (endpointMode) return endpointMode;

    const xaiOptions = getXaiProviderOptions(requestBody);
    const mode = String(
        requestBody.mode ||
        requestBody.video_mode ||
        requestBody.videoMode ||
        xaiOptions.mode ||
        ''
    ).trim().toLowerCase();

    if (mode === 'edit-video' || mode === 'edit' || mode === 'video-edit') {
        return 'edits';
    }
    if (mode === 'extend-video' || mode === 'extend' || mode === 'video-extension') {
        return 'extensions';
    }
    return 'generations';
}

function getVideoEndpointPath(mode) {
    if (mode === 'edits') return XAI_VIDEOS_EDITS_PATH;
    if (mode === 'extensions') return XAI_VIDEOS_EXTENSIONS_PATH;
    return XAI_VIDEOS_GENERATIONS_PATH;
}

function shouldPollVideoResult(requestBody = {}) {
    const xaiOptions = getXaiProviderOptions(requestBody);
    const values = [
        requestBody.poll,
        requestBody.wait,
        requestBody._wait_for_completion,
        requestBody.wait_for_completion,
        requestBody.waitForCompletion,
        xaiOptions.poll,
        xaiOptions.wait,
        xaiOptions.wait_for_completion,
        xaiOptions.waitForCompletion
    ];

    for (const value of values) {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (value === false || normalized === 'false' || normalized === '0' || normalized === 'no') {
            return false;
        }
    }

    return true;
}

function extractVideoUrl(videoResponse = {}) {
    const video = videoResponse?.video || {};
    return video.url ||
        video.video_url ||
        videoResponse.url ||
        videoResponse.video_url ||
        videoResponse.data?.[0]?.url ||
        '';
}

function extractVideoThumbnailUrl(videoResponse = {}) {
    const video = videoResponse?.video || {};
    return video.thumbnail_url ||
        video.thumbnailImageUrl ||
        videoResponse.thumbnail_url ||
        videoResponse.thumbnailImageUrl ||
        '';
}


/**
 * Grok CLI OAuth / xAI Responses API 服务类。
 *
 * 与 CodexApiService 保持同一调用形态：
 * - 初始化只加载凭据，不阻塞刷新。
 * - 过期刷新交给 ProviderPoolManager 后台队列。
 * - 非流式请求同样读取 xAI SSE，聚合 response.completed 后返回。
 */
export class GrokCliApiService {
    constructor(config) {
        this.config = config;
        this.baseUrl = normalizeBaseUrl(config.GROK_CLI_BASE_URL || config.XAI_BASE_URL || GROK_CLI_DEFAULT_BASE_URL);
        this.accessToken = null;
        this.refreshTokenValue = null;
        this.idToken = null;
        this.tokenType = 'Bearer';
        this.email = null;
        this.subject = null;
        this.userId = null;
        this.teamId = null;
        this.expiresAt = null;
        this.last_refresh = null;
        this.tokenEndpoint = config.GROK_CLI_TOKEN_ENDPOINT || XAI_DEFAULT_TOKEN_ENDPOINT;
        this.credsPath = null;
        this.uuid = config.uuid;
        this.isInitialized = false;
        this.accessTokenOnlyRefreshLogged = false;
        this.subscriptionsCache = null;
        this.subscriptionsSyncedAt = 0;
        this.loggedGrokAccountTier = null;
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(
            axiosConfig,
            this.config,
            this.config.MODEL_PROVIDER || MODEL_PROVIDER.GROK_CLI,
            this.baseUrl
        );
    }

    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Grok CLI] Initializing Grok CLI API Service...');
        await this.loadCredentials();
        this.isInitialized = true;
        logger.info(`[Grok CLI] Initialization complete. Account: ${this.email || this.subject || 'unknown'}`);
    }

    async loadCredentials() {
        const email = this.config.GROK_CLI_EMAIL || this.config.XAI_EMAIL || 'default';

        try {
            let creds;
            let credsPath;

            if (this.config.GROK_CLI_OAUTH_CREDS_FILE_PATH || this.config.XAI_OAUTH_CREDS_FILE_PATH) {
                credsPath = this.config.GROK_CLI_OAUTH_CREDS_FILE_PATH || this.config.XAI_OAUTH_CREDS_FILE_PATH;
                const exists = await this.fileExists(credsPath);
                if (!exists) {
                    throw new Error('Grok CLI credentials not found. Please authenticate first using OAuth.');
                }
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            } else {
                const targetDir = path.join(process.cwd(), 'configs', 'grok-cli');
                const files = await fs.readdir(targetDir);
                const safeEmail = sanitizeCredentialFilenamePart(email);
                const matchingFile = files
                    .filter(f => f.endsWith('.json') && (f.includes(`xai-${safeEmail}`) || f.includes('xai-')))
                    .sort()
                    .pop();

                if (!matchingFile) {
                    throw new Error('Grok CLI credentials not found. Please authenticate first using OAuth.');
                }

                credsPath = path.join(targetDir, matchingFile);
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            }

            this.credsPath = credsPath;
            this.idToken = creds.id_token || this.idToken;
            this.accessToken = creds.access_token;
            this.refreshTokenValue = creds.refresh_token;
            this.tokenType = creds.token_type || this.tokenType || 'Bearer';
            this.email = creds.email;
            this.subject = creds.sub || creds.subject;
            const accessClaims = parseJwtClaims(this.accessToken);
            this.userId = creds.user_id || creds.userId || accessClaims.principal_id || accessClaims.sub || this.userId;
            this.teamId = creds.team_id || creds.teamId || accessClaims.team_id || this.teamId;
            this.last_refresh = creds.last_refresh || this.last_refresh;
            this.tokenEndpoint = creds.token_endpoint || this.tokenEndpoint || XAI_DEFAULT_TOKEN_ENDPOINT;
            this.baseUrl = normalizeBaseUrl(
                this.config.GROK_CLI_BASE_URL ||
                this.config.XAI_BASE_URL ||
                (creds.auth_kind === 'oauth' ? GROK_CLI_DEFAULT_BASE_URL : creds.base_url) ||
                this.baseUrl
            );
            this.expiresAt = parseExpiry(creds.expired ?? creds.expires_at ?? creds.expiresAt);

            if (this.isExpiryDateNear()) {
                this.triggerBackgroundRefresh();
            }

            this.isInitialized = true;
            logger.info(`[Grok CLI] Initialized with account: ${this.email || this.subject || 'unknown'}`);
        } catch (error) {
            logger.warn(`[Grok CLI Auth] Failed to load credentials: ${error.message}`);
        }
    }

    async initializeAuth(forceRefresh = false) {
        if (this.accessToken && !forceRefresh) {
            return;
        }

        await this.loadCredentials();

        if (forceRefresh || !this.accessToken) {
            if (!this.refreshTokenValue) {
                if (this.accessToken) {
                    this.logAccessTokenOnlyRefreshSkipped();
                    return;
                }
                throw new Error('Grok CLI credentials not found. Please authenticate first using OAuth.');
            }

            logger.info('[Grok CLI] Token expiring soon or refresh requested, refreshing...');
            await this.refreshAccessToken();
        }
    }

    triggerBackgroundRefresh() {
        if (!this.refreshTokenValue) {
            this.logAccessTokenOnlyRefreshSkipped();
            return;
        }

        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Grok CLI] Token is near expiry, marking credential ${this.uuid} for background refresh`);
            poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.GROK_CLI, {
                uuid: this.uuid
            });
        }
    }

    logAccessTokenOnlyRefreshSkipped() {
        if (this.accessTokenOnlyRefreshLogged) return;
        this.accessTokenOnlyRefreshLogged = true;
        logger.warn('[Grok CLI] Access-token-only credential cannot be refreshed because refresh_token is empty. Re-authenticate when it expires.');
    }

    async generateContent(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        const selectedModel = this.resolveModel(model);
        this.applyInternalRequestMetadata(requestBody);

        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        if (isGrokCliImageModel(selectedModel)) {
            return this.generateImageResponseContent(selectedModel, requestBody);
        }

        if (isGrokCliVideoModel(selectedModel)) {
            return this.generateVideoContent(selectedModel, requestBody);
        }

        const body = await this.prepareRequestBody(selectedModel, requestBody, true);
        const url = `${this.baseUrl}/responses`;

        try {
            const axiosRequestConfig = {
                method: 'post',
                url,
                data: body,
                headers: this.buildHeaders(true, body.prompt_cache_key),
                responseType: 'text',
                timeout: 300000
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(axiosRequestConfig);
            return this.parseNonStreamResponse(response.data);
        } catch (error) {
            await this.handleRequestError(error, 'non-stream');
        }
    }

    async *generateContentStream(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        const selectedModel = this.resolveModel(model);
        this.applyInternalRequestMetadata(requestBody);

        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        if (isGrokCliImageModel(selectedModel)) {
            yield* this.generateImageContentStream(selectedModel, requestBody);
            return;
        }

        if (isGrokCliVideoModel(selectedModel)) {
            yield* this.generateVideoContentStream(selectedModel, requestBody);
            return;
        }

        const body = await this.prepareRequestBody(selectedModel, requestBody, true);
        const url = `${this.baseUrl}/responses`;

        try {
            const axiosRequestConfig = {
                method: 'post',
                url,
                data: body,
                headers: this.buildHeaders(true, body.prompt_cache_key),
                responseType: 'stream',
                timeout: 300000
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(axiosRequestConfig);
            yield* this.parseSSEStream(response.data);
        } catch (error) {
            await this.handleRequestError(error, 'stream');
        }
    }

    async generateImageContent(model, requestBody) {
        const { endpointPath, body } = this.prepareImageRequestBody(model, requestBody);
        const url = `${this.baseUrl}${endpointPath}`;

        try {
            const axiosRequestConfig = {
                method: 'post',
                url,
                data: body,
                headers: this.buildImageHeaders(),
                timeout: 300000
            };
            this._applySidecar(axiosRequestConfig);

            logger.info(`[Grok CLI] Image request model=${model}, endpoint=${endpointPath}, response_format=${body.response_format}`);
            const response = await axios.request(axiosRequestConfig);
            return this.normalizeImageResponse(response.data, model);
        } catch (error) {
            await this.handleRequestError(error, endpointPath === XAI_IMAGES_EDITS_PATH ? 'image-edit' : 'image-generation');
        }
    }

    async generateImageResponseContent(model, requestBody) {
        const nativeImageResponse = await this.generateImageContent(model, {
            ...requestBody,
            response_format: 'b64_json',
            _forceImageResponseFormat: 'b64_json'
        });
        return this.buildImageTextResponse(nativeImageResponse, model);
    }

    async *generateImageContentStream(model, requestBody) {
        const response = await this.generateImageResponseContent(model, {
            ...requestBody,
            stream: false
        });
        yield* this.streamTextResponse(response);
    }

    async generateVideoContent(model, requestBody) {
        const startResponse = await this.startVideoContent(model, requestBody);
        let nativeVideoResponse = startResponse;

        if (shouldPollVideoResult(requestBody)) {
            const requestId = startResponse?.request_id || startResponse?.id;
            if (!extractVideoUrl(nativeVideoResponse)) {
                if (!requestId) {
                    throw new Error('xAI video response did not include request_id or video URL.');
                }
                nativeVideoResponse = await this.pollVideoResult(requestId, requestBody);
            }

            if (!extractVideoUrl(nativeVideoResponse)) {
                throw new Error(`Grok CLI video request ${requestId || ''} completed without video URL.`);
            }
        }

        return this.buildVideoTextResponse(nativeVideoResponse, model);
    }

    async *generateVideoContentStream(model, requestBody) {
        const response = await this.generateVideoContent(model, {
            ...requestBody,
            stream: false
        });
        yield* this.streamTextResponse(response);
    }

    async startVideoContent(model, requestBody = {}, endpointMode = null) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        const selectedModel = this.resolveModel(model);
        this.applyInternalRequestMetadata(requestBody);

        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        if (!isGrokCliVideoModel(selectedModel)) {
            throw new Error(`Model '${selectedModel}' is not a Grok CLI video model.`);
        }

        const { endpointPath, body } = this.prepareVideoRequestBody(selectedModel, requestBody, endpointMode);
        const url = `${this.baseUrl}${endpointPath}`;

        try {
            const axiosRequestConfig = {
                method: 'post',
                url,
                data: body,
                headers: this.buildJsonHeaders(),
                timeout: 300000
            };
            this._applySidecar(axiosRequestConfig);

            logger.info(`[Grok CLI] Video request model=${selectedModel}, endpoint=${endpointPath}`);
            const response = await axios.request(axiosRequestConfig);
            return this.normalizeVideoResponse(response.data, selectedModel);
        } catch (error) {
            const mode = endpointPath === XAI_VIDEOS_EDITS_PATH
                ? 'video-edit'
                : endpointPath === XAI_VIDEOS_EXTENSIONS_PATH
                    ? 'video-extension'
                    : 'video-generation';
            await this.handleRequestError(error, mode);
        }
    }

    async getVideoStatus(requestId) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        const cleanRequestId = String(requestId || '').trim();
        if (!cleanRequestId) {
            throw new Error('request_id is required for Grok CLI video status');
        }

        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        try {
            const axiosRequestConfig = {
                method: 'get',
                url: `${this.baseUrl}/videos/${encodeURIComponent(cleanRequestId)}`,
                headers: this.buildJsonHeaders(),
                timeout: 300000
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(axiosRequestConfig);
            return this.normalizeVideoResponse(response.data);
        } catch (error) {
            await this.handleRequestError(error, 'video-status');
        }
    }

    async pollVideoResult(requestId, requestBody = {}) {
        const xaiOptions = getXaiProviderOptions(requestBody);
        const timeoutMs = parsePositiveInteger(requestBody.poll_timeout_ms || requestBody.pollTimeoutMs || xaiOptions.pollTimeoutMs) ||
            XAI_VIDEO_POLL_DEFAULT_TIMEOUT_MS;
        const intervalMs = parsePositiveInteger(requestBody.poll_interval_ms || requestBody.pollIntervalMs || xaiOptions.pollIntervalMs) ||
            XAI_VIDEO_POLL_DEFAULT_INTERVAL_MS;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() <= deadline) {
            const result = await this.getVideoStatus(requestId);
            const status = String(result?.status || '').toLowerCase();
            if (this.isVideoCompletedStatus(status)) {
                return result;
            }
            if (this.isVideoFailedStatus(status)) {
                throw new Error(`Grok CLI video request ${requestId} ${status}`);
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        throw new Error(`Grok CLI video request ${requestId} timed out after ${timeoutMs}ms`);
    }

    isVideoCompletedStatus(status) {
        return ['completed', 'done', 'succeeded', 'success'].includes(String(status || '').toLowerCase());
    }

    isVideoFailedStatus(status) {
        return ['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
    }

    resolveModel(model) {
        const rawModel = String(model || '').trim();
        const normalizedMediaModel = normalizeGrokCliMediaModel(rawModel);
        if (GROK_CLI_IMAGE_MODELS.has(normalizedMediaModel) || GROK_CLI_VIDEO_MODELS.has(normalizedMediaModel)) {
            return normalizedMediaModel;
        }

        const normalizedTextModel = normalizeGrokCliTextModel(rawModel);
        if (isGrokCliQualityModel(normalizedTextModel)) {
            return normalizedTextModel;
        }
        if (!GROK_CLI_MODELS.length || GROK_CLI_MODELS.includes(normalizedTextModel)) {
            return normalizedTextModel;
        }

        const defaultModel = GROK_CLI_MODELS.includes(GROK_CLI_DEFAULT_MODEL)
            ? GROK_CLI_DEFAULT_MODEL
            : (GROK_CLI_MODELS[0] || GROK_CLI_DEFAULT_MODEL);
        if (this.config.MODEL_FALLBACK_ENABLED === false) {
            throw new Error(`[Grok CLI] 模型不存在: ${rawModel}`);
        }
        logger.warn(`[Grok CLI] Model '${rawModel}' not found in supported list. Falling back to default: '${defaultModel}'`);
        return defaultModel;
    }

    applyInternalRequestMetadata(requestBody) {
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }
    }

    async prepareRequestBody(model, requestBody, stream) {
        const cleanedBody = { ...requestBody };
        const qualityModel = resolveGrokCliQualityModel(model);
        const metadata = cleanedBody.metadata || {};
        const convertedMessages = Array.isArray(cleanedBody.messages)
            ? convertOpenAIMessagesToResponsesInput(cleanedBody.messages)
            : null;

        if (convertedMessages) {
            if (!cleanedBody.input || (Array.isArray(cleanedBody.input) && cleanedBody.input.length === 0)) {
                cleanedBody.input = convertedMessages.input;
            }
            if (!cleanedBody.instructions && convertedMessages.instructions) {
                cleanedBody.instructions = convertedMessages.instructions;
            }
        }

        cleanedBody.model = qualityModel.model;
        if (qualityModel.effort && !cleanedBody.reasoning && !cleanedBody.reasoning_effort) {
            cleanedBody.reasoning_effort = qualityModel.effort;
        }
        cleanedBody.stream = stream;
        cleanedBody.store = cleanedBody.store ?? false;

        if (cleanedBody.max_tokens !== undefined && cleanedBody.max_output_tokens === undefined) {
            cleanedBody.max_output_tokens = cleanedBody.max_tokens;
        }

        delete cleanedBody.messages;
        delete cleanedBody.metadata;
        delete cleanedBody.max_tokens;
        delete cleanedBody.previous_response_id;
        delete cleanedBody.prompt_cache_retention;
        delete cleanedBody.safety_identifier;
        delete cleanedBody.stream_options;

        if (!modelSupportsReasoning(model)) {
            delete cleanedBody.reasoning;
            delete cleanedBody.reasoning_effort;
        } else if (cleanedBody.reasoning_effort && !cleanedBody.reasoning) {
            cleanedBody.reasoning = { effort: cleanedBody.reasoning_effort };
            delete cleanedBody.reasoning_effort;
        }

        const grokTools = buildGrokCliTools(this.config, cleanedBody, model);
        if (grokTools.length > 0) {
            cleanedBody.tools = grokTools;
        } else {
            delete cleanedBody.tools;
        }

        const grokToolChoice = normalizeGrokCliToolChoice(cleanedBody.tool_choice);
        if (grokToolChoice === undefined) {
            // Keep absent/unknown tool_choice untouched only when the caller did not send one.
            if (cleanedBody.tool_choice === undefined) {
                delete cleanedBody.tool_choice;
            }
        } else if (grokToolChoice === null) {
            delete cleanedBody.tool_choice;
        } else {
            cleanedBody.tool_choice = grokToolChoice;
        }

        delete cleanedBody.providerOptions;
        delete cleanedBody.provider_options;
        delete cleanedBody.enable_builtin_tools;
        delete cleanedBody.enableBuiltinTools;
        delete cleanedBody.grok_cli_enable_builtin_tools;
        delete cleanedBody.disable_builtin_tools;
        delete cleanedBody.disableBuiltinTools;
        delete cleanedBody.default_builtin_tools;
        delete cleanedBody.defaultBuiltinTools;
        delete cleanedBody.collection_ids;
        delete cleanedBody.collectionIds;
        delete cleanedBody.vector_store_ids;
        delete cleanedBody.vectorStoreIds;
        delete cleanedBody.max_num_results;
        delete cleanedBody.maxNumResults;
        delete cleanedBody.source;

        const sessionId = metadata.session_id ||
            metadata.conversation_id ||
            metadata.execution_session_id ||
            cleanedBody.prompt_cache_key ||
            '';
        if (sessionId) {
            cleanedBody.prompt_cache_key = String(sessionId);
        }

        if (this.config?._monitorRequestId) {
            try {
                const { getPluginManager } = await import('../../core/plugin-manager.js');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onInternalRequestConverted', {
                        requestId: this.config._monitorRequestId,
                        internalRequest: cleanedBody,
                        converterName: 'GrokCliApiService.prepareRequestBody'
                    });
                }
            } catch (e) {
                logger.error('[Grok CLI] Error calling onInternalRequestConverted hook:', e.message);
            }
        }

        return cleanedBody;
    }

    prepareImageRequestBody(model, requestBody = {}) {
        const prompt = extractImagePrompt(requestBody);
        if (!prompt) {
            throw new Error('prompt is required for Grok CLI image generation');
        }

        const xaiOptions = getXaiProviderOptions(requestBody);
        const imageRefs = extractImageReferences(requestBody);
        const isEdit = imageRefs.length > 0;
        const size = requestBody.size || requestBody._imageSize || xaiOptions.size;
        const aspectRatio = normalizeImageAspectRatio(
            requestBody.aspect_ratio ||
            requestBody.aspectRatio ||
            xaiOptions.aspect_ratio ||
            xaiOptions.aspectRatio,
            mapImageSizeToAspectRatio(size) || (isEdit ? '' : XAI_IMAGES_DEFAULT_ASPECT_RATIO)
        );
        const resolution = normalizeImageResolution(
            requestBody.resolution || xaiOptions.resolution,
            size,
            isEdit ? '' : XAI_IMAGES_DEFAULT_RESOLUTION
        );
        const responseFormat = normalizeImageResponseFormat(
            requestBody._forceImageResponseFormat ||
            requestBody.response_format ||
            xaiOptions.response_format ||
            xaiOptions.responseFormat
        );

        const body = {
            model,
            prompt,
            n: 1,
            response_format: responseFormat
        };

        if (aspectRatio) {
            body.aspect_ratio = aspectRatio;
        }
        if (resolution) {
            body.resolution = resolution;
        }

        if (imageRefs.length === 1) {
            body.image = imageRefs[0];
        } else if (imageRefs.length > 1) {
            body.images = imageRefs.slice(0, 3);
        }

        return {
            endpointPath: imageRefs.length > 0 ? XAI_IMAGES_EDITS_PATH : XAI_IMAGES_GENERATIONS_PATH,
            body
        };
    }

    prepareVideoRequestBody(model, requestBody = {}, endpointMode = null) {
        const prompt = extractImagePrompt(requestBody);
        if (!prompt) {
            throw new Error('prompt is required for Grok CLI video generation');
        }

        const xaiOptions = getXaiProviderOptions(requestBody);
        const mode = resolveVideoEndpointMode(requestBody, endpointMode);
        const endpointPath = getVideoEndpointPath(mode);
        const explicitInputImage = extractInputReferenceImage(requestBody);
        const allImageRefs = extractImageReferences(requestBody).map(toXaiMediaReference).filter(Boolean);
        const explicitReferenceImages = extractExplicitVideoReferenceImages(requestBody);
        const hasExplicitReferenceImages = explicitReferenceImages.length > 0;
        const hasDirectInputImage = !!(
            requestBody.image ||
            requestBody.image_url ||
            requestBody.input_reference?.image_url ||
            requestBody.inputReference?.image_url ||
            requestBody['input_reference.image_url'] ||
            requestBody['input_reference[image_url]']
        );
        const imageRefs = allImageRefs;
        const videoRefs = extractVideoReferences(requestBody).map(toXaiMediaReference).filter(Boolean);
        const size = requestBody.size || requestBody._videoSize || requestBody._imageSize;
        const videoSizeOptions = mapVideoSizeOptions(size);
        const aspectRatio = normalizeVideoAspectRatio(
            requestBody.aspect_ratio ||
            requestBody.aspectRatio ||
            xaiOptions.aspect_ratio ||
            xaiOptions.aspectRatio,
            videoSizeOptions.aspectRatio
        );
        const resolution = normalizeVideoResolution(
            requestBody.resolution || xaiOptions.resolution,
            videoSizeOptions.resolution
        );
        let duration = normalizeVideoDuration(
            requestBody.duration ||
            requestBody.seconds ||
            requestBody.video_length ||
            requestBody.videoLength ||
            xaiOptions.duration
        );
        const providerMode = String(xaiOptions.mode || requestBody.mode || '').trim().toLowerCase();
        const isReferenceMode = providerMode === 'reference-to-video' ||
            hasExplicitReferenceImages ||
            imageRefs.length > 1;

        const body = {
            model,
            prompt
        };

        if ((explicitInputImage || hasDirectInputImage) && hasExplicitReferenceImages) {
            throw new Error('image and reference_images cannot be combined on xAI');
        }

        if (isReferenceMode && imageRefs.length > XAI_VIDEOS_MAX_REFERENCES) {
            throw new Error(`reference_images supports at most ${XAI_VIDEOS_MAX_REFERENCES} images on xAI`);
        }

        if (isReferenceMode && duration > 10) {
            duration = 10;
        }

        body.duration = duration;

        if (endpointPath === XAI_VIDEOS_GENERATIONS_PATH) {
            if (isGrokCliImageToVideoOnlyModel(model) && imageRefs.length === 0) {
                throw new Error(`${model} requires an image or reference image; text-to-video is not supported by this model.`);
            }

            if (aspectRatio) {
                body.aspect_ratio = aspectRatio;
            }
            if (resolution) {
                body.resolution = resolution;
            }

            if (imageRefs.length > 0) {
                if (isReferenceMode || imageRefs.length > 1) {
                    body.reference_images = imageRefs.slice(0, XAI_VIDEOS_MAX_REFERENCES);
                } else {
                    body.image = explicitInputImage || imageRefs[0];
                }
            }
        } else {
            const video = videoRefs[0];
            if (!video) {
                throw new Error(`video is required for Grok CLI ${endpointPath === XAI_VIDEOS_EXTENSIONS_PATH ? 'video extension' : 'video editing'}`);
            }
            body.video = video;
        }

        return {
            endpointPath,
            body
        };
    }

    buildHeaders(stream = true, sessionId = '') {
        const headers = {
            'content-type': 'application/json',
            'authorization': `${this.tokenType || 'Bearer'} ${this.accessToken}`,
            'accept': stream ? 'text/event-stream' : 'application/json',
            'Connection': 'Keep-Alive',
            'x-xai-token-auth': 'xai-grok-cli',
            'x-grok-client-version': this.config.GROK_CLI_CLIENT_VERSION || GROK_CLI_CLIENT_VERSION,
            'user-agent': `grok-cli/${this.config.GROK_CLI_CLIENT_VERSION || GROK_CLI_CLIENT_VERSION}`,
        };

        if (sessionId) {
            headers['x-grok-conv-id'] = sessionId;
        }

        return headers;
    }

    buildJsonHeaders() {
        return {
            'content-type': 'application/json',
            'authorization': `${this.tokenType || 'Bearer'} ${this.accessToken}`,
            'accept': 'application/json',
            'Connection': 'Keep-Alive',
            'x-xai-token-auth': 'xai-grok-cli',
            'x-grok-client-version': this.config.GROK_CLI_CLIENT_VERSION || GROK_CLI_CLIENT_VERSION,
            'user-agent': `grok-cli/${this.config.GROK_CLI_CLIENT_VERSION || GROK_CLI_CLIENT_VERSION}`,
        };
    }

    buildSubscriptionHeaders() {
        const headers = {
            'authorization': `${this.tokenType || 'Bearer'} ${this.accessToken}`,
            'accept': 'application/json,text/plain,*/*',
            'x-xai-token-auth': 'xai-grok-cli',
            'x-grok-client-version': this.config.GROK_CLI_CLIENT_VERSION || GROK_CLI_CLIENT_VERSION,
            'user-agent': `grok-cli/${this.config.GROK_CLI_CLIENT_VERSION || GROK_CLI_CLIENT_VERSION}`,
            'Connection': 'Keep-Alive'
        };

        if (this.userId) {
            headers['x-userid'] = this.userId;
        }
        if (this.teamId) {
            headers['x-teamid'] = this.teamId;
        }

        return headers;
    }

    buildImageHeaders() {
        return this.buildJsonHeaders();
    }

    normalizeImageResponse(data, model) {
        let payload = data;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                return { created: Math.floor(Date.now() / 1000), data: [] };
            }
        }

        if (Array.isArray(payload?.data)) {
            return {
                ...payload,
                model: payload.model || model,
                created: payload.created || Math.floor(Date.now() / 1000)
            };
        }

        if (payload?.url || payload?.b64_json) {
            return {
                created: Math.floor(Date.now() / 1000),
                model,
                data: [payload]
            };
        }

        return payload;
    }

    extractImageOutputs(imageResponse = {}) {
        const rawItems = [];
        const addItems = value => {
            if (!value) return;
            if (Array.isArray(value)) {
                value.forEach(item => addItems(item));
                return;
            }
            rawItems.push(value);
        };

        addItems(imageResponse.data);
        addItems(imageResponse.images);
        if (imageResponse.url || imageResponse.b64_json || imageResponse.result) {
            addItems(imageResponse);
        }

        const outputs = [];
        for (const item of rawItems) {
            if (!item) continue;

            if (typeof item === 'string') {
                if (item.startsWith('data:image/')) {
                    const normalized = normalizeImageBase64(item);
                    outputs.push({
                        b64: normalized.b64,
                        url: imageDataUrl(normalized.b64, normalized.mimeType || 'image/png'),
                        mimeType: normalized.mimeType || 'image/png',
                        outputFormat: getImageOutputFormat(normalized.mimeType || 'image/png'),
                        revisedPrompt: ''
                    });
                } else {
                    outputs.push({
                        b64: '',
                        url: item,
                        mimeType: 'image/png',
                        outputFormat: 'png',
                        revisedPrompt: ''
                    });
                }
                continue;
            }

            if (typeof item !== 'object') continue;

            const rawB64 = item.b64_json || item.result || item.image?.b64_json || item.image?.base64 || '';
            const normalized = normalizeImageBase64(rawB64);
            const mimeType = normalized.mimeType || getImageMimeType(item);
            const b64 = normalized.b64;
            const url = item.url ||
                item.image_url ||
                item.image?.url ||
                (b64 ? imageDataUrl(b64, mimeType) : '');

            if (!b64 && !url) continue;

            outputs.push({
                b64,
                url,
                mimeType,
                outputFormat: getImageOutputFormat(item.output_format || item.outputFormat || mimeType),
                revisedPrompt: item.revised_prompt || item.revisedPrompt || ''
            });
        }

        return outputs;
    }

    formatImageResponseText(imageResponse = {}) {
        const outputs = this.extractImageOutputs(imageResponse);
        if (outputs.length === 0) {
            return 'Grok image request completed.';
        }

        return outputs
            .map((output, index) => {
                const imageUrl = output.url || imageDataUrl(output.b64, output.mimeType);
                const label = outputs.length > 1 ? `image ${index + 1}` : 'image';
                const lines = imageUrl ? [`![${label}](${imageUrl})`] : ['Grok image request completed.'];
                if (output.revisedPrompt) lines.push(`revised_prompt: ${output.revisedPrompt}`);
                return lines.join('\n');
            })
            .join('\n\n');
    }

    buildImageTextResponse(imageResponse = {}, model) {
        const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
        const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
        const createdAt = imageResponse.created || Math.floor(Date.now() / 1000);
        const outputs = this.extractImageOutputs(imageResponse);
        const outputItems = outputs
            .filter(output => output.b64)
            .map(output => ({
                id: `ig_${crypto.randomUUID().replace(/-/g, '')}`,
                type: 'image_generation_call',
                status: 'completed',
                result: output.b64,
                output_format: output.outputFormat || 'png',
                revised_prompt: output.revisedPrompt || undefined
            }));

        for (const output of outputs) {
            if (output.b64) continue;
            outputItems.push({
                id: `ig_${crypto.randomUUID().replace(/-/g, '')}`,
                type: 'image_generation_call',
                status: 'completed',
                url: output.url,
                image_url: output.url,
                output_format: output.outputFormat || 'png',
                revised_prompt: output.revisedPrompt || undefined
            });
        }

        outputItems.push({
            id: messageId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{
                type: 'output_text',
                text: this.formatImageResponseText(imageResponse),
                annotations: []
            }]
        });

        const usage = imageResponse.usage || {};
        const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
        const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
        const totalTokens = usage.total_tokens || inputTokens + outputTokens;

        return {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            status: 'completed',
            model,
            output: outputItems,
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: totalTokens
            },
            image: imageResponse,
            images: outputs
        };
    }

    normalizeVideoResponse(data, model = null) {
        let payload = data;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                return { status: 'unknown', raw: payload };
            }
        }

        if (!payload || typeof payload !== 'object') {
            return payload;
        }

        const normalized = {
            ...payload
        };

        if (model && !normalized.model) {
            normalized.model = model;
        }

        const videoUrl = normalized.video?.url || normalized.url || normalized.video_url;
        if (videoUrl && !Array.isArray(normalized.data)) {
            normalized.data = [{ url: videoUrl }];
        }

        return normalized;
    }

    formatVideoResponseText(videoResponse = {}) {
        const requestId = videoResponse.request_id || videoResponse.id || '';
        const status = videoResponse.status || '';
        const progress = videoResponse.progress;
        const videoUrl = extractVideoUrl(videoResponse);
        const thumbnailUrl = extractVideoThumbnailUrl(videoResponse);

        const lines = [];
        if (videoUrl) {
            lines.push(`[Play Video](${videoUrl})`);
            if (thumbnailUrl) lines.push(`[Video Thumbnail](${thumbnailUrl})`);
        } else if (this.isVideoCompletedStatus(status)) {
            lines.push('Grok video request completed but no video URL was returned.');
        } else {
            lines.push('Grok video request submitted and is still processing.');
        }

        if (requestId) lines.push(`request_id: ${requestId}`);
        if (status) lines.push(`status: ${status}`);
        if (progress !== undefined && progress !== null && progress !== '') lines.push(`progress: ${progress}`);

        return lines.join('\n');
    }

    buildVideoTextResponse(videoResponse = {}, model) {
        const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
        const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
        const text = this.formatVideoResponseText(videoResponse);
        const createdAt = Math.floor(Date.now() / 1000);

        return {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            status: 'completed',
            model,
            output: [{
                id: messageId,
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{
                    type: 'output_text',
                    text,
                    annotations: []
                }]
            }],
            usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0
            },
            video: videoResponse
        };
    }

    async *streamTextResponse(response) {
        const outputItems = Array.isArray(response.output) ? response.output : [];
        const item = outputItems.find(output => output?.type === 'message') || outputItems[0];
        const contentItems = Array.isArray(item?.content) ? item.content : [];
        const contentPart = contentItems.find(part => part?.type === 'output_text') || contentItems[0];
        const text = contentPart?.text || '';

        yield {
            type: 'response.created',
            response: {
                ...response,
                status: 'in_progress',
                output: []
            }
        };

        if (item) {
            yield {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                    ...item,
                    status: 'in_progress',
                    content: []
                }
            };
        }

        if (contentPart) {
            yield {
                type: 'response.content_part.added',
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                part: {
                    type: 'output_text',
                    text: '',
                    annotations: []
                }
            };
        }

        if (text) {
            yield {
                type: 'response.output_text.delta',
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: text
            };
        }

        if (contentPart) {
            yield {
                type: 'response.output_text.done',
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                text
            };
            yield {
                type: 'response.content_part.done',
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                part: contentPart
            };
        }

        if (item) {
            yield {
                type: 'response.output_item.done',
                output_index: 0,
                item
            };
        }

        yield {
            type: 'response.completed',
            response
        };
    }

    async handleRequestError(error, mode) {
        const status = error.response?.status;
        const retryAfter = getRetryAfterMs(error);

        if (status) {
            await normalizeProviderErrorMessage(error, { status, context: mode });
        }

        if (status === 401 || status === 403) {
            logger.info(`[Grok CLI] Received ${status} during ${mode}. Triggering background refresh...`);
            this.triggerBackgroundRefresh();
            error.credentialMarkedUnhealthy = true;
            error.shouldSwitchCredential = true;
            error.skipErrorCount = true;
        } else if (status === 429 || (status >= 500 && status < 600)) {
            error.shouldSwitchCredential = true;
            if (retryAfter !== null) {
                error.retryAfter = retryAfter;
            }
        }

        logger.error(`[Grok CLI] Error calling ${mode} API (Status: ${status || 'N/A'}, Code: ${error.code || 'N/A'}): ${error.message}`);
        throw error;
    }

    async refreshAccessToken() {
        if (!this.refreshTokenValue) {
            this.logAccessTokenOnlyRefreshSkipped();
            throw new Error('Cannot refresh Grok CLI access-token-only credential without refresh_token.');
        }

        try {
            const newTokens = await refreshGrokCliTokensWithRetry(this.refreshTokenValue, this.config, {
                id_token: this.idToken,
                email: this.email,
                sub: this.subject,
                base_url: this.baseUrl,
                token_endpoint: this.tokenEndpoint,
                redirect_uri: XAI_REDIRECT_URI
            });

            this.idToken = newTokens.id_token || this.idToken;
            this.accessToken = newTokens.access_token;
            this.refreshTokenValue = newTokens.refresh_token || this.refreshTokenValue;
            this.tokenType = newTokens.token_type || this.tokenType || 'Bearer';
            this.email = newTokens.email || this.email;
            this.subject = newTokens.sub || this.subject;
            this.userId = newTokens.user_id || newTokens.userId || this.userId;
            this.teamId = newTokens.team_id || newTokens.teamId || this.teamId;
            this.last_refresh = new Date().toISOString();
            this.tokenEndpoint = newTokens.token_endpoint || this.tokenEndpoint;
            this.baseUrl = normalizeBaseUrl(newTokens.base_url || this.baseUrl);

            const parsedExpiry = parseExpiry(newTokens.expired || newTokens.expires_at || newTokens.expiresAt);
            this.expiresAt = parsedExpiry || new Date(Date.now() + (newTokens.expires_in || 3600) * 1000);

            await this.saveCredentials();

            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.GROK_CLI, this.uuid);
            }
            logger.info('[Grok CLI] Token refreshed successfully');
        } catch (error) {
            logger.error('[Grok CLI] Failed to refresh token:', error.message);
            throw new Error('Failed to refresh Grok CLI token. Please re-authenticate.');
        }
    }

    isExpiryDateNear() {
        if (!this.expiresAt) return true;
        const expiry = this.expiresAt.getTime();
        if (Number.isNaN(expiry)) {
            logger.warn('[Grok CLI] expiresAt is invalid (NaN). Treating as near expiry to force refresh');
            return true;
        }
        const nearMinutes = this.config.CRON_NEAR_MINUTES || 5;
        const { message, isNearExpiry } = formatExpiryLog('Grok CLI', expiry, nearMinutes);
        logger.info(message);
        return isNearExpiry;
    }

    getCredentialsPath() {
        if (this.config.GROK_CLI_OAUTH_CREDS_FILE_PATH || this.config.XAI_OAUTH_CREDS_FILE_PATH) {
            return this.config.GROK_CLI_OAUTH_CREDS_FILE_PATH || this.config.XAI_OAUTH_CREDS_FILE_PATH;
        }

        if (this.credsPath) {
            return this.credsPath;
        }

        const safeEmail = sanitizeCredentialFilenamePart(this.email || this.subject || 'default');
        return path.join(process.cwd(), 'configs', 'grok-cli', `${Date.now()}_xai-${safeEmail}_oauth_creds.json`);
    }

    async saveCredentials() {
        const credsPath = this.getCredentialsPath();
        const credsDir = path.dirname(credsPath);

        if (!this.expiresAt || Number.isNaN(this.expiresAt.getTime())) {
            throw new Error('Invalid expiresAt when saving Grok CLI credentials');
        }

        await fs.mkdir(credsDir, { recursive: true });
        await atomicWriteFile(
            credsPath,
            JSON.stringify(
                {
                    id_token: this.idToken || '',
                    access_token: this.accessToken,
                    refresh_token: this.refreshTokenValue,
                    token_type: this.tokenType || 'Bearer',
                    expires_in: Math.max(0, Math.floor((this.expiresAt.getTime() - Date.now()) / 1000)),
                    last_refresh: this.last_refresh || new Date().toISOString(),
                    email: this.email,
                    sub: this.subject,
                    user_id: this.userId,
                    team_id: this.teamId,
                    type: 'xai',
                    auth_kind: 'oauth',
                    expired: this.expiresAt.toISOString(),
                    base_url: this.baseUrl,
                    redirect_uri: XAI_REDIRECT_URI,
                    token_endpoint: this.tokenEndpoint
                },
                null,
                2
            ),
            { encoding: 'utf8', mode: 0o600 }
        );

        this.credsPath = credsPath;
    }

    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async *parseSSEStream(stream) {
        let buffer = '';

        for await (const chunk of stream) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const event = this.parseSSELine(line);
                if (!event) continue;
                yield event;
            }
        }

        const finalEvent = this.parseSSELine(buffer);
        if (finalEvent) {
            yield finalEvent;
        }
    }

    parseSSELine(line) {
        const trimmedLine = String(line || '').trim();
        if (!trimmedLine || trimmedLine.startsWith(':') || trimmedLine.startsWith('event:') || trimmedLine.startsWith('id:') || trimmedLine.startsWith('retry:')) {
            return null;
        }

        const dataStr = trimmedLine.startsWith('data:') ? trimmedLine.slice(5).trim() : trimmedLine;
        if (!dataStr || dataStr === '[DONE]') return null;

        try {
            const parsed = JSON.parse(dataStr);
            if (parsed.type === 'error' || parsed.error) {
                const errorBody = parsed.error || parsed;
                const errorMsg = errorBody.message || JSON.stringify(errorBody);
                const error = new Error(`Grok CLI API error: ${errorMsg}`);
                if (errorBody.code === 'insufficient_quota' || errorBody.type === 'insufficient_quota') {
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                }
                throw error;
            }
            return parsed;
        } catch (error) {
            if (error.message.startsWith('Grok CLI API error')) {
                throw error;
            }
            logger.error('[Grok CLI] Failed to parse SSE data:', error.message);
            return null;
        }
    }

    parseNonStreamResponse(data) {
        const responseText = typeof data === 'string' ? data : String(data);
        let completedEvent = null;
        const outputItemsByIndex = new Map();
        const outputItemsFallback = [];
        const outputItems = new Map();
        const textDeltas = new Map();

        for (const line of responseText.split('\n')) {
            const event = this.parseSSELine(line);
            if (!event) continue;

            switch (event.type) {
                case 'response.output_item.added':
                    if (event.item) outputItems.set(event.item.id, event.item);
                    break;
                case 'response.output_item.done':
                    if (event.item) {
                        if (event.output_index !== undefined) {
                            outputItemsByIndex.set(event.output_index, event.item);
                        } else {
                            outputItemsFallback.push(event.item);
                        }
                    }
                    break;
                case 'response.output_text.delta':
                    if (event.item_id && event.delta) {
                        textDeltas.set(event.item_id, `${textDeltas.get(event.item_id) || ''}${event.delta}`);
                    }
                    break;
                case 'response.output_text.done':
                    if (event.item_id && event.text) {
                        textDeltas.set(event.item_id, event.text);
                    }
                    break;
                case 'response.completed':
                    completedEvent = event;
                    break;
            }
        }

        if (!completedEvent) {
            throw new Error('stream error: stream disconnected before completion: stream closed before response.completed');
        }

        if (!completedEvent.response) {
            completedEvent.response = {};
        }

        const completedOutput = completedEvent.response.output;
        if (!Array.isArray(completedOutput) || completedOutput.length === 0) {
            const sortedIndexes = Array.from(outputItemsByIndex.keys()).sort((a, b) => a - b);
            completedEvent.response.output = [
                ...sortedIndexes.map(index => outputItemsByIndex.get(index)),
                ...outputItemsFallback
            ];
        }

        if ((!completedEvent.response.output || completedEvent.response.output.length === 0) && outputItems.size > 0) {
            completedEvent.response.output = Array.from(outputItems.values());
        }

        for (const item of completedEvent.response.output || []) {
            if (item.type === 'message' && item.role === 'assistant') {
                const accumulatedText = textDeltas.get(item.id);
                if (accumulatedText !== undefined) {
                    item.content = item.content?.length
                        ? item.content.map(part => part.type === 'output_text' && !part.text ? { ...part, text: accumulatedText } : part)
                        : [{ type: 'output_text', text: accumulatedText }];
                }
            }
        }

        return completedEvent.response || completedEvent;
    }

    async listModels() {
        return {
            object: 'list',
            data: GROK_CLI_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'xai',
                display_name: id
            }))
        };
    }

    async refreshToken() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        if (this.isExpiryDateNear()) {
            await this.refreshAccessToken();
            return true;
        }
        return false;
    }

    async forceRefreshToken() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        await this.refreshAccessToken();
        return true;
    }

    async getUsageLimits() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        await this.initializeAuth(false);

        try {
            const url = this.config.GROK_CLI_BILLING_URL || GROK_CLI_DEFAULT_BILLING_URL;
            const axiosRequestConfig = {
                method: 'get',
                url,
                headers: {
                    ...this.buildJsonHeaders(),
                    'x-grok-cli-version': this.config.GROK_CLI_CLIENT_VERSION || GROK_CLI_CLIENT_VERSION
                },
                timeout: 30000
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(axiosRequestConfig);
            const subscriptions = await this.getSubscriptionsForUsage(response.data);
            const summary = summarizeBillingUsage(response.data, subscriptions);
            this.logGrokAccountTier(summary);

            return {
                ...response.data,
                summary,
                provider: 'grok-cli-oauth',
                account: this.email || this.subject || 'unknown',
                expiresAt: this.expiresAt?.toISOString?.() || null,
                baseUrl: this.baseUrl
            };
        } catch (error) {
            await this.handleRequestError(error, 'usage query');
        }
    }

    logGrokAccountTier(summary = {}) {
        const tier = summary.grokAccountTier || summary.subscriptionTier || 'unknown';
        const rawTier = summary.rawSubscriptionTier || 'unknown';
        const status = summary.subscriptionStatus || 'unknown';
        const logKey = `${tier}|${rawTier}|${status}`;

        if (this.loggedGrokAccountTier === logKey) return;
        this.loggedGrokAccountTier = logKey;
        logger.info(`[Grok CLI] Account tier resolved: ${tier} (raw: ${rawTier}, status: ${status})`);
    }

    async getSubscriptionsForUsage(billingData = undefined, forceRefresh = false) {
        const embeddedSubscriptions = billingData?.subscriptions || billingData?.config?.subscriptions;
        if (Array.isArray(embeddedSubscriptions)) {
            this.subscriptionsCache = { subscriptions: embeddedSubscriptions };
            this.subscriptionsSyncedAt = Date.now();
            return this.subscriptionsCache;
        }

        if (!forceRefresh && this.subscriptionsCache) {
            return this.subscriptionsCache;
        }

        const url = this.config.GROK_CLI_SUBSCRIPTIONS_URL || GROK_CLI_DEFAULT_SUBSCRIPTIONS_URL;
        if (!url) {
            return this.subscriptionsCache;
        }

        try {
            const axiosRequestConfig = {
                method: 'get',
                url,
                headers: this.buildSubscriptionHeaders(),
                timeout: 30000
            };
            this._applySidecar(axiosRequestConfig);

            const response = await axios.request(axiosRequestConfig);
            if (Array.isArray(response.data?.subscriptions)) {
                this.subscriptionsCache = response.data;
                this.subscriptionsSyncedAt = Date.now();
            }
        } catch (error) {
            logger.debug?.(`[Grok CLI] Subscription tier lookup skipped: ${error.message}`);
        }

        return this.subscriptionsCache;
    }

    startCacheCleanup() {
        // 保持与其他 core 的方法形态兼容；Grok CLI 目前不需要会话缓存清理。
    }

    newConversationId() {
        return crypto.randomUUID();
    }
}
