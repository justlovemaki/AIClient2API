import { weeklyGreed, quotaWindowState, compareAccounts, extractSessionId, extractQuotaWindows, GreedyStickyScheduler } from '../src/providers/greedy-sticky-scheduler.js';

const now = Date.parse('2026-10-11T12:00:00.000Z');
const weekly = (remaining, minutes) => ({ remainingFraction: remaining, resetAt: new Date(now + minutes * 60000).toISOString() });
const account = (uuid, weekRemaining, weekMinutes, hourRemaining = 1, updatedAt = now) => ({
    uuid,
    weekly: weekly(weekRemaining, weekMinutes),
    fiveHour: weekly(hourRemaining, 60),
    updatedAt
});

describe('weekly greed and eligibility', () => {
    test('closer reset and higher quota score higher, with a 600 second floor', () => {
        expect(weeklyGreed(0.8, new Date(now + 600000).toISOString(), now))
            .toBeGreaterThan(weeklyGreed(0.8, new Date(now + 3600000).toISOString(), now));
        expect(weeklyGreed(0.2, new Date(now + 1000).toISOString(), now)).toBeCloseTo(0.2 / 600);
        expect(weeklyGreed(2, new Date(now + 600000).toISOString(), now)).toBeNull();
    });

    test('an exhausted window whose reset already passed is eligible again', () => {
        expect(quotaWindowState({ remainingFraction: 0, resetAt: new Date(now - 1000).toISOString() }, now)).toBe('reset-due');
        expect(quotaWindowState({ remainingFraction: 0, resetAt: new Date(now + 1000).toISOString() }, now)).toBe('exhausted');
        expect(quotaWindowState({ remainingFraction: 'bad', resetAt: null }, now)).toBe('unknown');
    });

    test('fresh complete quota outranks stale quota', () => {
        const ranked = [account('stale', 1, 10, 1, now - 21 * 60000), account('fresh', 0.1, 100)].sort((a, b) => compareAccounts(a, b, now));
        expect(ranked.map(item => item.uuid)).toEqual(['fresh', 'stale']);
    });

    test('reads only the gemini weekly and five-hour buckets', () => {
        const windows = extractQuotaWindows({
            groups: [{
                buckets: [
                    { bucketId: 'gemini-weekly', remainingFraction: 0.9, resetTime: '2026-10-18T12:00:00Z' },
                    { bucketId: 'gemini-5h', remainingFraction: 1.4, resetTime: '2026-10-11T17:00:00Z' },
                    { bucketId: '3p-weekly', remainingFraction: 0.2, resetTime: '2026-10-18T12:00:00Z' }
                ]
            }]
        });
        expect(windows.weekly.remainingFraction).toBeCloseTo(0.9);
        expect(windows.fiveHour.remainingFraction).toBe(1);
        expect(extractQuotaWindows({ models: {} })).toEqual({ weekly: null, fiveHour: null });
    });

    test('reads the session id embedded in ZCode metadata', () => {
        expect(extractSessionId({ metadata: { user_id: JSON.stringify({ session_id: ' sess-1 ' }) } })).toBe('sess-1');
        expect(extractSessionId({ metadata: { user_id: 'plain' } })).toBeNull();
    });
});

