export function createAntigravityQuotaUsageLoader({ apiClient }) {
    return async function loadAntigravityQuotaUsage(providers = []) {
        const eligibleProviders = providers.filter(provider => provider?.isHealthy && !provider.isDisabled);
        if (eligibleProviders.length === 0) {
            return { available: false, usedPercent: 0, totalPercent: 0 };
        }

        const results = await Promise.all(eligibleProviders.map(async provider => {
            try {
                const response = await apiClient.get(`/providers/gemini-antigravity/${encodeURIComponent(provider.uuid)}/quota`);
                const quota = response?.quota;
                return quota?.available && Number.isFinite(quota.usedPercentage) ? quota.usedPercentage : null;
            } catch {
                return null;
            }
        }));
        const usedPercentages = results.filter(value => value !== null);
        return {
            available: usedPercentages.length > 0,
            usedPercent: usedPercentages.reduce((sum, value) => sum + value, 0),
            totalPercent: eligibleProviders.length * 100
        };
    };
}
