import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { isUIApiPath } from '../utils/ui-utils.js';
import { getPluginManager } from '../core/plugin-manager.js';
import { resolvePluginStaticFile } from '../core/plugin-security.js';

// Import UI modules
import * as auth from '../ui-modules/auth.js';
import * as configApi from '../ui-modules/config-api.js';
import * as providerApi from '../ui-modules/provider-api.js';
import * as usageApi from '../ui-modules/usage-api.js';
import * as pluginApi from '../ui-modules/plugin-api.js';
import * as uploadConfigApi from '../ui-modules/upload-config-api.js';
import * as systemApi from '../ui-modules/system-api.js';
import * as updateApi from '../ui-modules/update-api.js';
import * as oauthApi from '../ui-modules/oauth-api.js';
import * as customModelsApi from '../ui-modules/custom-models-api.js';
import * as accessApi from '../ui-modules/access-api.js';
import * as eventBroadcast from '../ui-modules/event-broadcast.js';
import { HELP_DATA, API_GUIDE_DATA, API_EXAMPLES, formatHelpText, formatApiGuideText } from '../utils/docs-data.js';

// Re-export from event-broadcast module
export { broadcastEvent, initializeUIManagement, handleUploadOAuthCredentials, upload } from '../ui-modules/event-broadcast.js';

/**
 * Serve static files for the UI
 * @param {string} pathParam - The request path
 * @param {http.ServerResponse} res - The HTTP response object
 */
export async function serveStaticFiles(pathParam, res) {
    // 1. 尝试从系统 static 目录服务
    const staticRoot = path.resolve(process.cwd(), 'static');
    const requested = pathParam === '/' || pathParam === '/index.html'
        ? 'index.html'
        : pathParam.replace('/static/', '');
    let filePath = path.resolve(staticRoot, requested);

    // Prevent path traversal: ensure the resolved path stays inside staticRoot
    const relToStatic = path.relative(staticRoot, filePath);
    if (relToStatic.startsWith('..') || path.isAbsolute(relToStatic)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return true;
    }

    if (!existsSync(filePath)) {
        // 2. 尝试从插件目录服务
        const pluginManager = getPluginManager();
        const plugin = pluginManager.getPluginByStaticPath(pathParam);
        if (plugin && plugin._baseDir) {
            filePath = resolvePluginStaticFile(plugin, pathParam);
        }
    }

    if (existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.json': 'application/json',
            '.ico': 'image/x-icon'
        }[ext] || 'text/plain';

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(readFileSync(filePath));
        return true;
    }
    return false;
}

/**
 * Handle UI management API requests
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @returns {Promise<boolean>} - True if the request was handled by UI API
 */
