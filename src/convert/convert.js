/**
 * 协议转换模块 - 新架构版本
 * 使用重构后的转换器架构
 *
 * 这个文件展示了如何使用新的转换器架构
 * 可以逐步替换原有的 convert.js
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { MODEL_PROTOCOL_PREFIX, getProtocolPrefix } from '../utils/common.js';
import { ConverterFactory } from '../converters/ConverterFactory.js';
import { CONFIG } from '../core/config-manager.js';
import {
    generateResponseCreated,
    generateResponseInProgress,
    generateOutputItemAdded,
    generateContentPartAdded,
    generateOutputTextDone,
    generateContentPartDone,
    generateOutputItemDone,
    generateResponseCompleted
} from '../providers/openai/openai-responses-core.mjs';

// =============================================================================
// 初始化：注册所有转换器
// =============================================================================

// =============================================================================
// 主转换函数
// =============================================================================

/**
 * 通用数据转换函数（新架构版本）
 * @param {object} data - 要转换的数据（请求体或响应）
 * @param {string} type - 转换类型：'request', 'response', 'streamChunk', 'modelList'
 * @param {string} fromProvider - 源模型提供商
 * @param {string} toProvider - 目标模型提供商
 * @param {string} [model] - 可选的模型名称（用于响应转换）
 * @returns {object} 转换后的数据
 * @throws {Error} 如果找不到合适的转换函数
 */
export function convertData(data, type, fromProvider, toProvider, model, requestId) {
    try {
        // 获取协议前缀
        const fromProtocol = getProtocolPrefix(fromProvider);
        const toProtocol = getProtocolPrefix(toProvider);

        // 如果目标协议为 forward，直接返回原始数据，无需转换
        if (toProtocol === MODEL_PROTOCOL_PREFIX.FORWARD || fromProtocol === MODEL_PROTOCOL_PREFIX.FORWARD) {
            logger.info(`[Convert] Target protocol is forward, skipping conversion`);
            return data;
        }

        // 从工厂获取转换器
        const converter = ConverterFactory.getConverter(fromProtocol);

        if (!converter) {
            throw new Error(`No converter found for protocol: ${fromProtocol}`);
        }

        // 根据类型调用相应的转换方法
        switch (type) {
            case 'request':
                return converter.convertRequest(data, toProtocol, requestId);
                
            case 'response':
                return converter.convertResponse(data, toProtocol, model, requestId);
                
            case 'streamChunk':
                return converter.convertStreamChunk(data, toProtocol, model, requestId);
                
            case 'modelList':
                return converter.convertModelList(data, toProtocol);
                
            default:
                throw new Error(`Unsupported conversion type: ${type}`);
        }
    } catch (error) {
        logger.error(`Conversion error: ${error.message}`);
        throw error;
    }
}

// =============================================================================
// 向后兼容的导出函数
// =============================================================================

/**
 * 以下函数保持与原有API的兼容性
 * 内部使用新的转换器架构
 */

// OpenAI 相关转换
export function toOpenAIRequestFromGemini(geminiRequest) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toOpenAIRequest(geminiRequest);
}

export function toOpenAIRequestFromClaude(claudeRequest) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
    return converter.toOpenAIRequest(claudeRequest);
}

export function toOpenAIChatCompletionFromGemini(geminiResponse, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toOpenAIResponse(geminiResponse, model);
}

export function toOpenAIChatCompletionFromClaude(claudeResponse, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
    return converter.toOpenAIResponse(claudeResponse, model);
}

/**
 * Release per-request stream state held by a singleton source converter.
 * A missing converter/state is intentionally non-fatal during stream cleanup.
 */
export function releaseStreamState(sourceProtocol, requestId = null) {
    try {
        const converter = ConverterFactory.getConverter(sourceProtocol);
        converter?.releaseOpenAIStreamState?.(requestId);
    } catch {
        // Conversion state cleanup must never replace the original stream error.
    }
}

