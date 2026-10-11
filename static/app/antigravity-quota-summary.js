export function createAntigravityQuotaUsageLoader({ apiClient } = {}) {
    return async function loadAntigravityQuotaUsage(providers = []) {
        const healthyProviders = providers.filter(provider => provider?.isHealthy && !provider.isDisabled);
        const accountUsage = await Promise.all(healthyProviders.map(async provider => {
            if (!provider.uuid) return null;

            try {
                const response = await apiClient.get(
                    `/providers/gemini-antigravity/${encodeURIComponent(provider.uuid)}/quota`
                );
                return response?.quota || null;
            } catch {
                return null;
            }
        }));

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
