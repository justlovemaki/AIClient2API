import http from 'http';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { getProxyConfigForProvider } from '../utils/proxy-utils.js';

/**
 * Kiro OAuth 配置（支持多种认证方式）
 */
const KIRO_OAUTH_CONFIG = {
    // Kiro Auth Service 端点 (用于 Social Auth)
    authServiceEndpoint: 'https://prod.us-east-1.auth.desktop.kiro.dev',
    
    // AWS SSO OIDC 端点 (用于 Builder ID)
    ssoOIDCEndpoint: 'https://oidc.{{region}}.amazonaws.com',
    
    // AWS Builder ID 起始 URL
    builderIDStartURL: 'https://view.awsapps.com/start',
    
    // 本地回调端口范围（用于 Social Auth HTTP 回调）
    callbackPortStart: 19876,
    callbackPortEnd: 19880,
    
    // 超时配置
    authTimeout: 10 * 60 * 1000,  // 10 分钟
    pollInterval: 5000,           // 5 秒
    
    // CodeWhisperer Scopes
    scopes: [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        // 'codewhisperer:transformations',
        // 'codewhisperer:taskassist'
    ],
    
    // 凭据存储（符合现有规范）
    credentialsDir: '.kiro',
    credentialsFile: 'oauth_creds.json',
    
    // 日志前缀
    logPrefix: '[Kiro Auth]'
};

/**
 * 活动的 Kiro 回调服务器管理
 */
const activeKiroServers = new Map();

/**
 * 活动的 Kiro 轮询任务管理（用于 Builder ID Device Code）
 */
const activeKiroPollingTasks = new Map();

/**
 * 创建带代理支持的 fetch 请求
 * 使用 axios 替代原生 fetch，以正确支持代理配置
 * @param {string} url - 请求 URL
 * @param {Object} options - fetch 选项（兼容 fetch API 格式）
 * @param {string} providerType - 提供商类型，用于获取代理配置
 * @returns {Promise<Object>} 返回类似 fetch Response 的对象
 */
async function fetchWithProxy(url, options = {}, providerType) {
    const proxyConfig = getProxyConfigForProvider(CONFIG, providerType);

    // 构建 axios 配置
    const axiosConfig = {
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 30000, // 30 秒超时
    };

    // 处理请求体
    if (options.body) {
        axiosConfig.data = options.body;
    }

    // 配置代理
    if (proxyConfig) {
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        axiosConfig.proxy = false; // 禁用 axios 内置代理，使用我们的 agent
        logger.info(`[OAuth] Using proxy for ${providerType}: ${CONFIG.PROXY_URL}`);
    }

    try {
        const axios = (await import('axios')).default;
        const response = await axios(axiosConfig);
        
        // 返回类似 fetch Response 的对象
        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            json: async () => response.data,
            text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        };
    } catch (error) {
        // 处理 axios 错误，转换为类似 fetch 的响应格式
        if (error.response) {
            // 服务器返回了错误状态码
            return {
                ok: false,
                status: error.response.status,
                statusText: error.response.statusText,
                headers: error.response.headers,
                json: async () => error.response.data,
                text: async () => typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data),
            };
        }
        // 网络错误或其他错误
        throw error;
    }
}

/**
 * 生成 HTML 响应页面
 * @param {boolean} isSuccess - 是否成功
 * @param {string} message - 显示消息
 * @returns {string} HTML 内容
 */
function generateResponsePage(isSuccess, message) {
    const title = isSuccess ? '授权成功！' : '授权失败';
    const countdownHtml = isSuccess ? `
        <p>此窗口将在 <span id="countdown" style="font-weight: bold; color: #2196f3;">10</span> 秒后自动关闭。</p>
        <p style="font-size: 12px; color: #999;">提示：您可以按 F12 查看详细日志。</p>
        <script>
            console.log("Kiro OAuth Result:", ${JSON.stringify(message)});
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
            max-width: 400px;
            width: 90%;
        }
        h1 { color: ${isSuccess ? '#4caf50' : '#f44336'}; margin-top: 0; }
        p { color: #666; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${isSuccess ? '✅' : '❌'} ${title}</h1>
        <p>${message}</p>
        ${countdownHtml}
    </div>
</body>
</html>`;
}

/**
 * 生成 PKCE 代码验证器
 * @returns {string} Base64URL 编码的随机字符串
 */
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * 生成 PKCE 代码挑战
 * @param {string} codeVerifier - 代码验证器
 * @returns {string} Base64URL 编码的 SHA256 哈希
 */
function generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256');
    hash.update(codeVerifier);
    return hash.digest('base64url');
}

/**
 * 处理 Kiro OAuth 授权（统一入口）
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 *   - method: 'google' | 'github' | 'builder-id'
 *   - saveToConfigs: boolean
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleKiroOAuth(currentConfig, options = {}) {
    const method = options.method || options.authMethod || 'google';  // 默认使用 Google，同时支持 authMethod 参数
    
    logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Starting OAuth with method: ${method}`);
    
    switch (method) {
        case 'google':
            return handleKiroSocialAuth('Google', currentConfig, options);
        case 'github':
            return handleKiroSocialAuth('Github', currentConfig, options);
        case 'builder-id':
            return handleKiroBuilderIDDeviceCode(currentConfig, options);
        default:
            throw new Error(`不支持的认证方式: ${method}`);
    }
}

/**
 * Kiro Social Auth (Google/GitHub) - 使用 HTTP localhost 回调
 */
async function handleKiroSocialAuth(provider, currentConfig, options = {}) {
    // 生成 PKCE 参数
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('base64url');
    
    // 启动本地回调服务器并获取端口
    let handlerPort;
    const providerKey = 'claude-kiro-oauth';
    const serverOptions = { ...options, socialProvider: provider };
    
    if (options.port) {
        const port = parseInt(options.port);
        await closeKiroServer(providerKey, port);
        const server = await createKiroHttpCallbackServer(port, codeVerifier, state, serverOptions);
        activeKiroServers.set(providerKey, { server, port });
        handlerPort = port;
    } else {
        handlerPort = await startKiroCallbackServer(codeVerifier, state, serverOptions);
    }
    
    // 使用 HTTP localhost 作为 redirect_uri
    const redirectUri = `kiro://kiro.kiroAgent/authenticate-success`;
    
    // 构建授权 URL (按照用户提供的逻辑修复)
    const authUrl = `${KIRO_OAUTH_CONFIG.authServiceEndpoint}/login?` +
        `idp=${provider}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=S256&` +
        `state=${state}`;
    
    return {
        authUrl,
        authInfo: {
            provider: 'claude-kiro-oauth',
            authMethod: 'social',
            socialProvider: provider,
            port: handlerPort,
            redirectUri: redirectUri,
            state: state,
            ...options
        }
    };
}

/**
 * Kiro Builder ID - Device Code Flow（类似 Qwen OAuth 模式）
 */
