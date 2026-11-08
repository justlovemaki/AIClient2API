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

    // The first input item remains unchanged in normal append-only conversations. Including
    // instructions and tools prevents unrelated prompts from sharing one global "default" key
    // while keeping the result stable across processes and model switches.
    const prefixSeed = {
        instructions: requestBody?.instructions || '',
        tools: Array.isArray(requestBody?.tools) ? requestBody.tools : [],
        input: Array.isArray(requestBody?.input) ? requestBody.input.slice(0, 1) : requestBody?.input || ''
    };
    const fingerprint = hashCacheSeed(prefixSeed).slice(0, 32);
    return {key: `aic2a-${fingerprint}`, source: 'prefix_fingerprint'};
}

/**
 * Preserve explicit null (used by image generation); only undefined means absent.
 * Model-specific defaults belong in the provider, after protocol conversion.
 */
export function resolveCodexReasoningEffort(requestBody, defaultEffort) {
    const effort = requestBody.reasoning_effort !== undefined
        ? requestBody.reasoning_effort
        : requestBody.reasoning?.effort;
    return effort === undefined ? defaultEffort : effort;
}

/** Match only the known upstream image-model parameter error, never generic refusals. */
export function isCodexImageComplexityMessage(message) {
    return typeof message === 'string'
        && /\bComplexity\s+['"][^'"]+['"]\s+is not supported for this image model\b/i.test(message);
}

/** A request-local workaround; callers must enforce a one-retry limit. */
export function getCodexImageEffortRetryBody(error, requestBody) {
    if (Number(error.response?.status) !== 400
        || error.imageGenerationAlreadySucceeded
        || error.imageRecoveryAttempted
        || typeof requestBody.reasoning?.effort !== 'string'
        || !Array.isArray(requestBody.tools)
        || !requestBody.tools.some(tool => tool?.type === 'image_generation')) {
        return null;
    }
    if (!isCodexImageComplexityMessage(error.message)
        && !isCodexImageComplexityMessage(error.response?.data?.error?.message)) {
        return null;
    }
    return {
        ...requestBody,
        reasoning: { ...requestBody.reasoning, effort: null }
    };
}

/** Only eligible for a request-local fallback, never a new default for ordinary chat. */
export function canRecoverCodexImageRequest(body) {
    return typeof body.reasoning?.effort === 'string'
        && Array.isArray(body.tools) && body.tools.some(tool => tool?.type === 'image_generation');
}

export function getCodexGeneratedImages(response) {
    return (Array.isArray(response?.output) ? response.output : []).filter(item => item?.type === 'image_generation_call'
        && typeof item.result === 'string' && item.result.trim());
}

/**
 * Observed in app-2026-11-08.log: completed response, unfinished image calls,
 * zero image usage, no result and no structured error. Never match apology text.
 */
export function isCodexIncompleteImageResponse(event, body) {
    const response = event?.response;
    if (!canRecoverCodexImageRequest(body) || event?.type !== 'response.completed'
        || response?.status !== 'completed' || response.error || response.background === true
        || response.tool_usage?.image_gen?.total_tokens !== 0 || !Array.isArray(response.output)) {
        return false;
    }
    const images = response.output.filter(item => item?.type === 'image_generation_call');
    return images.length > 0 && images.every(item => !item.result && !item.error
        && ['generating', 'in_progress'].includes(item.status));
}

function addUsageCounters(first, second) {
    first = first || {};
    second = second || {};
    const result = { ...first, ...second };
    for (const key of Object.keys(result)) {
        if (typeof first[key] === 'number' || typeof second[key] === 'number') {
            result[key] = (typeof first[key] === 'number' ? first[key] : 0)
                + (typeof second[key] === 'number' ? second[key] : 0);
        } else if (first[key] && second[key] && typeof first[key] === 'object' && typeof second[key] === 'object') {
            result[key] = addUsageCounters(first[key], second[key]);
        }
    }
    return result;
}

/** Retain the committed prefix; replace only the failed image segment and its apology. */
export function mergeCodexImageRecovery(original, recovered) {
    const response = original.response;
    const replacement = recovered.response;
    const firstImage = response.output.findIndex(item => item.type === 'image_generation_call');
    return {
        ...original,
        response: {
            ...response,
            completed_at: replacement.completed_at ?? response.completed_at,
            output: [...response.output.slice(0, firstImage), ...getCodexGeneratedImages(replacement)],
            usage: addUsageCounters(response.usage, replacement.usage),
            tool_usage: addUsageCounters(response.tool_usage, replacement.tool_usage)
        }
    };
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
