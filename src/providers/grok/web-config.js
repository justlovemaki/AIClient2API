/**
 * Grok Web Configuration and Constants
 * Separated from main implementation for better organization
 */

// Model mappings for Grok Web
const WEB_MODEL_MAPPING = {
    'grok-4.1-mini': { name: 'grok-4-1-thinking-1129', mode: 'MODEL_MODE_GROK_4_1_MINI_THINKING', modeId: 'grok-4-1-mini' },
    'grok-4.1-thinking': { name: 'grok-4-1-thinking-1129', mode: 'MODEL_MODE_GROK_4_1_THINKING', modeId: 'grok-4-1-thinking' },
    'grok-4.20': { name: 'grok-420', mode: 'MODEL_MODE_AUTO', modeId: 'auto' },
    'grok-4.20-auto': { name: 'grok-420', mode: 'MODEL_MODE_AUTO', modeId: 'auto' },
    'grok-4.20-fast': { name: 'grok-420', mode: 'MODEL_MODE_FAST', modeId: 'fast' },
    'grok-4.20-expert': { name: 'grok-420', mode: 'MODEL_MODE_EXPERT', modeId: 'expert' },
    'grok-4.20-heavy': { name: 'grok-420', mode: 'MODEL_MODE_HEAVY', modeId: 'heavy' },
    'grok-4.3': { name: 'grok-4.3', mode: 'MODEL_MODE_AUTO', modeId: 'auto' },
    'grok-imagine-1.0-fast': { name: 'imagine-image', mode: 'MODEL_MODE_FAST', modeId: 'fast' },
    'grok-imagine-1.0-fast-edit': { name: 'imagine-image', mode: 'MODEL_MODE_FAST', modeId: 'fast' },
    'grok-imagine-1.0': { name: 'imagine-image', mode: 'MODEL_MODE_FAST', modeId: 'expert' },
    'grok-imagine-1.0-edit': { name: 'imagine-image', mode: 'MODEL_MODE_FAST', modeId: 'expert' },
};

const MODEL_MAPPING = { ...WEB_MODEL_MAPPING };
Object.keys(WEB_MODEL_MAPPING).forEach(key => {
    if (!key.endsWith('-nsfw')) {
        MODEL_MAPPING[`${key}-nsfw`] = WEB_MODEL_MAPPING[key];
    }
});

export const GROK_WEB_MODELS = Object.keys(MODEL_MAPPING);

/**
 * Check if model is NSFW variant
 */
export function isGrokNsfwModel(modelId) {
    return typeof modelId === 'string' && modelId.toLowerCase().endsWith('-nsfw');
}

/**
 * Normalize model ID by removing NSFW suffix
 */
export function normalizeGrokModelId(modelId) {
    if (typeof modelId !== 'string') return modelId;
    return isGrokNsfwModel(modelId) ? modelId.slice(0, -5) : modelId;
}

/**
 * Get model mapping for a given model ID
 */
export function getModelMapping(modelId) {
    const rawModelId = typeof modelId === 'string' ? modelId : '';
    const normalizedModelId = normalizeGrokModelId(rawModelId);
    return MODEL_MAPPING[normalizedModelId] || MODEL_MAPPING['grok-4.3'] || { name: 'grok-4.3', modeId: 'auto' };
}
