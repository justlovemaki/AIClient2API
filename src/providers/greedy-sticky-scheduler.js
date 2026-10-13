const WEEK_FLOOR_SECONDS = 600;
const STALE_AFTER_MS = 20 * 60 * 1000;
const MAX_IN_FLIGHT = 3;
const SAME_SESSION_QUEUE_MS = 120000;
const TOKEN_REFRESH_WAIT_MS = 30000;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const IDLE_STOP_MS = 15 * 60 * 1000;

export function weeklyGreed(remainingFraction, resetAt, now = Date.now()) {
    if (!isFraction(remainingFraction)) return null;
    const resetMs = Date.parse(resetAt);
    if (!Number.isFinite(resetMs)) return null;
    const seconds = Math.max((resetMs - now) / 1000, WEEK_FLOOR_SECONDS);
    return remainingFraction / seconds;
}

export function extractQuotaWindows(usage) {
    const windows = {};
    const groups = Array.isArray(usage?.groups) ? usage.groups : [];
    for (const group of groups) {
        const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
        for (const bucket of buckets) {
            const bucketId = typeof bucket?.bucketId === 'string' ? bucket.bucketId : '';
            if (!bucketId.startsWith('gemini-')) continue;
            const remaining = Number(bucket.remainingFraction);
            const resetAt = typeof bucket.resetTime === 'string' ? bucket.resetTime : '';
            if (!Number.isFinite(remaining) || !Number.isFinite(Date.parse(resetAt))) continue;
            const window = { remainingFraction: Math.min(1, Math.max(0, remaining)), resetAt };
            if (bucketId.includes('5h')) windows.fiveHour = window;
            else if (bucketId.includes('weekly')) windows.weekly = window;
        }
    }
    return {
        weekly: windows.weekly || null,
        fiveHour: windows.fiveHour || null
    };
}

export function extractSessionId(requestBody) {
    const raw = requestBody?.metadata?.user_id;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw);
        const sessionId = typeof parsed?.session_id === 'string' ? parsed.session_id.trim() : '';
        return sessionId || null;
    } catch {
        return null;
    }
}

export function accountQuotaState(account, now = Date.now()) {
    const weekly = quotaWindowState(account?.weekly, now);
    const fiveHour = quotaWindowState(account?.fiveHour, now);
    if (weekly === 'unknown' || fiveHour === 'unknown') return 'unknown';
    if (weekly === 'exhausted' || fiveHour === 'exhausted') return 'exhausted';
    return 'known';
}

export function quotaWindowState(window, now = Date.now()) {
    if (!window || !isFraction(window.remainingFraction) || !Number.isFinite(Date.parse(window.resetAt || ''))) {
        return 'unknown';
    }
    if (window.remainingFraction > 0) return 'available';
    return Date.parse(window.resetAt) <= now ? 'reset-due' : 'exhausted';
}

export function compareAccounts(left, right, now = Date.now()) {
    const leftRank = freshnessRank(left, now);
    const rightRank = freshnessRank(right, now);
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftScore = weeklyGreed(left.weekly?.remainingFraction, left.weekly?.resetAt, now) || 0;
    const rightScore = weeklyGreed(right.weekly?.remainingFraction, right.weekly?.resetAt, now) || 0;
    if (leftScore !== rightScore) return rightScore - leftScore;
    const leftHour = isFraction(left.fiveHour?.remainingFraction) ? left.fiveHour.remainingFraction : -1;
    const rightHour = isFraction(right.fiveHour?.remainingFraction) ? right.fiveHour.remainingFraction : -1;
    if (leftHour !== rightHour) return rightHour - leftHour;
    return String(left.uuid).localeCompare(String(right.uuid));
}

export class GreedyStickyScheduler {
    constructor({
        limit = MAX_IN_FLIGHT,
        now = () => Date.now(),
        queueTimeoutMs = SAME_SESSION_QUEUE_MS,
        refreshWaitMs = TOKEN_REFRESH_WAIT_MS
    } = {}) {
        this.limit = limit;
        this.now = now;
        this.queueTimeoutMs = queueTimeoutMs;
        this.refreshWaitMs = refreshWaitMs;
        this.sessions = new Map();
        this.inFlight = new Map();
        this.queues = new Map();
        this.signals = new Map();
        this.accounts = new Map();
        this.refreshing = new Set();
        this.unhealthy = new Set();
        this.lastUserRequestAt = 0;
        this.lastRefreshAt = new Map();
    }

    noteUserRequest() {
        this.lastUserRequestAt = this.now();
    }

    shouldRefresh(uuid, { startup = false } = {}) {
        if (!startup && this.now() - this.lastUserRequestAt > IDLE_STOP_MS) return false;
        const last = this.lastRefreshAt.get(uuid) || 0;
        return this.now() - last >= REFRESH_INTERVAL_MS;
    }

    markRefreshed(uuid) {
        this.lastRefreshAt.set(uuid, this.now());
    }

    updateAccount(uuid, quota) {
        this.accounts.set(uuid, { ...quota, uuid, updatedAt: this.now() });
    }

    markUnhealthy(uuid) {
        this.unhealthy.add(uuid);
        this.forgetSessionsFor(uuid);
    }

    markHealthy(uuid) {
        this.unhealthy.delete(uuid);
    }

    setRefreshing(uuid, refreshing) {
        if (refreshing) this.refreshing.add(uuid);
        else this.refreshing.delete(uuid);
    }

