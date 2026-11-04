import { apiClient, authManager } from './auth.js';

function normalizeEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || !/^\/[A-Za-z0-9_/-]+$/.test(endpoint) || endpoint.includes('//')) {
        throw new Error('Invalid plugin API endpoint');
    }
    return endpoint;
}

function requireAdminSession() {
    if (authManager.isTokenValid()) return;
    authManager.clearToken();
    window.location.assign('/login.html');
    throw new Error('Administrator login required');
}

/**
 * Same-origin client for authenticated plugin administration pages.
 * Tokens remain in the existing UI auth manager and are never put in URLs.
 */
export function createPluginApi(endpoint) {
    const base = normalizeEndpoint(endpoint);
    const call = async (method, suffix = '', body) => {
        requireAdminSession();
        const target = normalizeEndpoint(base + suffix);
        if (method === 'GET') return apiClient.get(target);
        if (method === 'DELETE') return apiClient.delete(target);
        if (method === 'POST') return apiClient.post(target, body);
        if (method === 'PUT') return apiClient.put(target, body);
        throw new Error('Unsupported plugin API method');
    };
    return Object.freeze({
        get: (suffix = '') => call('GET', suffix),
        post: (body, suffix = '') => call('POST', suffix, body),
        put: (body, suffix = '') => call('PUT', suffix, body),
        delete: (suffix = '') => call('DELETE', suffix)
    });
}
