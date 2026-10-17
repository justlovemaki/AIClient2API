import crypto from 'node:crypto';
import logger from '../../utils/logger.js';

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

function firstUserText(requestBody) {
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    const userMessage = messages.find(message => message?.role === 'user');
    if (!userMessage) return null;

    if (typeof userMessage.content === 'string' && userMessage.content.trim()) {
        return userMessage.content.trim();
    }

    if (Array.isArray(userMessage.content)) {
        const textPart = userMessage.content.find(part => typeof part?.text === 'string' && part.text.trim());
        if (textPart) return textPart.text.trim();
    }

    return null;
}

function deriveSessionId(requestBody) {
    const text = firstUserText(requestBody);
    if (!text) return null;

    const digest = crypto.createHash('sha256').update(text).digest();
    const positiveValue = digest.readBigUInt64BE(0) & BigInt('0x7FFFFFFFFFFFFFFF');
    return `-${positiveValue.toString()}`;
}

function readMetadataSessionId(requestBody) {
    const metadata = requestBody?.metadata;
    if (!metadata || typeof metadata !== 'object') return null;

    if (typeof metadata.session_id === 'string' && metadata.session_id.trim()) {
        return metadata.session_id.trim();
    }

    if (typeof metadata.conversation_id === 'string' && metadata.conversation_id.trim()) {
        return metadata.conversation_id.trim();
    }

    if (typeof metadata.user_id === 'string' && metadata.user_id.trim()) {
        try {
            const parsed = JSON.parse(metadata.user_id);
            if (typeof parsed?.session_id === 'string' && parsed.session_id.trim()) {
                return parsed.session_id.trim();
            }
        } catch {
            return null;
        }
    }

    return null;
}

export function extractAntigravitySchedulerContext(req, requestBody) {
    const headers = req?.headers || {};
    let scheduler = headers['x-account-scheduler'];

    if (!scheduler && req?.url) {
        try {
            const host = headers.host || 'localhost';
            scheduler = new URL(req.url, `http://${host}`).searchParams.get('scheduler');
        } catch {
            scheduler = null;
        }
    }

    const isRoundRobin = String(scheduler || '').trim().toLowerCase() === 'round-robin';
    const headerSessionId = ['x-session-id', 'session-id', 'thread-id']
        .map(name => headers[name])
        .find(value => typeof value === 'string' && value.trim());
    const metadataSessionId = readMetadataSessionId(requestBody);
    const sessionId = headerSessionId?.trim() || metadataSessionId || deriveSessionId(requestBody);

    return {
        mode: isRoundRobin ? 'round-robin' : 'sticky',
        isRoundRobin,
        sessionId: sessionId || null
    };
}

export class AntigravitySessionAffinityManager {
    constructor(options = {}) {
        this.ttlMs = options.ttlMs || DEFAULT_SESSION_TTL_MS;
        this.bindings = new Map();
    }

    getBinding(sessionId) {
        if (!sessionId) return null;
        const entry = this.bindings.get(sessionId);
        if (!entry) return null;

        if (Date.now() - entry.lastSeen > this.ttlMs) {
            this.bindings.delete(sessionId);
            return null;
        }

        entry.lastSeen = Date.now();
        return entry.uuid;
    }

    bindSession(sessionId, uuid) {
        if (!sessionId || !uuid) return;
        const now = Date.now();
        this.bindings.set(sessionId, { uuid, boundAt: now, lastSeen: now });
        logger.info(`[Antigravity Sticky] Bound session '${sessionId}' to account ${uuid}`);
    }

    unbindSession(sessionId, reason = 'failover') {
        if (!sessionId) return;
        const entry = this.bindings.get(sessionId);
        if (!entry) return;
        this.bindings.delete(sessionId);
        logger.info(`[Antigravity Sticky] Unbound session '${sessionId}' from account ${entry.uuid}: ${reason}`);
    }
}

let manager;

export function getAntigravitySessionAffinityManager() {
    if (!manager) manager = new AntigravitySessionAffinityManager();
    return manager;
}

export function resetAntigravitySessionAffinityManager() {
    manager = null;
}