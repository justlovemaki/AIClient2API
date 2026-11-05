import http from 'http';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { getProxyConfigForProvider } from '../utils/proxy-utils.js';

const GROK_CLI_PROVIDER = 'grok-cli-oauth';

/**
 * Grok CLI OAuth 配置。
 * clientId/scope/redirectUri 与 xAI Grok CLI OAuth public client 保持一致。
 */
const GROK_CLI_OAUTH_CONFIG = {
    issuer: 'https://auth.x.ai',
    discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
    deviceCodeEndpoint: 'https://auth.x.ai/oauth2/device/code',
    deviceGrantType: 'urn:ietf:params:oauth:grant-type:device_code',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    scope: 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write',
    redirectUri: 'http://127.0.0.1:56121/callback',
    port: 56121,
    defaultApiBaseUrl: 'https://api.x.ai/v1',
    logPrefix: '[Grok CLI Auth]'
};

const activeServers = new Map();

function sanitizeGrokCliCredentialFilenamePart(value) {
    const sanitized = String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120);

    return sanitized || 'default';
}

function generateResponsePage(isSuccess, message, provider = GROK_CLI_PROVIDER) {
    const title = isSuccess ? '授权成功' : '授权失败';
    const countdownHtml = isSuccess ? `
        <p>此窗口将在 <span id="countdown" style="font-weight: bold; color: #2196f3;">10</span> 秒后自动关闭。</p>
        <script>
            const notifyOpener = () => {
                try {
                    if (window.opener && !window.opener.closed) {
                        window.opener.postMessage({
                            type: 'oauth-popup-complete',
                            provider: ${JSON.stringify(provider)},
                            success: true
                        }, window.location.origin);
                    }
                } catch (e) {}
            };
            notifyOpener();
            let countdown = 10;
            const timer = setInterval(() => {
                countdown--;
                const el = document.getElementById('countdown');
                if (el) el.textContent = countdown;
                if (countdown <= 0) {
                    clearInterval(timer);
                    window.close();
                }
            }, 1000);
        </script>` : '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color: #f5f5f5;
        }
        .container {
            text-align: center;
            padding: 2rem;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 420px;
            width: 90%;
        }
        h1 { color: ${isSuccess ? '#4caf50' : '#f44336'}; margin-top: 0; }
        p { color: #666; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
        ${countdownHtml}
    </div>
</body>
</html>`;
}

async function closeActiveServer(provider, port = null) {
    const existing = activeServers.get(provider);

    if (existing) {
        try {
            const closePromise = new Promise((resolve, reject) => {
                existing.server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Server close timeout after 2s')), 2000);
            });

            await Promise.race([closePromise, timeoutPromise]);
            logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} ${provider} server closed successfully`);
        } catch (error) {
            logger.warn(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Server close failed or timed out: ${error.message}`);
        } finally {
            activeServers.delete(provider);
        }
    }

    if (port) {
        for (const [p, info] of activeServers.entries()) {
            if (info.port === port) {
                await closeActiveServer(p);
            }
        }
    }
}

function validateOAuthEndpoint(rawUrl, field) {
    const value = String(rawUrl || '').trim();
    if (!value) {
        throw new Error(`xAI discovery ${field} is empty`);
    }

    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || (host !== 'x.ai' && !host.endsWith('.x.ai'))) {
        throw new Error(`xAI discovery ${field} host is not on x.ai: ${value}`);
    }

    return value;
}

export class GrokCliAuth {
    constructor(config) {
        this.config = config;
        const axiosConfig = { timeout: 30000 };
        const proxyConfig = getProxyConfigForProvider(config, GROK_CLI_PROVIDER);
        if (proxyConfig) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
            axiosConfig.proxy = false;
            logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Proxy enabled for OAuth requests`);
        }

        this.httpClient = axios.create(axiosConfig);
        this.server = null;
        this.discovery = null;
    }

    generatePKCECodes() {
        const verifier = crypto.randomBytes(96).toString('base64url');
        const challenge = crypto.createHash('sha256')
            .update(verifier)
            .digest('base64url');

        return { verifier, challenge };
    }

    async discoverEndpoints() {
        if (this.discovery) return this.discovery;

        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Discovering xAI OAuth endpoints...`);
        const response = await this.httpClient.get(GROK_CLI_OAUTH_CONFIG.discoveryUrl, {
            headers: { Accept: 'application/json' }
        });

        const authorizationEndpoint = validateOAuthEndpoint(response.data?.authorization_endpoint, 'authorization_endpoint');
        const tokenEndpoint = validateOAuthEndpoint(response.data?.token_endpoint, 'token_endpoint');

        this.discovery = {
            authorizationEndpoint,
            tokenEndpoint
        };

        return this.discovery;
    }

    async generateAuthUrl() {
        const pkce = this.generatePKCECodes();
        const state = crypto.randomBytes(16).toString('hex');
        const nonce = crypto.randomBytes(16).toString('hex');
        const discovery = await this.discoverEndpoints();

        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Generating auth URL...`);

        const server = await this.startCallbackServer();
        this.server = server;

        const authUrl = new URL(discovery.authorizationEndpoint);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', GROK_CLI_OAUTH_CONFIG.clientId);
        authUrl.searchParams.set('redirect_uri', GROK_CLI_OAUTH_CONFIG.redirectUri);
        authUrl.searchParams.set('scope', GROK_CLI_OAUTH_CONFIG.scope);
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('nonce', nonce);
        authUrl.searchParams.set('plan', 'generic');
        authUrl.searchParams.set('referrer', 'grok-cli');

        return {
            authUrl: authUrl.toString(),
            state,
            nonce,
            pkce,
            tokenEndpoint: discovery.tokenEndpoint,
            server
        };
    }

    async requestDeviceCode() {
        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Requesting xAI device code...`);

        try {
            const response = await this.httpClient.post(
                GROK_CLI_OAUTH_CONFIG.deviceCodeEndpoint,
                new URLSearchParams({
                    client_id: GROK_CLI_OAUTH_CONFIG.clientId,
                    scope: GROK_CLI_OAUTH_CONFIG.scope,
                    referrer: 'grok-build'
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json',
                        'x-grok-client-surface': 'ui'
                    }
                }
            );

            const deviceCode = response.data;
            if (!deviceCode?.device_code || !deviceCode?.user_code || !deviceCode?.verification_uri) {
                throw new Error('xAI returned an incomplete device authorization response');
            }

            return {
                ...deviceCode,
                interval: Math.max(Number(deviceCode.interval) || 5, 1),
                expires_in: Math.max(Number(deviceCode.expires_in) || 600, 600)
            };
        } catch (error) {
            logger.error(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Device code request failed:`, error.response?.data || error.message);
            throw new Error(`Failed to request Grok CLI device code: ${error.response?.data?.error_description || error.message}`);
        }
    }

    async completeDeviceCodeFlow(deviceCode, tokenEndpoint, isCancelled = () => false) {
        const endpoint = tokenEndpoint || `${GROK_CLI_OAUTH_CONFIG.issuer}/oauth2/token`;
        const deadline = Date.now() + deviceCode.expires_in * 1000;
        let interval = deviceCode.interval;

        const postWithCancellation = async requestBody => {
            const controller = new AbortController();
            const cancellationWatcher = new Promise((_, reject) => {
                const timer = setInterval(() => {
                    if (!isCancelled()) return;
                    clearInterval(timer);
                    controller.abort();
                    reject(new Error('Grok CLI authorization session was replaced'));
                }, 25);
                controller.signal.addEventListener('abort', () => clearInterval(timer), { once: true });
            });
            try {
                return await Promise.race([
                    this.httpClient.post(endpoint, requestBody, {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Accept': 'application/json',
                            'x-grok-client-surface': 'ui'
                        },
                        validateStatus: () => true,
                        signal: controller.signal
                    }),
                    cancellationWatcher
                ]);
            } finally {
                controller.abort();
            }
        };

        while (Date.now() < deadline) {
            if (isCancelled()) {
                throw new Error('Grok CLI authorization session was replaced');
            }

            await new Promise(resolve => setTimeout(resolve, interval * 1000));
            if (isCancelled()) {
                throw new Error('Grok CLI authorization session was replaced');
            }

            const response = await postWithCancellation(
                new URLSearchParams({
                    grant_type: GROK_CLI_OAUTH_CONFIG.deviceGrantType,
                    device_code: deviceCode.device_code,
                    client_id: GROK_CLI_OAUTH_CONFIG.clientId
                }).toString()
            );

            if (isCancelled()) {
                throw new Error('Grok CLI authorization session was replaced');
            }

            if (response.status >= 200 && response.status < 300) {
                return response.data;
            }

            const errorCode = response.data?.error;
            const description = response.data?.error_description || errorCode || `HTTP ${response.status}`;
            if (errorCode === 'authorization_pending') continue;
            if (errorCode === 'slow_down') {
                interval += 5;
                continue;
            }
            if (errorCode === 'access_denied') {
                throw new Error(`Grok CLI authorization denied: ${description}`);
            }
            if (errorCode === 'expired_token') {
                throw new Error('Grok CLI device code expired. Start authorization again.');
            }

            throw new Error(`Grok CLI device token exchange failed: ${description}`);
        }

        throw new Error('Grok CLI device code expired. Start authorization again.');
    }

    async completeOAuthFlow(code, state, expectedState, pkce, tokenEndpoint) {
        if (state !== expectedState) {
            throw new Error('State mismatch - possible CSRF attack');
        }

        const tokens = await this.exchangeCodeForTokens(code, pkce.verifier, tokenEndpoint);
        const claims = this.parseJWT(tokens.id_token);
        const credentials = this.buildCredentials(tokens, {
            email: claims.email,
            sub: claims.sub,
            tokenEndpoint
        });

        const saveResult = await this.saveCredentials(credentials);

        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Authentication successful`);
        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Email: ${credentials.email || 'unknown'}`);
        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Subject: ${credentials.sub || 'unknown'}`);

        if (this.server) {
            this.server.close();
            this.server = null;
        }

        return {
            ...credentials,
            credPath: saveResult.credsPath,
            relativePath: saveResult.relativePath
        };
    }

    async startCallbackServer() {
        await closeActiveServer(GROK_CLI_PROVIDER, GROK_CLI_OAUTH_CONFIG.port);

        return new Promise((resolve, reject) => {
            const server = http.createServer();

            server.on('request', (req, res) => {
                if (!req.url.startsWith('/callback')) {
                    res.writeHead(204);
                    res.end();
                    return;
                }

                const url = new URL(req.url, GROK_CLI_OAUTH_CONFIG.redirectUri);
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');
                const error = url.searchParams.get('error');
                const errorDescription = url.searchParams.get('error_description');

                if (error) {
                    const message = errorDescription || error;
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, message));
                    server.emit('auth-error', new Error(message));
                    return;
                }

                if (code && state) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(true, 'Grok CLI 授权成功，凭据将自动保存。'));
                    server.emit('auth-success', { code, state });
                    return;
                }

                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, '回调缺少授权码或 state。'));
            });

            server.listen(GROK_CLI_OAUTH_CONFIG.port, GROK_CLI_OAUTH_CONFIG.redirectUri.includes('127.0.0.1') ? '127.0.0.1' : undefined, () => {
                logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Callback server listening on ${GROK_CLI_OAUTH_CONFIG.redirectUri}`);
                activeServers.set(GROK_CLI_PROVIDER, { server, port: GROK_CLI_OAUTH_CONFIG.port });
                resolve(server);
            });

            server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${GROK_CLI_OAUTH_CONFIG.port} is already in use. Please close other applications using this port.`));
                } else {
                    reject(error);
                }
            });
        });
    }

    async exchangeCodeForTokens(code, codeVerifier, tokenEndpoint) {
        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Exchanging authorization code for tokens...`);
        const endpoint = tokenEndpoint || (await this.discoverEndpoints()).tokenEndpoint;

        try {
            const response = await this.httpClient.post(
                endpoint,
                new URLSearchParams({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: GROK_CLI_OAUTH_CONFIG.redirectUri,
                    client_id: GROK_CLI_OAUTH_CONFIG.clientId,
                    code_verifier: codeVerifier
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                }
            );

            return response.data;
        } catch (error) {
            logger.error(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Token exchange failed:`, error.response?.data || error.message);
            throw new Error(`Failed to exchange code for tokens: ${error.response?.data?.error_description || error.message}`);
        }
    }

    async refreshTokens(refreshToken, tokenEndpoint, fallback = {}) {
        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Refreshing access token...`);
        const endpoint = tokenEndpoint || fallback.token_endpoint || (await this.discoverEndpoints()).tokenEndpoint;

        try {
            const response = await this.httpClient.post(
                endpoint,
                new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: GROK_CLI_OAUTH_CONFIG.clientId,
                    refresh_token: refreshToken
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                }
            );

            const tokens = response.data;
            const claims = this.parseJWT(tokens.id_token);
            return this.buildCredentials(tokens, {
                ...fallback,
                email: claims.email || fallback.email,
                sub: claims.sub || fallback.sub,
                tokenEndpoint: endpoint
            });
        } catch (error) {
            logger.error(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Token refresh failed:`, error.response?.data || error.message);
            throw new Error(`Failed to refresh Grok CLI tokens: ${error.response?.data?.error_description || error.message}`);
        }
    }

    parseJWT(token) {
        if (!token) return {};
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                throw new Error('Invalid JWT token format');
            }

            const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
            return JSON.parse(payload);
        } catch (error) {
            logger.warn(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Failed to parse JWT: ${error.message}`);
            return {};
        }
    }

    buildCredentials(tokens, fallback = {}) {
        const expiresIn = tokens.expires_in || fallback.expires_in || 3600;
        return {
            id_token: tokens.id_token || fallback.id_token || '',
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || fallback.refresh_token || '',
            token_type: tokens.token_type || fallback.token_type || 'Bearer',
            expires_in: expiresIn,
            last_refresh: new Date().toISOString(),
            email: fallback.email || '',
            sub: fallback.sub || '',
            type: 'xai',
            auth_kind: 'oauth',
            expired: new Date(Date.now() + expiresIn * 1000).toISOString(),
            base_url: fallback.base_url || GROK_CLI_OAUTH_CONFIG.defaultApiBaseUrl,
            redirect_uri: fallback.redirect_uri || GROK_CLI_OAUTH_CONFIG.redirectUri,
            token_endpoint: fallback.tokenEndpoint || fallback.token_endpoint || ''
        };
    }

    async saveCredentials(creds) {
        const safeEmail = sanitizeGrokCliCredentialFilenamePart(creds.email || creds.sub || 'default');
        let credsPath;

        if (this.config.GROK_CLI_OAUTH_CREDS_FILE_PATH || this.config.XAI_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.GROK_CLI_OAUTH_CREDS_FILE_PATH || this.config.XAI_OAUTH_CREDS_FILE_PATH;
        } else {
            const targetDir = path.join(process.cwd(), 'configs', 'grok-cli');
            await fs.promises.mkdir(targetDir, { recursive: true });
            const suffix = crypto.randomBytes(4).toString('hex');
            credsPath = path.join(targetDir, `${Date.now()}_xai-${safeEmail}-${suffix}_oauth_creds.json`);
        }

        await fs.promises.mkdir(path.dirname(credsPath), { recursive: true });
        await fs.promises.writeFile(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });

        const relativePath = path.relative(process.cwd(), credsPath);
        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Credentials saved to ${relativePath}`);

        return { credsPath, relativePath };
    }

    async checkDuplicate({ sub, email, refreshToken, accessToken }) {
        const targetDir = path.join(process.cwd(), 'configs', 'grok-cli');

        try {
            if (!fs.existsSync(targetDir)) {
                return { isDuplicate: false };
            }

            const files = await fs.promises.readdir(targetDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                try {
                    const fullPath = path.join(targetDir, file);
                    const credentials = JSON.parse(await fs.promises.readFile(fullPath, 'utf8'));
                    const matched =
                        (sub && credentials.sub === sub) ||
                        (email && credentials.email === email) ||
                        (refreshToken && credentials.refresh_token === refreshToken) ||
                        (accessToken && credentials.access_token === accessToken);

                    if (matched) {
                        return {
                            isDuplicate: true,
                            existingPath: path.relative(process.cwd(), fullPath)
                        };
                    }
                } catch {
                    // 忽略无法解析的历史文件。
                }
            }
        } catch (error) {
            logger.warn(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Error checking duplicates: ${error.message}`);
        }

        return { isDuplicate: false };
    }
}