async function handleKiroBuilderIDDeviceCode(currentConfig, options = {}) {
    // 停止之前的轮询任务
    for (const [existingTaskId] of activeKiroPollingTasks.entries()) {
        if (existingTaskId.startsWith('kiro-')) {
            stopKiroPollingTask(existingTaskId);
        }
    }

    // 获取 Builder ID Start URL（优先使用前端传入的值，否则使用默认值）
    const builderIDStartURL = options.builderIDStartURL || KIRO_OAUTH_CONFIG.builderIDStartURL;
    logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Using Builder ID Start URL: ${builderIDStartURL}`);

    // 1. 注册 OIDC 客户端
    const region = options.region || 'us-east-1';
    const ssoOIDCEndpoint = KIRO_OAUTH_CONFIG.ssoOIDCEndpoint.replace('{{region}}', region);
    
    const regResponse = await fetchWithProxy(`${ssoOIDCEndpoint}/client/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'KiroIDE'
        },
        body: JSON.stringify({
            clientName: 'Kiro IDE',
            clientType: 'public',
            scopes: KIRO_OAUTH_CONFIG.scopes,
            // grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
        })
    }, 'claude-kiro-oauth');
    
    if (!regResponse.ok) {
        throw new Error(`Kiro OAuth 客户端注册失败: ${regResponse.status}`);
    }
    
    const regData = await regResponse.json();
    
    // 2. 启动设备授权
    const authResponse = await fetchWithProxy(`${ssoOIDCEndpoint}/device_authorization`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            clientId: regData.clientId,
            clientSecret: regData.clientSecret,
            startUrl: builderIDStartURL
        })
    }, 'claude-kiro-oauth');
    
    if (!authResponse.ok) {
        throw new Error(`Kiro OAuth 设备授权失败: ${authResponse.status}`);
    }
    
    const deviceAuth = await authResponse.json();
    
    // 3. 启动后台轮询（类似 Qwen OAuth 的模式）
    const taskId = `kiro-${deviceAuth.deviceCode.substring(0, 8)}-${Date.now()}`;

    
    // 异步轮询
    pollKiroBuilderIDToken(
        regData.clientId,
        regData.clientSecret,
        deviceAuth.deviceCode,
        5, 
        300, 
        taskId,
        { ...options, region }
    ).catch(error => {
        logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} 轮询失败 [${taskId}]:`, error);
        broadcastEvent('oauth_error', {
            provider: 'claude-kiro-oauth',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    });
    
    return {
        authUrl: deviceAuth.verificationUriComplete,
        authInfo: {
            provider: 'claude-kiro-oauth',
            authMethod: 'builder-id',
            deviceCode: deviceAuth.deviceCode,
            userCode: deviceAuth.userCode,
            verificationUri: deviceAuth.verificationUri,
            verificationUriComplete: deviceAuth.verificationUriComplete,
            expiresIn: deviceAuth.expiresIn,
            interval: deviceAuth.interval,
            ...options
        }
    };
}

/**
 * 轮询获取 Kiro Builder ID Token
 */
async function pollKiroBuilderIDToken(clientId, clientSecret, deviceCode, interval, expiresIn, taskId, options = {}) {
    let credPath = path.join(os.homedir(), KIRO_OAUTH_CONFIG.credentialsDir, KIRO_OAUTH_CONFIG.credentialsFile);
    const maxAttempts = Math.floor(expiresIn / interval);
    let attempts = 0;
    
    const taskControl = { shouldStop: false };
    activeKiroPollingTasks.set(taskId, taskControl);
    
    logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 开始轮询令牌 [${taskId}]`);
    
    const poll = async () => {
        if (taskControl.shouldStop) {
            throw new Error('轮询任务已被取消');
        }
        
        if (attempts >= maxAttempts) {
            activeKiroPollingTasks.delete(taskId);
            throw new Error('授权超时');
        }
        
        attempts++;
        
        try {
            const region = options.region || 'us-east-1';
            const ssoOIDCEndpoint = KIRO_OAUTH_CONFIG.ssoOIDCEndpoint.replace('{{region}}', region);
            const response = await fetchWithProxy(`${ssoOIDCEndpoint}/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'KiroIDE'
                },
                body: JSON.stringify({
                    clientId,
                    clientSecret,
                    deviceCode,
                    grantType: 'urn:ietf:params:oauth:grant-type:device_code'
                })
            }, 'claude-kiro-oauth');
            
            const data = await response.json();
            
            if (response.ok && data.accessToken) {
                logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 成功获取令牌 [${taskId}]`);
                
                // 保存令牌（符合现有规范）
                if (options.saveToConfigs) {
                    const timestamp = Date.now();
                    const folderName = `${timestamp}_kiro-auth-token`;
                    const targetDir = path.join(process.cwd(), 'configs', 'kiro', folderName);
                    await fs.promises.mkdir(targetDir, { recursive: true });
                    credPath = path.join(targetDir, `${folderName}.json`);
                }
                
                const tokenData = {
                    accessToken: data.accessToken,
                    refreshToken: data.refreshToken,
                    expiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
                    authMethod: 'builder-id',
                    clientId,
                    clientSecret,
                    region: options.region || 'us-east-1',
                    idcRegion: options.region || 'us-east-1'
                };
                
                await fs.promises.mkdir(path.dirname(credPath), { recursive: true });
                await fs.promises.writeFile(credPath, JSON.stringify(tokenData, null, 2));
                
                activeKiroPollingTasks.delete(taskId);
                
                // 广播成功事件（符合现有规范）
                broadcastEvent('oauth_success', {
                    provider: 'claude-kiro-oauth',
                    credPath,
                    relativePath: path.relative(process.cwd(), credPath),
                    timestamp: new Date().toISOString()
                });
                
                // 自动关联新生成的凭据到 Pools
                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: path.relative(process.cwd(), credPath)
                });
                
                return tokenData;
            }
            
            // 检查错误类型
            if (data.error === 'authorization_pending') {
                logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 等待用户授权 [${taskId}]... (${attempts}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, interval * 1000));
                return poll();
            } else if (data.error === 'slow_down') {
                await new Promise(resolve => setTimeout(resolve, (interval + 5) * 1000));
                return poll();
            } else {
                activeKiroPollingTasks.delete(taskId);
                throw new Error(`授权失败: ${data.error || '未知错误'}`);
            }
        } catch (error) {
            if (error.message.includes('授权') || error.message.includes('取消')) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, interval * 1000));
            return poll();
        }
    };
    
    return poll();
}

