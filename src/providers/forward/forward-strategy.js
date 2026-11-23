import { ProviderStrategy } from '../../utils/provider-strategy.js';
import logger from '../../utils/logger.js';
import { extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';

/**
 * Forward provider strategy implementation.
 * Designed to be as transparent as possible.
 */
class ForwardStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        const model = requestBody.model || 'default';
        const isStream = requestBody.stream === true;
        return { model, isStream };
    }

    extractResponseText(response) {
        // Attempt to extract text using common patterns (OpenAI, Claude, etc.)
        if (response.choices && response.choices.length > 0) {
            const choice = response.choices[0];
            if (choice.message && choice.message.content) {
                return choice.message.content;
            } else if (choice.delta && choice.delta.content) {
                return choice.delta.content;
            }
        }
        if (response.content && Array.isArray(response.content)) {
            return response.content.map(c => c.text || '').join('');
        }
        return '';
    }

    extractPromptText(requestBody) {
        if (requestBody.messages && requestBody.messages.length > 0) {
            const lastMessage = requestBody.messages[requestBody.messages.length - 1];
            let content = lastMessage.content;
            if (typeof content === 'object' && content !== null) {
                return JSON.stringify(content);
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
        if (filePromptContent === null) {
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
        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'forward'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        // No-op for transparency
    }
}

export { ForwardStrategy };

