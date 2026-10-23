export function createAntigravityQuotaUsageLoader({ apiClient } = {}) {
    const cacheTtlMs = 5000;
    const maxConcurrency = 4;
    const cache = new Map();
    const inFlight = new Map();

    const fetchAccountQuota = async provider => {
        const now = Date.now();
        const cached = cache.get(provider.uuid);
        if (cached && cached.expiresAt > now) return cached.quota;
        if (inFlight.has(provider.uuid)) return inFlight.get(provider.uuid);

        const request = (async () => {
            try {
                const response = await apiClient.get(
                    `/providers/gemini-antigravity/${encodeURIComponent(provider.uuid)}/quota`
                );
                const quota = response?.quota || null;
                cache.set(provider.uuid, { quota, expiresAt: Date.now() + cacheTtlMs });
                return quota;
            } catch {
                cache.set(provider.uuid, { quota: null, expiresAt: Date.now() + cacheTtlMs });
                return null;
            } finally {
                inFlight.delete(provider.uuid);
            }
        })();
        inFlight.set(provider.uuid, request);
        return request;
    };

    const mapWithLimit = async (providers, mapper) => {
        const results = new Array(providers.length);
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < providers.length) {
                const index = nextIndex++;
                results[index] = await mapper(providers[index]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(maxConcurrency, providers.length) }, worker));
        return results;
    };

    return async function loadAntigravityQuotaUsage(providers = []) {
        const healthyProviders = providers.filter(provider => provider?.isHealthy && !provider.isDisabled);
        const accountUsage = await mapWithLimit(
            healthyProviders.filter(provider => provider.uuid),
            fetchAccountQuota
        );

        const totalPercent = healthyProviders.length * 100;
        return Object.fromEntries(['gemini', 'claude'].map(family => {
            const percentages = accountUsage.map(quota => {
                const familyQuota = quota?.[family];
                const rawPercentage = familyQuota?.usedPercentage;
                if (!familyQuota?.available || rawPercentage == null) return null;

                const usedPercentage = Number(rawPercentage);
                return Number.isFinite(usedPercentage)
                    ? Math.round(Math.min(100, Math.max(0, usedPercentage)))
                    : null;
            });
            const available = percentages.every(percentage => percentage !== null);

            return [family, {
                available,
                usedPercent: available ? percentages.reduce((sum, percentage) => sum + percentage, 0) : null,
                totalPercent
            }];
        }));
    };
}