/**
 * 停止 Kiro 轮询任务
 */
function stopKiroPollingTask(taskId) {
    const task = activeKiroPollingTasks.get(taskId);
    if (task) {
        task.shouldStop = true;
        activeKiroPollingTasks.delete(taskId);
        logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 已停止轮询任务: ${taskId}`);
    }
}

/**
 * 启动 Kiro 回调服务器（用于 Social Auth HTTP 回调）
 */
async function startKiroCallbackServer(codeVerifier, expectedState, options = {}) {
    const providerKey = 'claude-kiro-oauth';
    const portStart = KIRO_OAUTH_CONFIG.callbackPortStart;
    const portEnd = KIRO_OAUTH_CONFIG.callbackPortEnd;
    
    // 启动前先尝试关闭该提供商已有的服务器
    await closeKiroServer(providerKey);
    
    for (let port = portStart; port <= portEnd; port++) {
        // 如果端口被本系统其他 OAuth 任务占用，也尝试关闭
        await closeKiroServer(null, port);
        
        try {
            const server = await createKiroHttpCallbackServer(port, codeVerifier, expectedState, { ...options, providerKey });
            activeKiroServers.set(providerKey, { server, port });
            logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 回调服务器已启动于端口 ${port}`);
            return port;
        } catch (err) {
            if (err.code === 'EADDRINUSE') {
                logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 端口 ${port} 被占用 (EADDRINUSE)，尝试下一个...`);
            } else {
                logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} 在端口 ${port} 启动服务器时出错: ${err.message}`);
            }
        }
    }
    
    throw new Error('所有端口都被占用，无法启动回调服务器');
}

/**
 * 关闭 Kiro 服务器
 */
