import { API_ACTIONS, extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';
import logger from '../../utils/logger.js';
import { ProviderStrategy } from '../../utils/provider-strategy.js';

const GEMINI_RETRYABLE_FINISH_REASONS = Object.freeze({
    MALFORMED_FUNCTION_CALL: 'Gemini produced an invalid function call.',
    UNEXPECTED_TOOL_CALL: 'Gemini attempted an unexpected tool call.',
    MALFORMED_RESPONSE: 'Gemini produced a malformed response.',
    TOO_MANY_TOOL_CALLS: 'Gemini exceeded the tool call limit.',
    MISSING_THOUGHT_SIGNATURE: 'Gemini ended due to a missing thought signature.'
});

/**
 * Gemini provider strategy implementation.
 */
class GeminiStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const urlPattern = new RegExp(`/v1beta/models/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
        const urlMatch = requestUrl.pathname.match(urlPattern);
        const [, urlmodel, action] = urlMatch;
        const model = urlmodel;
        const isStream = action === API_ACTIONS.STREAM_GENERATE_CONTENT;
        return { model, isStream };
    }

    extractResponseText(response) {
        if (response.candidates && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                return candidate.content.parts.map(part => part.text).join('');
            }
        }
        return '';
    }

    classifyResponseFailure(response) {
        // Some Gemini transports wrap the protocol response in a `response` field.
        const candidates = response?.candidates || response?.response?.candidates;
        if (!Array.isArray(candidates)) return null;

        const candidate = candidates.find(item =>
            typeof item?.finishReason === 'string' &&
            Object.prototype.hasOwnProperty.call(GEMINI_RETRYABLE_FINISH_REASONS, item.finishReason)
        );
        if (!candidate) return null;

        return {
            code: candidate.finishReason,
            message: candidate.finishMessage || GEMINI_RETRYABLE_FINISH_REASONS[candidate.finishReason],
            retryable: true,
            retryCategory: 'empty_output',
            skipErrorCount: true,
            shouldSwitchCredential: true
        };
    }

    extractPromptText(requestBody) {
        if (requestBody.contents && requestBody.contents.length > 0) {
            const lastContent = requestBody.contents[requestBody.contents.length - 1];
            if (lastContent.parts && lastContent.parts.length > 0) {
                return lastContent.parts.map(part => part.text).join('');
            }
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

        const existingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.GEMINI);

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : filePromptContent;

        requestBody.systemInstruction = { parts: [{ text: newSystemText }] };
        delete requestBody.system_instruction;
        logger.info(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'gemini'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.GEMINI);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.GEMINI);
    }
}

export { GeminiStrategy };

