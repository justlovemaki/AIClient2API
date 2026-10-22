import { t } from './i18n.js';

const statusKeys = {
    not_returned: 'models.status.notReturned',
    tier_restricted: 'models.status.tierRestricted',
    unknown: 'models.status.unknown'
};

// Display-only decoration: never use the resulting label as a request/model ID.
export function formatModelLabel(modelId, status) {
    const key = statusKeys[status];
    const grokQualityLabels = {
        'grok-4.7-low': 'Grok 4.7 (Low)',
        'grok-4.7-medium': 'Grok 4.7 (Medium)',
        'grok-4.7-high': 'Grok 4.7 (High)',
        'grok-4.7-extra-high': 'Grok 4.7 (Extra High)'
    };
    const label = grokQualityLabels[modelId] || modelId;
    return key ? `${label} ${t(key)}` : label;
}