async function closeKiroServer(provider, port = null) {
    if (provider) {
        const existing = activeKiroServers.get(provider);
        if (existing) {
            try {
                const serverPort = existing.port;
                logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 正在关闭提供商 ${provider} 在端口 ${serverPort} 上的服务器...`);
                
                // 强行关闭所有活跃连接 (Node.js 18.2+)
                if (existing.server.closeAllConnections) {
                    existing.server.closeAllConnections();
                }

                const closePromise = new Promise((resolve, reject) => {
                    existing.server.close((err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('关闭超时 (2s)')), 2000);
                });

                await Promise.race([closePromise, timeoutPromise]);
                logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 已成功关闭提供商 ${provider} 在端口 ${serverPort} 上的旧服务器`);
            } catch (error) {
                logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} 关闭提供商 ${provider} 服务器时遇到问题 (可能已释放或正在关闭): ${error.message}`);
            } finally {
                // 只有当 Map 中还是这个实例时才删除 (双重检查)
                const current = activeKiroServers.get(provider);
                if (current && current.server === existing.server) {
                    activeKiroServers.delete(provider);
                }
            }
        }
    }

    if (port) {
        // 查找占用该端口的其他提供商并关闭
        const providersToClose = [];
        for (const [p, info] of activeKiroServers.entries()) {
            if (info.port === port) {
                providersToClose.push(p);
            }
        }
        
        for (const p of providersToClose) {
            await closeKiroServer(p);
        }
    }
}

/**
 * 创建 Kiro HTTP 回调服务器
 */
function createKiroHttpCallbackServer(port, codeVerifier, expectedState, options = {}) {
    const redirectUri = `kiro://kiro.kiroAgent/authenticate-success`;
    const providerKey = options.providerKey || 'claude-kiro-oauth';
    
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                
                if (url.pathname === '/oauth/callback' || url.pathname === '/authenticate-success') {
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const errorParam = url.searchParams.get('error');
                    
                    if (errorParam) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `授权失败: ${errorParam}`));
                        return;
                    }
                    
                    if (state !== expectedState) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, 'State 验证失败'));
                        return;
                    }
                    
                    // 交换 Code 获取 Token（使用动态的 redirect_uri）
                    const tokenResponse = await fetchWithProxy(`${KIRO_OAUTH_CONFIG.authServiceEndpoint}/oauth/token`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'AIClient2API/1.0.0'
                        },
                        body: JSON.stringify({
                            grant_type: 'authorization_code',
                            code,
                            code_verifier: codeVerifier,
                            redirect_uri: redirectUri
                        })
                    }, 'claude-kiro-oauth');
                    
                    if (!tokenResponse.ok) {
                        const errorText = await tokenResponse.text();
                        logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token exchange failed:`, errorText);
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateResponsePage(false, `获取令牌失败: ${tokenResponse.status}`));
                        return;
                    }
                    
                    const tokenData = await tokenResponse.json();
                    
                    // 保存令牌
                    let credPath = path.join(os.homedir(), KIRO_OAUTH_CONFIG.credentialsDir, KIRO_OAUTH_CONFIG.credentialsFile);
                    
                    if (options.saveToConfigs) {
                        const timestamp = Date.now();
                        const folderName = `${timestamp}_kiro-auth-token`;
                        const targetDir = path.join(process.cwd(), 'configs', 'kiro', folderName);
                        await fs.promises.mkdir(targetDir, { recursive: true });
                        credPath = path.join(targetDir, `${folderName}.json`);
                    }
                    
                    const arnRegionMatch = typeof tokenData.profileArn === 'string'
                        ? tokenData.profileArn.match(/^arn:aws:codewhisperer:([a-z0-9-]+):/i)
                        : null;
                    const saveData = {
                        accessToken: tokenData.accessToken,
                        refreshToken: tokenData.refreshToken,
                        profileArn: tokenData.profileArn,
                        socialProvider: options.socialProvider,
                        expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000).toISOString(),
                        authMethod: 'social',
                        region: arnRegionMatch?.[1] || 'us-east-1'
                    };
                    
                    await fs.promises.mkdir(path.dirname(credPath), { recursive: true });
                    await fs.promises.writeFile(credPath, JSON.stringify(saveData, null, 2));
                    
                    logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 令牌已保存: ${credPath}`);
                    
                    // 广播成功事件
                    broadcastEvent('oauth_success', {
                        provider: 'claude-kiro-oauth',
                        credPath,
                        relativePath: path.relative(process.cwd(), credPath),
                        timestamp: new Date().toISOString()
                    });
                    
                    // 自动关联新生成的凭据到 Pools
                    await autoLinkProviderConfigs(CONFIG, {
                        onlyCurrentCred: true,
                        credPath: path.relative(process.cwd(), credPath)
                    });
                    
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(true, '授权成功！您可以关闭此页面'));
                    
                    // 关闭服务器
                    server.close(() => {
                        const current = activeKiroServers.get(providerKey);
                        if (current && current.server === server) {
                            activeKiroServers.delete(providerKey);
                            logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 服务器已正常关闭并从活跃列表移除`);
                        }
                    });
                    
                } else {
                    res.writeHead(204);
                    res.end();
                }
            } catch (error) {
                logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} 处理回调出错:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `服务器错误: ${error.message}`));
            }
        });
        
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
        
        // 超时自动关闭
        setTimeout(() => {
            if (server.listening) {
                server.close(() => {
                    const current = activeKiroServers.get(providerKey);
                    if (current && current.server === server) {
                        activeKiroServers.delete(providerKey);
                        logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 服务器因超时关闭并从活跃列表移除`);
                    }
                });
            }
        }, KIRO_OAUTH_CONFIG.authTimeout);
    });
}

/**
 * Kiro Token 刷新常量
 */
const KIRO_REFRESH_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    CONTENT_TYPE_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    DEFAULT_PROVIDER: 'Google',
    REQUEST_TIMEOUT: 30000,
    DEFAULT_REGION: 'us-east-1',
    IDC_REGION: 'us-east-1'  // 用于 REFRESH_IDC_URL 的区域配置
};

/**
 * 通过 refreshToken 获取 accessToken
 * @param {string} refreshToken - Kiro 的 refresh token
 * @param {string} region - AWS 区域 (默认: us-east-1)
 * @returns {Promise<Object>} 包含 accessToken 等信息的对象
 */
