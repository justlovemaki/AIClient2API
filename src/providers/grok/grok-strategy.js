import logger from '../../utils/logger.js';
import { ProviderStrategy } from '../../utils/provider-strategy.js';
import { applySystemPromptReplacements } from '../../converters/utils.js';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/constants.js';
import { clearRequestSystemPrompts } from '../../utils/system-prompt-replacements.js';

/**
 * Grok provider strategy implementation.
 */
class GrokStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        // Grok protocol usually used internally, but if exposed:
        const model = requestBody.model || 'grok-3';
        const isStream = requestBody.stream !== false;
        return { model, isStream };
    }

    extractResponseText(response) {
        // From Grok response
        return response.message || '';
    }

    extractPromptText(requestBody) {
        // From converted Grok request
        return requestBody.message || '';
    }

    async applySystemPromptFromFile(config, requestBody) {
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent == null) {
            return requestBody;
        }

        const finalFilePrompt = applySystemPromptReplacements(filePromptContent, config.SYSTEM_PROMPT_REPLACEMENTS);
        const append = config.SYSTEM_PROMPT_MODE === 'append';
        if (Array.isArray(requestBody.messages) && (requestBody.messages.length > 0 || !requestBody.message)) {
            // Grok rebuilds `message` from `messages` when available.
            const fileMessage = { role: 'system', content: finalFilePrompt };
            if (append) {
                requestBody.messages.push(fileMessage);
            } else {
                clearRequestSystemPrompts(requestBody, MODEL_PROTOCOL_PREFIX.GROK);
                requestBody.messages.unshift(fileMessage);
            }
        } else {
            // A flat message has no role boundaries; don't guess which text to remove.
            const existingMessage = requestBody.message || '';
            requestBody.message = append
                ? `${existingMessage}\n\nSystem: ${finalFilePrompt}`
                : `System: ${finalFilePrompt}\n\n${existingMessage}`;
        }
        logger.info(`[System Prompt] Applied system prompt for Grok in '${config.SYSTEM_PROMPT_MODE}' mode.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        // Not implemented for Grok yet
    }
}

export { GrokStrategy };
