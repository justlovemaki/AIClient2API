export const GROK_CLI_QUOTA_CACHE_TTL_MS = 60_000;

export function createGrokCliQuotaUsageLoader({ apiClient, now = () => Date.now() } = {}) {
    if (!apiClient || typeof apiClient.get !== 'function') {
        throw new TypeError('An API client is required to load Grok CLI quota.');
    }

    const cache = new Map();
    const requests = new Map();

    return async function loadGrokCliQuotaUsage(providers = []) {
        const eligibleProviders = providers.filter(provider => provider?.isHealthy && !provider.isDisabled && provider?.uuid);
        const results = await Promise.all(eligibleProviders.map(async provider => {
            const cached = cache.get(provider.uuid);
            if (cached && now() - cached.cachedAt < GROK_CLI_QUOTA_CACHE_TTL_MS) return cached.result;

            const inFlight = requests.get(provider.uuid);
            if (inFlight) return inFlight;

            const request = apiClient.get(`/providers/grok-cli-oauth/${encodeURIComponent(provider.uuid)}/quota`)
                .then(response => response?.quota || { available: false })
                .catch(() => ({ available: false }))
                .then(result => {
                    cache.set(provider.uuid, { cachedAt: now(), result });
                    return result;
                })
                .finally(() => requests.delete(provider.uuid));

            requests.set(provider.uuid, request);
            return request;
        }));

        const paidAccounts = results.filter(result => result?.available);
        const freeAccounts = results.filter(result => result?.isFree);
        const unavailableAccounts = results.filter(result => !result?.available && !result?.isFree);

        return {
            available: paidAccounts.length > 0,
            usedPercent: paidAccounts.reduce((sum, result) => sum + result.usedPercentage, 0),
            totalPercent: paidAccounts.length * 100,
            paidAccountCount: paidAccounts.length,
            freeAccountCount: freeAccounts.length,
            unavailableAccountCount: unavailableAccounts.length,
            accounts: results
        };
    };
}
