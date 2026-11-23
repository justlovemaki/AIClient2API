/**
 * 转换器公共工具函数模块
 * 提供各种协议转换所需的通用辅助函数
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';

// =============================================================================
// 常量定义
// =============================================================================

// 通用默认值
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TEMPERATURE = 1;
export const DEFAULT_TOP_P = 0.95;

// =============================================================================
// OpenAI 相关常量
// =============================================================================
export const OPENAI_DEFAULT_MAX_TOKENS = 128000;
export const OPENAI_DEFAULT_TEMPERATURE = 1;
export const OPENAI_DEFAULT_TOP_P = 0.95;
export const OPENAI_DEFAULT_INPUT_TOKEN_LIMIT = 32768;
export const OPENAI_DEFAULT_OUTPUT_TOKEN_LIMIT = 128000;

// =============================================================================
// Claude 相关常量
// =============================================================================
export const CLAUDE_DEFAULT_MAX_TOKENS = 200000;
export const CLAUDE_DEFAULT_TEMPERATURE = 1;
export const CLAUDE_DEFAULT_TOP_P = 0.95;

// =============================================================================
// Gemini 相关常量
// =============================================================================
export const GEMINI_DEFAULT_MAX_TOKENS = 65534;
export const GEMINI_DEFAULT_TEMPERATURE = 1;
export const GEMINI_DEFAULT_TOP_P = 0.95;
export const GEMINI_DEFAULT_INPUT_TOKEN_LIMIT = 32768;
export const GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT = 65534;

// =============================================================================
// OpenAI Responses 相关常量
// =============================================================================
export const OPENAI_RESPONSES_DEFAULT_MAX_TOKENS = 128000;
export const OPENAI_RESPONSES_DEFAULT_TEMPERATURE = 1;
export const OPENAI_RESPONSES_DEFAULT_TOP_P = 0.95;
export const OPENAI_RESPONSES_DEFAULT_INPUT_TOKEN_LIMIT = 32768;
export const OPENAI_RESPONSES_DEFAULT_OUTPUT_TOKEN_LIMIT = 128000;

// =============================================================================
// 通用辅助函数
// =============================================================================

/**
 * Vertex Claude 对历史 thinking 块的签名有最低长度要求：短于此值的串会被判为
 * "Invalid signature"，缺字段则是 "thinking.signature: Field required"。
 */
export const MIN_VALID_THOUGHT_SIGNATURE_LENGTH = 50;

/**
 * 判断一个 thinking 块的签名能否原样回传给上游。
 * 只接受字符串且长度达到下限；非字符串（对象、数字）与空串一律视为无效，
 * 避免 truthy 判断放行一个上游本来就会拒收的值。
 * @param {*} signature - 待检查的签名字段
 * @returns {boolean}
 */
export function hasUsableThinkingSignature(signature) {
    return typeof signature === 'string' && signature.length >= MIN_VALID_THOUGHT_SIGNATURE_LENGTH;
}

/**
 * 在 block.signature 与 block.thoughtSignature 之间取一个可用签名。
 * signature 优先；它无效时退回 thoughtSignature，两者都不合格则返回 null。
 * @param {object} block - 含 signature / thoughtSignature 字段的块
 * @returns {string|null}
 */
export function pickThinkingSignature(block) {
    if (hasUsableThinkingSignature(block?.signature)) return block.signature;
    if (hasUsableThinkingSignature(block?.thoughtSignature)) return block.thoughtSignature;
    return null;
}

/**
 * 把签名字段缩成一句可放进日志的描述，避免整串签名淹没日志。
 * @param {*} signature - 待描述的签名字段
 * @returns {string}
 */
export function describeSignature(signature) {
    if (signature === undefined || signature === null) return 'absent';
    if (typeof signature !== 'string') return `non-string(${typeof signature})`;
    if (signature.length === 0) return 'empty';
    return `len=${signature.length}`;
}

/**
 * 判断值是否为 undefined 或 0，并返回默认值
 * @param {*} value - 要检查的值
 * @param {*} defaultValue - 默认值
 * @returns {*} 处理后的值
 */
export function checkAndAssignOrDefault(value, defaultValue) {
    if (value !== undefined && value !== 0) {
        return value;
    }
    return defaultValue;
}