export function toOpenAIStreamChunkFromGemini(geminiChunk, model, requestId = null) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toOpenAIStreamChunk(geminiChunk, model, requestId);
}

export function toOpenAIStreamChunkFromClaude(claudeChunk, model, requestId = null) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
    return converter.toOpenAIStreamChunk(claudeChunk, model, requestId);
}

export function toOpenAIModelListFromGemini(geminiModels) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toOpenAIModelList(geminiModels);
}

export function toOpenAIModelListFromClaude(claudeModels) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
    return converter.toOpenAIModelList(claudeModels);
}

// Claude 相关转换
export function toClaudeRequestFromOpenAI(openaiRequest) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
    return converter.toClaudeRequest(openaiRequest);
}

export function toClaudeRequestFromOpenAIResponses(responsesRequest) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
    return converter.toClaudeRequest(responsesRequest);
}

export function toClaudeChatCompletionFromOpenAI(openaiResponse, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
    return converter.toClaudeResponse(openaiResponse, model);
}

export function toClaudeChatCompletionFromGemini(geminiResponse, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toClaudeResponse(geminiResponse, model);
}

export function toClaudeStreamChunkFromOpenAI(openaiChunk, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
    return converter.toClaudeStreamChunk(openaiChunk, model);
}

export function toClaudeStreamChunkFromGemini(geminiChunk, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toClaudeStreamChunk(geminiChunk, model);
}

export function toClaudeModelListFromOpenAI(openaiModels) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
    return converter.toClaudeModelList(openaiModels);
}

export function toClaudeModelListFromGemini(geminiModels) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toClaudeModelList(geminiModels);
}

// Gemini 相关转换
export function toGeminiRequestFromOpenAI(openaiRequest) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
    return converter.toGeminiRequest(openaiRequest);
}

export function toGeminiRequestFromClaude(claudeRequest) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
    return converter.toGeminiRequest(claudeRequest);
}

export function toGeminiRequestFromOpenAIResponses(responsesRequest) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
    return converter.toGeminiRequest(responsesRequest);
}

// OpenAI Responses 相关转换
export function toOpenAIResponsesFromOpenAI(openaiResponse, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
    return converter.toOpenAIResponsesResponse(openaiResponse, model);
}

export function toOpenAIResponsesFromClaude(claudeResponse, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
    return converter.toOpenAIResponsesResponse(claudeResponse, model);
}

export function toOpenAIResponsesFromGemini(geminiResponse, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toOpenAIResponsesResponse(geminiResponse, model);
}

export function toOpenAIResponsesStreamChunkFromOpenAI(openaiChunk, model, requestId) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
    return converter.toOpenAIResponsesStreamChunk(openaiChunk, model, requestId);
}

export function toOpenAIResponsesStreamChunkFromClaude(claudeChunk, model, requestId) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
    return converter.toOpenAIResponsesStreamChunk(claudeChunk, model, requestId);
}

export function toOpenAIResponsesStreamChunkFromGemini(geminiChunk, model, requestId) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
    return converter.toOpenAIResponsesStreamChunk(geminiChunk, model, requestId);
}

// 从 OpenAI Responses 转换到其他格式
export function toOpenAIRequestFromOpenAIResponses(responsesRequest) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
    return converter.toOpenAIRequest(responsesRequest);
}

export function toOpenAIChatCompletionFromOpenAIResponses(responsesResponse, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
    return converter.toOpenAIResponse(responsesResponse, model);
}

export function toOpenAIStreamChunkFromOpenAIResponses(responsesChunk, model) {
    const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
    return converter.toOpenAIStreamChunk(responsesChunk, model);
}

// 辅助函数导出
export async function extractAndProcessSystemMessages(messages) {
    const { extractAndProcessSystemMessages: extract } = await import('../converters/utils.js');
    return extract(messages, CONFIG?.SYSTEM_PROMPT_REPLACEMENTS);
}

export async function extractTextFromMessageContent(content) {
    const { Utils } = await import('../converters/utils.js');
    return Utils.extractText(content);
}

