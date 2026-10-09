/**
 * Gemini转换器
 * 处理Gemini（Google）协议与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseConverter } from '../BaseConverter.js';
import {
    checkAndAssignOrDefault,
    OPENAI_DEFAULT_MAX_TOKENS,
    OPENAI_DEFAULT_TEMPERATURE,
    OPENAI_DEFAULT_TOP_P,
    CLAUDE_DEFAULT_MAX_TOKENS,
    CLAUDE_DEFAULT_TEMPERATURE,
    CLAUDE_DEFAULT_TOP_P
} from '../utils.js';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';
import {
    generateResponseCreated,
    generateResponseInProgress,
    generateOutputItemAdded,
    generateContentPartAdded,
    generateOutputTextDone,
    generateContentPartDone,
    generateOutputItemDone,
    generateOutputTextDelta,
    generateResponseCompleted,
    streamStateManager
} from '../../providers/openai/openai-responses-core.mjs';

/**
 * 修复 Gemini 返回的工具参数名称问题
 * Gemini 有时会使用不同的参数名称，需要映射到 Claude Code 期望的格式
 */
function remapFunctionCallArgs(toolName, args) {
    if (!args || typeof args !== 'object') return args;
    
    const remappedArgs = { ...args };
    const toolNameLower = toolName.toLowerCase();
    
    // [IMPORTANT] Claude Code CLI 的 EnterPlanMode 工具禁止携带任何参数
    if (toolName === 'EnterPlanMode') {
        return {};
    }
    
    switch (toolNameLower) {
        case 'grep':
        case 'search':
        case 'search_code_definitions':
        case 'search_code_snippets':
            // [FIX] Gemini hallucination: maps parameter description to "description" field
            if (remappedArgs.description && !remappedArgs.pattern) {
                remappedArgs.pattern = remappedArgs.description;
                delete remappedArgs.description;
            }
            
            // Gemini uses "query", Claude Code expects "pattern"
            if (remappedArgs.query && !remappedArgs.pattern) {
                remappedArgs.pattern = remappedArgs.query;
                delete remappedArgs.query;
            }
            
            // [CRITICAL FIX] Claude Code uses "path" (string), NOT "paths" (array)!
            if (!remappedArgs.path) {
                if (remappedArgs.paths) {
                    if (Array.isArray(remappedArgs.paths)) {
                        remappedArgs.path = remappedArgs.paths[0] || '.';
                    } else if (typeof remappedArgs.paths === 'string') {
                        remappedArgs.path = remappedArgs.paths;
                    } else {
                        remappedArgs.path = '.';
                    }
                    delete remappedArgs.paths;
                } else {
                    // Default to current directory if missing
                    remappedArgs.path = '.';
                }
            }
            // Note: We keep "-n" and "output_mode" if present as they are valid in Grep schema
            break;
            
        case 'glob':
            // [FIX] Gemini hallucination: maps parameter description to "description" field
            if (remappedArgs.description && !remappedArgs.pattern) {
                remappedArgs.pattern = remappedArgs.description;
                delete remappedArgs.description;
            }
            
            // Gemini uses "query", Claude Code expects "pattern"
            if (remappedArgs.query && !remappedArgs.pattern) {
                remappedArgs.pattern = remappedArgs.query;
                delete remappedArgs.query;
            }
            
            // [CRITICAL FIX] Claude Code uses "path" (string), NOT "paths" (array)!
            // [NOTE] 与 grep 不同，glob 不添加默认 path（参考 Rust 代码）
            if (!remappedArgs.path) {
                if (remappedArgs.paths) {
                    if (Array.isArray(remappedArgs.paths)) {
                        remappedArgs.path = remappedArgs.paths[0] || '.';
                    } else if (typeof remappedArgs.paths === 'string') {
                        remappedArgs.path = remappedArgs.paths;
                    } else {
                        remappedArgs.path = '.';
                    }
                    delete remappedArgs.paths;
                }
                // [FIX] glob 不添加默认 path，与 Rust 代码保持一致
            }
            break;
            
        case 'read':
            // Gemini might use "path" vs "file_path"
            if (remappedArgs.path && !remappedArgs.file_path) {
                remappedArgs.file_path = remappedArgs.path;
                delete remappedArgs.path;
            }
            break;
            
        case 'ls':
            // LS tool: ensure "path" parameter exists
            if (!remappedArgs.path) {
                remappedArgs.path = '.';
            }
            break;
            
        default:
            // [NEW] [Issue #785] Generic Property Mapping for all tools
            // If a tool has "paths" (array of 1) but no "path", convert it.
            // [FIX] 与 Rust 代码保持一致：只在 paths.length === 1 时转换，不删除原始 paths
            if (!remappedArgs.path && remappedArgs.paths) {
                if (Array.isArray(remappedArgs.paths) && remappedArgs.paths.length === 1) {
                    const pathValue = remappedArgs.paths[0];
                    if (typeof pathValue === 'string') {
                        remappedArgs.path = pathValue;
                        // [FIX] Rust 代码中不删除 paths，这里也不删除
                    }
                }
            }
            break;
    }
    
    return remappedArgs;
}

/**
 * [FIX] 规范化工具名称
 * Gemini 有时会返回 "search" 而不是 "Grep"
 */
function normalizeToolName(name) {
    if (!name) return name;
    
    const nameLower = name.toLowerCase();
    if (nameLower === 'search') {
        return 'Grep';
    }
    return name;
}

/**
 * Gemini转换器类
 * 实现Gemini协议到其他协议的转换
 */
export class GeminiConverter extends BaseConverter {
    constructor() {
        super('gemini');
        this.openAIResponsesStreamStates = new Map();
        // Gemini → OpenAI 流的按请求状态：稳定 chunk id、跨 chunk 的 tool_calls index。
        // 单例转换器会服务并发请求，状态必须显式按 requestId 隔离和释放。
        this.openAIStreamStates = new Map();
    }

    /**
     * 显式释放一次 Gemini → OpenAI 流的状态。
     *
     * 正常 STOP 会在转换器内自动清理；客户端中断、上游 throw 或无终止块 EOF 时，
     * 由 common.js 的 finally 调用本方法，避免单例 Map 残留。
     */
    releaseOpenAIStreamState(requestId = null) {
        this.openAIStreamStates.delete(requestId || 'default');
    }

    /** 供生命周期回归测试断言状态没有泄漏。 */
    openAIStreamStateCount() {
        return this.openAIStreamStates.size;
    }