/**
 * 生成唯一ID
 * @param {string} prefix - ID前缀
 * @returns {string} 生成的ID
 */
export function generateId(prefix = '') {
    return prefix ? `${prefix}_${uuidv4()}` : uuidv4();
}

/**
 * 安全解析JSON字符串
 * @param {string} str - JSON字符串
 * @returns {*} 解析后的对象或原始字符串
 */
export function safeParseJSON(str) {
    if (!str) {
        return str;
    }
    let cleanedStr = str;

    // 处理可能被截断的转义序列
    if (cleanedStr.endsWith('\\') && !cleanedStr.endsWith('\\\\')) {
        cleanedStr = cleanedStr.substring(0, cleanedStr.length - 1);
    } else if (cleanedStr.endsWith('\\u') || cleanedStr.endsWith('\\u0') || cleanedStr.endsWith('\\u00')) {
        const idx = cleanedStr.lastIndexOf('\\u');
        cleanedStr = cleanedStr.substring(0, idx);
    }

    try {
        return JSON.parse(cleanedStr || '{}');
    } catch (e) {
        return str;
    }
}

/**
 * 提取消息内容中的文本
 * @param {string|Array} content - 消息内容
 * @returns {string} 提取的文本
 */
export function extractTextFromMessageContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

/**
 * 应用系统提示词内容替换
 * @param {string} content - 原始内容
 * @param {Array} replacements - 替换规则数组
 * @returns {string} 替换后的内容
 */
export function applySystemPromptReplacements(content, replacements = []) {
    if (!content || !replacements || !Array.isArray(replacements) || replacements.length === 0) {
        return content;
    }
    let newContent = content;
    for (const replacement of replacements) {
        if (replacement?.old !== undefined && replacement.new !== undefined) {
            if (typeof replacement.old === 'string' && replacement.old.length > 0) {
                // 简单字符串全量替换
                newContent = newContent.split(replacement.old).join(replacement.new);
            } else if (replacement.old instanceof RegExp || (typeof replacement.old === 'object' && replacement.old !== null)) {
                // 正则表达式替换
                newContent = newContent.replace(replacement.old, replacement.new);
            }
        }
    }
    return newContent;
}

/**
 * 提取并处理系统消息
 * @param {Array} messages - 消息数组
 * @param {Array} replacements - 替换规则数组，可选
 * @returns {{systemInstruction: Object|null, nonSystemMessages: Array}}
 */
export function extractAndProcessSystemMessages(messages, replacements = []) {
    const systemContents = [];
    const nonSystemMessages = [];

    for (const message of messages) {
        if (message.role === 'system' || message.role === 'developer') {
            let content = extractTextFromMessageContent(message.content);
            
            // 应用系统提示词内容替换
            content = applySystemPromptReplacements(content, replacements);
            
            systemContents.push(content);
        } else {
            nonSystemMessages.push(message);
        }
    }

    let systemInstruction = null;
    if (systemContents.length > 0) {
        systemInstruction = {
            parts: [{
                text: systemContents.join('\n')
            }]
        };
    }
    return { systemInstruction, nonSystemMessages };
}

// JSON Schema 清理配置常量
const GEMINI_ALLOWED_KEYS = [
    "type",
    "description",
    "properties",
    "required",
    "enum",
    "items",
    "nullable"
];

const OPENAI_EXCLUDED_KEYS = ['$schema'];

/**
 * 规范化 type 字段值
 * @param {string|Array} typeValue - type 字段的原始值
 * @param {Function} caseTransform - 大小写转换函数 (toUpperCase 或 toLowerCase)
 * @returns {string|undefined} 规范化后的 type 值
 */
function normalizeTypeField(typeValue, caseTransform) {
    if (Array.isArray(typeValue)) {
        const actualType = typeValue.find(t => t !== 'null');
        return actualType ? caseTransform(actualType) : undefined;
    }

    if (typeof typeValue === 'string') {
        return caseTransform(typeValue);
    }

    return undefined;
}

/**
 * 递归清理 properties 对象
 * @param {Object} properties - properties 对象
 * @param {Function} cleanFn - 清理函数
 * @returns {Object} 清理后的 properties
 */