async function refreshKiroToken(refreshToken, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION) {
    const refreshUrl = KIRO_REFRESH_CONSTANTS.REFRESH_URL.replace('{{region}}', region);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), KIRO_REFRESH_CONSTANTS.REQUEST_TIMEOUT);
    
    try {
        const response = await fetchWithProxy(refreshUrl, {
            method: 'POST',
            headers: {
                'Content-Type': KIRO_REFRESH_CONSTANTS.CONTENT_TYPE_JSON
            },
            body: JSON.stringify({ refreshToken }),
            signal: controller.signal
        }, 'claude-kiro-oauth');
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data.accessToken) {
            throw new Error('Invalid refresh response: Missing accessToken');
        }
        
        const expiresIn = data.expiresIn || 3600;
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        
        const arnRegionMatch = typeof data.profileArn === 'string'
            ? data.profileArn.match(/^arn:aws:codewhisperer:([a-z0-9-]+):/i)
            : null;
        return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken || refreshToken,
            profileArn: data.profileArn || '',
            expiresAt: expiresAt,
            authMethod: KIRO_REFRESH_CONSTANTS.AUTH_METHOD_SOCIAL,
            provider: KIRO_REFRESH_CONSTANTS.DEFAULT_PROVIDER,
            region: arnRegionMatch?.[1] || region
        };
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    }
}

/**
 * 检查 Kiro 凭据是否已存在（基于 refreshToken + provider 组合）
 * @param {string} refreshToken - 要检查的 refreshToken
 * @param {string} provider - 提供商名称 (默认: 'claude-kiro-oauth')
 * @returns {Promise<{isDuplicate: boolean, existingPath?: string}>} 检查结果
 */
