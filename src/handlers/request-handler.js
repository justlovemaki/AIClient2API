import deepmerge from 'deepmerge';
import logger from '../utils/logger.js';
import requestContext from '../utils/context.js';
import { handleError, getClientIp, getRequestBody } from '../utils/common.js';
import { handleUIApiRequests, serveStaticFiles } from '../services/ui-manager.js';
import { isUIPath, isUIApiPath } from '../utils/ui-utils.js';
import { handleAPIRequests } from '../services/api-manager.js';
import { getApiService, getProviderStatus } from '../services/service-manager.js';
import { getProviderPoolManager } from '../services/service-manager.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import { getRegisteredProviders, isRegisteredProvider } from '../providers/adapter.js';
import { countTokensAnthropic } from '../utils/token-utils.js';
import { PROMPT_LOG_FILENAME } from '../core/config-manager.js';
import { getPluginManager } from '../core/plugin-manager.js';
import { randomUUID } from 'crypto';
import { handleGrokAssetsProxy } from '../utils/grok-assets-proxy.js';

/**
 * Generate a short unique request ID (8 characters)
 */
function generateRequestId() {
    return randomUUID().slice(0, 8);
}

/**
 * Main request handler. It authenticates the request, determines the endpoint type,
 * and delegates to the appropriate specialized handler function.
 * @param {Object} config - The server configuration
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @returns {Function} - The request handler function
 */