function cleanPropertiesRecursively(properties, cleanFn) {
    const cleaned = {};
    for (const [propName, propSchema] of Object.entries(properties)) {
        cleaned[propName] = cleanFn(propSchema);
    }
    return cleaned;
}

/**
 * 处理 type 字段（Gemini 格式）
 * @param {Object} sanitized - 目标对象
 * @param {string|Array} typeValue - type 字段值
 */
function handleGeminiTypeField(sanitized, typeValue) {
    if (Array.isArray(typeValue) && typeValue.includes('null')) {
        sanitized.nullable = true;
    }

    const normalizedType = normalizeTypeField(typeValue, t => t.toUpperCase());
    if (normalizedType) {
        sanitized.type = normalizedType;
    }
}

/**
 * 处理 type 字段（OpenAI 格式）
 * @param {Object} sanitized - 目标对象
 * @param {string|Array} typeValue - type 字段值
 */
function handleOpenAITypeField(sanitized, typeValue) {
    if (Array.isArray(typeValue)) {
        sanitized.type = typeValue.map(t => t.toLowerCase());
    } else if (typeof typeValue === 'string') {
        sanitized.type = typeValue.toLowerCase();
    }
}

/**
 * 通用 JSON Schema 清理函数
 * @param {Object} schema - JSON Schema
 * @param {Object} options - 清理选项
 * @param {Array} options.allowedKeys - 允许的键白名单（可选）
 * @param {Array} options.excludedKeys - 排除的键黑名单（可选）
 * @param {Function} options.typeHandler - type 字段处理函数
 * @param {Function} recursiveFn - 递归调用的函数
 * @returns {Object} 清理后的 JSON Schema
 */
function cleanJsonSchemaGeneric(schema, options, recursiveFn) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => recursiveFn(item));
    }

    const { allowedKeys, excludedKeys, typeHandler } = options;
    const sanitized = {};

    for (const [key, value] of Object.entries(schema)) {
        // 应用黑名单过滤
        if (excludedKeys && excludedKeys.includes(key)) {
            continue;
        }

        // 应用白名单过滤
        if (allowedKeys && !allowedKeys.includes(key)) {
            continue;
        }

        // 处理 enum：Gemini 要求枚举元素为字符串（仅 sanitizeEnum 模式）
        if (key === 'enum' && options.sanitizeEnum) {
            if (Array.isArray(value)) {
                const strEnum = value.filter(v => typeof v === 'string');
                if (strEnum.length > 0) {
                    sanitized[key] = strEnum;
                }
            }
            continue;
        }

        // 处理 properties
        if (key === 'properties' && typeof value === 'object' && value !== null) {
            sanitized[key] = cleanPropertiesRecursively(value, recursiveFn);
            continue;
        }

        // 处理 items
        if (key === 'items') {
            sanitized[key] = recursiveFn(value);
            continue;
        }

        // 处理 type
        if (key === 'type') {
            typeHandler(sanitized, value);
            continue;
        }

        // 其他属性直接复制
        sanitized[key] = value;
    }

    return sanitized;
}

/**
 * 清理JSON Schema属性（移除Gemini不支持的属性）
 * Google Gemini API 只支持有限的 JSON Schema 属性，不支持以下属性：
 * - exclusiveMinimum, exclusiveMaximum, minimum, maximum
 * - minLength, maxLength, minItems, maxItems
 * - pattern, format, default, const
 * - additionalProperties, $schema, $ref, $id
 * - allOf, anyOf, oneOf, not
 * @param {Object} schema - JSON Schema
 * @returns {Object} 清理后的JSON Schema
 */
export function cleanJsonSchemaProperties(schema) {
    return cleanJsonSchemaGeneric(
        schema,
        {
            allowedKeys: GEMINI_ALLOWED_KEYS,
            typeHandler: handleGeminiTypeField,
            sanitizeEnum: true
        },
        cleanJsonSchemaProperties
    );
}

/**
 * 清理JSON Schema属性（用于OpenAI格式）
 * OpenAI API 要求标准的 JSON Schema 格式，type 字段必须是小写
 * 移除不必要的属性：$schema, additionalProperties 等
 * @param {Object} schema - JSON Schema
 * @returns {Object} 清理后的JSON Schema
 */
