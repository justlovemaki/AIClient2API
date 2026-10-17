/**
 * Grok Web Header Generation
 * Handles WebSocket and HTTP header construction
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a statsig ID (from grok2api implementation)
 */
export function genStatsigId() {
    const randomString = (len, alpha = false) => {
        const chars = alpha ? 'abcdefghijklmnopqrstuvwxyz0123456789' : 'abcdefghijklmnopqrstuvwxyz';
        let res = '';
        for (let i = 0; i < len; i++) res += chars[Math.floor(Math.random() * chars.length)];
        return res;
    };
    const msg = Math.random() < 0.5
        ? `e:TypeError: Cannot read properties of null (reading 'children['${randomString(5, true)}']')`
        : `e:TypeError: Cannot read properties of undefined (reading '${randomString(10)}')`;
    return Buffer.from(msg).toString('base64');
}

/**
 * Build WebSocket headers for authentication
 */
export function buildWebSocketHeaders(token, cfClearance, cfBm, baseUrl, userAgent) {
    let ssoToken = token || "";
    if (ssoToken.startsWith("sso=")) ssoToken = ssoToken.substring(4);

    const cookieParts = [];
    if (ssoToken) {
        cookieParts.push(`sso=${ssoToken}`, `sso-rw=${ssoToken}`);
    }
    if (cfClearance) {
        cookieParts.push(`cf_clearance=${cfClearance}`);
    }
    if (cfBm) {
        cookieParts.push(`__cf_bm=${cfBm}`);
    }

    const statsigId = genStatsigId();

    return {
        'Cookie': cookieParts.join('; '),
        'Origin': baseUrl,
        'Host': new URL(baseUrl).host,
        'User-Agent': userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Statsig-ID': statsigId,
        'Connection': 'Upgrade'
    };
}

/**
 * Build HTTP headers for non-WebSocket requests
 */
export function buildHttpHeaders(token, cfClearance, cfBm, baseUrl, userAgent) {
    let ssoToken = token || "";
    if (ssoToken.startsWith("sso=")) ssoToken = ssoToken.substring(4);

    const cookieParts = [];
    if (ssoToken) {
        cookieParts.push(`sso=${ssoToken}`, `sso-rw=${ssoToken}`);
    }
    if (cfClearance) {
        cookieParts.push(`cf_clearance=${cfClearance}`);
    }
    if (cfBm) {
        cookieParts.push(`__cf_bm=${cfBm}`);
    }

    const statsigId = genStatsigId();

    return {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'cookie': cookieParts.join('; '),
        'origin': baseUrl,
        'priority': 'u=1, i',
        'referer': `${baseUrl}/`,
        'sec-ch-ua': '"Chromium";v="143", "Google Chrome";v="143", "Not/A)Brand";v="99"',
        'sec-ch-ua-full-version': '"143.0.7499.110"',
        'sec-ch-ua-full-version-list': '"Chromium";v="143.0.7499.110", "Google Chrome";v="143.0.7499.110", "Not/A)Brand";v="99.0.0.0"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': userAgent,
        'x-statsig-id': statsigId,
        'x-xai-request-id': uuidv4()
    };
}

/**
 * Normalize image URLs to assets.grok.com format
 */
export function normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('http') || url.startsWith('data:')) return url;
    return `https://assets.grok.com/${url.startsWith('/') ? url.slice(1) : url}`;
}
