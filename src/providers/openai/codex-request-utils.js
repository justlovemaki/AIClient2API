import crypto from 'crypto';

function asNonEmptyString(value) {
    if (typeof value === 'string' && value.trim()) {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    return null;
}

function hashCacheSeed(value) {
    const serialized = JSON.stringify(value) ?? '';
    return crypto.createHash('sha256').update(serialized).digest('hex');
}

function getMessagesPrefix(messages) {
    if (!Array.isArray(messages)) return [];

    const firstUserIndex = messages.findIndex(message => message?.role === 'user');
    return messages.slice(0, firstUserIndex >= 0 ? firstUserIndex + 1 : 1);
}

/**
 * Resolve one stable cache identity for the Codex request body and session headers.
 *
 * A client-supplied prompt_cache_key is authoritative. Replacing it with a proxy-local
 * UUID breaks cache locality for long-running sessions and after proxy restarts. When a
 * client does not supply one, prefer its session metadata; the deterministic prefix
 * fingerprint is only a last-resort fallback for append-only clients.
 */
export function resolveCodexCacheIdentity(requestBody, metadata = {}) {
    const explicitKey = asNonEmptyString(requestBody?.prompt_cache_key);
    if (explicitKey) {
        return {key: explicitKey, source: 'prompt_cache_key'};
    }

    const metadataFields = ['session_id', 'conversation_id', 'thread_id', 'user_id'];
    for (const field of metadataFields) {
        const value = asNonEmptyString(metadata?.[field]);
        if (value) {
            return {key: value, source: `metadata.${field}`};
        }
    }

    // The first input/message prefix remains unchanged in normal append-only conversations.
    // Include both protocols because the scheduler sees the raw request before conversion.
    const prefixSeed = {
        instructions: requestBody?.instructions || '',
        tools: Array.isArray(requestBody?.tools) ? requestBody.tools : [],
        input: Array.isArray(requestBody?.input) ? requestBody.input.slice(0, 1) : requestBody?.input || '',
        messages: getMessagesPrefix(requestBody?.messages)
    };
    const fingerprint = hashCacheSeed(prefixSeed).slice(0, 32);
    return {key: `aic2a-${fingerprint}`, source: 'prefix_fingerprint'};
}

export function normalizeCodexInstructions(requestBody) {
    if (!Array.isArray(requestBody.input)) {
        return requestBody;
    }

    const instructionTexts = [];
    requestBody.input = requestBody.input.filter(item => {
        const isMessage = !item?.type || item.type === 'message';
        const isInstructionRole = item?.role === 'system' || item?.role === 'developer';
        if (!isMessage || !isInstructionRole) {
            return true;
        }

        const content = item.content;
        if (typeof content === 'string') {
            instructionTexts.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content) {
                const text = typeof part === 'string' ? part : part?.text;
                if (text) instructionTexts.push(text);
            }
        }
        return false;
    });

    if (instructionTexts.length > 0) {
        const incomingInstructions = instructionTexts.join('\n');
        if (!requestBody.instructions) {
            requestBody.instructions = incomingInstructions;
        } else if (requestBody.instructions !== incomingInstructions) {
            requestBody.instructions = `${requestBody.instructions}\n${incomingInstructions}`;
        }
    }

    return requestBody;
}
