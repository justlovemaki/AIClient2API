/**
 * 识别 Google「额度用尽」并提取恢复时间。
 * 流式错误体是原始字符串，非流式是对象或数组，两种都要认。
 * 这里不碰网络和凭据，测试可以直接导入。
 */

export function isQuotaExhaustedError(error) {
    const entries = getErrorEntries(error);
    return entries.some(entry => entry?.error?.status === 'RESOURCE_EXHAUSTED');
}

export function getQuotaRecoveryTime(error, now = Date.now()) {
    const entries = getErrorEntries(error);
    for (const entry of entries) {
        const details = entry?.error?.details;
        if (!Array.isArray(details)) continue;
        for (const detail of details) {
            const timestamp = detail?.metadata?.quotaResetTimeStamp;
            if (timestamp) {
                const ms = Date.parse(timestamp);
                if (!Number.isNaN(ms) && ms > now) return new Date(ms);
            }
            const delay = detail?.metadata?.quotaResetDelay || detail?.retryDelay;
            const milliseconds = parseGoogleDuration(delay);
            if (milliseconds > 0) return new Date(now + milliseconds);
        }
    }
    return null;
}

function getErrorEntries(error) {
    let data = error?.response?.data;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return []; }
    }
    if (!data || typeof data !== 'object') return [];
    return Array.isArray(data) ? data : [data];
}

function parseGoogleDuration(value) {
    if (!value) return 0;
    const match = String(value).match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
    if (!match || !(match[1] || match[2] || match[3])) return 0;
    return (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
}