    /**
     * 转换请求
     */
    convertRequest(data, targetProtocol) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIRequest(data);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeRequest(data);
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
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeResponse(data, model);
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
                return this.toOpenAIStreamChunk(chunk, model, requestId);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeStreamChunk(chunk, model);
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
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeModelList(data);
            default:
                return data;
        }
    }

    // =========================================================================
    // Gemini -> OpenAI 转换
    // =========================================================================

    /**
     * Gemini请求 -> OpenAI请求
     */
    toOpenAIRequest(geminiRequest) {
        const openaiRequest = {
            messages: [],
            model: geminiRequest.model,
            max_tokens: checkAndAssignOrDefault(geminiRequest.max_tokens, OPENAI_DEFAULT_MAX_TOKENS),
            temperature: checkAndAssignOrDefault(geminiRequest.temperature, OPENAI_DEFAULT_TEMPERATURE),
            top_p: checkAndAssignOrDefault(geminiRequest.top_p, OPENAI_DEFAULT_TOP_P),
        };

        // 处理系统指令
        if (geminiRequest.systemInstruction && Array.isArray(geminiRequest.systemInstruction.parts)) {
            const { content: systemContent } = this.processGeminiPartsToOpenAIContent(geminiRequest.systemInstruction.parts);
            if (systemContent) {
                openaiRequest.messages.push({
                    role: 'system',
                    content: systemContent
                });
            }
        }

        // 处理内容
        if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
            geminiRequest.contents.forEach(content => {
                if (content && Array.isArray(content.parts)) {
                    const { content: openaiContent, reasoning_content } = this.processGeminiPartsToOpenAIContent(content.parts);
                    if ((openaiContent && openaiContent.length > 0) || reasoning_content) {
                        const openaiRole = content.role === 'model' ? 'assistant' : content.role;
                        const message = {
                            role: openaiRole,
                            content: openaiContent
                        };
                        if (reasoning_content) {
                            message.reasoning_content = reasoning_content;
                        }
                        openaiRequest.messages.push(message);
                    }
                }
            });
        }

        return openaiRequest;
    }

    /**
     * Gemini响应 -> OpenAI响应
     */
    toOpenAIResponse(geminiResponse, model) {
        const { content, reasoning_content } = this.processGeminiResponseContent(geminiResponse);
        
        // 提取 tool_calls
        const toolCalls = [];
        let finishReason = "stop";
        
        if (geminiResponse && geminiResponse.candidates) {
            for (const candidate of geminiResponse.candidates) {
                if (candidate.content && candidate.content.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.functionCall) {
                            toolCalls.push({
                                id: part.functionCall.id || `call_${uuidv4()}`,
                                type: 'function',
                                function: {
                                    name: part.functionCall.name,
                                    arguments: typeof part.functionCall.args === 'string' 
                                        ? part.functionCall.args 
                                        : JSON.stringify(part.functionCall.args)
                                }
                            });
                        }
                    }
                }
            }
        }
        
        // 如果有工具调用，设置 finish_reason 为 tool_calls
        if (toolCalls.length > 0) {
            finishReason = "tool_calls";
        }
        
        const message = {
            role: "assistant",
            content: content
        };

        if (reasoning_content) {
            message.reasoning_content = reasoning_content;
        }
        
        // 只有在有 tool_calls 时才添加该字段
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
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
            usage: geminiResponse.usageMetadata ? {
                prompt_tokens: geminiResponse.usageMetadata.promptTokenCount || 0,
                completion_tokens: geminiResponse.usageMetadata.candidatesTokenCount || 0,
                total_tokens: geminiResponse.usageMetadata.totalTokenCount || 0,
                cached_tokens: geminiResponse.usageMetadata.cachedContentTokenCount || 0,
                prompt_tokens_details: {
                    cached_tokens: geminiResponse.usageMetadata.cachedContentTokenCount || 0
                },
                completion_tokens_details: {
                    reasoning_tokens: geminiResponse.usageMetadata.thoughtsTokenCount || 0
                }
            } : {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                cached_tokens: 0,
                prompt_tokens_details: {
                    cached_tokens: 0
                },
                completion_tokens_details: {
                    reasoning_tokens: 0
        }
            },
        };
    }

    /**
     * Gemini流式响应 -> OpenAI流式响应
     */
    toOpenAIStreamChunk(geminiChunk, model, requestId = null) {
        if (!geminiChunk) return null;

        const candidate = geminiChunk.candidates?.[0];
        if (!candidate) return null;

        // Gemini 会把并行 functionCall 拆成多个 chunk。OpenAI 客户端却按同一
        // chunk.id 与 tool_calls[].index 合并增量，因此状态必须跨 chunk、按请求保存。
        // 兼容入口缺 requestId 时保留 default 槽，但只警告一次，不能假装它能隔离并发。
        const stateKey = requestId || 'default';
        if (!requestId && !this.__warnedDefaultOpenAIStreamState) {
            this.__warnedDefaultOpenAIStreamState = true;
            console.warn('[GeminiConverter] toOpenAIStreamChunk missing requestId; concurrent streams share the default state');
        }
        if (!this.openAIStreamStates.has(stateKey)) {
            this.openAIStreamStates.set(stateKey, {
                chunkId: `chatcmpl-${uuidv4()}`,
                toolCallIndex: 0,
                sawToolCall: false
            });
        }
        const streamState = this.openAIStreamStates.get(stateKey);

        let content = '';
        let reasoning_content = '';
        const toolCalls = [];
        // 本 chunk 是否携带了可识别的 part（含仅有 thoughtSignature 的 part）。
        // Gemini 3 系列会先回传只带 thoughtSignature、不带 text 的 part，若把这种 chunk 整体丢弃，
        // 当整个流只由这类 part 组成时下游会收到 0 个 chunk（LangChain 报 "No generations found in stream."）。
        let sawPart = false;

        // 从parts中提取文本和tool calls
        const parts = candidate.content?.parts;
        if (parts && Array.isArray(parts)) {
            for (const part of parts) {
                // 用 typeof 判断而非 truthiness，避免 text 为空串时被跳过
                if (typeof part.text === 'string') {
                    sawPart = true;
                    if (part.thought === true) {
                        reasoning_content += part.text;
                    } else {
                        content += part.text;
                    }
                }
                if (part.functionCall) {
                    sawPart = true;
                    toolCalls.push({
                        index: streamState.toolCallIndex++,
                        id: part.functionCall.id || `call_${uuidv4()}`,
                        type: 'function',
                        function: {
                            name: part.functionCall.name,
                            arguments: typeof part.functionCall.args === 'string'
                                ? part.functionCall.args
                                : JSON.stringify(part.functionCall.args)
                        }
                    });
                }
                // thoughtSignature 本身不透传给客户端（Gemini 内部数据），但要记为“收到过 part”
                if (part.thoughtSignature || part.thought_signature) {
                    sawPart = true;
                }
            }
        }

        if (toolCalls.length > 0) {
            streamState.sawToolCall = true;
        }

        // 处理finishReason
        let finishReason = null;
        if (candidate.finishReason) {
            const finishReasonMap = {
                'FINISH_REASON_UNSPECIFIED': 'stop',
                'STOP': 'stop',
                'MAX_TOKENS': 'length',
                'SAFETY': 'content_filter',
                'RECITATION': 'content_filter',
                'OTHER': 'stop',
                'BLOCKLIST': 'content_filter',
                'PROHIBITED_CONTENT': 'content_filter',
                'SPII': 'content_filter',
                'MALFORMED_FUNCTION_CALL': 'stop',
                'MODEL_ARMOR': 'content_filter',
            };
            finishReason = finishReasonMap[candidate.finishReason] || 'stop';
            // 工具调用数据块本身必须保持 finish_reason=null；只在原生终止块上报告 tool_calls。
            if (finishReason === 'stop' && streamState.sawToolCall) {
                finishReason = 'tool_calls';
            }
        }

        // 构建delta对象
        const delta = {};
        if (content) delta.content = content;
        if (reasoning_content) delta.reasoning_content = reasoning_content;
        if (toolCalls.length > 0) delta.tool_calls = toolCalls;

        // Don't return empty delta chunks
        // 例外：本 chunk 确实携带了 part（例如仅有 thoughtSignature）时，仍下发一个空 delta，
        // 保证下游至少能收到一个 generation，不会把有效流误判为空流。
        if (Object.keys(delta).length === 0 && !finishReason && !sawPart) {
            return null;
        }

        const chunk = {
            id: streamState.chunkId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
                index: 0,
                delta: delta,
                finish_reason: finishReason,
            }],
        };

        // 正常终止时转换器自行清理；其它退出路径由 common.js finally 显式清理。
        if (candidate.finishReason) {
            this.releaseOpenAIStreamState(stateKey);
        }

        if(geminiChunk.usageMetadata){
            chunk.usage = {
                prompt_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                completion_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
                total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0,
                cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0,
                prompt_tokens_details: {
                    cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0
                },
                completion_tokens_details: {
                    reasoning_tokens: geminiChunk.usageMetadata.thoughtsTokenCount || 0
                }
            };
        }

        return chunk;
    }

    /**
     * Gemini模型列表 -> OpenAI模型列表
     */
    toOpenAIModelList(geminiModels) {
        return {
            object: "list",
            data: geminiModels.models.map(m => {
                const modelId = m.name.startsWith('models/') ? m.name.substring(7) : m.name;
                return {
                    id: modelId,
                    object: "model",
                    created: Math.floor(Date.now() / 1000),
                    owned_by: "google",
                    display_name: m.displayName || modelId,
                };
            }),
        };
    }

    /**
     * 处理Gemini parts到OpenAI内容
     */
    processGeminiPartsToOpenAIContent(parts) {
        if (!parts || !Array.isArray(parts)) return { content: '', reasoning_content: '' };

        const contentArray = [];
        const reasoningParts = [];

        parts.forEach(part => {
            if (!part) return;

            if (typeof part.text === 'string') {
                if (part.thought === true) {
                    reasoningParts.push(part.text);
                } else {
                    contentArray.push({
                        type: 'text',
                        text: part.text
                    });
                }
            }

            if (part.inlineData) {
                const { mimeType, data } = part.inlineData;
                if (mimeType && data) {
                    contentArray.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${mimeType};base64,${data}`
                        }
                    });
                }
            }

            if (part.fileData) {
                const { mimeType, fileUri } = part.fileData;
                if (mimeType && fileUri) {
                    if (mimeType.startsWith('image/')) {
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: fileUri
                            }
                        });
                    } else if (mimeType.startsWith('audio/')) {
                        contentArray.push({
                            type: 'text',
                            text: `[Audio file: ${fileUri}]`
                        });
                    }
                }
            }
        });

        const content = contentArray.length === 1 && contentArray[0].type === 'text'
            ? contentArray[0].text
            : contentArray;

        return {
            content,
            reasoning_content: reasoningParts.join('\n')
        };
    }

    /**
     * 处理Gemini响应内容
     */
    processGeminiResponseContent(geminiResponse) {
        if (!geminiResponse || !geminiResponse.candidates) return { content: '', reasoning_content: '' };
        
        const contents = [];
        const reasoningContents = [];
        
        geminiResponse.candidates.forEach(candidate => {
            if (candidate.content && candidate.content.parts) {
                candidate.content.parts.forEach(part => {
                    if (part.text) {
                        if (part.thought === true) {
                            reasoningContents.push(part.text);
                        } else {
                            contents.push(part.text);
                        }
                    }
                });
            }
        });
        
        return {
            content: contents.join('\n'),
            reasoning_content: reasoningContents.join('\n')
        };
    }

    // =========================================================================
    // Gemini -> Claude 转换
    // =========================================================================

    /**
     * Gemini请求 -> Claude请求
     */
    toClaudeRequest(geminiRequest) {
        const claudeRequest = {
            model: geminiRequest.model || 'claude-3-opus',
            messages: [],
            max_tokens: checkAndAssignOrDefault(geminiRequest.generationConfig?.maxOutputTokens, CLAUDE_DEFAULT_MAX_TOKENS),
            temperature: checkAndAssignOrDefault(geminiRequest.generationConfig?.temperature, CLAUDE_DEFAULT_TEMPERATURE),
            top_p: checkAndAssignOrDefault(geminiRequest.generationConfig?.topP, CLAUDE_DEFAULT_TOP_P),
        };

        // 处理系统指令
        if (geminiRequest.systemInstruction && geminiRequest.systemInstruction.parts) {
            const systemText = geminiRequest.systemInstruction.parts
                .filter(p => p.text)
                .map(p => p.text)
                .join('\n');
            if (systemText) {
                claudeRequest.system = systemText;
            }
        }

        // 处理内容
        if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
            geminiRequest.contents.forEach(content => {
                if (!content || !content.parts) return;

                const role = content.role === 'model' ? 'assistant' : 'user';
                const claudeContent = this.processGeminiPartsToClaudeContent(content.parts);

                if (claudeContent.length > 0) {
                    claudeRequest.messages.push({
                        role: role,
                        content: claudeContent
                    });
                }
            });
        }

        // 处理工具
        if (geminiRequest.tools && geminiRequest.tools[0]?.functionDeclarations) {
            claudeRequest.tools = geminiRequest.tools[0].functionDeclarations.map(func => ({
                name: func.name,
                description: func.description || '',
                input_schema: func.parameters || { type: 'object', properties: {} }
            }));
        }

        return claudeRequest;
    }

    /**
     * Gemini响应 -> Claude响应
     */
    toClaudeResponse(geminiResponse, model) {
        if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
            return {
                id: `msg_${uuidv4()}`,
                type: "message",
                role: "assistant",
                content: [],
                model: model,
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: {
                    input_tokens: geminiResponse?.usageMetadata?.promptTokenCount || 0,
                    output_tokens: geminiResponse?.usageMetadata?.candidatesTokenCount || 0
                }
            };
        }

        const candidate = geminiResponse.candidates[0];
        const { content, hasToolUse } = this.processGeminiResponseToClaudeContent(geminiResponse);
        const finishReason = candidate.finishReason;
        let stopReason = "end_turn";

        // - 如果有工具调用，stop_reason 应该是 "tool_use"
        if (hasToolUse) {
            stopReason = 'tool_use';
        } else if (finishReason) {
            switch (finishReason) {
                case 'STOP':
                    stopReason = 'end_turn';
                    break;
                case 'MAX_TOKENS':
                    stopReason = 'max_tokens';
                    break;
                case 'SAFETY':
                    stopReason = 'safety';
                    break;
                case 'RECITATION':
                    stopReason = 'recitation';
                    break;
                case 'OTHER':
                    stopReason = 'other';
                    break;
                default:
                    stopReason = 'end_turn';
            }
        }

        return {
            id: `msg_${uuidv4()}`,
            type: "message",
            role: "assistant",
            content: content,
            model: model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: {
                input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: geminiResponse.usageMetadata?.cachedContentTokenCount || 0,
                output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0
            }
        };
    }

    /**
     * Gemini流式响应 -> Claude流式响应
     */
    toClaudeStreamChunk(geminiChunk, model) {
        if (!geminiChunk) return null;

        // 处理完整的Gemini chunk对象
        if (typeof geminiChunk === 'object' && !Array.isArray(geminiChunk)) {
            const candidate = geminiChunk.candidates?.[0];
            
            if (candidate) {
                const parts = candidate.content?.parts;
                
                // thinking 和 text 块
                if (parts && Array.isArray(parts)) {
                    const results = [];
                    let hasToolUse = false;
                    
                    for (const part of parts) {
                        if (!part) continue;
                        
                        if (typeof part.text === 'string') {
                            if (part.thought === true) {
                                // [FIX] 这是一个 thinking 块
                                const thinkingResult = {
                                    type: "content_block_delta",
                                    index: 0,
                                    delta: {
                                        type: "thinking_delta",
                                        thinking: part.text
                                    }
                                };
                                results.push(thinkingResult);
                                
                                // 如果有签名，发送 signature_delta
                                // [FIX] 同时检查 thoughtSignature 和 thought_signature
                                const rawSignature = part.thoughtSignature || part.thought_signature;
                                if (rawSignature) {
                                    let signature = rawSignature;
                                    try {
                                        const decoded = Buffer.from(signature, 'base64').toString('utf-8');
                                        if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                                            signature = decoded;
                                        }
                                    } catch (e) {
                                        // 解码失败，保持原样
                                    }
                                    results.push({
                                        type: "content_block_delta",
                                        index: 0,
                                        delta: {
                                            type: "signature_delta",
                                            signature: signature
                                        }
                                    });
                                }
                            } else {
                                // 普通文本
                                results.push({
                                    type: "content_block_delta",
                                    index: 0,
                                    delta: {
                                        type: "text_delta",
                                        text: part.text
                                    }
                                });
                            }
                        }
                        
                        // [FIX] 处理 functionCall
                        if (part.functionCall) {
                            hasToolUse = true;
                            // [FIX] 规范化工具名称和参数映射
                            const toolName = normalizeToolName(part.functionCall.name);
                            const remappedArgs = remapFunctionCallArgs(toolName, part.functionCall.args || {});
                            
                            // 发送 tool_use 开始
                            const toolId = part.functionCall.id || `${toolName}-${uuidv4().split('-')[0]}`;
                            results.push({
                                type: "content_block_start",
                                index: 0,
                                content_block: {
                                    type: "tool_use",
                                    id: toolId,
                                    name: toolName,
                                    input: {}
                                }
                            });
                            // 发送参数
                            results.push({
                                type: "content_block_delta",
                                index: 0,
                                delta: {
                                    type: "input_json_delta",
                                    partial_json: JSON.stringify(remappedArgs)
                                }
                            });
                        }
                    }
                    
                    // [FIX] 如果有工具调用，添加 message_delta 事件设置 stop_reason 为 tool_use
                    if (hasToolUse && candidate.finishReason) {
                        const messageDelta = {
                            type: "message_delta",
                            delta: {
                                stop_reason: 'tool_use'
                            }
                        };
                        if (geminiChunk.usageMetadata) {
                            messageDelta.usage = {
                                input_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                                cache_creation_input_tokens: 0,
                                cache_read_input_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0,
                                output_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0
                            };
                        }
                        results.push(messageDelta);
                    }
                    
                    // 如果有多个结果，返回数组；否则返回单个或 null
                    if (results.length > 1) {
                        return results;
                    } else if (results.length === 1) {
                        return results[0];
                    }
                }
                
                // 处理finishReason
                if (candidate.finishReason) {
                    const result = {
                        type: "message_delta",
                        delta: {
                            stop_reason: candidate.finishReason === 'STOP' ? 'end_turn' :
                                       candidate.finishReason === 'MAX_TOKENS' ? 'max_tokens' :
                                       candidate.finishReason.toLowerCase()
                        }
                    };
                    
                    // 添加 usage 信息
                    if (geminiChunk.usageMetadata) {
                        result.usage = {
                            input_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0,
                            output_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
                            prompt_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                            completion_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
                            total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0,
                            cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0
                        };
                    }
                    
                    return result;
                }
            }
        }

        // 向后兼容：处理字符串格式
        if (typeof geminiChunk === 'string') {
            return {
                type: "content_block_delta",
                index: 0,
                delta: {
                    type: "text_delta",
                    text: geminiChunk
                }
            };
        }

        return null;
    }

    /**
     * Gemini模型列表 -> Claude模型列表
     */
    toClaudeModelList(geminiModels) {
        return {
            models: geminiModels.models.map(m => ({
                name: m.name.startsWith('models/') ? m.name.substring(7) : m.name,
                description: "",
            })),
        };
    }

    /**
     * 处理Gemini parts到Claude内容
     */
    processGeminiPartsToClaudeContent(parts) {
        if (!parts || !Array.isArray(parts)) return [];

        const content = [];

        parts.forEach(part => {
            if (!part) return;

            // 处理 thinking 块
            // Gemini 使用 thought: true 和 thoughtSignature 表示思考内容
            // [FIX] 同时支持 thoughtSignature 和 thought_signature（Gemini CLI 可能使用下划线格式）
            if (part.text) {
                if (part.thought === true) {
                    // 这是一个 thinking 块
                    const thinkingBlock = {
                        type: 'thinking',
                        thinking: part.text
                    };
                    // 处理签名 - 可能是 Base64 编码的
                    // [FIX] 同时检查 thoughtSignature 和 thought_signature
                    const rawSignature = part.thoughtSignature || part.thought_signature;
                    if (rawSignature) {
                        let signature = rawSignature;
                        // 尝试 Base64 解码
                        try {
                            const decoded = Buffer.from(signature, 'base64').toString('utf-8');
                            // 检查解码后是否是有效的 UTF-8 字符串
                            if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                                signature = decoded;
                            }
                        } catch (e) {
                            // 解码失败，保持原样
                        }
                        thinkingBlock.signature = signature;
                    }
                    content.push(thinkingBlock);
                } else {
                    // 普通文本
                    content.push({
                        type: 'text',
                        text: part.text
                    });
                }
            }

            if (part.inlineData) {
                content.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: part.inlineData.mimeType,
                        data: part.inlineData.data
                    }
                });
            }

            if (part.functionCall) {
                // [FIX] 规范化工具名称和参数映射
                const toolName = normalizeToolName(part.functionCall.name);
                const remappedArgs = remapFunctionCallArgs(toolName, part.functionCall.args || {});
                
                // [FIX] 使用 Gemini 提供的 id，如果没有则生成
                const toolUseBlock = {
                    type: 'tool_use',
                    id: part.functionCall.id || `${toolName}-${uuidv4().split('-')[0]}`,
                    name: toolName,
                    input: remappedArgs
                };
                // [FIX] 如果有签名，添加到 tool_use 块
                // [FIX] 同时检查 thoughtSignature 和 thought_signature
                const rawSignature = part.thoughtSignature || part.thought_signature;
                if (rawSignature) {
                    let signature = rawSignature;
                    try {
                        const decoded = Buffer.from(signature, 'base64').toString('utf-8');
                        if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                            signature = decoded;
                        }
                    } catch (e) {
                        // 解码失败，保持原样
                    }
                    toolUseBlock.signature = signature;
                }
                content.push(toolUseBlock);
            }

            if (part.functionResponse) {
                // [FIX] 正确处理 functionResponse
                let responseContent = part.functionResponse.response;
                // 如果 response 是对象且有 result 字段，提取它
                if (responseContent && typeof responseContent === 'object' && responseContent.result !== undefined) {
                    responseContent = responseContent.result;
                }
                content.push({
                    type: 'tool_result',
                    // 优先使用 id（即原始 tool_use_id），回退到 name
                    tool_use_id: part.functionResponse.id || part.functionResponse.name,
                    content: typeof responseContent === 'string' ? responseContent : JSON.stringify(responseContent)
                });
            }
        });

        return content;
    }

    /**
     * 处理Gemini响应到Claude内容
     * @returns {{ content: Array, hasToolUse: boolean }}
     */
    processGeminiResponseToClaudeContent(geminiResponse) {
        if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
            return { content: [], hasToolUse: false };
        }

        const content = [];
        let hasToolUse = false;

        for (const candidate of geminiResponse.candidates) {
            if (candidate.finishReason && candidate.finishReason !== 'STOP') {
                if (candidate.finishMessage) {
                    content.push({
                        type: 'text',
                        text: `Error: ${candidate.finishMessage}`
                    });
                }
                continue;
            }

            if (candidate.content && candidate.content.parts) {
                for (const part of candidate.content.parts) {
                    // 处理 thinking 块
                    if (part.text) {
                        if (part.thought === true) {
                            // 这是一个 thinking 块
                            const thinkingBlock = {
                                type: 'thinking',
                                thinking: part.text
                            };
                            // 处理签名
                            // [FIX] 同时检查 thoughtSignature 和 thought_signature
                            const rawSignature = part.thoughtSignature || part.thought_signature;
                            if (rawSignature) {
                                let signature = rawSignature;
                                try {
                                    const decoded = Buffer.from(signature, 'base64').toString('utf-8');
                                    if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                                        signature = decoded;
                                    }
                                } catch (e) {
                                    // 解码失败，保持原样
                                }
                                thinkingBlock.signature = signature;
                            }
                            content.push(thinkingBlock);
                        } else {
                            // 普通文本
                            content.push({
                                type: 'text',
                                text: part.text
                            });
                        }
                    } else if (part.inlineData) {
                        content.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: part.inlineData.mimeType,
                                data: part.inlineData.data
                            }
                        });
                    } else if (part.functionCall) {
                        hasToolUse = true;
                        // [FIX] 规范化工具名称和参数映射
                        const toolName = normalizeToolName(part.functionCall.name);
                        const remappedArgs = remapFunctionCallArgs(toolName, part.functionCall.args || {});
                        
                        // [FIX] 使用 Gemini 提供的 id
                        const toolUseBlock = {
                            type: 'tool_use',
                            id: part.functionCall.id || `${toolName}-${uuidv4().split('-')[0]}`,
                            name: toolName,
                            input: remappedArgs
                        };
                        // 添加签名（如果存在）
                        // [FIX] 同时检查 thoughtSignature 和 thought_signature
                        const rawSignature = part.thoughtSignature || part.thought_signature;
                        if (rawSignature) {
                            let signature = rawSignature;
                            try {
                                const decoded = Buffer.from(signature, 'base64').toString('utf-8');
                                if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                                    signature = decoded;
                                }
                            } catch (e) {
                                // 解码失败，保持原样
                            }
                            toolUseBlock.signature = signature;
                        }
                        content.push(toolUseBlock);
                    }
                }
            }
        }

        return { content, hasToolUse };
    }

    // =========================================================================
    // Gemini -> OpenAI Responses 转换
    // =========================================================================

    /**
     * Gemini请求 -> OpenAI Responses请求
     */
    toOpenAIResponsesRequest(geminiRequest) {
        const responsesRequest = {
            model: geminiRequest.model,
            instructions: '',
            input: [],
            stream: geminiRequest.stream || false,
            max_output_tokens: geminiRequest.generationConfig?.maxOutputTokens,
            temperature: geminiRequest.generationConfig?.temperature,
            top_p: geminiRequest.generationConfig?.topP
        };

        // 处理系统指令
        if (geminiRequest.systemInstruction && geminiRequest.systemInstruction.parts) {
            responsesRequest.instructions = geminiRequest.systemInstruction.parts
                .filter(p => p.text)
                .map(p => p.text)
                .join('\n');
        }

        // 处理内容
        if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
            geminiRequest.contents.forEach(content => {
                const role = content.role === 'model' ? 'assistant' : 'user';
                const parts = content.parts || [];
                
                parts.forEach(part => {
                    if (part.text) {
                        responsesRequest.input.push({
                            type: 'message',
                            role: role,
                            content: [{
                                type: role === 'assistant' ? 'output_text' : 'input_text',
                                text: part.text
                            }]
                        });
                    }
                    
                    if (part.functionCall) {
                        responsesRequest.input.push({
                            type: 'function_call',
                            call_id: part.functionCall.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
                            name: part.functionCall.name,
                            arguments: typeof part.functionCall.args === 'string' 
                                ? part.functionCall.args 
                                : JSON.stringify(part.functionCall.args)
                        });
                    }
                    
                    if (part.functionResponse) {
                        responsesRequest.input.push({
                            type: 'function_call_output',
                            call_id: part.functionResponse.name, // Gemini 通常使用 name 作为关联
                            output: typeof part.functionResponse.response?.result === 'string'
                                ? part.functionResponse.response.result
                                : JSON.stringify(part.functionResponse.response || {})
                        });
                    }

                    if (part.inlineData) {
                        responsesRequest.input.push({
                            type: 'message',
                            role: role,
                            content: [{
                                type: 'input_image',
                                image_url: {
                                    url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                                }
                            }]
                        });
                    }
                });
            });
        }

        // 处理工具
        if (geminiRequest.tools && geminiRequest.tools[0]?.functionDeclarations) {
            responsesRequest.tools = geminiRequest.tools[0].functionDeclarations.map(fn => ({
                type: 'function',
                name: fn.name,
                description: fn.description,
                parameters: fn.parameters || fn.parametersJsonSchema || { type: 'object', properties: {} }
            }));
        }

        return responsesRequest;
    }

    /**
     * 构建稳定的 OpenAI Responses 消息项 ID
     */
    _buildResponsesMessageItemId(responseId, index = 0) {
        return responseId ? `msg_${responseId}_${index}` : `msg_${uuidv4().replace(/-/g, '')}`;
    }

    _buildResponsesFunctionItemId(callId) {
        return callId ? `fc_${callId}` : `fc_${uuidv4().replace(/-/g, '')}`;
    }

    _stringifyGeminiFunctionArgs(args) {
        return typeof args === 'string' ? args : JSON.stringify(args || {});
    }

    _getOpenAIResponsesStreamState(model, requestId) {
        const stateKey = requestId || 'default';
        if (!this.openAIResponsesStreamStates.has(stateKey)) {
            const responseId = `resp_${uuidv4().replace(/-/g, '')}`;
            this.openAIResponsesStreamStates.set(stateKey, {
                responseId,
                msgId: this._buildResponsesMessageItemId(responseId, 0),
                model: model || 'unknown',
                createdAt: Math.floor(Date.now() / 1000),
                started: false,
                textStarted: false,
                toolCalls: new Map()
            });
        }

        const state = this.openAIResponsesStreamStates.get(stateKey);
        if (model) {
            state.model = model;
        }

        const coreState = streamStateManager.getOrCreateState(stateKey);
        coreState.id = state.responseId;
        coreState.msgId = state.msgId;
        coreState.model = state.model;
        coreState.startTime = state.createdAt;
        if (!state.started) {
            coreState.fullText = '';
            coreState.toolCalls = [];
            coreState.currentToolCall = null;
            coreState.status = 'in_progress';
        }

        return { stateKey, state };
    }

    _ensureOpenAIResponsesStreamStarted(stateKey, state, events) {
        if (state.started) {
            return;
        }
        events.push(
            generateResponseCreated(stateKey, state.model),
            generateResponseInProgress(stateKey)
        );
        state.started = true;
    }

    _ensureOpenAIResponsesTextStarted(stateKey, state, events) {
        this._ensureOpenAIResponsesStreamStarted(stateKey, state, events);
        if (state.textStarted) {
            return;
        }
        events.push(
            generateOutputItemAdded(stateKey),
            generateContentPartAdded(stateKey)
        );
        state.textStarted = true;
    }

    _getGeminiResponsesToolState(state, part, index) {
        const callId = part.functionCall.id || `call_${state.responseId}_${index}`;
        const key = String(index);
        if (!state.toolCalls.has(key)) {
            state.toolCalls.set(key, {
                outputIndex: index,
                callId,
                itemId: this._buildResponsesFunctionItemId(callId),
                name: part.functionCall.name || '',
                arguments: this._stringifyGeminiFunctionArgs(part.functionCall.args),
                added: false,
                done: false
            });
        }
        const toolState = state.toolCalls.get(key);
        if (part.functionCall.id && toolState.callId !== part.functionCall.id) {
            toolState.callId = part.functionCall.id;
            toolState.itemId = this._buildResponsesFunctionItemId(part.functionCall.id);
        }
        if (part.functionCall.name) {
            toolState.name = part.functionCall.name;
        }
        toolState.arguments = this._stringifyGeminiFunctionArgs(part.functionCall.args);
        return toolState;
    }

    _emitGeminiResponsesTool(stateKey, state, toolState, events) {
        this._ensureOpenAIResponsesStreamStarted(stateKey, state, events);
        if (!toolState.added) {
            events.push({
                item: {
                    id: toolState.itemId,
                    call_id: toolState.callId,
                    type: "function_call",
                    name: toolState.name,
                    arguments: "",
                    status: "in_progress"
                },
                output_index: toolState.outputIndex,
                sequence_number: 2,
                type: "response.output_item.added"
            });
            toolState.added = true;
        }
        if (!toolState.done) {
            if (toolState.arguments) {
                events.push({
                    delta: toolState.arguments,
                    item_id: toolState.itemId,
                    output_index: toolState.outputIndex,
                    sequence_number: 3,
                    type: "response.function_call_arguments.delta"
                });
            }
            events.push({
                type: "response.function_call_arguments.done",
                item_id: toolState.itemId,
                output_index: toolState.outputIndex,
                arguments: toolState.arguments
            });
            events.push({
                type: "response.output_item.done",
                output_index: toolState.outputIndex,
                item: {
                    id: toolState.itemId,
                    call_id: toolState.callId,
                    type: "function_call",
                    name: toolState.name,
                    arguments: toolState.arguments,
                    status: "completed"
                }
            });
            toolState.done = true;
        }
    }

    toOpenAIResponsesResponse(geminiResponse, model) {
        const { content, reasoning_content } = this.processGeminiResponseContent(geminiResponse);
        const textContent = typeof content === 'string' ? content : JSON.stringify(content);

        let output = [];
        const responseId = `resp_${uuidv4().replace(/-/g, '')}`;
        const toolCalls = [];

        if (geminiResponse?.candidates) {
            for (const candidate of geminiResponse.candidates) {
                const parts = candidate.content?.parts || [];
                for (const part of parts) {
                    if (part.functionCall) {
                        const callId = part.functionCall.id || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
                        toolCalls.push({
                            id: this._buildResponsesFunctionItemId(callId),
                            call_id: callId,
                            type: "function_call",
                            name: part.functionCall.name,
                            arguments: this._stringifyGeminiFunctionArgs(part.functionCall.args),
                            status: "completed"
                        });
                    }
                }
            }
        }

        if (textContent || toolCalls.length === 0) {
            output.push({
                id: this._buildResponsesMessageItemId(responseId, 0),
                summary: [],
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{
                    annotations: [],
                    logprobs: [],
                    text: textContent,
                    type: "output_text"
                }]
            });
        }
        output.push(...toolCalls);

        const response = {
            background: false,
            created_at: Math.floor(Date.now() / 1000),
            error: null,
            id: responseId,
            incomplete_details: null,
            max_output_tokens: null,
            max_tool_calls: null,
            metadata: {},
            model: model,
            object: "response",
            output: output,
            parallel_tool_calls: true,
            previous_response_id: null,
            prompt_cache_key: null,
            reasoning: {},
            safety_identifier: "user-" + uuidv4().replace(/-/g, ''),
            service_tier: "default",
            status: "completed",
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
                input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
                input_tokens_details: {
                    cached_tokens: geminiResponse.usageMetadata?.cachedContentTokenCount || 0
                },
                output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
                output_tokens_details: {
                    reasoning_tokens: geminiResponse.usageMetadata?.thoughtsTokenCount || 0
                },
                total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0
            },
            user: null
        };

        if (reasoning_content) {
            response.reasoning_content = reasoning_content;
        }

        return response;
    }

    /**
     * Gemini流式响应 -> OpenAI Responses流式响应
     */
    toOpenAIResponsesStreamChunk(geminiChunk, model, requestId = null) {
        if (!geminiChunk) return [];

        const { stateKey, state } = this._getOpenAIResponsesStreamState(model, requestId);
        const events = [];

        // 处理完整的Gemini chunk对象
        if (typeof geminiChunk === 'object' && !Array.isArray(geminiChunk)) {
            const candidate = geminiChunk.candidates?.[0];
            
            if (candidate) {
                const parts = candidate.content?.parts;
                
                // 第一个chunk - 检测是否是开始（有role）
                if (candidate.content?.role === 'model' && parts && parts.length > 0) {
                    // 只在第一次有内容时发送开始事件
                    const hasContent = parts.some(part => part && typeof part.text === 'string' && part.text.length > 0);
                    if (hasContent) {
                        this._ensureOpenAIResponsesTextStarted(stateKey, state, events);
                    }
                }
                
                // 提取文本内容
                if (parts && Array.isArray(parts)) {
                    const textParts = parts.filter(part => part && typeof part.text === 'string' && part.thought !== true);
                    if (textParts.length > 0) {
                        const text = textParts.map(part => part.text).join('');
                        this._ensureOpenAIResponsesTextStarted(stateKey, state, events);
                        events.push(generateOutputTextDelta(stateKey, text));
                    }

                    // [FIX] 提取推理内容
                    const thoughtParts = parts.filter(part => part && typeof part.text === 'string' && part.thought === true);
                    if (thoughtParts.length > 0) {
                        const thoughtText = thoughtParts.map(part => part.text).join('');
                        this._ensureOpenAIResponsesStreamStarted(stateKey, state, events);
                        events.push({
                            type: 'response.reasoning_summary_text.delta',
                            response_id: state.responseId,
                            delta: thoughtText
                        });
                    }

                    const functionParts = parts.filter(part => part && part.functionCall);
                    functionParts.forEach((part, index) => {
                        const toolState = this._getGeminiResponsesToolState(state, part, index);
                        this._emitGeminiResponsesTool(stateKey, state, toolState, events);
                    });
                    if (functionParts.length > 0) {
                        const coreState = streamStateManager.getOrCreateState(stateKey);
                        coreState.toolCalls = Array.from(state.toolCalls.values()).map(toolState => ({
                            id: toolState.itemId,
                            call_id: toolState.callId,
                            name: toolState.name,
                            arguments: toolState.arguments || '{}'
                        }));
                    }
                }
                
                // 处理finishReason
                if (candidate.finishReason) {
                    this._ensureOpenAIResponsesStreamStarted(stateKey, state, events);
                    if (state.textStarted) {
                        events.push(
                            generateOutputTextDone(stateKey),
                            generateContentPartDone(stateKey),
                            generateOutputItemDone(stateKey)
                        );
                    }
                    const completedEvent = generateResponseCompleted(stateKey, {
                        input_tokens: geminiChunk.usageMetadata?.promptTokenCount || 0,
                        input_tokens_details: {
                            cached_tokens: geminiChunk.usageMetadata?.cachedContentTokenCount || 0
                        },
                        output_tokens: geminiChunk.usageMetadata?.candidatesTokenCount || 0,
                        output_tokens_details: {
                            reasoning_tokens: geminiChunk.usageMetadata?.thoughtsTokenCount || 0
                        },
                        total_tokens: geminiChunk.usageMetadata?.totalTokenCount || 0
                    });
                    events.push(completedEvent);
                    
                    // 如果有 usage 信息，更新最后一个事件
                    if (geminiChunk.usageMetadata && events.length > 0) {
                        const lastEvent = events[events.length - 1];
                        if (lastEvent.response) {
                            lastEvent.response.usage = {
                                input_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
                                input_tokens_details: {
                                    cached_tokens: geminiChunk.usageMetadata.cachedContentTokenCount || 0
                                },
                                output_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
                                output_tokens_details: {
                                    reasoning_tokens: geminiChunk.usageMetadata.thoughtsTokenCount || 0
                                },
                                total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0
                            };
                        }
                    }

                    streamStateManager.cleanup(stateKey);
                    this.openAIResponsesStreamStates.delete(stateKey);
                }
            }
        }

        // 向后兼容：处理字符串格式
        if (typeof geminiChunk === 'string') {
            this._ensureOpenAIResponsesTextStarted(stateKey, state, events);
            events.push(generateOutputTextDelta(stateKey, geminiChunk));
        }

        return events;
    }

    // =========================================================================
    // Gemini -> Codex 转换
    // =========================================================================

    /**
     * Gemini请求 -> Codex请求
     */
    toCodexRequest(geminiRequest) {
        // 使用 CodexConverter 进行转换，因为 CodexConverter.js 中已经实现了 OpenAI -> Codex 的逻辑
        // 我们需要先将 Gemini 转为 OpenAI 格式，再转为 Codex 格式
        const openaiRequest = this.toOpenAIRequest(geminiRequest);
        
        // 注意：这里我们直接在 GeminiConverter 中实现逻辑，避免循环依赖
        const codexRequest = {
            model: openaiRequest.model,
            instructions: '',
            input: [],
            stream: geminiRequest.stream || false,
            store: false,
            reasoning: {
                effort: 'medium',
                summary: 'auto'
            },
            parallel_tool_calls: true,
            include: ['reasoning.encrypted_content']
        };

        // 处理系统指令
        if (geminiRequest.systemInstruction && geminiRequest.systemInstruction.parts) {
            codexRequest.instructions = geminiRequest.systemInstruction.parts
                .filter(p => p.text)
                .map(p => p.text)
                .join('\n');
        }

        // 处理内容
        if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
            const pendingCallIDs = [];
            
            geminiRequest.contents.forEach(content => {
                const role = content.role === 'model' ? 'assistant' : 'user';
                const parts = content.parts || [];
                
                parts.forEach(part => {
                    // [FIX] 过滤 Gemini 3.1 Pro 的思考过程 (thought: true)
                    if (part.text && part.thought !== true) {
                        codexRequest.input.push({
                            type: 'message',
                            role: role,
                            content: [{
                                type: role === 'assistant' ? 'output_text' : 'input_text',
                                text: part.text
                            }]
                        });
                    }
                    
                    if (part.functionCall) {
                        const callId = `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
                        pendingCallIDs.push(callId);
                        codexRequest.input.push({
                            type: 'function_call',
                            call_id: callId,
                            name: part.functionCall.name,
                            arguments: typeof part.functionCall.args === 'string' 
                                ? part.functionCall.args 
                                : JSON.stringify(part.functionCall.args)
                        });
                    }
                    
                    if (part.functionResponse) {
                        const callId = pendingCallIDs.shift() || `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
                        codexRequest.input.push({
                            type: 'function_call_output',
                            call_id: callId,
                            output: typeof part.functionResponse.response?.result === 'string'
                                ? part.functionResponse.response.result
                                : JSON.stringify(part.functionResponse.response || {})
                        });
                    }
                });
            });
        }

        // 处理工具
        if (geminiRequest.tools && geminiRequest.tools[0]?.functionDeclarations) {
            codexRequest.tools = geminiRequest.tools[0].functionDeclarations.map(fn => ({
                type: 'function',
                name: fn.name,
                description: fn.description,
                parameters: fn.parameters || { type: 'object', properties: {} }
            }));
        }

        return codexRequest;
    }

    /**
     * Gemini请求 -> Grok请求
     */
    toGrokRequest(geminiRequest) {
        // 先转换为 OpenAI 格式
        const openaiRequest = this.toOpenAIRequest(geminiRequest);
        return {
            ...openaiRequest,
            _isConverted: true
        };
    }

    /**
     * Gemini响应 -> Codex响应 (实际上是 Codex 转 Gemini)
     */
    toCodexResponse(geminiResponse, model) {
        // 这里实际上是实现 Codex -> Gemini 的非流式转换
        // 为了保持接口一致，我们按照其他 Converter 的命名习惯
        const parts = [];
        if (geminiResponse.response?.output) {
            geminiResponse.response.output.forEach(item => {
                if (item.type === 'message' && item.content) {
                    const textPart = item.content.find(c => c.type === 'output_text');
                    if (textPart) parts.push({ text: textPart.text });
                } else if (item.type === 'reasoning' && item.summary) {
                    const textPart = item.summary.find(c => c.type === 'summary_text');
                    if (textPart) parts.push({ text: textPart.text, thought: true });
                } else if (item.type === 'function_call') {
                    parts.push({
                        functionCall: {
                            name: item.name,
                            args: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments
                        }
                    });
                }
            });
        }

        return {
            candidates: [{
                content: {
                    role: 'model',
                    parts: parts
                },
                finishReason: 'STOP'
            }],
            usageMetadata: {
                promptTokenCount: geminiResponse.response?.usage?.input_tokens || 0,
                candidatesTokenCount: geminiResponse.response?.usage?.output_tokens || 0,
                totalTokenCount: geminiResponse.response?.usage?.total_tokens || 0
            },
            modelVersion: model,
            responseId: geminiResponse.response?.id
        };
    }

    /**
     * Gemini流式响应 -> Codex流式响应 (实际上是 Codex 转 Gemini)
     */
    toCodexStreamChunk(codexChunk, model) {
        const type = codexChunk.type;
        const resId = codexChunk.response?.id || 'default';
        
        const template = {
            candidates: [{
                content: {
                    role: "model",
                    parts: []
                }
            }],
            modelVersion: model,
            responseId: resId
        };

        if (type === 'response.reasoning_summary_text.delta') {
            template.candidates[0].content.parts.push({ text: codexChunk.delta, thought: true });
            return template;
        }

        if (type === 'response.output_text.delta') {
            template.candidates[0].content.parts.push({ text: codexChunk.delta });
            return template;
        }

        if (type === 'response.output_item.done' && codexChunk.item?.type === 'function_call') {
            template.candidates[0].content.parts.push({
                functionCall: {
                    name: codexChunk.item.name,
                    args: typeof codexChunk.item.arguments === 'string' ? JSON.parse(codexChunk.item.arguments) : codexChunk.item.arguments
                }
            });
            return template;
        }

        if (type === 'response.completed') {
            template.candidates[0].finishReason = "STOP";
            template.usageMetadata = {
                promptTokenCount: codexChunk.response.usage?.input_tokens || 0,
                candidatesTokenCount: codexChunk.response.usage?.output_tokens || 0,
                totalTokenCount: codexChunk.response.usage?.total_tokens || 0
            };
            return template;
        }

        return null;
    }
}

export default GeminiConverter;