// =============================================================================
// 工具函数
// =============================================================================

/**
 * 获取所有已注册的协议
 * @returns {Array<string>} 协议前缀数组
 */
export function getRegisteredProtocols() {
    return ConverterFactory.getRegisteredProtocols();
}

/**
 * 检查协议是否已注册
 * @param {string} protocol - 协议前缀
 * @returns {boolean} 是否已注册
 */
export function isProtocolRegistered(protocol) {
    return ConverterFactory.isProtocolRegistered(protocol);
}

/**
 * 清除所有转换器缓存
 */
export function clearConverterCache() {
    ConverterFactory.clearCache();
}

/**
 * 获取转换器实例（用于高级用法）
 * @param {string} protocol - 协议前缀
 * @returns {BaseConverter} 转换器实例
 */
export function getConverter(protocol) {
    return ConverterFactory.getConverter(protocol);
}

// =============================================================================
// 辅助函数 - 从原 convert.js 迁移
// =============================================================================

/**
 * 生成 OpenAI 流式响应的停止块
 * @param {string} model - 模型名称
 * @returns {Object} OpenAI 流式停止块
 */
export function getOpenAIStreamChunkStop(model) {
    return {
        id: `chatcmpl-${uuidv4()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        system_fingerprint: "",
        choices: [{
            index: 0,
            delta: {
                content: "",
                reasoning_content: ""
            },
            finish_reason: 'stop',
            message: {
                content: "",
                reasoning_content: ""
            }
        }],
        usage:{
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}

/**
 * 生成 OpenAI Responses 流式响应的开始事件
 * @param {string} id - 响应 ID
 * @param {string} model - 模型名称
 * @returns {Array} 开始事件数组
 */
export function getOpenAIResponsesStreamChunkBegin(id, model) {
    return [
        generateResponseCreated(id, model),
        generateResponseInProgress(id),
        generateOutputItemAdded(id),
        generateContentPartAdded(id)
    ];
}

/**
 * 生成 OpenAI Responses 流式响应的结束事件
 * @param {string} id - 响应 ID
 * @returns {Array} 结束事件数组
 */
export function getOpenAIResponsesStreamChunkEnd(id) {
    return [
        generateOutputTextDone(id),
        generateContentPartDone(id),
        generateOutputItemDone(id),
        generateResponseCompleted(id)
    ];
}

// =============================================================================
// 默认导出
// =============================================================================

export default {
    convertData,
    getRegisteredProtocols,
    isProtocolRegistered,
    clearConverterCache,
    getConverter,
    // 向后兼容的函数
    toOpenAIRequestFromGemini,
    toOpenAIRequestFromClaude,
    toOpenAIChatCompletionFromGemini,
    toOpenAIChatCompletionFromClaude,
    toOpenAIStreamChunkFromGemini,
    toOpenAIStreamChunkFromClaude,
    toOpenAIModelListFromGemini,
    toOpenAIModelListFromClaude,
    toClaudeRequestFromOpenAI,
    toClaudeChatCompletionFromOpenAI,
    toClaudeChatCompletionFromGemini,
    toClaudeStreamChunkFromOpenAI,
    toClaudeStreamChunkFromGemini,
    toClaudeModelListFromOpenAI,
    toClaudeModelListFromGemini,
    toGeminiRequestFromOpenAI,
    toGeminiRequestFromClaude,
    toOpenAIResponsesFromOpenAI,
    toOpenAIResponsesFromClaude,
    toOpenAIResponsesFromGemini,
    toOpenAIResponsesStreamChunkFromOpenAI,
    toOpenAIResponsesStreamChunkFromClaude,
    toOpenAIResponsesStreamChunkFromGemini,
    toOpenAIRequestFromOpenAIResponses,
    toOpenAIChatCompletionFromOpenAIResponses,
    toOpenAIStreamChunkFromOpenAIResponses,
    toClaudeRequestFromOpenAIResponses,
    toGeminiRequestFromOpenAIResponses,
};