export async function refreshGrokCliTokensWithRetry(refreshToken, config = {}, fallback = {}, maxRetries = 3) {
    const auth = new GrokCliAuth(config);
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await auth.refreshTokens(refreshToken, fallback.token_endpoint, fallback);
        } catch (error) {
            lastError = error;
            logger.warn(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Retry ${i + 1}/${maxRetries} failed:`, error.message);

            if (i < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, i), 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

export async function batchImportGrokCliTokensStream(tokens, onProgress = null, skipDuplicateCheck = false) {
    const auth = new GrokCliAuth({});
    const results = {
        total: tokens.length,
        success: 0,
        failed: 0,
        details: []
    };

    for (let i = 0; i < tokens.length; i++) {
        const tokenData = tokens[i];
        const progressData = {
            index: i + 1,
            total: tokens.length,
            current: null
        };

        try {
            if (!tokenData || typeof tokenData !== 'object' || Array.isArray(tokenData)) {
                throw new Error('Token 数据必须是 JSON 对象');
            }

            if (tokenData.skipped || tokenData.error) {
                throw new Error(tokenData.reason || tokenData.error || 'skipped');
            }

            if (!tokenData.access_token) {
                throw new Error('Token 缺少必需字段 access_token');
            }

            let claims = {};
            for (const candidate of [tokenData.id_token, tokenData.access_token]) {
                if (!candidate) continue;
                claims = auth.parseJWT(candidate);
                if (Object.keys(claims).length > 0) break;
            }

            const sub = tokenData.sub || tokenData.subject || tokenData.user_id || claims.sub || '';
            const email = tokenData.email || tokenData.name || claims.email || (sub ? `xai-${sub}` : '');
            const refreshToken = tokenData.refresh_token || '';

            if (!skipDuplicateCheck) {
                const duplicateCheck = await auth.checkDuplicate({
                    sub,
                    email,
                    refreshToken,
                    accessToken: tokenData.access_token
                });

                if (duplicateCheck.isDuplicate) {
                    progressData.current = {
                        index: i + 1,
                        success: false,
                        error: 'duplicate',
                        email,
                        sub,
                        existingPath: duplicateCheck.existingPath
                    };
                    results.failed++;
                    results.details.push(progressData.current);
                    if (onProgress) {
                        onProgress({
                            ...progressData,
                            successCount: results.success,
                            failedCount: results.failed
                        });
                    }
                    continue;
                }
            }

            let expired = null;
            const expiredValue = tokenData.expired || tokenData.expiresAt || tokenData.expires_at || tokenData.expire;
            if (expiredValue) {
                const parsed = typeof expiredValue === 'number'
                    ? new Date(expiredValue > 1000000000000 ? expiredValue : expiredValue * 1000)
                    : new Date(expiredValue);
                expired = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
            }
            if (!expired && tokenData.expires_in) {
                const seconds = Number(tokenData.expires_in);
                if (Number.isFinite(seconds) && seconds > 0) {
                    expired = new Date(Date.now() + seconds * 1000).toISOString();
                }
            }
            if (!expired && claims.exp) {
                const claimExp = Number(claims.exp);
                if (Number.isFinite(claimExp)) {
                    const parsed = new Date(claimExp * 1000);
                    if (!Number.isNaN(parsed.getTime())) {
                        expired = parsed.toISOString();
                    }
                }
            }
            if (!expired) {
                expired = new Date(Date.now() + 3600 * 1000).toISOString();
            }

            const expiresIn = Math.max(0, Math.floor((new Date(expired).getTime() - Date.now()) / 1000));
            const credentials = {
                id_token: tokenData.id_token || '',
                access_token: tokenData.access_token,
                refresh_token: refreshToken,
                token_type: tokenData.token_type || 'Bearer',
                expires_in: Number.isFinite(expiresIn) ? expiresIn : 3600,
                last_refresh: tokenData.last_refresh || new Date().toISOString(),
                email,
                sub,
                type: 'xai',
                auth_kind: 'oauth',
                expired,
                base_url: tokenData.base_url || tokenData.xai_base_url || GROK_CLI_OAUTH_CONFIG.defaultApiBaseUrl,
                redirect_uri: tokenData.redirect_uri || GROK_CLI_OAUTH_CONFIG.redirectUri,
                token_endpoint: tokenData.token_endpoint || '',
                access_token_only: !refreshToken
            };

            const saveResult = await auth.saveCredentials(credentials);
            const relativePath = saveResult.relativePath;

            logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Token ${i + 1} imported: ${relativePath}`);

            progressData.current = {
                index: i + 1,
                success: true,
                email,
                sub,
                accessTokenOnly: !refreshToken,
                path: relativePath
            };
            results.success++;
            results.details.push(progressData.current);

            await autoLinkProviderConfigs(CONFIG, {
                onlyCurrentCred: true,
                credPath: relativePath
            });
        } catch (error) {
            logger.error(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Token ${i + 1} import failed: ${error.message}`);

            progressData.current = {
                index: i + 1,
                success: false,
                email: tokenData?.email || tokenData?.name,
                sub: tokenData?.sub || tokenData?.subject,
                error: error.message
            };
            results.failed++;
            results.details.push(progressData.current);
        }

        if (onProgress) {
            onProgress({
                ...progressData,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    }

    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: GROK_CLI_PROVIDER,
            count: results.success,
            timestamp: new Date().toISOString()
        });
    }

    return results;
}

export async function handleGrokCliOAuth(currentConfig, options = {}) {
    const auth = new GrokCliAuth(currentConfig);

    try {
        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Generating OAuth URL...`);

        if (global.grokCliOAuthSessions && global.grokCliOAuthSessions.size > 0) {
            logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Cleaning up old OAuth sessions...`);
            for (const [sessionId, session] of global.grokCliOAuthSessions.entries()) {
                try {
                    if (session.pollTimer) {
                        clearInterval(session.pollTimer);
                    }
                    session.cancelled = true;
                    global.grokCliOAuthSessions.delete(sessionId);
                } catch (error) {
                    logger.warn(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Failed to clean up session ${sessionId}: ${error.message}`);
                }
            }
        }

        const deviceCode = await auth.requestDeviceCode();
        const state = crypto.randomBytes(16).toString('hex');
        const tokenEndpoint = `${GROK_CLI_OAUTH_CONFIG.issuer}/oauth2/token`;
        const authUrl = deviceCode.verification_uri_complete || deviceCode.verification_uri;

        if (!global.grokCliOAuthSessions) {
            global.grokCliOAuthSessions = new Map();
        }

        const sessionId = state;
        const session = {
            auth,
            state,
            tokenEndpoint,
            deviceCode,
            cancelled: false,
            createdAt: Date.now()
        };

        global.grokCliOAuthSessions.set(sessionId, session);

        (async () => {
            try {
                logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Waiting for device authorization...`);
                const tokens = await auth.completeDeviceCodeFlow(
                    deviceCode,
                    tokenEndpoint,
                    () => session.cancelled || global.grokCliOAuthSessions.get(sessionId) !== session
                );
                if (session.cancelled || global.grokCliOAuthSessions.get(sessionId) !== session) {
                    return;
                }
                const claims = auth.parseJWT(tokens.id_token);
                const credentials = auth.buildCredentials(tokens, {
                    email: claims.email,
                    sub: claims.sub,
                    tokenEndpoint
                });
                if (session.cancelled || global.grokCliOAuthSessions.get(sessionId) !== session) {
                    return;
                }
                const saveResult = await auth.saveCredentials(credentials);
                if (session.cancelled || global.grokCliOAuthSessions.get(sessionId) !== session) {
                    return;
                }
                const savedCredentials = {
                    ...credentials,
                    credPath: saveResult.credsPath,
                    relativePath: saveResult.relativePath
                };

                global.grokCliOAuthSessions.delete(sessionId);

                if (session.cancelled) {
                    return;
                }

                broadcastEvent('oauth_success', {
                    provider: GROK_CLI_PROVIDER,
                    credPath: savedCredentials.credPath,
                    relativePath: savedCredentials.relativePath,
                    timestamp: new Date().toISOString(),
                    email: savedCredentials.email,
                    sub: savedCredentials.sub
                });

                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: savedCredentials.relativePath
                });

                logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} OAuth flow completed successfully`);
            } catch (error) {
                if (session.cancelled) {
                    return;
                }

                logger.error(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Failed to complete device OAuth flow: ${error.message}`);
                global.grokCliOAuthSessions.delete(sessionId);

                broadcastEvent('oauth_error', {
                    provider: GROK_CLI_PROVIDER,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        })();

        return {
            success: true,
            authUrl,
            authInfo: {
                provider: GROK_CLI_PROVIDER,
                method: 'oauth2-device',
                sessionId,
                userCode: deviceCode.user_code,
                verificationUri: deviceCode.verification_uri,
                expiresIn: deviceCode.expires_in,
                interval: deviceCode.interval,
                instructions: [
                    '1. 点击下方按钮打开 xAI 验证页面',
                    `2. 在页面中确认代码 ${deviceCode.user_code}`,
                    '3. 完成授权后 AIClient2API 会自动保存凭据',
                    '4. 无需将代码粘贴到 Grok Build'
                ]
            }
        };
    } catch (error) {
        logger.error(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Failed to generate OAuth URL: ${error.message}`);

        return {
            success: false,
            error: error.message,
            authInfo: {
                provider: GROK_CLI_PROVIDER,
                method: 'oauth2-pkce',
                instructions: [
                    `1. 确保端口 ${GROK_CLI_OAUTH_CONFIG.port} 未被占用`,
                    '2. 确保可以访问 auth.x.ai',
                    '3. 确保浏览器可以正常打开',
                    '4. 如果问题持续，请检查网络连接'
                ]
            }
        };
    }
}