describe('greedy sticky assignment', () => {
    function scheduler() {
        return new GreedyStickyScheduler({ now: () => now, queueTimeoutMs: 20 });
    }

    test('a bound conversation stays put when another account later ranks higher', async () => {
        const gate = scheduler();
        await gate.acquire({ accounts: [account('old', 0.9, 20), account('new', 0.2, 100)], sessionId: 'conversation' });
        const next = await gate.acquire({ accounts: [account('old', 0.2, 100), account('new', 0.9, 20)], sessionId: 'conversation' });
        expect(next.uuid).toBe('old');
    });

    test('a new conversation uses the highest greed account and then sticks to it', async () => {
        const gate = scheduler();
        const accounts = [account('low', 0.2, 100), account('high', 0.9, 20)];
        const first = await gate.acquire({ accounts, sessionId: 'conversation' });
        const second = await gate.acquire({ accounts: accounts.reverse(), sessionId: 'conversation' });
        expect(first.uuid).toBe('high');
        expect(second.uuid).toBe('high');
    });

    test('the fourth new conversation skips a full account', async () => {
        const gate = scheduler();
        const accounts = [account('best', 1, 10), account('next', 0.5, 10)];
        for (let i = 0; i < 3; i += 1) await gate.acquire({ accounts, sessionId: `new-${i}` });
        const fourth = await gate.acquire({ accounts, sessionId: 'new-4' });
        expect(fourth.uuid).toBe('next');
    });

    test('the same conversation queues on its own full account instead of moving', async () => {
        const gate = scheduler();
        const accounts = [account('only', 1, 10), account('other', 0.1, 10)];
        const held = [];
        for (let i = 0; i < 3; i += 1) held.push(await gate.acquire({ accounts, sessionId: 'conversation' }));
        let released = false;
        const queued = gate.acquire({ uuid: 'only', accounts, sessionId: 'conversation' }).then(result => {
            expect(released).toBe(true);
            return result;
        });
        released = true;
        gate.release(held[0].uuid);
        await expect(queued).resolves.toMatchObject({ uuid: 'only' });
    });

    test('queueing gives up instead of waiting forever', async () => {
        const gate = scheduler();
        const accounts = [account('only', 1, 10)];
        for (let i = 0; i < 3; i += 1) await gate.acquire({ accounts, sessionId: 'conversation' });
        await expect(gate.acquire({ uuid: 'only', accounts, sessionId: 'conversation' })).resolves.toMatchObject({ status: 'busy' });
    });

    test('an account is not usable until both quota windows are known', async () => {
        const gate = scheduler();
        const unknown = { uuid: 'unknown', weekly: null, fiveHour: null, updatedAt: now };
        const known = account('known', 0.2, 100);
        await expect(gate.acquire({ accounts: [unknown, known], sessionId: 'conversation' })).resolves.toMatchObject({ uuid: 'known' });
    });

    test('all exhausted accounts return the earliest reset instead of waiting', async () => {
        const gate = scheduler();
        const accounts = [account('one', 0, 30, 0), account('two', 0, 10, 0)];
        await expect(gate.acquire({ accounts, sessionId: 'conversation' })).resolves.toMatchObject({
            status: 'quota-exhausted',
            resetAt: accounts[1].fiveHour.resetAt
        });
    });

    test('an unhealthy sticky account is replaced', async () => {
        const gate = scheduler();
        const accounts = [account('old', 1, 10), account('new', 0.4, 10)];
        await gate.acquire({ accounts, sessionId: 'conversation' });
        gate.markUnhealthy('old');
        await expect(gate.acquire({ uuid: 'old', accounts, sessionId: 'conversation' })).resolves.toMatchObject({ uuid: 'new', switched: true });
    });

    test('token refresh waits briefly and then leaves the stuck account', async () => {
        const gate = new GreedyStickyScheduler({ now: () => now, queueTimeoutMs: 20, refreshWaitMs: 20 });
        gate.setRefreshing('old', true);
        await expect(gate.acquire({ uuid: 'old', accounts: [account('old', 1, 10), account('fresh', 0.4, 10)], sessionId: 'conversation' })).resolves.toMatchObject({ uuid: 'fresh' });
        expect(gate.sessions.get('conversation')).toBe('fresh');
    });

    test('missing session identity follows the current ranking without pretending to stick', async () => {
        const gate = scheduler();
        const first = await gate.acquire({ accounts: [account('a', 0.2, 10), account('b', 0.9, 10)] });
        gate.release(first.uuid);
        const second = await gate.acquire({ accounts: [account('a', 0.9, 10), account('b', 0.2, 10)] });
        expect(first.uuid).toBe('b');
        expect(second.uuid).toBe('a');
    });

    test('background quota refresh stops while idle and staggers accounts', () => {
        let clock = now;
        const gate = new GreedyStickyScheduler({ now: () => clock });
        expect(gate.shouldRefresh('startup', { startup: true })).toBe(true);
        gate.noteUserRequest();
        expect(gate.shouldRefresh('a')).toBe(true);
        gate.markRefreshed('a');
        expect(gate.shouldRefresh('a')).toBe(false);
        clock += 15 * 60000;
        expect(gate.shouldRefresh('b')).toBe(true);
        clock += 16 * 60000;
        expect(gate.shouldRefresh('a')).toBe(false);
    });
});