export async function checkKiroCredentialsDuplicate(refreshToken, provider = 'claude-kiro-oauth') {
    const kiroDir = path.join(process.cwd(), 'configs', 'kiro');
    
    try {
        // 检查 configs/kiro 目录是否存在
        if (!fs.existsSync(kiroDir)) {
            return { isDuplicate: false };
        }
        
        // 递归扫描所有 JSON 文件
        const scanDirectory = async (dirPath) => {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                    const result = await scanDirectory(fullPath);
                    if (result.isDuplicate) {
                        return result;
                    }
                } else if (entry.isFile() && entry.name.endsWith('.json')) {
                    try {
                        const content = await fs.promises.readFile(fullPath, 'utf8');
                        const credentials = JSON.parse(content);
                        
                        // 检查 refreshToken 是否匹配
                        if (credentials.refreshToken && credentials.refreshToken === refreshToken) {
                            const relativePath = path.relative(process.cwd(), fullPath);
                            logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Found duplicate refreshToken in: ${relativePath}`);
                            return {
                                isDuplicate: true,
                                existingPath: relativePath
                            };
                        }
                    } catch (parseError) {
                        // 忽略解析错误的文件
                    }
                }
            }
            
            return { isDuplicate: false };
        };
        
        return await scanDirectory(kiroDir);
        
    } catch (error) {
        logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Error checking duplicates:`, error.message);
        return { isDuplicate: false };
    }
}

/**
 * 批量导入 Kiro refreshToken 并生成凭据文件
 * @param {string[]} refreshTokens - refreshToken 数组
 * @param {string} region - AWS 区域 (默认: us-east-1)
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查 (默认: false)
 * @returns {Promise<Object>} 批量处理结果
 */
export async function batchImportKiroRefreshTokens(refreshTokens, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION, skipDuplicateCheck = false) {
    const results = {
        total: refreshTokens.length,
        success: 0,
        failed: 0,
        details: []
    };
    
    for (let i = 0; i < refreshTokens.length; i++) {
        const refreshToken = refreshTokens[i].trim();
        
        if (!refreshToken) {
            results.details.push({
                index: i + 1,
                success: false,
                error: 'Empty token'
            });
            results.failed++;
            continue;
        }
        
        // 检查重复
        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkKiroCredentialsDuplicate(refreshToken);
            if (duplicateCheck.isDuplicate) {
                results.details.push({
                    index: i + 1,
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                });
                results.failed++;
                continue;
            }
        }
        
        try {
            logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 正在刷新第 ${i + 1}/${refreshTokens.length} 个 token...`);
            
            const tokenData = await refreshKiroToken(refreshToken, region);
            
            // 生成文件路径: configs/kiro/{timestamp}_kiro-auth-token/{timestamp}_kiro-auth-token.json
            const timestamp = Date.now();
            const folderName = `${timestamp}_kiro-auth-token`;
            const targetDir = path.join(process.cwd(), 'configs', 'kiro', folderName);
            await fs.promises.mkdir(targetDir, { recursive: true });
            
            const credPath = path.join(targetDir, `${folderName}.json`);
            await fs.promises.writeFile(credPath, JSON.stringify(tokenData, null, 2));
            
            const relativePath = path.relative(process.cwd(), credPath);
            
            logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 已保存: ${relativePath}`);
            
            results.details.push({
                index: i + 1,
                success: true,
                path: relativePath,
                expiresAt: tokenData.expiresAt
            });
            results.success++;
            
        } catch (error) {
            logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 刷新失败:`, error.message);
            
            results.details.push({
                index: i + 1,
                success: false,
                error: error.message
            });
            results.failed++;
        }
    }
    
    // 如果有成功的，广播事件并自动关联
    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: 'claude-kiro-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });
        
        // 自动关联新生成的凭据到 Pools
        for (const detail of results.details) {
            if (detail.success && detail.path) {
                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: detail.path
                });
            }
        }
    }
    
    return results;
}

/**
 * 批量导入 Kiro refreshToken 并生成凭据文件（流式版本，支持实时进度回调）
 * @param {string[]} refreshTokens - refreshToken 数组
 * @param {string} region - AWS 区域 (默认: us-east-1)
 * @param {Function} onProgress - 进度回调函数，每处理完一个 token 调用
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查 (默认: false)
 * @returns {Promise<Object>} 批量处理结果
 */
export async function batchImportKiroRefreshTokensStream(refreshTokens, region = KIRO_REFRESH_CONSTANTS.DEFAULT_REGION, onProgress = null, skipDuplicateCheck = false) {
    const results = {
        total: refreshTokens.length,
        success: 0,
        failed: 0,
        details: []
    };
    
    for (let i = 0; i < refreshTokens.length; i++) {
        const refreshToken = refreshTokens[i].trim();
        const progressData = {
            index: i + 1,
            total: refreshTokens.length,
            current: null
        };
        
        if (!refreshToken) {
            progressData.current = {
                index: i + 1,
                success: false,
                error: 'Empty token'
            };
            results.details.push(progressData.current);
            results.failed++;
            
            // 发送进度更新
            if (onProgress) {
                onProgress({
                    ...progressData,
                    successCount: results.success,
                    failedCount: results.failed
                });
            }
            continue;
        }
        
        // 检查重复
        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkKiroCredentialsDuplicate(refreshToken);
            if (duplicateCheck.isDuplicate) {
                progressData.current = {
                    index: i + 1,
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                };
                results.details.push(progressData.current);
                results.failed++;
                
                // 发送进度更新
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
        
        try {
            logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} 正在刷新第 ${i + 1}/${refreshTokens.length} 个 token...`);
            
            const tokenData = await refreshKiroToken(refreshToken, region);
            
            // 生成文件路径: configs/kiro/{timestamp}_kiro-auth-token/{timestamp}_kiro-auth-token.json
            const timestamp = Date.now();
            const folderName = `${timestamp}_kiro-auth-token`;
            const targetDir = path.join(process.cwd(), 'configs', 'kiro', folderName);
            await fs.promises.mkdir(targetDir, { recursive: true });
            
            const credPath = path.join(targetDir, `${folderName}.json`);
            await fs.promises.writeFile(credPath, JSON.stringify(tokenData, null, 2));
            
            const relativePath = path.relative(process.cwd(), credPath);
            
            logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 已保存: ${relativePath}`);
            
            progressData.current = {
                index: i + 1,
                success: true,
                path: relativePath,
                expiresAt: tokenData.expiresAt
            };
            results.details.push(progressData.current);
            results.success++;
            
        } catch (error) {
            logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} Token ${i + 1} 刷新失败:`, error.message);
            
            progressData.current = {
                index: i + 1,
                success: false,
                error: error.message
            };
            results.details.push(progressData.current);
            results.failed++;
        }
        
        // 发送进度更新
        if (onProgress) {
            onProgress({
                ...progressData,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    }
    
    // 如果有成功的，广播事件并自动关联
    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: 'claude-kiro-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });
        
        // 自动关联新生成的凭据到 Pools
        for (const detail of results.details) {
            if (detail.success && detail.path) {
                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: detail.path
                });
            }
        }
    }
    
    return results;
}

/**
 * 导入 AWS SSO 凭据用于 Kiro (Builder ID 模式)
 * 从用户上传的 AWS SSO cache 文件中导入凭据
 * @param {Object} credentials - 合并后的凭据对象，需包含 clientId 和 clientSecret
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查 (默认: false)
 * @returns {Promise<Object>} 导入结果
 */