export async function handleUIApiRequests(method, pathParam, req, res, currentConfig, providerPoolManager) {
    // 处理登录接口
    if (method === 'POST' && pathParam === '/api/login') {
        return await auth.handleLoginRequest(req, res);
    }

    // 健康检查接口（用于前端token验证）
    if (method === 'GET' && pathParam === '/api/health') {
        return await systemApi.handleHealthCheck(req, res);
    }
    
    // Handle UI management API requests (需要token验证)
    if (isUIApiPath(pathParam)) {
        // 检查token验证
        const isAuth = await auth.checkAuth(req);
        if (!isAuth) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end(JSON.stringify({
                error: {
                    message: 'Unauthorized access, please login first',
                    code: 'UNAUTHORIZED'
                }
            }));
            return true;
        }
    }

    // 文件上传API
    if (method === 'POST' && pathParam === '/api/upload-oauth-credentials') {
        return await eventBroadcast.handleUploadOAuthCredentials(req, res);
    }

    // Update admin password
    if (method === 'POST' && pathParam === '/api/admin-password') {
        return await configApi.handleUpdateAdminPassword(req, res);
    }

    // Get configuration
    if (method === 'GET' && pathParam === '/api/config') {
        return await configApi.handleGetConfig(req, res, currentConfig);
    }

    // Get access overview information for the simplified connection page
    if (method === 'GET' && pathParam === '/api/access-info') {
        return await accessApi.handleGetAccessInfo(req, res, currentConfig, providerPoolManager);
    }

    // Update configuration
    if (method === 'POST' && pathParam === '/api/config') {
        return await configApi.handleUpdateConfig(req, res, currentConfig);
    }

    // Get system information
    if (method === 'GET' && pathParam === '/api/system') {
        return await systemApi.handleGetSystem(req, res);
    }

    // Download today's log file
    if (method === 'GET' && pathParam === '/api/system/download-log') {
        return await systemApi.handleDownloadTodayLog(req, res);
    }

    // Clear today's log file
    if (method === 'POST' && pathParam === '/api/system/clear-log') {
        return await systemApi.handleClearTodayLog(req, res);
    }

    // Get provider pools summary
    if (method === 'GET' && pathParam === '/api/providers') {
        return await providerApi.handleGetProviders(req, res, currentConfig, providerPoolManager);
    }

    // Get supported provider types based on registered adapters
    if (method === 'GET' && pathParam === '/api/providers/supported') {
        return await providerApi.handleGetSupportedProviders(req, res, currentConfig, providerPoolManager);
    }

    // Get specific provider type details
    const providerTypeMatch = pathParam.match(/^\/api\/providers\/([^\/]+)$/);
    if (method === 'GET' && providerTypeMatch) {
        const providerType = decodeURIComponent(providerTypeMatch[1]);
        return await providerApi.handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Get available models for all providers or specific provider type
    if (method === 'GET' && pathParam === '/api/provider-models') {
        return await providerApi.handleGetProviderModels(req, res, currentConfig, providerPoolManager);
    }

    // Get available models for a specific provider type
    const providerModelsMatch = pathParam.match(/^\/api\/provider-models\/([^\/]+)$/);
    if (method === 'GET' && providerModelsMatch) {
        const providerType = decodeURIComponent(providerModelsMatch[1]);
        return await providerApi.handleGetProviderTypeModels(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Add new provider configuration
    if (method === 'POST' && pathParam === '/api/providers') {
        return await providerApi.handleAddProvider(req, res, currentConfig, providerPoolManager);
    }

    // Reset all providers health status for a specific provider type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'reset-health' as UUID
    const resetHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/reset-health$/);
    if (method === 'POST' && resetHealthMatch) {
        const providerType = decodeURIComponent(resetHealthMatch[1]);
        return await providerApi.handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Perform health check for all providers of a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'health-check' as UUID
    const healthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/health-check$/);
    if (method === 'POST' && healthCheckMatch) {
        const providerType = decodeURIComponent(healthCheckMatch[1]);
        return await providerApi.handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Detect available models for a specific provider node
    const detectModelsMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/detect-models$/);
    if (method === 'POST' && detectModelsMatch) {
        const providerType = decodeURIComponent(detectModelsMatch[1]);
        const providerUuid = detectModelsMatch[2];
        return await providerApi.handleDetectProviderModels(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Perform health check for a specific provider node
    const singleHealthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/health-check$/);
    if (method === 'POST' && singleHealthCheckMatch) {
        const providerType = decodeURIComponent(singleHealthCheckMatch[1]);
        const providerUuid = singleHealthCheckMatch[2];
        return await providerApi.handleSingleProviderHealthCheck(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Delete all unhealthy providers for a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'delete-unhealthy' as UUID
    const deleteUnhealthyMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/delete-unhealthy$/);
    if (method === 'DELETE' && deleteUnhealthyMatch) {
        const providerType = decodeURIComponent(deleteUnhealthyMatch[1]);
        return await providerApi.handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Refresh UUIDs for all unhealthy providers of a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'refresh-unhealthy-uuids' as UUID
    const refreshUnhealthyUuidsMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/refresh-unhealthy-uuids$/);
    if (method === 'POST' && refreshUnhealthyUuidsMatch) {
        const providerType = decodeURIComponent(refreshUnhealthyUuidsMatch[1]);
        return await providerApi.handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Disable/Enable specific provider configuration
    const disableEnableProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/(disable|enable)$/);
    if (disableEnableProviderMatch) {
        const providerType = decodeURIComponent(disableEnableProviderMatch[1]);
        const providerUuid = disableEnableProviderMatch[2];
        const action = disableEnableProviderMatch[3];
        return await providerApi.handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action);
    }

    // Refresh UUID for specific provider configuration
    const refreshUuidMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/refresh-uuid$/);
    if (method === 'POST' && refreshUuidMatch) {
        const providerType = decodeURIComponent(refreshUuidMatch[1]);
        const providerUuid = refreshUuidMatch[2];
        return await providerApi.handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Update specific provider configuration
    // NOTE: This generic route must be after all specific routes like /reset-health, /health-check, /delete-unhealthy
    const updateProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)$/);
    if (method === 'PUT' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];
        return await providerApi.handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Delete specific provider configuration
    if (method === 'DELETE' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];
        return await providerApi.handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Generate OAuth authorization URL for providers
    const generateAuthUrlMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/generate-auth-url$/);
    if (method === 'POST' && generateAuthUrlMatch) {
        const providerType = decodeURIComponent(generateAuthUrlMatch[1]);
        return await oauthApi.handleGenerateAuthUrl(req, res, currentConfig, providerType);
    }

    // Handle manual OAuth callback
    if (method === 'POST' && pathParam === '/api/oauth/manual-callback') {
        return await oauthApi.handleManualOAuthCallback(req, res);
    }

    // Server-Sent Events for real-time updates
    if (method === 'GET' && pathParam === '/api/events') {
        return await eventBroadcast.handleEvents(req, res);
    }

    // Get upload configuration files list
    if (method === 'GET' && pathParam === '/api/upload-configs') {
        return await uploadConfigApi.handleGetUploadConfigs(req, res, currentConfig, providerPoolManager);
    }

    // View specific configuration file
    const viewConfigMatch = pathParam.match(/^\/api\/upload-configs\/view\/(.+)$/);
    if (method === 'GET' && viewConfigMatch) {
        const filePath = decodeURIComponent(viewConfigMatch[1]);
        return await uploadConfigApi.handleViewConfigFile(req, res, filePath);
    }

    // Download specific configuration file
    const downloadConfigMatch = pathParam.match(/^\/api\/upload-configs\/download\/(.+)$/);
    if (method === 'GET' && downloadConfigMatch) {
        const filePath = decodeURIComponent(downloadConfigMatch[1]);
        return await uploadConfigApi.handleDownloadConfigFile(req, res, filePath);
    }

    // Delete specific configuration file
    const deleteConfigMatch = pathParam.match(/^\/api\/upload-configs\/delete\/(.+)$/);
    if (method === 'DELETE' && deleteConfigMatch) {
        const filePath = decodeURIComponent(deleteConfigMatch[1]);
        return await uploadConfigApi.handleDeleteConfigFile(req, res, filePath);
    }

    // Force expire specific configuration file
    const forceExpireConfigMatch = pathParam.match(/^\/api\/upload-configs\/force-expire\/(.+)$/);
    if (method === 'POST' && forceExpireConfigMatch) {
        const filePath = decodeURIComponent(forceExpireConfigMatch[1]);
        return await uploadConfigApi.handleForceExpireConfig(req, res, filePath, currentConfig, providerPoolManager);
    }

    // Download all configs as zip
    if (method === 'GET' && pathParam === '/api/upload-configs/download-all') {
        return await uploadConfigApi.handleDownloadAllConfigs(req, res);
    }

    // Delete all unbound config files
    if (method === 'DELETE' && pathParam === '/api/upload-configs/delete-unbound') {
        return await uploadConfigApi.handleDeleteUnboundConfigs(req, res, currentConfig, providerPoolManager);
    }

    // Quick link config to corresponding provider based on directory
    if (method === 'POST' && pathParam === '/api/quick-link-provider') {
        return await providerApi.handleQuickLinkProvider(req, res, currentConfig, providerPoolManager);
    }

    // Get usage limits for all providers
    if (method === 'GET' && pathParam === '/api/usage') {
        return await usageApi.handleGetUsage(req, res, currentConfig, providerPoolManager);
    }

    // Reset usage quota for a specific provider instance
    const usageResetInstanceMatch = pathParam.match(/^\/api\/usage\/([^\/]+)\/([^\/]+)\/reset$/);
    if (method === 'POST' && usageResetInstanceMatch) {
        const providerType = decodeURIComponent(usageResetInstanceMatch[1]);
        const providerUuid = decodeURIComponent(usageResetInstanceMatch[2]);
        return await usageApi.handleResetSingleInstanceUsage(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Get supported providers for usage query
    if (method === 'GET' && pathParam === '/api/usage/supported-providers') {
        return await usageApi.handleGetSupportedProviders(req, res);
    }

    // Get usage limits for a specific provider type
    const usageProviderMatch = pathParam.match(/^\/api\/usage\/([^\/]+)$/);
    if (method === 'GET' && usageProviderMatch) {
        const providerType = decodeURIComponent(usageProviderMatch[1]);
        return await usageApi.handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Get usage limits for a specific provider instance
    const usageInstanceMatch = pathParam.match(/^\/api\/usage\/([^\/]+)\/([^\/]+)$/);
    if (method === 'GET' && usageInstanceMatch) {
        const providerType = decodeURIComponent(usageInstanceMatch[1]);
        const providerUuid = decodeURIComponent(usageInstanceMatch[2]);
        return await usageApi.handleGetSingleInstanceUsage(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Check for updates - compare local VERSION with latest git tag
    if (method === 'GET' && pathParam === '/api/check-update') {
        return await updateApi.handleCheckUpdate(req, res);
    }

    // Perform update - git fetch and checkout to latest tag
    if (method === 'POST' && pathParam === '/api/update') {
        return await updateApi.handlePerformUpdate(req, res);
    }

    // Reload configuration files
    if (method === 'POST' && pathParam === '/api/reload-config') {
        return await configApi.handleReloadConfig(req, res, providerPoolManager);
    }

    // Restart service (worker process)
    if (method === 'POST' && pathParam === '/api/restart-service') {
        return await systemApi.handleRestartService(req, res);
    }

    // Get service mode information
    if (method === 'GET' && pathParam === '/api/service-mode') {
        return await systemApi.handleGetServiceMode(req, res);
    }

    // Help and API guide for remote AI calling
    if (method === 'GET' && pathParam === '/api/help') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const format = url.searchParams.get('format');
        
        if (format === 'text') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(formatHelpText().replace(/\x1b\[[0-9;]*m/g, '')); // 去掉颜色代码
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(HELP_DATA));
        }
        return true;
    }

    if (method === 'GET' && pathParam === '/api/example') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const format = url.searchParams.get('format');

        if (format === 'text') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(formatApiGuideText().replace(/\x1b\[[0-9;]*m/g, '')); // 去掉颜色代码
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                routes: API_GUIDE_DATA,
                examples: API_EXAMPLES
            }));
        }
        return true;
    }

    // Batch import Kiro refresh tokens with SSE (real-time progress)
    if (method === 'POST' && pathParam === '/api/kiro/batch-import-tokens') {
        return await oauthApi.handleBatchImportKiroTokens(req, res);
    }

    if (method === 'POST' && pathParam === '/api/gemini/batch-import-tokens') {
        return await oauthApi.handleBatchImportGeminiTokens(req, res);
    }

    if (method === 'POST' && pathParam === '/api/codex/batch-import-tokens') {
        return await oauthApi.handleBatchImportCodexTokens(req, res);
    }

    if (method === 'POST' && pathParam === '/api/grok-cli/batch-import-tokens') {
        return await oauthApi.handleBatchImportGrokCliTokens(req, res);
    }

    if (method === 'POST' && pathParam === '/api/codex/import-external-credentials') {
        return await oauthApi.handleImportCodexExternalCredentials(req, res);
    }

    if (method === 'POST' && pathParam === '/api/grok/batch-import-tokens') {
        return await oauthApi.handleBatchImportGrokTokens(req, res);
    }

    // Import AWS SSO credentials for Kiro
    if (method === 'POST' && pathParam === '/api/kiro/import-aws-credentials') {
        return await oauthApi.handleImportAwsCredentials(req, res);
    }

    // Get plugins list
    if (method === 'GET' && pathParam === '/api/plugins') {
        return await pluginApi.handleGetPlugins(req, res);
    }

    // Get market plugins
    if (method === 'GET' && pathParam === '/api/plugins/market') {
        return await pluginApi.handleGetMarketPlugins(req, res);
    }

    // Install plugin
    if (method === 'POST' && pathParam === '/api/plugins/install') {
        return await pluginApi.handleInstallPlugin(req, res);
    }

    // Upload plugin
    if (method === 'POST' && pathParam === '/api/plugins/upload') {
        return await pluginApi.handleUploadPlugin(req, res);
    }

    // Toggle plugin status
    const togglePluginMatch = pathParam.match(/^\/api\/plugins\/(.+)\/toggle$/);
    if (method === 'POST' && togglePluginMatch) {
        const pluginName = decodeURIComponent(togglePluginMatch[1]);
        return await pluginApi.handleTogglePlugin(req, res, pluginName);
    }

    // Uninstall plugin
    const uninstallPluginMatch = pathParam.match(/^\/api\/plugins\/(.+)$/);
    if (method === 'DELETE' && uninstallPluginMatch) {
        const pluginName = decodeURIComponent(uninstallPluginMatch[1]);
        return await pluginApi.handleUninstallPlugin(req, res, pluginName);
    }

    // Custom models management
    if (method === 'GET' && pathParam === '/api/custom-models') {
        return await customModelsApi.handleGetCustomModels(req, res, currentConfig);
    }

    if (method === 'POST' && pathParam === '/api/custom-models') {
        return await customModelsApi.handleAddCustomModel(req, res, currentConfig);
    }

    const customModelMatch = pathParam.match(/^\/api\/custom-models\/(.+)$/);
    if (customModelMatch) {
        const modelId = decodeURIComponent(customModelMatch[1]);
        if (method === 'PUT') {
            return await customModelsApi.handleUpdateCustomModel(req, res, currentConfig, modelId);
        }
        if (method === 'DELETE') {
            return await customModelsApi.handleDeleteCustomModel(req, res, currentConfig, modelId);
        }
    }

    return false;
}