    async acquire({ uuid, sessionId, accounts }) {
        for (const account of accounts || []) this.updateAccount(account.uuid, account);
        const started = this.now();
        let sticky = uuid || (sessionId ? this.sessions.get(sessionId) : null) || null;
        while (this.now() - started <= this.queueTimeoutMs) {
            if (sticky && this.blocked(sticky)) {
                if (sessionId && this.sessions.get(sessionId) === sticky) this.sessions.delete(sessionId);
                sticky = null;
            }
            if (sticky && this.refreshing.has(sticky)) {
                const waitingFor = sticky;
                const refreshed = await this.waitForChange(waitingFor, this.refreshWaitMs);
                if (!refreshed || this.refreshing.has(waitingFor)) {
                    if (sessionId && this.sessions.get(sessionId) === waitingFor) this.sessions.delete(sessionId);
                    sticky = null;
                }
                continue;
            }
            const active = this.inFlight.get(sticky) || 0;
            if (sticky && active < this.limit) {
                this.inFlight.set(sticky, active + 1);
                return { status: 'acquired', uuid: sticky };
            }
            if (sticky && sessionId && this.sessions.get(sessionId) === sticky) {
                const granted = await this.enqueue(sticky);
                if (granted) return { status: 'acquired', uuid: sticky };
                if (this.blocked(sticky)) {
                    this.sessions.delete(sessionId);
                    sticky = null;
                    continue;
                }
                return { status: 'busy' };
            }
            const candidate = this.rankAvailable(accounts)[0];
            if (!candidate) {
                if (this.allCapacityFull(accounts)) {
                    await this.waitForAny(accounts);
                    continue;
                }
                return { status: 'quota-exhausted', resetAt: this.earliestReset(accounts) };
            }
            this.inFlight.set(candidate.uuid, (this.inFlight.get(candidate.uuid) || 0) + 1);
            if (sessionId) this.sessions.set(sessionId, candidate.uuid);
            return { status: 'acquired', uuid: candidate.uuid, switched: Boolean(uuid && uuid !== candidate.uuid) };
        }
        return { status: 'busy' };
    }

    release(uuid) {
        const next = Math.max(0, (this.inFlight.get(uuid) || 0) - 1);
        this.inFlight.set(uuid, next);
        const queue = this.queues.get(uuid) || [];
        const waiter = queue.shift();
        if (waiter && next < this.limit && !this.blocked(uuid)) {
            this.inFlight.set(uuid, next + 1);
            waiter.grant();
            return;
        }
        this.notify(uuid);
    }

    enqueue(uuid) {
        return new Promise(resolve => {
            let settled = false;
            const finish = granted => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(granted);
            };
            const waiter = { grant: () => finish(true) };
            const timer = setTimeout(() => {
                const queue = this.queues.get(uuid) || [];
                const index = queue.indexOf(waiter);
                if (index >= 0) queue.splice(index, 1);
                finish(false);
            }, this.queueTimeoutMs);
            const queue = this.queues.get(uuid) || [];
            queue.push(waiter);
            this.queues.set(uuid, queue);
        });
    }

    rankAvailable(accounts) {
        return (accounts || [])
            .filter(account => !this.blocked(account.uuid) && (this.inFlight.get(account.uuid) || 0) < this.limit)
            .sort((left, right) => compareAccounts(left, right, this.now()));
    }

    blocked(uuid) {
        if (this.unhealthy.has(uuid) || this.refreshing.has(uuid)) return true;
        const account = this.accounts.get(uuid);
        if (!account) return true;
        return accountQuotaState(account, this.now()) !== 'known';
    }

    allCapacityFull(accounts) {
        const eligible = (accounts || []).filter(account => !this.blocked(account.uuid));
        return eligible.length > 0 && eligible.every(account => (this.inFlight.get(account.uuid) || 0) >= this.limit);
    }

    earliestReset(accounts) {
        const times = (accounts || [])
            .map(account => Date.parse(account.fiveHour?.resetAt || account.weekly?.resetAt || ''))
            .filter(time => Number.isFinite(time) && time > this.now());
        return times.length ? new Date(Math.min(...times)).toISOString() : null;
    }

    forgetSessionsFor(uuid) {
        for (const [sessionId, bound] of this.sessions) {
            if (bound === uuid) this.sessions.delete(sessionId);
        }
    }

    waitForAny(accounts) {
        return Promise.race((accounts || []).map(account => this.waitForChange(account.uuid)));
    }

    waitForChange(uuid, timeoutMs = this.queueTimeoutMs) {
        return new Promise(resolve => {
            const signals = this.signals.get(uuid) || [];
            const finish = ok => {
                clearTimeout(timer);
                resolve(ok);
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            signals.push(() => finish(true));
            this.signals.set(uuid, signals);
        });
    }

    notify(uuid) {
        const signals = this.signals.get(uuid) || [];
        this.signals.set(uuid, []);
        for (const signal of signals) signal();
    }
}

function freshnessRank(account, now) {
    const fresh = Number.isFinite(account.updatedAt) && now - account.updatedAt <= STALE_AFTER_MS;
    const known = quotaWindowState(account.weekly, now) !== 'unknown' && quotaWindowState(account.fiveHour, now) !== 'unknown';
    return fresh && known ? 0 : 1;
}

function isFraction(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export const GREEDY_STICKY_LIMITS = {
    WEEK_FLOOR_SECONDS,
    STALE_AFTER_MS,
    MAX_IN_FLIGHT,
    SAME_SESSION_QUEUE_MS,
    TOKEN_REFRESH_WAIT_MS,
    REFRESH_INTERVAL_MS,
    IDLE_STOP_MS
};