export function createRequestHandler(config, providerPoolManager) {
    return async function requestHandler(req, res) {
        // Generate unique request ID and set it in logger context
        const clientIp = getClientIp(req, config);
        const requestId = `${clientIp}:${generateRequestId()}`;

        return requestContext.run({ requestId }, async () => {
            return logger.runWithContext(requestId, async () => {
                // Deep copy the config for each request to allow dynamic modification
                const currentConfig = deepmerge({}, config);
                currentConfig._monitorRequestId = requestId;
                
                // 计算当前请求的基础 URL
                const protocol = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
                const host = req.headers.host;
                currentConfig.requestBaseUrl = `${protocol}://${host}`;
                
                const requestUrl = new URL(req.url, `http://${req.headers.host}`);
                let path = requestUrl.pathname;
                // 规范化路径：移除末尾斜杠（除非是根路径）
                if (path.length > 1 && path.endsWith('/')) {
                    path = path.slice(0, -1);
                    requestUrl.pathname = path;
                }
                const method = req.method;

                try {
                    // Set CORS headers for all requests
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
                    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key, Model-Provider, X-Requested-With, Accept, Origin');
                    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours cache for preflight

                    // Handle CORS preflight requests
                    if (method === 'OPTIONS') {
                        res.writeHead(204);
                        res.end();
                        return;
                    }

                    // Serve static files for UI (除了登录页面需要认证)
                    // 检查是否是插件静态文件
                    const pluginManager = getPluginManager();
                    const isPluginStatic = pluginManager.isPluginStaticPath(path);
                    
                    // 如果 UI 已禁用，拦截所有 UI 相关的静态资源请求
                    const _isUIPath = isUIPath(path);
                    
                    if (!currentConfig.UI_ENABLED) {
                        if (_isUIPath || isPluginStatic) {
                            handleError(res, { status: 404, message: 'UI static files are disabled' }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        }
                    }

                    // 尝试处理 UI 相关的请求
                    if (currentConfig.UI_ENABLED) {
                         // 如果启用了 UI，或者请求的不是 UI 静态资源（可能是 API），则继续
                         if (_isUIPath || isPluginStatic) {
                            const pluginStaticOwner = isPluginStatic ? pluginManager.getPluginByStaticPath(path) : null;
                            if (pluginStaticOwner && !pluginStaticOwner._enabled) {
                                res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
                                res.end(JSON.stringify({
                                    success: false,
                                    error: {
                                        message: `插件未启用：${pluginStaticOwner.name}`,
                                        code: 'PLUGIN_DISABLED'
                                    }
                                }));
                                return;
                            }
                            const served = await serveStaticFiles(path, res);
                            if (served) return;
                        }
                    }

                    // 执行插件路由
                    const pluginRouteHandled = await pluginManager.executeRoutes(method, path, req, res, currentConfig);
                    if (pluginRouteHandled) return;

                    // 处理 UI API 请求（即使 UI_ENABLED 为 false，API 也保持可用）
                    const uiHandled = await handleUIApiRequests(method, path, req, res, currentConfig, providerPoolManager);
                    if (uiHandled) return;

                    // logger.info(`\n${new Date().toLocaleString()}`);
                    logger.info(`[Server] Received request: ${req.method} http://${req.headers.host}${req.url}`);

                    // Health check endpoint
                    if (method === 'GET' && path === '/health') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            status: 'healthy',
                            timestamp: new Date().toISOString(),
                            provider: currentConfig.MODEL_PROVIDER
                        }));
                        return true;
                    }

                    // Grok assets proxy endpoint
                    if (method === 'GET' && path === '/api/grok/assets') {
                        await handleGrokAssetsProxy(req, res, currentConfig, providerPoolManager);
                        return true;
                    }

                    // providers health endpoint
                    // url params: provider[string], customName[string], unhealthRatioThreshold[float]
                    // 支持provider, customName过滤记录 
                    // 支持unhealthRatioThreshold控制不健康比例的阈值, 当unhealthyRatio超过阈值返回summaryHealthy: false
                    if (method === 'GET' && path === '/provider_health') {
                        try {
                            const provider = requestUrl.searchParams.get('provider');
                            const customName = requestUrl.searchParams.get('customName');
                            let unhealthRatioThreshold = requestUrl.searchParams.get('unhealthRatioThreshold');
                            unhealthRatioThreshold = unhealthRatioThreshold === null ? 0.0001 : parseFloat(unhealthRatioThreshold);
                            let provideStatus = await getProviderStatus(currentConfig, { provider, customName });
                            let summaryHealth = true;
                            if (!isNaN(unhealthRatioThreshold)) {
                                summaryHealth = provideStatus.unhealthyRatio <= unhealthRatioThreshold;
                            }
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                timestamp: new Date().toISOString(),
                                items: provideStatus.providerPoolsSlim,
                                count: provideStatus.count,
                                unhealthyCount: provideStatus.unhealthyCount,
                                unhealthyRatio: provideStatus.unhealthyRatio,
                                unhealthySummeryMessage: provideStatus.unhealthySummeryMessage,
                                summaryHealth
                            }));
                            return true;
                        } catch (error) {
                            logger.info(`[Server] req provider_health error: ${error.message}`);
                            handleError(res, { status: 500, message: `Failed to get providers health: ${error.message}` }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        }
                    }


                    // Handle API requests
                    // Allow overriding MODEL_PROVIDER via request header
                    const modelProviderHeader = req.headers['model-provider'];
                    if (modelProviderHeader) {
                        if (isRegisteredProvider(modelProviderHeader)) {
                            currentConfig.MODEL_PROVIDER = modelProviderHeader;
                            // 标记提供商来自用户显式指定，自定义模型路由不会跨提供商选择
                            currentConfig.PROVIDER_EXPLICIT = true;
                            logger.info(`[Config] MODEL_PROVIDER overridden by header to: ${currentConfig.MODEL_PROVIDER}`);
                        } else {
                            logger.warn(`[Config] Provider ${modelProviderHeader} in header is not available.`);
                            handleError(res, { status: 400, message: `Provider ${modelProviderHeader} in header is not available.` }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        }
                    }
                    
                    // Check if the first path segment matches a MODEL_PROVIDER and switch if it does
                    const pathSegments = path.split('/').filter(segment => segment.length > 0);
                    
                    if (pathSegments.length > 0) {
                        const firstSegment = pathSegments[0];
                        const isValidProvider = isRegisteredProvider(firstSegment);
                        const isAutoMode = firstSegment === MODEL_PROVIDER.AUTO;

                        if (firstSegment && (isValidProvider || isAutoMode)) {
                            currentConfig.MODEL_PROVIDER = firstSegment;
                            // 标记提供商来自用户显式指定（auto 例外：它本身代表「不指定」）
                            currentConfig.PROVIDER_EXPLICIT = !isAutoMode;
                            logger.info(`[Config] MODEL_PROVIDER overridden by path segment to: ${currentConfig.MODEL_PROVIDER}`);
                            pathSegments.shift();
                            path = '/' + pathSegments.join('/');
                            requestUrl.pathname = path;
                        } else if (firstSegment && Object.values(MODEL_PROVIDER).includes(firstSegment)) {
                            // 如果在 MODEL_PROVIDER 中但没注册适配器，拦截并报错
                            logger.warn(`[Config] Provider ${firstSegment} is recognized but no adapter is registered.`);
                            handleError(res, { status: 400, message: `Provider ${firstSegment} is not available.` }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        } else if (firstSegment && !isValidProvider) {
                            logger.info(`[Config] Ignoring invalid MODEL_PROVIDER in path segment: ${firstSegment}`);
                        }
                    }

                    // 1. 执行认证流程（只有 type='auth' 的插件参与）
                    const authResult = await pluginManager.executeAuth(req, res, requestUrl, currentConfig);
                    if (authResult.handled) {
                        // 认证插件已处理请求（如发送了错误响应）
                        return;
                    }
                    if (!authResult.authorized) {
                        // 没有认证插件授权，使用 handleError 返回 401
                        handleError(res, { status: 401, message: 'Unauthorized: API key is invalid or missing.' }, currentConfig.MODEL_PROVIDER, null, req);
                        return;
                    }
                    
                    // 2. 执行普通中间件（type!='auth' 的插件）
                    const middlewareResult = await pluginManager.executeMiddleware(req, res, requestUrl, currentConfig);
                    if (middlewareResult.handled) {
                        // 中间件已处理请求
                        return;
                    }

                    // Handle count_tokens requests (Anthropic API compatible)
                    if (path.includes('/count_tokens') && method === 'POST') {
                        try {
                            const body = await getRequestBody(req, { maxBytes: 1024 * 1024 * 2 }); // Limit to 1MB
                            logger.info(`[Server] Handling count_tokens request for model: ${body.model}`);

                            // Use common utility method directly
                            try {
                                const result = countTokensAnthropic(body);
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify(result));
                            } catch (tokenError) {
                                logger.warn(`[Server] Common countTokens failed, falling back: ${tokenError.message}`);
                                // Last resort: return 0
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ input_tokens: 0 }));
                            }
                            return true;
                        } catch (error) {
                            logger.error(`[Server] count_tokens error: ${error.message}`);
                            handleError(res, { status: 500, message: `Failed to count tokens: ${error.message}` }, currentConfig.MODEL_PROVIDER, null, req);
                            return;
                        }
                    }

                    // 获取或选择 API Service 实例
                    let apiService;
                    // try {
                    //     apiService = await getApiService(currentConfig);
                    // } catch (error) {
                    //     handleError(res, { statusCode: 500, message: `Failed to get API service: ${error.message}` }, currentConfig.MODEL_PROVIDER);
                    //     const poolManager = getProviderPoolManager();
                    //     if (poolManager) {
                    //         poolManager.markProviderUnhealthy(currentConfig.MODEL_PROVIDER, {
                    //             uuid: currentConfig.uuid
                    //         });
                    //     }
                    //     return;
                    // }

                    try {
                        // Handle API requests
                        const apiHandled = await handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, PROMPT_LOG_FILENAME);
                        if (apiHandled) return;

                        // Fallback for unmatched routes
                        handleError(res, { status: 404, message: 'Not Found' }, currentConfig.MODEL_PROVIDER, null, req);
                    } catch (error) {
                        handleError(res, error, currentConfig.MODEL_PROVIDER, null, req);
                    }
                } finally {
                    // AsyncLocalStorage 自动管理生命周期，不再需要手动清理
                }
            });
        });
    };

}
