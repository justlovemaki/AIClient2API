import logger from '../utils/logger.js';
import { resolveCodexCacheIdentity } from './openai/codex-request-utils.js';
import { MODEL_PROVIDER } from '../utils/constants.js';

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour TTL for idle sessions

/**
 * Extracts session identifier and scheduler preference from request metadata and headers.
 * 
 * Supports:
 * - Direct HTTP headers: x-account-scheduler, x-session-id, x-copilot-session-id, session-id, thread-id
 * - Body fields: prompt_cache_key, metadata.session_id, metadata.conversation_id, metadata.thread_id, metadata.user_id, user
 * - Codex cache identity derivation as fallback
 * 
 * Default mode is 'sticky' unless explicitly requested as 'round-robin' (e.g. via x-account-scheduler: round-robin or ?scheduler=round-robin).
 */
export function extractSchedulerContext(req, requestBody, providerType) {
    const headers = req?.headers || {};
    
    // Check scheduler mode preference
    // Header takes priority over URL query parameter
    let schedulerMode = headers['x-account-scheduler'] || headers['account-scheduler'];
    if (!schedulerMode && req?.url) {
        try {
            const host = headers.host || 'localhost';
            const parsedUrl = new URL(req.url, `http://${host}`);
            schedulerMode = parsedUrl.searchParams.get('scheduler') || parsedUrl.searchParams.get('account-scheduler');
        } catch {
            // ignore URL parse errors
        }
    }

    const isRoundRobin = String(schedulerMode || '').trim().toLowerCase() === 'round-robin';

    // Extract session ID
    let sessionId = null;
    let sessionSource = null;

    // 1. Explicit session headers (Copilot, Codex, custom)
    const headerCandidates = [
        ['x-session-id', headers['x-session-id']],
        ['x-copilot-session-id', headers['x-copilot-session-id']],
        ['session-id', headers['session-id']],
        ['thread-id', headers['thread-id']],
        ['mcp-session-id', headers['mcp-session-id']]
    ];

    for (const [source, val] of headerCandidates) {
        if (typeof val === 'string' && val.trim()) {
            sessionId = val.trim();
            sessionSource = `header.${source}`;
            break;
        }
    }

    // 2. Request body metadata
    if (!sessionId && requestBody) {
        // Direct prompt_cache_key
        if (typeof requestBody.prompt_cache_key === 'string' && requestBody.prompt_cache_key.trim()) {
            sessionId = requestBody.prompt_cache_key.trim();
            sessionSource = 'body.prompt_cache_key';
        } else if (typeof requestBody.session_id === 'string' && requestBody.session_id.trim()) {
            sessionId = requestBody.session_id.trim();
            sessionSource = 'body.session_id';
        } else if (typeof requestBody.user === 'string' && requestBody.user.trim()) {
            sessionId = requestBody.user.trim();
            sessionSource = 'body.user';
        } else if (requestBody.metadata && typeof requestBody.metadata === 'object') {
            const meta = requestBody.metadata;
            if (typeof meta.session_id === 'string' && meta.session_id.trim()) {
                sessionId = meta.session_id.trim();
                sessionSource = 'body.metadata.session_id';
            } else if (typeof meta.conversation_id === 'string' && meta.conversation_id.trim()) {
                sessionId = meta.conversation_id.trim();
                sessionSource = 'body.metadata.conversation_id';
            } else if (typeof meta.thread_id === 'string' && meta.thread_id.trim()) {
                sessionId = meta.thread_id.trim();
                sessionSource = 'body.metadata.thread_id';
            } else if (typeof meta.user_id === 'string' && meta.user_id.trim()) {
                // If user_id is JSON-encoded (like Antigravity / Gemini CLI)
                try {
                    const parsed = JSON.parse(meta.user_id);
                    if (parsed?.session_id && typeof parsed.session_id === 'string' && parsed.session_id.trim()) {
                        sessionId = parsed.session_id.trim();
                        sessionSource = 'body.metadata.user_id.session_id';
                    }
                } catch {
                    sessionId = meta.user_id.trim();
                    sessionSource = 'body.metadata.user_id';
                }
            }
        }
    }

    // 3. Provider-specific deterministic fallback (e.g. for Codex)
    if (!sessionId && requestBody && providerType === MODEL_PROVIDER.CODEX_API) {
        const codexIdentity = resolveCodexCacheIdentity(requestBody, requestBody?.metadata);
        if (codexIdentity?.key) {
            sessionId = codexIdentity.key;
            sessionSource = `codex.${codexIdentity.source}`;
        }
    }

    return {
        mode: isRoundRobin ? 'round-robin' : 'sticky',
        isRoundRobin,
        sessionId: sessionId || null,
        sessionSource: sessionSource || null
    };
}

/**
 * Manages sticky session bindings between sessions and provider accounts.
 */
export class SessionAffinityManager {
    constructor(options = {}) {
        this.ttlMs = options.ttlMs || DEFAULT_SESSION_TTL_MS;
        // Key: `${providerType}:${sessionId}` => { uuid, lastSeen, boundAt }
        this.bindings = new Map();
        this.supportedProviders = new Set([MODEL_PROVIDER.CODEX_API]);
    }

    /**
     * Checks if a provider type is supported for sticky sessions.
     */
    supportsProvider(providerType) {
        return this.supportedProviders.has(providerType);
    }

    /**
     * Gets the bound account UUID for a session if still active and not expired.
     */
    getBinding(providerType, sessionId) {
        if (!providerType || !sessionId) return null;
        const key = `${providerType}:${sessionId}`;
        const entry = this.bindings.get(key);
        if (!entry) return null;

        const now = Date.now();
        if (now - entry.lastSeen > this.ttlMs) {
            this.bindings.delete(key);
            return null;
        }

        entry.lastSeen = now;
        return entry.uuid;
    }

    /**
     * Binds a session to a specific account UUID.
     */
    bindSession(providerType, sessionId, uuid) {
        if (!providerType || !sessionId || !uuid) return;
        const key = `${providerType}:${sessionId}`;
        const now = Date.now();
        this.bindings.set(key, {
            uuid,
            boundAt: now,
            lastSeen: now
        });
        logger.info(`[Sticky Session] Bound session '${sessionId}' to account ${uuid} (${providerType})`);
    }

    /**
     * Unbinds a session (e.g., when the account encounters 429, quota exhaustion, or fails).
     */
    unbindSession(providerType, sessionId, reason = 'failover') {
        if (!providerType || !sessionId) return;
        const key = `${providerType}:${sessionId}`;
        const existing = this.bindings.get(key);
        if (existing) {
            this.bindings.delete(key);
            logger.info(`[Sticky Session] Unbound session '${sessionId}' from account ${existing.uuid} (${providerType}) due to: ${reason}`);
        }
    }

    /**
     * Periodic cleanup of expired session bindings.
     */
    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.bindings.entries()) {
            if (now - entry.lastSeen > this.ttlMs) {
                this.bindings.delete(key);
            }
        }
    }
}

let globalSessionAffinityManager = null;

export function getSessionAffinityManager(options) {
    if (!globalSessionAffinityManager) {
        globalSessionAffinityManager = new SessionAffinityManager(options);
    }
    return globalSessionAffinityManager;
}

export function resetSessionAffinityManager() {
    globalSessionAffinityManager = null;
}
