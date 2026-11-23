import { ProviderStrategy } from '../../utils/provider-strategy.js';
import logger from '../../utils/logger.js';
import { clearRequestSystemPrompts } from '../../utils/system-prompt-replacements.js';
import { extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';

/**
 * OpenAI provider strategy implementation.
 */
class OpenAIStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        const model = requestBody.model;
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    extractResponseText(response) {
        if (!response.choices) {
            return '';
        }
        if (response.choices && response.choices.length > 0) {
            const choice = response.choices[0];
            if (choice.message && choice.message.content) {
                return choice.message.content;
            } else if (choice.delta && choice.delta.content) {
                return choice.delta.content;
            } else if (choice.delta && choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
                return choice.delta.tool_calls;
            }
        }
        return '';
    }

    extractPromptText(requestBody) {
        if (requestBody.messages && requestBody.messages.length > 0) {
            const lastMessage = requestBody.messages[requestBody.messages.length - 1];
            let content = lastMessage.content;
            if (typeof content === 'object' && content !== null) {
                if (Array.isArray(content)) {
                    return content.map(item => item.text).join('\n');
                } else {
                    return JSON.stringify(content);
                }
            }
            return content;
        }
        return '';
    }

    async applySystemPromptFromFile(config, requestBody) {
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent == null) {
            return requestBody;
        }

        if (config.SYSTEM_PROMPT_MODE === 'overwrite') {
            clearRequestSystemPrompts(requestBody, MODEL_PROTOCOL_PREFIX.OPENAI);
            requestBody.messages ??= [];
            requestBody.messages.unshift({ role: 'system', content: filePromptContent });
            logger.info(`[System Prompt] Overwrote system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} for provider 'openai'.`);
            return requestBody;
        }

        const existingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.OPENAI);

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : filePromptContent;

        if (!requestBody.messages) {
            requestBody.messages = [];
        }
        const systemMessageIndex = requestBody.messages.findIndex(m => m.role === 'system' || m.role === 'developer');
        if (systemMessageIndex !== -1) {
            requestBody.messages[systemMessageIndex].content = newSystemText;
        } else {
            requestBody.messages.unshift({ role: 'system', content: newSystemText });
        }
        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'openai'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        //logger.info('[System Prompt] Managing system prompt for provider "openai".', requestBody);
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.OPENAI);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.OPENAI);
    }
}

export { OpenAIStrategy };

