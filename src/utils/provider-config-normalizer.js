const PROVIDER_STRING_ARRAY_CONFIG_FIELDS = [
    'DEFAULT_MODEL_PROVIDERS',
    'PROXY_ENABLED_PROVIDERS',
    'TLS_SIDECAR_ENABLED_PROVIDERS'
];

const PROVIDER_BOOLEAN_CONFIG_FIELDS = [
    'TLS_SIDECAR_ENABLED'
];

// 可选数值字段：留空/非法值归一为 null（而非删除字段），
// 这样 UI 清空后能通过浅合并覆盖掉节点上已存在的旧值
const PROVIDER_OPTIONAL_NUMBER_CONFIG_FIELDS = [
    'priority'
];

function normalizeStringArrayConfigValue(value) {
    if (Array.isArray(value)) {
        return value
            .filter(item => item !== undefined && item !== null && item !== false)
            .map(item => String(item).trim())
            .filter(Boolean);
    }

    if (value === undefined || value === null || typeof value === 'boolean') {
        return [];
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return [];
        }

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return normalizeStringArrayConfigValue(parsed);
                }
            } catch {
                // Fall back to comma-separated parsing below.
            }
        }

        return trimmed
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
    }

    return [];
}

function normalizeOptionalNumberConfigValue(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value === 'string' && value.trim() === '') {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBooleanConfigValue(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) {
            return true;
        }
        if (['false', '0', 'no', 'off', 'disabled', ''].includes(normalized)) {
            return false;
        }
    }

    return Boolean(value);
}

/**
 * Provider edit UI renders unknown provider fields as text inputs. If root-level
 * proxy/TLS settings are stored on a provider node, arrays and booleans can
 * round-trip as strings and silently disable proxy routing. Normalize only known
 * typed fields that are present in the request, without adding new fields.
 */
export function normalizeProviderConfigFields(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

    const result = { ...data };
    for (const key of PROVIDER_STRING_ARRAY_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = normalizeStringArrayConfigValue(result[key]);
        }
    }

    for (const key of PROVIDER_BOOLEAN_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = normalizeBooleanConfigValue(result[key]);
        }
    }

    for (const key of PROVIDER_OPTIONAL_NUMBER_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = normalizeOptionalNumberConfigValue(result[key]);
        }
    }

    return result;
}
