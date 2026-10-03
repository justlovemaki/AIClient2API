/**
 * Claude转换器
 * 处理Claude（Anthropic）协议与其他协议之间的转换
 */

import {v4 as uuidv4} from 'uuid';
import logger from '../../utils/logger.js';
import {BaseConverter} from '../BaseConverter.js';
import {
    checkAndAssignOrDefault,
    cleanJsonSchemaForOpenAI,
    determineReasoningEffortFromBudget,
    GEMINI_DEFAULT_INPUT_TOKEN_LIMIT,
    GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT,
    OPENAI_DEFAULT_MAX_TOKENS,
    OPENAI_DEFAULT_TEMPERATURE,
    OPENAI_DEFAULT_TOP_P
} from '../utils.js';
import {MODEL_PROTOCOL_PREFIX} from '../../utils/common.js';
import {
    finishToolCall,
    generateContentPartAdded,
    generateContentPartDone,
    generateFunctionCallArgsDelta,
    generateFunctionCallArgsDone,
    generateFunctionCallOutputItemDone,
    generateOutputItemAdded,
    generateOutputItemDone,
    generateOutputTextDelta,
    generateOutputTextDone,
    generateResponseCompleted,
    generateResponseCreated,
    generateResponseInProgress,
    startToolCall,
    streamStateManager
} from '../../providers/openai/openai-responses-core.mjs';

/**
 * Claude转换器类
 * 实现Claude协议到其他协议的转换
 */
/**
 * 清洗 tool_use/tool_result ID，只保留 [a-zA-Z0-9_-] 字符
 * Claude API 要求 tool_use.id 匹配 ^[a-zA-Z0-9_-]+$
 */
