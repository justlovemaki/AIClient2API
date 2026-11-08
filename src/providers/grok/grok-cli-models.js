const GROK_CLI_QUALITY_MODELS = new Map([
    ['grok-4.7-low', 'low'],
    ['grok-4.7-medium', 'medium'],
    ['grok-4.7-high', 'high'],
    ['grok-4.7-extra-high', 'extra_high']
]);

export function resolveGrokCliQualityModel(model) {
    const normalized = String(model || '').trim().toLowerCase();
    const effort = GROK_CLI_QUALITY_MODELS.get(normalized);
    return effort ? { model: 'grok-4.7', effort } : { model: normalized, effort: null };
}

export function isGrokCliQualityModel(model) {
    return GROK_CLI_QUALITY_MODELS.has(String(model || '').trim().toLowerCase());
}