export async function importAwsCredentials(credentials, skipDuplicateCheck = false) {
    try {
        // 验证必需字段 - 需要四个字段都存在
        const missingFields = [];
        if (!credentials.clientId) missingFields.push('clientId');
        if (!credentials.clientSecret) missingFields.push('clientSecret');
        if (!credentials.accessToken) missingFields.push('accessToken');
        if (!credentials.refreshToken) missingFields.push('refreshToken');
        
        if (missingFields.length > 0) {
            return {
                success: false,
                error: `Missing required fields: ${missingFields.join(', ')}`
            };
        }
        
        // 检查重复凭据
        if (!skipDuplicateCheck) {
            const duplicateCheck = await checkKiroCredentialsDuplicate(credentials.refreshToken);
            if (duplicateCheck.isDuplicate) {
                return {
                    success: false,
                    error: 'duplicate',
                    existingPath: duplicateCheck.existingPath
                };
            }
        }
        
        logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Importing AWS credentials...`);
        
        // 准备凭据数据 - 四个字段都是必需的
        const credentialsData = {
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            authMethod: credentials.authMethod || 'builder-id',
            // region: credentials.region || KIRO_REFRESH_CONSTANTS.DEFAULT_REGION,
            idcRegion: credentials.idcRegion || KIRO_REFRESH_CONSTANTS.IDC_REGION
        };
        
        // 可选字段
        if (credentials.expiresAt) {
            credentialsData.expiresAt = credentials.expiresAt;
        }
        if (credentials.startUrl) {
            credentialsData.startUrl = credentials.startUrl;
        }
        if (credentials.registrationExpiresAt) {
            credentialsData.registrationExpiresAt = credentials.registrationExpiresAt;
        }
        
        // 尝试刷新获取最新的 accessToken
        try {
            logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Attempting to refresh token with provided credentials...`);
            
            const refreshRegion = credentials.idcRegion || KIRO_REFRESH_CONSTANTS.IDC_REGION;
            const refreshUrl = KIRO_REFRESH_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', refreshRegion);
            
            const refreshResponse = await fetchWithProxy(refreshUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    refreshToken: credentials.refreshToken,
                    clientId: credentials.clientId,
                    clientSecret: credentials.clientSecret,
                    grantType: 'refresh_token'
                })
            }, 'claude-kiro-oauth');
            
            if (refreshResponse.ok) {
                const tokenData = await refreshResponse.json();
                credentialsData.accessToken = tokenData.accessToken;
                credentialsData.refreshToken = tokenData.refreshToken;
                const expiresIn = tokenData.expiresIn || 3600;
                credentialsData.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
                logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} Token refreshed successfully`);
            } else {
                logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Token refresh failed, saving original credentials`);
            }
        } catch (refreshError) {
            logger.warn(`${KIRO_OAUTH_CONFIG.logPrefix} Token refresh error:`, refreshError.message);
            // 继续保存原始凭据
        }
        
        // 生成文件路径: configs/kiro/{timestamp}_kiro-auth-token/{timestamp}_kiro-auth-token.json
        const timestamp = Date.now();
        const folderName = `${timestamp}_kiro-auth-token`;
        const targetDir = path.join(process.cwd(), 'configs', 'kiro', folderName);
        await fs.promises.mkdir(targetDir, { recursive: true });
        
        const credPath = path.join(targetDir, `${folderName}.json`);
        await fs.promises.writeFile(credPath, JSON.stringify(credentialsData, null, 2));
        
        const relativePath = path.relative(process.cwd(), credPath);
        
        logger.info(`${KIRO_OAUTH_CONFIG.logPrefix} AWS credentials saved to: ${relativePath}`);
        
        // 广播事件
        broadcastEvent('oauth_success', {
            provider: 'claude-kiro-oauth',
            relativePath: relativePath,
            timestamp: new Date().toISOString()
        });
        
        // 自动关联新生成的凭据到 Pools
        await autoLinkProviderConfigs(CONFIG, {
            onlyCurrentCred: true,
            credPath: relativePath
        });
        
        return {
            success: true,
            path: relativePath
        };
        
    } catch (error) {
        logger.error(`${KIRO_OAUTH_CONFIG.logPrefix} AWS credentials import failed:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}


