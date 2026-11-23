/**
 * 识别 Google「额度用尽」并提取恢复时间。
 * 流式错误体是原始字符串，非流式是对象或数组，两种都要认。
 * 这里不碰网络和凭据，测试可以直接导入。
 */

export function isQuotaExhaustedError(error) {
    return getErrorEntries(error).some(entry => {
        const body = entry?.error;
        return body?.status === 'RESOURCE_EXHAUSTED' && Array.isArray(body.details) && body.details.some(detail =>
            detail?.reason === 'QUOTA_EXHAUSTED' || detail?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure' ||
            Boolean(detail?.metadata?.quotaResetTimeStamp || detail?.metadata?.quotaResetDelay)
        );
    });
}

export function isTosViolationError(error) {
    return getErrorEntries(error).some(entry => {
        const body = entry?.error;
        return body?.reason === 'TOS_VIOLATION' || body?.status === 'TOS_VIOLATION' ||
            (Array.isArray(body?.details) && body.details.some(detail => detail?.reason === 'TOS_VIOLATION'));
    });
}

export function getQuotaRecoveryTime(error, now = Date.now()) {
    const details = getErrorEntries(error).flatMap(entry => Array.isArray(entry?.error?.details) ? entry.error.details : []);
    for (const detail of details) {
        const timestamp = detail?.metadata?.quotaResetTimeStamp;
        const ms = Date.parse(timestamp || '');
        if (!Number.isNaN(ms) && ms > now) return new Date(ms);
    }
    for (const detail of details) {
        const delay = detail?.metadata?.quotaResetDelay || detail?.retryDelay;
        const milliseconds = parseGoogleDuration(delay);
        if (milliseconds > 0) return new Date(now + milliseconds);
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
