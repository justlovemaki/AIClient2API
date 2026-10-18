import crypto from 'node:crypto';
import logger from '../../utils/logger.js';

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_QUOTA_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_QUOTA_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_QUOTA_RESET_FLOOR_SECONDS = 600;

function readQuotaWindows(usage) {
    const buckets = [];
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        const remaining = value.remainingFraction ?? value.remaining_fraction ?? value.remaining;
        const resetAt = value.resetAt ?? value.reset_at ?? value.resetTime;
        if (typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 1) {
            buckets.push({ remaining, resetAt });
        }
        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') visit(child);
        }
    };
    visit(usage);
    return buckets;
}

function quotaScore(snapshot, now = Date.now()) {
    const usable = snapshot?.windows?.filter(window => window.remaining > 0) || [];
    if (usable.length === 0) return null;
    return Math.max(...usable.map(window => {
        const resetAt = Date.parse(window.resetAt || '');
        const seconds = Number.isFinite(resetAt)
            ? Math.max(DEFAULT_QUOTA_RESET_FLOOR_SECONDS, (resetAt - now) / 1000)
            : DEFAULT_QUOTA_RESET_FLOOR_SECONDS;
        return window.remaining / seconds;
    }));
}

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
        this.quotaRefreshIntervalMs = options.quotaRefreshIntervalMs || DEFAULT_QUOTA_REFRESH_INTERVAL_MS;
        this.quotaIdleTimeoutMs = options.quotaIdleTimeoutMs || DEFAULT_QUOTA_IDLE_TIMEOUT_MS;
        this.bindings = new Map();
        this.quotaSnapshots = new Map();
        this.refreshing = new Set();
        this.lastRequestAt = 0;
    }

    noteRequest() {
        this.lastRequestAt = Date.now();
    }

    updateQuota(uuid, usage) {
        if (!uuid) return;
        this.quotaSnapshots.set(uuid, {
            windows: readQuotaWindows(usage),
            refreshedAt: Date.now()
        });
    }

    getQuotaScore(uuid, now = Date.now()) {
        const snapshot = this.quotaSnapshots.get(uuid);
        if (!snapshot) return null;
        return quotaScore(snapshot, now);
    }

    shouldRefresh(uuid, now = Date.now()) {
        const snapshot = this.quotaSnapshots.get(uuid);
        if (this.lastRequestAt && now - this.lastRequestAt > this.quotaIdleTimeoutMs) return false;
        return !snapshot || now - snapshot.refreshedAt >= this.quotaRefreshIntervalMs;
    }

    markRefreshing(uuid, value) {
        if (value) this.refreshing.add(uuid);
        else this.refreshing.delete(uuid);
    }

    async refreshQuota(uuid, fetchQuota) {
        if (!uuid || typeof fetchQuota !== 'function' || this.refreshing.has(uuid) || !this.shouldRefresh(uuid)) {
            return false;
        }

        this.markRefreshing(uuid, true);
        try {
            this.updateQuota(uuid, await fetchQuota());
            return true;
        } catch (error) {
            logger.debug(`[Antigravity Sticky] Quota refresh failed for ${uuid}: ${error.message}`);
            return false;
        } finally {
            this.markRefreshing(uuid, false);
        }
    }

    rankInitialProviders(providers, now = Date.now()) {
        return [...providers].sort((left, right) => {
            const leftScore = this.getQuotaScore(left.config.uuid, now);
            const rightScore = this.getQuotaScore(right.config.uuid, now);
            if (leftScore !== null && rightScore === null) return -1;
            if (leftScore === null && rightScore !== null) return 1;
            if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
                return rightScore - leftScore;
            }
            return 0;
        });
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