export function cleanJsonSchemaForOpenAI(schema) {
    return cleanJsonSchemaGeneric(
        schema,
        {
            excludedKeys: OPENAI_EXCLUDED_KEYS,
            typeHandler: handleOpenAITypeField
        },
        cleanJsonSchemaForOpenAI
    );
}

/**
 * 映射结束原因
 * @param {string} reason - 结束原因
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @returns {string} 映射后的结束原因
 */
export function mapFinishReason(reason, sourceFormat, targetFormat) {
    const reasonMappings = {
        openai: {
            anthropic: {
                stop: "end_turn",
                length: "max_tokens",
                content_filter: "stop_sequence",
                tool_calls: "tool_use"
            }
        },
        gemini: {
            anthropic: {
                STOP: "end_turn",
                MAX_TOKENS: "max_tokens",
                SAFETY: "stop_sequence",
                RECITATION: "stop_sequence",
                stop: "end_turn",
                length: "max_tokens",
                safety: "stop_sequence",
                recitation: "stop_sequence",
                other: "end_turn"
            }
        }
    };

    try {
        return reasonMappings[sourceFormat][targetFormat][reason] || "end_turn";
    } catch (e) {
        return "end_turn";
    }
}

/**
 * 根据budget_tokens智能判断OpenAI reasoning_effort等级
 * @param {number|null} budgetTokens - Anthropic thinking的budget_tokens值
 * @returns {string} OpenAI reasoning_effort等级
 */
export function determineReasoningEffortFromBudget(budgetTokens) {
    if (budgetTokens === null || budgetTokens === undefined) {
        logger.info("No budget_tokens provided, defaulting to reasoning_effort='high'");
        return "high";
    }

    const LOW_THRESHOLD = 50;
    const HIGH_THRESHOLD = 200;

    logger.debug(`Threshold configuration: low <= ${LOW_THRESHOLD}, medium <= ${HIGH_THRESHOLD}, high > ${HIGH_THRESHOLD}`);

    let effort;
    if (budgetTokens <= LOW_THRESHOLD) {
        effort = "low";
    } else if (budgetTokens <= HIGH_THRESHOLD) {
        effort = "medium";
    } else {
        effort = "high";
    }

    logger.info(`🎯 Budget tokens ${budgetTokens} -> reasoning_effort '${effort}' (thresholds: low<=${LOW_THRESHOLD}, high<=${HIGH_THRESHOLD})`);
    return effort;
}

/**
 * 从OpenAI文本中提取thinking内容
 * @param {string} text - 文本内容
 * @returns {string|Array} 提取后的内容
 */
export function extractThinkingFromOpenAIText(text) {
    const thinkingPattern = /<thinking>\s*(.*?)\s*<\/thinking>/gs;
    const matches = [...text.matchAll(thinkingPattern)];

    const contentBlocks = [];
    let lastEnd = 0;

    for (const match of matches) {
        const beforeText = text.substring(lastEnd, match.index).trim();
        if (beforeText) {
            contentBlocks.push({
                type: "text",
                text: beforeText
            });
        }

        const thinkingText = match[1].trim();
        if (thinkingText) {
            contentBlocks.push({
                type: "thinking",
                thinking: thinkingText
            });
        }

        lastEnd = match.index + match[0].length;
    }

    const afterText = text.substring(lastEnd).trim();
    if (afterText) {
        contentBlocks.push({
            type: "text",
            text: afterText
        });
    }

    if (contentBlocks.length === 0) {
        return text;
    }

    if (contentBlocks.length === 1 && contentBlocks[0].type === "text") {
        return contentBlocks[0].text;
    }

    return contentBlocks;
}

// =============================================================================
// 工具状态管理器（单例模式）
// =============================================================================

/**
 * 全局工具状态管理器
 */
class ToolStateManager {
    constructor() {
        if (ToolStateManager.instance) {
            return ToolStateManager.instance;
        }
        ToolStateManager.instance = this;
        this._toolMappings = {};
        return this;
    }

    storeToolMapping(funcName, toolId) {
        this._toolMappings[funcName] = toolId;
    }

    getToolId(funcName) {
        return this._toolMappings[funcName] || null;
    }

    clearMappings() {
        this._toolMappings = {};
    }
}

export const toolStateManager = new ToolStateManager();