function sanitizeToolId(id) {
    if (!id) return id;
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class ClaudeConverter extends BaseConverter {
    constructor() {
        super('claude');
    }

    /**
     * 转换请求
     */
    convertRequest(data, targetProtocol) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIRequest(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesRequest(data);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexRequest(data);
            case MODEL_PROTOCOL_PREFIX.GROK:
                return this.toGrokRequest(data);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换响应
     */
    convertResponse(data, targetProtocol, model) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexResponse(data, model);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换流式响应块
     */
    convertStreamChunk(chunk, targetProtocol, model, requestId) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesStreamChunk(chunk, model, requestId);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexStreamChunk(chunk, model);
            default:
                throw new Error(`Unsupported target protocol: ${targetProtocol}`);
        }
    }

    /**
     * 转换模型列表
     */
    convertModelList(data, targetProtocol) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIModelList(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiModelList(data);
            default:
                return data;
        }
    }

    // =========================================================================
    // Claude -> OpenAI 转换
    // =========================================================================

    /**
     * Claude请求 -> OpenAI请求
     */
    toOpenAIRequest(claudeRequest) {
        const openaiMessages = [];
        let systemMessageContent = '';

        // 添加系统消息
        if (claudeRequest.system) {
            systemMessageContent = claudeRequest.system;
        }

        // 处理消息
        if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
            // thinking 模式启用（enabled / adaptive）时，上游
            // （DeepSeek / Kimi / SiliconFlow / iFlow / GLM-4.6 / MiniMax M2 等）
            // 强制要求带 tool_calls 的 assistant 消息携带 reasoning_content 字段，缺失即 400。
            // 字段存在即可，值可为空字符串（客户端历史未保留 thinking 块时的兜底）。
            const thinkingType = claudeRequest.thinking && claudeRequest.thinking.type;
            const thinkingEnabled = thinkingType === "enabled" || thinkingType === "adaptive";

            const tempOpenAIMessages = [];
            for (const msg of claudeRequest.messages) {
                const role = msg.role;

                // 处理用户的工具结果消息
                if (role === "user" && Array.isArray(msg.content)) {
                    const hasToolResult = msg.content.some(
                        item => item && typeof item === 'object' && item.type === "tool_result"
                    );

                    if (hasToolResult) {
                        for (const item of msg.content) {
                            if (item && typeof item === 'object' && item.type === "tool_result") {
                                const toolUseId = item.tool_use_id || item.id || "";
                                let contentStr = item.content || "";
                                if (typeof contentStr === 'object') {
                                    contentStr = JSON.stringify(contentStr);
                                } else {
                                    contentStr = String(contentStr);
                                }
                                tempOpenAIMessages.push({
                                    role: "tool",
                                    tool_call_id: toolUseId,
                                    content: contentStr,
                                });
                            }
                        }
                        continue;
                    }
                }

                // 抽取 assistant 消息中的 thinking 块作为 reasoning_content
                let reasoningContent = '';
                if (role === "assistant" && Array.isArray(msg.content)) {
                    const reasoningParts = [];
                    for (const block of msg.content) {
                        if (block && typeof block === 'object' && block.type === 'thinking' && block.thinking) {
                            reasoningParts.push(typeof block.thinking === 'string' ? block.thinking : String(block.thinking));
                        }
                    }
                    if (reasoningParts.length > 0) {
                        reasoningContent = reasoningParts.join('\n');
                    }
                }

                // 处理assistant消息中的工具调用
                if (role === "assistant" && Array.isArray(msg.content) && msg.content.length > 0) {
                    const toolUsePart = msg.content.find(b => b && b.type === "tool_use");
                    if (toolUsePart) {
                        const funcName = toolUsePart.name || "";
                        const funcArgs = toolUsePart.input || {};
                        const toolCallMsg = {
                            role: "assistant",
                            content: '',
                            tool_calls: [
                                {
                                    id: toolUsePart.id || `call_${funcName}_1`,
                                    type: "function",
                                    function: {
                                        name: funcName,
                                        arguments: JSON.stringify(funcArgs)
                                    },
                                    index: toolUsePart.index || 0
                                }
                            ]
                        };
                        // 带 tool_calls 的 assistant 消息：thinking 启用则强制携带 reasoning_content（空串兜底）
                        if (thinkingEnabled || reasoningContent) {
                            toolCallMsg.reasoning_content = reasoningContent;
                        }
                        tempOpenAIMessages.push(toolCallMsg);
                        continue;
                    }
                }

                // 普通文本消息
                const contentConverted = this.processClaudeContentToOpenAIContent(msg.content || "");
                const hasContent = contentConverted && (Array.isArray(contentConverted) ? contentConverted.length > 0 : contentConverted.trim().length > 0);
                if (hasContent) {
                    const openaiMsg = { role: role, content: contentConverted };
                    if (reasoningContent) {
                        openaiMsg.reasoning_content = reasoningContent;
                    }
                    tempOpenAIMessages.push(openaiMsg);
                } else if (reasoningContent) {
                    tempOpenAIMessages.push({
                        role: role,
                        content: '',
                        reasoning_content: reasoningContent
                    });
                }
            }

            // OpenAI兼容性校验
            const validatedMessages = [];
            for (let idx = 0; idx < tempOpenAIMessages.length; idx++) {
                const m = tempOpenAIMessages[idx];
                if (m.role === "assistant" && m.tool_calls) {
                    const callIds = m.tool_calls.map(tc => tc.id).filter(id => id);
                    let unmatched = new Set(callIds);
                    for (let laterIdx = idx + 1; laterIdx < tempOpenAIMessages.length; laterIdx++) {
                        const later = tempOpenAIMessages[laterIdx];
                        if (later.role === "tool" && unmatched.has(later.tool_call_id)) {
                            unmatched.delete(later.tool_call_id);
                        }
                        if (unmatched.size === 0) break;
                    }
                    if (unmatched.size > 0) {
                        m.tool_calls = m.tool_calls.filter(tc => !unmatched.has(tc.id));
                        if (m.tool_calls.length === 0) {
                            delete m.tool_calls;
                            if (m.content === null) m.content = "";
                        }
                    }
                }
                validatedMessages.push(m);
            }
            openaiMessages.push(...validatedMessages);
        }

        const openaiRequest = {
            model: claudeRequest.model,
            messages: openaiMessages,
            max_tokens: checkAndAssignOrDefault(claudeRequest.max_tokens, OPENAI_DEFAULT_MAX_TOKENS),
            temperature: checkAndAssignOrDefault(claudeRequest.temperature, OPENAI_DEFAULT_TEMPERATURE),
            top_p: checkAndAssignOrDefault(claudeRequest.top_p, OPENAI_DEFAULT_TOP_P),
            stream: claudeRequest.stream,
        };

        // 处理工具
        if (claudeRequest.tools) {
            const openaiTools = [];
            for (const tool of claudeRequest.tools) {
                openaiTools.push({
                    type: "function",
                    function: {
                        name: tool.name || "",
                        description: tool.description || "",
                        parameters: cleanJsonSchemaForOpenAI(tool.input_schema || {})
                    }
                });
            }
            openaiRequest.tools = openaiTools;
            openaiRequest.tool_choice = "auto";
        }

        // 处理thinking转换（enabled / adaptive 都映射为 OpenAI reasoning_effort）
        const _thinkingType = claudeRequest.thinking && claudeRequest.thinking.type;
        if (_thinkingType === "enabled" || _thinkingType === "adaptive") {
            // adaptive 没有 budget_tokens，effort 来自 output_config.effort（high/medium/low/xhigh/max）
            // enabled 则按 budget_tokens 推算
            // OpenAI 兼容上游只接受 low/medium/high，需收敛 max/xhigh -> high
            const effortFromConfig = claudeRequest.output_config && claudeRequest.output_config.effort;
            const budgetTokens = claudeRequest.thinking.budget_tokens;
            let reasoningEffort = effortFromConfig
                ? String(effortFromConfig).toLowerCase()
                : determineReasoningEffortFromBudget(budgetTokens);
            if (reasoningEffort === "max" || reasoningEffort === "xhigh") {
                reasoningEffort = "high";
            }
            if (!["low", "medium", "high"].includes(reasoningEffort)) {
                reasoningEffort = "high";
            }
            openaiRequest.reasoning_effort = reasoningEffort;

            let maxCompletionTokens = null;
            if (claudeRequest.max_tokens !== undefined) {
                maxCompletionTokens = claudeRequest.max_tokens;
                delete openaiRequest.max_tokens;
            } else {
                const envMaxTokens = process.env.OPENAI_REASONING_MAX_TOKENS;
                if (envMaxTokens) {
                    try {
                        maxCompletionTokens = parseInt(envMaxTokens, 10);
                    } catch (e) {
                        logger.warn(`Invalid OPENAI_REASONING_MAX_TOKENS value '${envMaxTokens}'`);
                    }
                }
                if (!envMaxTokens) {
                    throw new Error("For OpenAI reasoning models, max_completion_tokens is required.");
                }
            }
            openaiRequest.max_completion_tokens = maxCompletionTokens;
        }

        // 添加系统消息
        if (systemMessageContent) {
            let stringifiedSystemMessageContent = systemMessageContent;
            if (Array.isArray(systemMessageContent)) {
                stringifiedSystemMessageContent = systemMessageContent.map(item =>
                    typeof item === 'string' ? item : item.text).join('\n');
            }
            openaiRequest.messages.unshift({ role: 'system', content: stringifiedSystemMessageContent });
        }

        return openaiRequest;
    }

    /**
     * Claude响应 -> OpenAI响应
     */
    toOpenAIResponse(claudeResponse, model) {
        if (!claudeResponse || !claudeResponse.content || claudeResponse.content.length === 0) {
            return {
                id: `chatcmpl-${uuidv4()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "",
                    },
                    finish_reason: "stop",
                }],
                usage: {
                    prompt_tokens: claudeResponse.usage?.input_tokens || 0,
                    completion_tokens: claudeResponse.usage?.output_tokens || 0,
                    total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
                    cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0,
                    prompt_tokens_details: {
                        cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
                    }
                },
            };
        }

        // Extract thinking blocks into OpenAI-style `reasoning_content`.
        let reasoningContent = '';
        if (Array.isArray(claudeResponse.content)) {
            for (const block of claudeResponse.content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type === 'thinking') {
                    reasoningContent += (block.thinking ?? block.text ?? '');
                }
            }
        }

        // 检查是否包含 tool_use
        const hasToolUse = claudeResponse.content.some(block => block && block.type === 'tool_use');
        
        let message = {
            role: "assistant",
            content: null
        };

        if (hasToolUse) {
            // 处理包含工具调用的响应
            const toolCalls = [];
            let textContent = '';

            for (const block of claudeResponse.content) {
                if (!block) continue;

                if (block.type === 'text') {
                    textContent += block.text || '';
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id || `call_${block.name}_${Date.now()}`,
                        type: "function",
                        function: {
                            name: block.name || '',
                            arguments: JSON.stringify(block.input || {})
                        }
                    });
                }
            }

            message.content = textContent || null;
            if (toolCalls.length > 0) {
                message.tool_calls = toolCalls;
            }
        } else {
            // 处理普通文本响应
            message.content = this.processClaudeResponseContent(claudeResponse.content);
        }

        if (reasoningContent) {
            message.reasoning_content = reasoningContent;
        }

        // 处理 finish_reason
        let finishReason = 'stop';
        if (claudeResponse.stop_reason === 'end_turn') {
            finishReason = 'stop';
        } else if (claudeResponse.stop_reason === 'max_tokens') {
            finishReason = 'length';
        } else if (claudeResponse.stop_reason === 'tool_use') {
            finishReason = 'tool_calls';
        } else if (claudeResponse.stop_reason) {
            finishReason = claudeResponse.stop_reason;
        }

        return {
            id: `chatcmpl-${uuidv4()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                message: message,
                finish_reason: finishReason,
            }],
            usage: {
                prompt_tokens: claudeResponse.usage?.input_tokens || 0,
                completion_tokens: claudeResponse.usage?.output_tokens || 0,
                total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
                cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0,
                prompt_tokens_details: {
                    cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
                }
            },
        };
    }

    /**
     * Claude流式响应 -> OpenAI流式响应
     */
    toOpenAIStreamChunk(claudeChunk, model) {
        if (!claudeChunk) return null;

        // 处理 Claude 流式事件
        const chunkId = `chatcmpl-${uuidv4()}`;
        const timestamp = Math.floor(Date.now() / 1000);

        // message_start 事件
        if (claudeChunk.type === 'message_start') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        role: "assistant",
                        content: ""
                    },
                    finish_reason: null
                }],
                usage: {
                    prompt_tokens: claudeChunk.message?.usage?.input_tokens || 0,
                    completion_tokens: 0,
                    total_tokens: claudeChunk.message?.usage?.input_tokens || 0,
                    cached_tokens: claudeChunk.message?.usage?.cache_read_input_tokens || 0
                }
            };
        }

        // content_block_start 事件
        if (claudeChunk.type === 'content_block_start') {
            const contentBlock = claudeChunk.content_block;
            
            // 处理 tool_use 类型
            if (contentBlock && contentBlock.type === 'tool_use') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: claudeChunk.index || 0,
                                id: contentBlock.id,
                                type: "function",
                                function: {
                                    name: contentBlock.name,
                                    arguments: ""
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 text 类型
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        content: ""
                    },
                    finish_reason: null
                }]
            };
        }

        // content_block_delta 事件
        if (claudeChunk.type === 'content_block_delta') {
            const delta = claudeChunk.delta;
            
            // 处理 text_delta
            if (delta && delta.type === 'text_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            content: delta.text || ""
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 thinking_delta (推理内容)
            if (delta && delta.type === 'thinking_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            reasoning_content: delta.thinking || ""
                        },
                        finish_reason: null
                    }]
                };
            }

            // 处理 input_json_delta (tool arguments)
            if (delta && delta.type === 'input_json_delta') {
                return {
                    id: chunkId,
                    object: "chat.completion.chunk",
                    created: timestamp,
                    model: model,
                    system_fingerprint: "",
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: claudeChunk.index || 0,
                                function: {
                                    arguments: delta.partial_json || ""
                                }
                            }]
                        },
                        finish_reason: null
                    }]
                };
            }
        }

        // content_block_stop 事件
        if (claudeChunk.type === 'content_block_stop') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: null
                }]
            };
        }

        // message_delta 事件
        if (claudeChunk.type === 'message_delta') {
            const stopReason = claudeChunk.delta?.stop_reason;
            const finishReason = stopReason === 'end_turn' ? 'stop' :
                                stopReason === 'max_tokens' ? 'length' :
                                stopReason === 'tool_use' ? 'tool_calls' :
                                stopReason || 'stop';

            const chunk = {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: finishReason
                }]
            };

            if(claudeChunk.usage){
                chunk.usage = {
                    prompt_tokens: claudeChunk.usage.input_tokens || 0,
                    completion_tokens: claudeChunk.usage.output_tokens || 0,
                    total_tokens: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0),
                    cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0,
                    prompt_tokens_details: {
                        cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0
                    }
                };
            }

            return chunk;
        }

        // message_stop 事件
        if (claudeChunk.type === 'message_stop') {
            return null;
            // const chunk = {
            //     id: chunkId,
            //     object: "chat.completion.chunk",
            //     created: timestamp,
            //     model: model,
            //     system_fingerprint: "",
            //     choices: [{
            //         index: 0,
            //         delta: {},
            //         finish_reason: 'stop'
            //     }]
            // };
            // return chunk;
        }

        // 兼容旧格式：如果是字符串，直接作为文本内容
        if (typeof claudeChunk === 'string') {
            return {
                id: chunkId,
                object: "chat.completion.chunk",
                created: timestamp,
                model: model,
                system_fingerprint: "",
                choices: [{
                    index: 0,
                    delta: {
                        content: claudeChunk
                    },
                    finish_reason: null
                }]
            };
        }

        return null;
    }

    /**
     * Claude模型列表 -> OpenAI模型列表
     */
    toOpenAIModelList(claudeModels) {
        return {
            object: "list",
            data: claudeModels.models.map(m => {
                const modelId = m.id || m.name;
                return {
                    id: modelId,
                    object: "model",
                    created: Math.floor(Date.now() / 1000),
                    owned_by: "anthropic",
                    display_name: modelId,
                };
            }),
        };
    }

    /**
     * 将 Claude 模型列表转换为 Gemini 模型列表
     */
    toGeminiModelList(claudeModels) {
        const models = claudeModels.models || [];
        return {
            models: models.map(m => ({
                name: `models/${m.id || m.name}`,
                version: m.version || "1.0.0",
                displayName: m.displayName || m.id || m.name,
                description: m.description || `A generative model for text and chat generation. ID: ${m.id || m.name}`,
                inputTokenLimit: m.inputTokenLimit || GEMINI_DEFAULT_INPUT_TOKEN_LIMIT,
                outputTokenLimit: m.outputTokenLimit || GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT,
                supportedGenerationMethods: m.supportedGenerationMethods || ["generateContent", "streamGenerateContent"]
            }))
        };
    }

    /**
     * 处理Claude内容到OpenAI格式
     */
    processClaudeContentToOpenAIContent(content) {
        if (!content) return [];
        
        // 如果是字符串，直接转换为 OpenAI 的文本块格式
        if (typeof content === 'string') {
            return [{
                type: 'text',
                text: content
            }];
        }

        if (!Array.isArray(content)) return [];
        
        const contentArray = [];
        
        content.forEach(block => {
            if (!block) return;
            
            switch (block.type) {
                case 'text':
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
                    break;
                    
                case 'image':
                    if (block.source && block.source.type === 'base64') {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${block.source.media_type};base64,${block.source.data}`
                            }
                        });
                    }
                    break;
                    
                case 'tool_use':
                    contentArray.push({
                        type: 'text',
                        text: `[Tool use: ${block.name}]`
                    });
                    break;
                    
                case 'tool_result':
                    contentArray.push({
                        type: 'text',
                        text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
                    });
                    break;
                    
                default:
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
            }
        });
        
        return contentArray;
    }

    /**
     * 处理Claude响应内容
     */
    processClaudeResponseContent(content) {
        if (!content) return '';
        
        if (typeof content === 'string') return content;

        if (!Array.isArray(content)) return '';
        
        const contentArray = [];
        
        content.forEach(block => {
            if (!block) return;
            
            switch (block.type) {
                case 'text':
                    contentArray.push({
                        type: 'text',
                        text: block.text || ''
                    });
                    break;
                    
                case 'image':
                    if (block.source && block.source.type === 'base64') {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${block.source.media_type};base64,${block.source.data}`
                            }
                        });
                    }
                    break;
                    
                default:
                    if (block.text) {
                        contentArray.push({
                            type: 'text',
                            text: block.text
                        });
                    }
            }
        });
        
        return contentArray.length === 1 && contentArray[0].type === 'text'
            ? contentArray[0].text
            : contentArray;
    }

    // =========================================================================
    // Claude -> Gemini 转换
    // =========================================================================

    // Gemini Claude thought signature constant
    static GEMINI_CLAUDE_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

    /**
     * Claude请求 -> Gemini请求
     */
    toGeminiRequest(claudeRequest) {
        if (!claudeRequest || typeof claudeRequest !== 'object') {
            logger.warn("Invalid claudeRequest provided to toGeminiRequest.");
            return { contents: [] };
        }

        const geminiRequest = {
            contents: []
        };

        // 处理系统指令 - 支持数组和字符串格式
        if (claudeRequest.system) {
            if (Array.isArray(claudeRequest.system)) {
                // 数组格式的系统指令
                const systemParts = [];
                claudeRequest.system.forEach(systemPrompt => {
                    if (systemPrompt && systemPrompt.type === 'text' && typeof systemPrompt.text === 'string') {
                        systemParts.push({ text: systemPrompt.text });
                    }
                });
                if (systemParts.length > 0) {
                    geminiRequest.systemInstruction = {
                        role: 'user',
                        parts: systemParts
                    };
                }
            } else if (typeof claudeRequest.system === 'string') {
                // 字符串格式的系统指令
                geminiRequest.systemInstruction = {
                    parts: [{ text: claudeRequest.system }]
                };
            } else if (typeof claudeRequest.system === 'object') {
                // 对象格式的系统指令
                geminiRequest.systemInstruction = {
                    parts: [{ text: JSON.stringify(claudeRequest.system) }]
                };
            }
        }

        // 处理消息
        if (Array.isArray(claudeRequest.messages)) {
            // [FIX tool_use_id→name] 预扫描全部消息，构建 tool_use id -> name 精确映射，
            // 避免 tool_result 转换时从 id 猜测函数名（ZCode 的 "tool_<uuid>" 格式会猜错导致上游 400）
            const toolUseNameMap = new Map();
            for (const message of claudeRequest.messages) {
                if (Array.isArray(message?.content)) {
                    for (const block of message.content) {
                        if (block?.type === 'tool_use' && block.id && block.name) {
                            toolUseNameMap.set(block.id, block.name);
                        }
                    }
                }
            }

            claudeRequest.messages.forEach(message => {
                if (!message || typeof message !== 'object' || !message.role) {
                    logger.warn("Skipping invalid message in claudeRequest.messages.");
                    return;
                }

                const geminiRole = message.role === 'assistant' ? 'model' : 'user';
                const content = message.content;

                // 处理内容
                if (Array.isArray(content)) {
                    const parts = [];
                    
                    content.forEach(block => {
                        if (!block || typeof block !== 'object') return;
                        
                        switch (block.type) {
                            case 'text':
                                if (typeof block.text === 'string') {
                                    parts.push({ text: block.text });
                                }
                                break;
                            
                            // 添加 thinking 块处理
                            case 'thinking':
                                if (typeof block.thinking === 'string' && block.thinking.length > 0) {
                                    const thinkingPart = {
                                        text: block.thinking,
                                        thought: true
                                    };
                                    // 如果有签名，添加 thoughtSignature
                                    if (block.signature && block.signature.length >= 50) {
                                        thinkingPart.thoughtSignature = block.signature;
                                    }
                                    parts.push(thinkingPart);
                                }
                                break;
                            
                            // [FIX] 处理 redacted_thinking 块
                            case 'redacted_thinking':
                                // 将 redacted_thinking 转换为普通文本
                                if (block.data) {
                                    parts.push({ 
                                        text: `[Redacted Thinking: ${block.data}]` 
                                    });
                                }
                                break;
                                
                            case 'tool_use':
                                // 转换为 Gemini functionCall 格式
                                // [FIX] 允许 input 为 null/undefined/{} 等任何值，避免 tool_use 块被静默丢弃
                                if (block.name) {
                                    const rawInput = block.input ?? {};
                                    const args = typeof rawInput === 'string'
                                        ? rawInput
                                        : JSON.stringify(rawInput);
                                    // [FIX] 当 id 缺失时自动生成，确保 Antigravity 转 Claude 时 tool_use.id 不为空
                                    const toolUseId = sanitizeToolId(block.id) || `toolu_${uuidv4().replace(/-/g, '')}`;
                                    
                                    // 验证 args 是有效的 JSON 对象
                                    try {
                                        const parsedArgs = JSON.parse(args);
                                        if (parsedArgs && typeof parsedArgs === 'object') {
                                            const fc = {
                                                name: block.name,
                                                args: parsedArgs,
                                                id: toolUseId
                                            };
                                            parts.push({
                                                thoughtSignature: ClaudeConverter.GEMINI_CLAUDE_THOUGHT_SIGNATURE,
                                                functionCall: fc
                                            });
                                        }
                                    } catch (e) {
                                        // 如果解析失败，尝试直接使用 input
                                        const fallbackInput = rawInput && typeof rawInput === 'object' ? rawInput : {};
                                        const fc = {
                                            name: block.name,
                                            args: fallbackInput,
                                            id: toolUseId
                                        };
                                        parts.push({
                                            thoughtSignature: ClaudeConverter.GEMINI_CLAUDE_THOUGHT_SIGNATURE,
                                            functionCall: fc
                                        });
                                    }
                                }
                                break;
                                
                            case 'tool_result':
                                // 转换为 Gemini functionResponse 格式
                                // [FIX] 当 tool_use_id 缺失时自动生成，确保 functionResponse.id 不为空
                                const toolCallId = sanitizeToolId(block.tool_use_id) || `tool_result_${uuidv4().replace(/-/g, '')}`;
                                {
                                    // 尝试从之前的 tool_use 块中查找对应的函数名
                                    // 如果找不到，则从 tool_use_id 中提取
                                    let funcName = toolCallId;

                                    // 检查是否有缓存的 tool_id -> name 映射
                                    // 格式通常是 "funcName-uuid" 或 "toolu_xxx"
                                    if (toolUseNameMap.has(block.tool_use_id)) {
                                        // [FIX tool_use_id→name] 优先用预扫描的精确映射（覆盖 ZCode "tool_<uuid>" 等任意 id 格式）
                                        funcName = toolUseNameMap.get(block.tool_use_id);
                                    } else if (toolCallId.startsWith('toolu_')) {
                                        // Claude 格式的 tool_use_id，需要从上下文中查找函数名
                                        // 这里我们保留原始 ID 作为 name（Gemini 会处理）
                                        funcName = toolCallId;
                                    } else {
                                        const toolCallIdParts = toolCallId.split('-');
                                        if (toolCallIdParts.length > 1) {
                                            // 移除最后一个部分（UUID），保留函数名
                                            funcName = toolCallIdParts.slice(0, -1).join('-');
                                        }
                                    }
                                    
                                    // 获取响应数据
                                    let responseData = block.content;
                                    const imageParts = [];

                                    // 的 tool_result_compressor 逻辑
                                    // 处理嵌套的 content 数组（如图片等）
                                    if (Array.isArray(responseData)) {
                                        // 提取文本内容
                                        const textParts = responseData
                                            .filter(item => item && item.type === 'text')
                                            .map(item => item.text)
                                            .join('\n');
                                        // [FIX tool_result images] 提取 base64 图片块转为 Gemini inlineData part。
                                        // 原逻辑把整个数组 JSON.stringify 成文本（图片数据变成乱码字符串，
                                        // 视觉模型因此"看不见"工具返回的截图，客户端表现为静默空回合）。
                                        for (const item of responseData) {
                                            if (item && item.type === 'image' && item.source?.type === 'base64' && item.source.data) {
                                                imageParts.push({
                                                    inlineData: {
                                                        mimeType: item.source.media_type || 'image/jpeg',
                                                        data: item.source.data
                                                    }
                                                });
                                            }
                                        }
                                        responseData = textParts || JSON.stringify(responseData.filter(item => !(item && item.type === 'image')));
                                    } else if (typeof responseData !== 'string') {
                                        responseData = JSON.stringify(responseData);
                                    }

                                    parts.push({
                                        functionResponse: {
                                            name: funcName,
                                            // 保留原始 tool_use_id，Antigravity 转 Claude tool_result 时必需
                                            id: toolCallId,
                                            response: {
                                                result: responseData
                                            }
                                        }
                                    });
                                    // [FIX tool_result images] 工具返回的截图以 inlineData 跟在 functionResponse 后，
                                    // 使视觉模型能真正"看到"工具读取的图片
                                    parts.push(...imageParts);
                                }
                                break;
                                
                            case 'image':
                                if (block.source && block.source.type === 'base64') {
                                    parts.push({
                                        inlineData: {
                                            mimeType: block.source.media_type,
                                            data: block.source.data
                                        }
                                    });
                                }
                                break;
                        }
                    });
                    
                    if (parts.length > 0) {
                        geminiRequest.contents.push({
                            role: geminiRole,
                            parts: parts
                        });
                    }
                } else if (typeof content === 'string') {
                    // 字符串内容
                    geminiRequest.contents.push({
                        role: geminiRole,
                        parts: [{ text: content }]
                    });
                }
            });
        }

        // 添加生成配置
        const generationConfig = {};
        
        if (claudeRequest.max_tokens !== undefined) {
            generationConfig.maxOutputTokens = claudeRequest.max_tokens;
        }
        if (claudeRequest.temperature !== undefined) {
            generationConfig.temperature = claudeRequest.temperature;
        }
        if (claudeRequest.top_p !== undefined) {
            generationConfig.topP = claudeRequest.top_p;
        }
        if (claudeRequest.top_k !== undefined) {
            generationConfig.topK = claudeRequest.top_k;
        }
        
        // 处理 thinking 配置 - 转换为 Gemini thinkingBudget
        if (claudeRequest.thinking && claudeRequest.thinking.type === 'enabled') {
            if (claudeRequest.thinking.budget_tokens !== undefined) {
                const budget = claudeRequest.thinking.budget_tokens;
                if (!generationConfig.thinkingConfig) {
                    generationConfig.thinkingConfig = {};
                }
                generationConfig.thinkingConfig.thinkingBudget = budget;
                generationConfig.thinkingConfig.include_thoughts = true;
            }
        }
        
        if (Object.keys(generationConfig).length > 0) {
            geminiRequest.generationConfig = generationConfig;
        }

        // 处理工具 - 使用 parametersJsonSchema 格式
        if (Array.isArray(claudeRequest.tools) && claudeRequest.tools.length > 0) {
            const functionDeclarations = [];
            let googleSearchTool = null;
            let urlContextTool = null;
            let googleMapsTool = null;
            
            claudeRequest.tools.forEach(tool => {
                if (!tool || typeof tool !== 'object') {
                    logger.warn("Skipping invalid tool declaration in claudeRequest.tools.");
                    return;
                }

                // 处理 google_search 扩展
                if (tool.google_search) {
                    googleSearchTool = tool.google_search;
                }

                // 处理 url_context 扩展
                if (tool.url_context) {
                    urlContextTool = tool.url_context;
                }

                // 处理 google_maps 扩展
                if (tool.googleMaps) {
                    googleMapsTool = tool.googleMaps;
                }

                // 如果没有名称且不是上述扩展，则跳过函数处理
                if (!tool.name) {
                    logger.warn("Skipping unnamed tool declaration in claudeRequest.tools.");
                    return;
                }

                // 清理 input_schema
                let inputSchema = tool.input_schema;
                if (inputSchema && typeof inputSchema === 'object') {
                    // 创建副本以避免修改原始对象
                    inputSchema = JSON.parse(JSON.stringify(inputSchema));
                    // 清理不需要的字段
                    delete inputSchema.$schema;
                    // 清理 URL 格式（Gemini 不支持）
                    this.cleanUrlFormatFromSchema(inputSchema);
                }

                const funcDecl = {
                    name: String(tool.name),
                    description: String(tool.description || '')
                };
                
                // 使用 parametersJsonSchema 而不是 parameters
                if (inputSchema) {
                    funcDecl.parametersJsonSchema = inputSchema;
                }
                
                functionDeclarations.push(funcDecl);
            });
            
            if (functionDeclarations.length > 0 || googleSearchTool || urlContextTool || googleMapsTool) {
                geminiRequest.tools = [];
                if (functionDeclarations.length > 0) {
                    geminiRequest.tools.push({ functionDeclarations });
                }
                if (googleSearchTool) {
                    geminiRequest.tools.push({ googleSearch: googleSearchTool });
                }
                if (urlContextTool) {
                    geminiRequest.tools.push({ urlContext: urlContextTool });
                }
                if (googleMapsTool) {
                    geminiRequest.tools.push({ googleMaps: googleMapsTool });
                }
            }
        }

        // 处理tool_choice
        if (claudeRequest.tool_choice) {
            geminiRequest.toolConfig = this.buildGeminiToolConfigFromClaude(claudeRequest.tool_choice);
        }

        // 添加默认安全设置
        geminiRequest.safetySettings = this.getDefaultSafetySettings();

        return geminiRequest;
    }

    /**
     * 清理 JSON Schema 中的 URL 格式
     * Gemini 不支持 "format": "uri"
     */
    cleanUrlFormatFromSchema(schema) {
        if (!schema || typeof schema !== 'object') return;

        // Gemini 只接受字符串枚举值：过滤非字符串元素，过滤后为空则移除 enum
        if (Array.isArray(schema.enum)) {
            schema.enum = schema.enum.filter(v => typeof v === 'string');
            if (schema.enum.length === 0) {
                delete schema.enum;
            }
        }

        // 如果是属性对象，检查并清理 format
        if (schema.type === 'string' && schema.format === 'uri') {
            delete schema.format;
        }

        // 递归处理 properties
        if (schema.properties && typeof schema.properties === 'object') {
            Object.values(schema.properties).forEach(prop => {
                this.cleanUrlFormatFromSchema(prop);
            });
        }

        // 递归处理 items（数组类型）
        if (schema.items) {
            this.cleanUrlFormatFromSchema(schema.items);
        }

        // 递归处理 additionalProperties
        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
            this.cleanUrlFormatFromSchema(schema.additionalProperties);
        }
    }

    /**
     * 获取默认的 Gemini 安全设置
     */
    getDefaultSafetySettings() {
        return [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" }
        ];
    }

    /**
     * Claude响应 -> Gemini响应
     */
    toGeminiResponse(claudeResponse, model) {
        if (!claudeResponse || !claudeResponse.content || claudeResponse.content.length === 0) {
            return { candidates: [], usageMetadata: {} };
        }

        const parts = [];

        // 处理内容块
        for (const block of claudeResponse.content) {
            if (!block) continue;

            switch (block.type) {
                case 'text':
                    if (block.text) {
                        parts.push({ text: block.text });
                    }
                    break;

                // 添加 thinking 块处理
                case 'thinking':
                    if (block.thinking) {
                        const thinkingPart = {
                            text: block.thinking,
                            thought: true
                        };
                        // 如果有签名，添加 thoughtSignature
                        if (block.signature && block.signature.length >= 50) {
                            thinkingPart.thoughtSignature = block.signature;
                        }
                        parts.push(thinkingPart);
                    }
                    break;

                case 'tool_use':
                    // [FIX] 添加 id 和 thoughtSignature 支持
                    const functionCallPart = {
                        functionCall: {
                            name: block.name,
                            args: block.input || {}
                        }
                    };
                    // 添加 id（如果存在）
                    if (block.id) {
                        functionCallPart.functionCall.id = block.id;
                    }
                    // 添加签名（如果存在）
                    if (block.signature && block.signature.length >= 50) {
                        functionCallPart.thoughtSignature = block.signature;
                    }
                    parts.push(functionCallPart);
                    break;

                case 'image':
                    if (block.source && block.source.type === 'base64') {
                        parts.push({
                            inlineData: {
                                mimeType: block.source.media_type,
                                data: block.source.data
                            }
                        });
                    }
                    break;

                default:
                    if (block.text) {
                        parts.push({ text: block.text });
                    }
            }
        }

        // 映射finish_reason
        const finishReasonMap = {
            'end_turn': 'STOP',
            'max_tokens': 'MAX_TOKENS',
            'tool_use': 'STOP',
            'stop_sequence': 'STOP'
        };

        return {
            candidates: [{
                content: {
                    role: 'model',
                    parts: parts
                },
                finishReason: finishReasonMap[claudeResponse.stop_reason] || 'STOP'
            }],
            usageMetadata: claudeResponse.usage ? {
                promptTokenCount: claudeResponse.usage.input_tokens || 0,
                candidatesTokenCount: claudeResponse.usage.output_tokens || 0,
                totalTokenCount: (claudeResponse.usage.input_tokens || 0) + (claudeResponse.usage.output_tokens || 0),
                cachedContentTokenCount: claudeResponse.usage.cache_read_input_tokens || 0,
                promptTokensDetails: [{
                    modality: "TEXT",
                    tokenCount: claudeResponse.usage.input_tokens || 0
                }],
                candidatesTokensDetails: [{
                    modality: "TEXT",
                    tokenCount: claudeResponse.usage.output_tokens || 0
                }]
            } : {}
        };
    }

    /**
     * Claude流式响应 -> Gemini流式响应
     */
    toGeminiStreamChunk(claudeChunk, model) {
        if (!claudeChunk) return null;

        // 处理Claude流式事件
        if (typeof claudeChunk === 'object' && !Array.isArray(claudeChunk)) {
            // content_block_start 事件 - 处理 thinking 块开始
            if (claudeChunk.type === 'content_block_start') {
                const contentBlock = claudeChunk.content_block;
                if (contentBlock && contentBlock.type === 'thinking') {
                    // thinking 块开始，返回空（等待 delta）
                    return null;
                }
                if (contentBlock && contentBlock.type === 'tool_use') {
                    // tool_use 块开始
                    return {
                        candidates: [{
                            content: {
                                role: "model",
                                parts: [{
                                    functionCall: {
                                        name: contentBlock.name,
                                        args: {},
                                        id: contentBlock.id
                                    }
                                }]
                            }
                        }]
                    };
                }
            }
            
            // content_block_delta 事件
            if (claudeChunk.type === 'content_block_delta') {
                const delta = claudeChunk.delta;
                
                // 处理 text_delta
                if (delta && delta.type === 'text_delta') {
                    return {
                        candidates: [{
                            content: {
                                role: "model",
                                parts: [{
                                    text: delta.text || ""
                                }]
                            }
                        }]
                    };
                }
                
                // [FIX] 处理 thinking_delta - 转换为 Gemini 的 thought 格式
                if (delta && delta.type === 'thinking_delta') {
                    return {
                        candidates: [{
                            content: {
                                role: "model",
                                parts: [{
                                    text: delta.thinking || "",
                                    thought: true
                                }]
                            }
                        }]
                    };
                }
                
                // [FIX] 处理 signature_delta
                if (delta && delta.type === 'signature_delta') {
                    // 签名通常与前一个 thinking 块关联
                    // 在流式场景中，我们可以忽略或记录
                    return null;
                }
                
                // [FIX] 处理 input_json_delta (tool arguments)
                if (delta && delta.type === 'input_json_delta') {
                    // 工具参数增量，Gemini 不支持增量参数，忽略
                    return null;
                }
            }
            
            // message_delta 事件 - 流结束
            if (claudeChunk.type === 'message_delta') {
                const stopReason = claudeChunk.delta?.stop_reason;
                const result = {
                    candidates: [{
                        finishReason: stopReason === 'end_turn' ? 'STOP' :
                                    stopReason === 'max_tokens' ? 'MAX_TOKENS' :
                                    stopReason === 'tool_use' ? 'STOP' :
                                    'OTHER'
                    }]
                };
                
                // 添加 usage 信息
                if (claudeChunk.usage) {
                    result.usageMetadata = {
                        promptTokenCount: claudeChunk.usage.input_tokens || 0,
                        candidatesTokenCount: claudeChunk.usage.output_tokens || 0,
                        totalTokenCount: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0),
                        cachedContentTokenCount: claudeChunk.usage.cache_read_input_tokens || 0,
                        promptTokensDetails: [{
                            modality: "TEXT",
                            tokenCount: claudeChunk.usage.input_tokens || 0
                        }],
                        candidatesTokensDetails: [{
                            modality: "TEXT",
                            tokenCount: claudeChunk.usage.output_tokens || 0
                        }]
                    };
                }
                
                return result;
            }
        }

        // 向后兼容：处理字符串格式
        if (typeof claudeChunk === 'string') {
            return {
                candidates: [{
                    content: {
                        role: "model",
                        parts: [{
                            text: claudeChunk
                        }]
                    }
                }]
            };
        }

        return null;
    }

    /**
     * 处理Claude内容到Gemini parts
     */
    processClaudeContentToGeminiParts(content) {
        if (!content) return [];

        if (typeof content === 'string') {
            return [{ text: content }];
        }

        if (Array.isArray(content)) {
            const parts = [];

            content.forEach(block => {
                if (!block || typeof block !== 'object' || !block.type) {
                    logger.warn("Skipping invalid content block.");
                    return;
                }

                switch (block.type) {
                    case 'text':
                        if (typeof block.text === 'string') {
                            parts.push({ text: block.text });
                        }
                        break;

                    case 'image':
                        if (block.source && typeof block.source === 'object' && 
                            block.source.type === 'base64' &&
                            typeof block.source.media_type === 'string' && 
                            typeof block.source.data === 'string') {
                            parts.push({
                                inlineData: {
                                    mimeType: block.source.media_type,
                                    data: block.source.data
                                }
                            });
                        }
                        break;

                    case 'tool_use':
                        if (typeof block.name === 'string' && 
                            block.input && typeof block.input === 'object') {
                            parts.push({
                                functionCall: {
                                    name: block.name,
                                    args: block.input
                                }
                            });
                        }
                        break;

                    case 'tool_result':
                        if (typeof block.tool_use_id === 'string') {
                            parts.push({
                                functionResponse: {
                                    name: block.tool_use_id,
                                    response: { content: block.content }
                                }
                            });
                        }
                        break;

                    default:
                        if (typeof block.text === 'string') {
                            parts.push({ text: block.text });
                        }
                }
            });

            return parts;
        }

        return [];
    }

    /**
     * 构建Gemini工具配置
     */
    buildGeminiToolConfigFromClaude(claudeToolChoice) {
        if (!claudeToolChoice || typeof claudeToolChoice !== 'object' || !claudeToolChoice.type) {
            logger.warn("Invalid claudeToolChoice provided.");
            return undefined;
        }

        switch (claudeToolChoice.type) {
            case 'auto':
                return { functionCallingConfig: { mode: 'AUTO' } };
            case 'none':
                return { functionCallingConfig: { mode: 'NONE' } };
            case 'tool':
                if (claudeToolChoice.name && typeof claudeToolChoice.name === 'string') {
                    return { 
                        functionCallingConfig: { 
                            mode: 'ANY', 
                            allowedFunctionNames: [claudeToolChoice.name] 
                        } 
                    };
                }
                logger.warn("Invalid tool name in claudeToolChoice of type 'tool'.");
                return undefined;
            default:
                logger.warn(`Unsupported claudeToolChoice type: ${claudeToolChoice.type}`);
                return undefined;
        }
    }

    // =========================================================================
    // Claude -> OpenAI Responses 转换
    // =========================================================================

    _stringifyContentValue(value) {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        return JSON.stringify(value);
    }

    _normalizeClaudeSystem(system) {
        if (!system) {
            return '';
        }
        if (typeof system === 'string') {
            return system;
        }
        if (Array.isArray(system)) {
            return system
                .map(part => typeof part === 'string' ? part : (part?.text ?? this._stringifyContentValue(part)))
                .filter(Boolean)
                .join('\n');
        }
        return this._stringifyContentValue(system);
    }

    _claudeImageToResponsesPart(block) {
        const source = block?.source || {};
        const data = source.data || source.base64;
        const mediaType = source.media_type || source.mime_type || 'image/jpeg';
        if (data) {
            return {
                type: 'input_image',
                image_url: {
                    url: `data:${mediaType};base64,${data}`
                }
            };
        }
        if (source.url) {
            return {
                type: 'input_image',
                image_url: {
                    url: source.url
                }
            };
        }
        return null;
    }

    _pushResponsesMessage(input, role, content) {
        if (!content || content.length === 0) {
            return;
        }
        input.push({
            type: 'message',
            role: role === 'assistant' ? 'assistant' : 'user',
            content
        });
    }

    _mapClaudeToolToResponses(tool) {
        if (!tool || typeof tool !== 'object') {
            return null;
        }
        if (tool.type === 'web_search_20250305') {
            return { type: 'web_search_preview' };
        }
        return {
            type: 'function',
            name: tool.name,
            description: tool.description || '',
            parameters: cleanJsonSchemaForOpenAI(tool.input_schema || { type: 'object', properties: {} })
        };
    }

    _mapClaudeToolChoiceToResponses(toolChoice) {
        if (!toolChoice) {
            return undefined;
        }
        if (typeof toolChoice === 'string') {
            if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
                return toolChoice;
            }
            return undefined;
        }
        if (toolChoice.type === 'auto') return 'auto';
        if (toolChoice.type === 'any') return 'required';
        if (toolChoice.type === 'none') return 'none';
        if (toolChoice.type === 'tool' && toolChoice.name) {
            return {
                type: 'function',
                name: toolChoice.name
            };
        }
        return undefined;
    }

    _mapClaudeThinkingToResponses(claudeRequest) {
        const thinkingType = claudeRequest.thinking?.type;
        if (thinkingType !== 'enabled' && thinkingType !== 'adaptive') {
            return undefined;
        }
        const configuredEffort = claudeRequest.output_config?.effort;
        let effort = configuredEffort
            ? String(configuredEffort).toLowerCase()
            : determineReasoningEffortFromBudget(claudeRequest.thinking?.budget_tokens);
        if (effort === 'max') {
            effort = 'xhigh';
        }
        return { effort };
    }

    _buildResponsesMessageItemId(responseId, index = 0) {
        return responseId ? `msg_${responseId}_${index}` : `msg_${uuidv4().replace(/-/g, '')}`;
    }

    _resetOpenAIResponsesStreamState(state, claudeMessage, model) {
        const responseId = claudeMessage?.id || state.id;
        state.id = responseId;
        state.msgId = this._buildResponsesMessageItemId(responseId, 0);
        state.fullText = '';
        state.sequenceNumber = 0;
        state.model = model || claudeMessage?.model || state.model;
        state.status = 'in_progress';
        state.startTime = Math.floor(Date.now() / 1000);
        state.toolCalls = [];
        state.currentToolCall = null;
        state.savedUsage = null;
        state.reasoningId = `rs_${responseId}_0`;
        state.reasoningStarted = false;
        state.reasoningText = '';
    }

    _ensureOpenAIResponsesReasoningStarted(state, outputIndex, events) {
        if (state.reasoningStarted) {
            return;
        }
        events.push({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: {
                id: state.reasoningId,
                type: "reasoning",
                status: "in_progress",
                summary: []
            }
        });
        events.push({
            type: "response.reasoning_summary_part.added",
            item_id: state.reasoningId,
            output_index: outputIndex,
            summary_index: 0,
            part: {
                type: "summary_text",
                text: ""
            }
        });
        state.reasoningStarted = true;
    }

    /**
     * Claude请求 -> OpenAI Responses请求
     */
    toOpenAIResponsesRequest(claudeRequest) {
        const responsesRequest = {
            model: claudeRequest.model,
            input: [],
            stream: claudeRequest.stream || false
        };

        if (claudeRequest.max_tokens !== undefined) {
            responsesRequest.max_output_tokens = claudeRequest.max_tokens;
        }
        if (claudeRequest.temperature !== undefined) {
            responsesRequest.temperature = claudeRequest.temperature;
        }
        if (claudeRequest.top_p !== undefined) {
            responsesRequest.top_p = claudeRequest.top_p;
        }
        if (claudeRequest.metadata !== undefined) {
            responsesRequest.metadata = claudeRequest.metadata;
        }
        if (claudeRequest.parallel_tool_calls !== undefined) {
            responsesRequest.parallel_tool_calls = claudeRequest.parallel_tool_calls;
        }

        const instructions = this._normalizeClaudeSystem(claudeRequest.system);
        if (instructions) {
            responsesRequest.instructions = instructions;
        }

        // 处理 thinking 配置
        const reasoning = this._mapClaudeThinkingToResponses(claudeRequest);
        if (reasoning) {
            responsesRequest.reasoning = reasoning;
        }

        // 处理消息
        if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
            claudeRequest.messages.forEach(msg => {
                const role = msg.role;
                const content = msg.content;
                let messageContent = [];

                const flushMessage = () => {
                    this._pushResponsesMessage(responsesRequest.input, role, messageContent);
                    messageContent = [];
                };

                if (Array.isArray(content)) {
                    for (const c of content) {
                        if (!c) continue;
                        if (c.type === 'text') {
                            messageContent.push({
                                type: role === 'assistant' ? 'output_text' : 'input_text',
                                text: c.text || ''
                            });
                            continue;
                        }
                        if (c.type === 'image') {
                            const imagePart = this._claudeImageToResponsesPart(c);
                            if (imagePart) {
                                messageContent.push(imagePart);
                            }
                            continue;
                        }
                        if (c.type === 'thinking') {
                            flushMessage();
                            const thinkingText = c.thinking ?? c.text;
                            if (thinkingText) {
                                responsesRequest.input.push({
                                    type: 'reasoning',
                                    summary: [{
                                        type: 'summary_text',
                                        text: String(thinkingText)
                                    }]
                                });
                            }
                            continue;
                        }
                        if (c.type === 'tool_use') {
                            flushMessage();
                            responsesRequest.input.push({
                                type: 'function_call',
                                call_id: c.id,
                                name: c.name,
                                arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input || {}),
                                status: 'completed'
                            });
                            continue;
                        }
                        if (c.type === 'tool_result') {
                            flushMessage();
                            responsesRequest.input.push({
                                type: 'function_call_output',
                                call_id: c.tool_use_id || c.id,
                                output: this._stringifyContentValue(c.content)
                            });
                        }
                    }
                    flushMessage();
                } else if (typeof content === 'string') {
                    messageContent.push({
                        type: role === 'assistant' ? 'output_text' : 'input_text',
                        text: content
                    });
                    flushMessage();
                }
            });
        }

        // 处理工具
        if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
            const tools = claudeRequest.tools.map(tool => this._mapClaudeToolToResponses(tool)).filter(Boolean);
            if (tools.length > 0) {
                responsesRequest.tools = tools;
            }
        }

        const toolChoice = this._mapClaudeToolChoiceToResponses(claudeRequest.tool_choice);
        if (toolChoice) {
            responsesRequest.tool_choice = toolChoice;
        }

        return responsesRequest;
    }

    /**
     * Claude响应 -> OpenAI Responses响应
     */
    toOpenAIResponsesResponse(claudeResponse, model) {
        const output = [];
        const messageContent = [];
        const reasoningSummary = [];
        const createdAt = Math.floor(Date.now() / 1000);
        const responseId = claudeResponse.id || `resp_${uuidv4().replace(/-/g, '')}`;
        const messageItemId = this._buildResponsesMessageItemId(responseId, 0);

        // Process Claude content blocks, handling both text and tool_use
        if (Array.isArray(claudeResponse.content)) {
            for (const block of claudeResponse.content) {
                if (block.type === 'text' && block.text) {
                    messageContent.push({
                        annotations: [],
                        logprobs: [],
                        text: block.text,
                        type: "output_text"
                    });
                } else if (block.type === 'thinking') {
                    const thinking = block.thinking ?? block.text;
                    if (thinking) {
                        reasoningSummary.push({
                            type: "summary_text",
                            text: String(thinking)
                        });
                    }
                } else if (block.type === 'tool_use') {
                    output.push({
                        type: "function_call",
                        id: `fc_${uuidv4().replace(/-/g, '')}`,
                        call_id: block.id || `call_${uuidv4().replace(/-/g, '')}`,
                        name: block.name,
                        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
                        status: "completed"
                    });
                }
            }
        }

        if (reasoningSummary.length > 0) {
            output.unshift({
                id: `rs_${uuidv4().replace(/-/g, '')}`,
                type: "reasoning",
                status: "completed",
                summary: reasoningSummary
            });
        }

        if (messageContent.length > 0 || output.length === 0) {
            output.unshift({
                type: "message",
                id: messageItemId,
                summary: [],
                role: "assistant",
                status: "completed",
                content: messageContent
            });
        }

        const incomplete = claudeResponse.stop_reason === 'max_tokens';

        return {
            background: false,
            created_at: createdAt,
            error: null,
            id: responseId,
            incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
            max_output_tokens: null,
            max_tool_calls: null,
            metadata: {},
            model: model || claudeResponse.model,
            object: "response",
            output: output,
            parallel_tool_calls: true,
            previous_response_id: null,
            prompt_cache_key: null,
            reasoning: reasoningSummary.length > 0 ? { summary: "auto" } : {},
            safety_identifier: "user-" + uuidv4().replace(/-/g, ''),
            service_tier: "default",
            status: incomplete ? "incomplete" : "completed",
            store: false,
            temperature: 1,
            text: {
                format: { type: "text" },
            },
            tool_choice: "auto",
            tools: [],
            top_logprobs: 0,
            top_p: 1,
            truncation: "disabled",
            usage: {
                input_tokens: claudeResponse.usage?.input_tokens || 0,
                input_tokens_details: {
                    cached_tokens: claudeResponse.usage?.cache_read_input_tokens || 0
                },
                output_tokens: claudeResponse.usage?.output_tokens || 0,
                output_tokens_details: {
                    reasoning_tokens: 0
                },
                total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
            },
            user: null
        };
    }

    /**
     * Claude流式响应 -> OpenAI Responses流式响应
     */
    toOpenAIResponsesStreamChunk(claudeChunk, model, requestId = null) {
        if (!claudeChunk) return [];

        const stateKey = requestId || 'default';
        const events = [];

        // message_start 事件 - 流开始
        if (claudeChunk.type === 'message_start') {
            const state = streamStateManager.getOrCreateState(stateKey);
            this._resetOpenAIResponsesStreamState(state, claudeChunk.message, model);
            events.push(
                generateResponseCreated(stateKey, model || claudeChunk.message?.model || 'unknown'),
                generateResponseInProgress(stateKey),
                generateOutputItemAdded(stateKey),
                generateContentPartAdded(stateKey)
            );
        }

        // content_block_start 事件
        if (claudeChunk.type === 'content_block_start') {
            const contentBlock = claudeChunk.content_block;
            
            // 对于 tool_use 类型，添加工具调用项
            if (contentBlock && contentBlock.type === 'tool_use') {
                startToolCall(stateKey, contentBlock.id, contentBlock.name);
                events.push({
                    item: {
                        id: contentBlock.id,
                        call_id: contentBlock.id,
                        type: "function_call",
                        name: contentBlock.name,
                        arguments: "",
                        status: "in_progress"
                    },
                    output_index: claudeChunk.index || 0,
                    sequence_number: 2,
                    type: "response.output_item.added"
                });
            }
        }

        // content_block_delta 事件
        if (claudeChunk.type === 'content_block_delta') {
            const delta = claudeChunk.delta;
            
            // 处理文本增量
            if (delta && delta.type === 'text_delta') {
                events.push(generateOutputTextDelta(stateKey, delta.text || ""));
            }
            // 处理推理内容增量
            else if (delta && delta.type === 'thinking_delta') {
                const state = streamStateManager.getOrCreateState(stateKey);
                const outputIndex = claudeChunk.index || 0;
                this._ensureOpenAIResponsesReasoningStarted(state, outputIndex, events);
                state.reasoningText += delta.thinking || "";
                events.push({
                    delta: delta.thinking || "",
                    item_id: state.reasoningId,
                    output_index: outputIndex,
                    sequence_number: 3,
                    summary_index: 0,
                    type: "response.reasoning_summary_text.delta"
                });
            }
            // 处理工具调用参数增量
            else if (delta && delta.type === 'input_json_delta') {
                const state = streamStateManager.getOrCreateState(stateKey);
                const itemId = state.currentToolCall ? state.currentToolCall.id : 'unknown';
                events.push(generateFunctionCallArgsDelta(
                    stateKey, itemId, claudeChunk.index || 0, delta.partial_json || ""
                ));
            }
        }

        // content_block_stop 事件
        if (claudeChunk.type === 'content_block_stop') {
            const state = streamStateManager.getOrCreateState(stateKey);
            if (state.currentToolCall) {
                const itemId = state.currentToolCall.id;
                const outputIdx = claudeChunk.index || 0;
                events.push(generateFunctionCallArgsDone(stateKey, itemId, outputIdx));
                const finished = finishToolCall(stateKey);
                if (finished) {
                    events.push(generateFunctionCallOutputItemDone(stateKey, finished, outputIdx));
                }
            }
        }

        // message_delta 事件 - 保存 usage 供 message_stop 使用
        if (claudeChunk.type === 'message_delta') {
            if (claudeChunk.usage) {
                const state = streamStateManager.getOrCreateState(stateKey);
                state.savedUsage = {
                    input_tokens: claudeChunk.usage.input_tokens || 0,
                    input_tokens_details: { cached_tokens: claudeChunk.usage.cache_read_input_tokens || 0 },
                    output_tokens: claudeChunk.usage.output_tokens || 0,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: (claudeChunk.usage.input_tokens || 0) + (claudeChunk.usage.output_tokens || 0)
                };
            }
        }

        // message_stop 事件
        if (claudeChunk.type === 'message_stop') {
            const state = streamStateManager.getOrCreateState(stateKey);
            const savedUsage = state.savedUsage || null;
            if (state.reasoningStarted) {
                events.push({
                    type: "response.reasoning_summary_text.done",
                    item_id: state.reasoningId,
                    output_index: 0,
                    summary_index: 0,
                    text: state.reasoningText
                });
                events.push({
                    type: "response.reasoning_summary_part.done",
                    item_id: state.reasoningId,
                    output_index: 0,
                    summary_index: 0,
                    part: {
                        type: "summary_text",
                        text: state.reasoningText
                    }
                });
                events.push({
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        id: state.reasoningId,
                        type: "reasoning",
                        status: "completed",
                        summary: [{
                            type: "summary_text",
                            text: state.reasoningText
                        }]
                    }
                });
            }
            events.push(
                generateOutputTextDone(stateKey),
                generateContentPartDone(stateKey),
                generateOutputItemDone(stateKey)
            );
            const completedEvent = generateResponseCompleted(stateKey, savedUsage);
            if (state.reasoningStarted) {
                completedEvent.response.output.unshift({
                    id: state.reasoningId,
                    type: "reasoning",
                    status: "completed",
                    summary: [{
                        type: "summary_text",
                        text: state.reasoningText
                    }]
                });
            }
            events.push(completedEvent);
            streamStateManager.cleanup(stateKey);
        }

        return events;
    }

    // =========================================================================
    // Claude -> Codex 转换
    // =========================================================================

    /**
     * 应用简单缩短规则缩短工具名称
     */
    _shortenNameIfNeeded(name) {
        const limit = 64;
        if (name.length <= limit) {
            return name;
        }
        if (name.startsWith("mcp__")) {
            const idx = name.lastIndexOf("__");
            if (idx > 0) {
                const cand = "mcp__" + name.substring(idx + 2);
                if (cand.length > limit) {
                    return cand.substring(0, limit);
                }
                return cand;
            }
        }
        return name.substring(0, limit);
    }

    /**
     * 构建短名称映射以确保请求内唯一性
     */
    _buildShortNameMap(names) {
        const limit = 64;
        const used = new Set();
        const m = {};

        const baseCandidate = (n) => {
            if (n.length <= limit) {
                return n;
            }
            if (n.startsWith("mcp__")) {
                const idx = n.lastIndexOf("__");
                if (idx > 0) {
                    let cand = "mcp__" + n.substring(idx + 2);
                    if (cand.length > limit) {
                        cand = cand.substring(0, limit);
                    }
                    return cand;
                }
            }
            return n.substring(0, limit);
        };

        const makeUnique = (cand) => {
            if (!used.has(cand)) {
                return cand;
            }
            const base = cand;
            for (let i = 1; ; i++) {
                const suffix = "_" + i;
                const allowed = limit - suffix.length;
                let tmp = base;
                if (tmp.length > (allowed < 0 ? 0 : allowed)) {
                    tmp = tmp.substring(0, allowed < 0 ? 0 : allowed);
                }
                tmp = tmp + suffix;
                if (!used.has(tmp)) {
                    return tmp;
                }
            }
        };

        for (const n of names) {
            const cand = baseCandidate(n);
            const uniq = makeUnique(cand);
            used.add(uniq);
            m[n] = uniq;
        }
        return m;
    }

    /**
     * 标准化工具参数，确保对象 Schema 包含 properties
     */
    _normalizeToolParameters(schema) {
        if (!schema || typeof schema !== 'object') {
            return { type: 'object', properties: {} };
        }
        const result = { ...schema };
        if (!result.type) {
            result.type = 'object';
        }
        if (result.type === 'object' && !result.properties) {
            result.properties = {};
        }
        return result;
    }

    /**
     * Claude请求 -> Codex请求
     */
    toCodexRequest(claudeRequest) {
        const codexRequest = {
            model: claudeRequest.model,
            instructions: '',
            input: [],
            stream: true,
            store: false,
            parallel_tool_calls: true,
            metadata: claudeRequest.metadata || {},
            reasoning: {
                effort: claudeRequest.reasoning?.effort || 'medium',
                summary: 'auto'
            },
            include: ['reasoning.encrypted_content']
        };

        // 处理系统指令
        if (claudeRequest.system) {
            let instructions = '';
            if (Array.isArray(claudeRequest.system)) {
                instructions = claudeRequest.system.map(s => typeof s === 'string' ? s : s.text).join('\n');
            } else {
                instructions = claudeRequest.system;
            }
            codexRequest.instructions = instructions;
        }

        // 处理工具并构建短名称映射
        let shortMap = {};
        if (claudeRequest.tools && Array.isArray(claudeRequest.tools)) {
            const toolNames = claudeRequest.tools.map(t => t.name).filter(Boolean);
            shortMap = this._buildShortNameMap(toolNames);

            codexRequest.tools = claudeRequest.tools.map(tool => {
                // 特殊处理：将 Claude Web Search 工具映射到 Codex web_search
                if (tool.type === "web_search_20250305") {
                    return { type: "web_search" };
                }

                let name = tool.name;
                if (shortMap[name]) {
                    name = shortMap[name];
                } else {
                    name = this._shortenNameIfNeeded(name);
                }

                const convertedTool = {
                    type: 'function',
                    name: name,
                    description: tool.description || '',
                    parameters: this._normalizeToolParameters(tool.input_schema),
                    strict: false
                };
                
                // 移除 parameters.$schema
                if (convertedTool.parameters && convertedTool.parameters.$schema) {
                    delete convertedTool.parameters.$schema;
                }

                return convertedTool;
            });
            codexRequest.tool_choice = "auto";
        }

        // 处理消息
        if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
            for (const msg of claudeRequest.messages) {
                const role = msg.role;
                const content = msg.content;

                let currentMessage = {
                    type: 'message',
                    role: role,
                    content: []
                };

                const flushMessage = () => {
                    if (currentMessage.content.length > 0) {
                        codexRequest.input.push({ ...currentMessage });
                        currentMessage.content = [];
                    }
                };

                const appendTextContent = (text) => {
                    const partType = role === 'assistant' ? 'output_text' : 'input_text';
                    currentMessage.content.push({
                        type: partType,
                        text: text
                    });
                };

                const appendImageContent = (data, mediaType) => {
                    currentMessage.content.push({
                        type: 'input_image',
                        image_url: `data:${mediaType};base64,${data}`
                    });
                };

                if (Array.isArray(content)) {
                    for (const block of content) {
                        switch (block.type) {
                            case 'text':
                                appendTextContent(block.text);
                                break;
                            case 'image':
                                if (block.source) {
                                    const data = block.source.data || block.source.base64 || '';
                                    const mediaType = block.source.media_type || block.source.mime_type || 'application/octet-stream';
                                    if (data) {
                                        appendImageContent(data, mediaType);
                                    }
                                }
                                break;
                            case 'tool_use':
                                flushMessage();
                                let toolName = block.name;
                                if (shortMap[toolName]) {
                                    toolName = shortMap[toolName];
                                } else {
                                    toolName = this._shortenNameIfNeeded(toolName);
                                }
                                codexRequest.input.push({
                                    type: 'function_call',
                                    call_id: block.id,
                                    name: toolName,
                                    arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
                                });
                                break;
                            case 'tool_result':
                                flushMessage();
                                codexRequest.input.push({
                                    type: 'function_call_output',
                                    call_id: block.tool_use_id,
                                    output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || "")
                                });
                                break;
                        }
                    }
                } else if (typeof content === 'string') {
                    appendTextContent(content);
                }
                flushMessage();
            }
        }

        // 处理 thinking 转换
        if (claudeRequest.thinking && claudeRequest.thinking.type === "enabled") {
            const budgetTokens = claudeRequest.thinking.budget_tokens;
            codexRequest.reasoning.effort = determineReasoningEffortFromBudget(budgetTokens);
        } else if (claudeRequest.thinking && claudeRequest.thinking.type === "disabled") {
             codexRequest.reasoning.effort = determineReasoningEffortFromBudget(0);
        }

        // 注入 Codex 指令 (对应 末尾的特殊逻辑)
        // 注意：这里需要检查是否需要注入 "EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!"
        // 通过 misc.GetCodexInstructionsEnabled() 判断，这里我们参考其逻辑
        const shouldInjectInstructions = process.env.CODEX_INSTRUCTIONS_ENABLED === 'true'; // 假设环境变量控制
        if (shouldInjectInstructions && codexRequest.input.length > 0) {
            const firstInput = codexRequest.input[0];
            const firstText = firstInput.content && firstInput.content[0] && firstInput.content[0].text;
            const instructions = "EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!";
            if (firstText !== instructions) {
                codexRequest.input.unshift({
                    type: 'message',
                    role: 'user',
                    content: [{
                        type: 'input_text',
                        text: instructions
                    }]
                });
            }
        }

        return codexRequest;
    }

    /**
     * Claude请求 -> Grok请求
     */
    toGrokRequest(claudeRequest) {
        // 先转换为 OpenAI 格式，因为 Grok 兼容 OpenAI 格式
        const openaiRequest = this.toOpenAIRequest(claudeRequest);
        return {
            ...openaiRequest,
            _isConverted: true
        };
    }

    /**
     * Claude响应 -> Codex响应 (实际上是 Codex 转 Claude)
     */
    toCodexResponse(codexResponse, model) {
        const content = [];
        let stopReason = "end_turn";

        if (codexResponse.response?.output) {
            codexResponse.response.output.forEach(item => {
                if (item.type === 'message' && item.content) {
                    const textPart = item.content.find(c => c.type === 'output_text');
                    if (textPart) content.push({ type: 'text', text: textPart.text });
                } else if (item.type === 'reasoning' && item.summary) {
                    const textPart = item.summary.find(c => c.type === 'summary_text');
                    if (textPart) content.push({ type: 'thinking', thinking: textPart.text });
                } else if (item.type === 'function_call') {
                    stopReason = "tool_use";
                    content.push({
                        type: 'tool_use',
                        id: item.call_id,
                        name: item.name,
                        input: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments
                    });
                }
            });
        }

        return {
            id: codexResponse.response?.id || `msg_${uuidv4().replace(/-/g, '')}`,
            type: "message",
            role: "assistant",
            model: model,
            content: content,
            stop_reason: stopReason,
            usage: {
                input_tokens: codexResponse.response?.usage?.input_tokens || 0,
                output_tokens: codexResponse.response?.usage?.output_tokens || 0
            }
        };
    }

    /**
     * Claude流式响应 -> Codex流式响应 (实际上是 Codex 转 Claude)
     */
    toCodexStreamChunk(codexChunk, model) {
        const type = codexChunk.type;
        const resId = codexChunk.response?.id || 'default';
        
        if (type === 'response.created') {
            return {
                type: "message_start",
                message: {
                    id: codexChunk.response.id,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: model,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            };
        }

        if (type === 'response.reasoning_summary_text.delta') {
            return {
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: codexChunk.delta }
            };
        }

        if (type === 'response.output_text.delta') {
            return {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: codexChunk.delta }
            };
        }

        if (type === 'response.output_item.done' && codexChunk.item?.type === 'function_call') {
            return [
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: {
                        type: "tool_use",
                        id: codexChunk.item.call_id,
                        name: codexChunk.item.name,
                        input: {}
                    }
                },
                {
                    type: "content_block_delta",
                    index: 0,
                    delta: {
                        type: "input_json_delta",
                        partial_json: typeof codexChunk.item.arguments === 'string' ? codexChunk.item.arguments : JSON.stringify(codexChunk.item.arguments)
                    }
                },
                {
                    type: "content_block_stop",
                    index: 0
                }
            ];
        }

        if (type === 'response.completed') {
            return [
                {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: {
                        input_tokens: codexChunk.response.usage?.input_tokens || 0,
                        output_tokens: codexChunk.response.usage?.output_tokens || 0
                    }
                },
                { type: "message_stop" }
            ];
        }

        return null;
    }
}

export default ClaudeConverter;