export async function handleGrokCliOAuthCallback(code, state) {
    try {
        if (!global.grokCliOAuthSessions || !global.grokCliOAuthSessions.has(state)) {
            throw new Error('Invalid or expired OAuth session');
        }

        const session = global.grokCliOAuthSessions.get(state);
        const { auth, state: expectedState, pkce, tokenEndpoint } = session;

        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} Processing OAuth callback...`);

        const result = await auth.completeOAuthFlow(code, state, expectedState, pkce, tokenEndpoint);
        global.grokCliOAuthSessions.delete(state);

        broadcastEvent('oauth_success', {
            provider: GROK_CLI_PROVIDER,
            credPath: result.credPath,
            relativePath: result.relativePath,
            timestamp: new Date().toISOString(),
            email: result.email,
            sub: result.sub
        });

        await autoLinkProviderConfigs(CONFIG, {
            onlyCurrentCred: true,
            credPath: result.relativePath
        });

        logger.info(`${GROK_CLI_OAUTH_CONFIG.logPrefix} OAuth callback processed successfully`);

        return {
            success: true,
            message: 'Grok CLI authentication successful',
            credentials: result,
            email: result.email,
            sub: result.sub,
            credPath: result.credPath,
            relativePath: result.relativePath
        };
    } catch (error) {
        logger.error(`${GROK_CLI_OAUTH_CONFIG.logPrefix} OAuth callback failed: ${error.message}`);

        broadcastEvent('oauth_error', {
            provider: GROK_CLI_PROVIDER,
            error: error.message,
            timestamp: new Date().toISOString()
        });

        return {
            success: false,
            error: error.message
        };
    }
}
