import '../core/security-hardening.js';
import logger from '../utils/logger.js';
import * as http from 'http';
import { initializeConfig, CONFIG } from '../core/config-manager.js';
import { initApiService, autoLinkProviderConfigs } from './service-manager.js';
import { initializeUIManagement } from './ui-manager.js';
import { initializeAPIManagement } from './api-manager.js';
import { createRequestHandler } from '../handlers/request-handler.js';
import { discoverPlugins, getPluginManager } from '../core/plugin-manager.js';
import { getTLSSidecar } from '../utils/tls-sidecar.js';
import { HEALTH_CHECK } from '../utils/constants.js';
import { initializeAdminPassword } from '../ui-modules/auth.js';

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * 描述 / Description:
 * (最终生产就绪版本 / Final Production Ready Version)
 * 此脚本创建一个独立的 Node.js HTTP 服务器，作为 Google Cloud Code Assist API 的本地代理。
 * 此版本包含所有功能和错误修复，设计为健壮、灵活且易于通过全面可控的日志系统进行监控。
 * 
 * This script creates a standalone Node.js HTTP server that acts as a local proxy for the Google Cloud Code Assist API.
 * This version includes all features and bug fixes, designed to be robust, flexible, and easy to monitor through a comprehensive and controllable logging system.
 *
 * 主要功能 / Key Features:
 * - OpenAI & Gemini & Claude 多重兼容性：无缝桥接使用 OpenAI API 格式的客户端与 Google Gemini API。支持原生 Gemini API (`/v1beta`) 和 OpenAI 兼容 (`/v1`) 端点。
 *   OpenAI & Gemini & Claude Dual Compatibility: Seamlessly bridges clients using the OpenAI API format with the Google Gemini API. Supports both native Gemini API (`/v1beta`) and OpenAI-compatible (`/v1`) endpoints.
 * 
 * - 强大的身份验证管理：支持多种身份验证方法，包括通过 Base64 字符串、文件路径或自动发现本地凭据的 OAuth 2.0 配置。能够自动刷新过期令牌以确保服务持续运行。
 *   Robust Authentication Management: Supports multiple authentication methods, including OAuth 2.0 configuration via Base64 strings, file paths, or automatic discovery of local credentials. Capable of automatically refreshing expired tokens to ensure continuous service operation.
 * 
 * - 灵活的 API 密钥验证：支持三种 API 密钥验证方法：`Authorization: Bearer <key>` 请求头、`x-goog-api-key` 请求头和 `?key=` URL 查询参数，可通过 `--api-key` 启动参数配置。
 *   Flexible API Key Validation: Supports three API key validation methods: `Authorization: Bearer <key>` request header, `x-goog-api-key` request header, and `?key=` URL query parameter, configurable via the `--api-key` startup parameter.
 * 
 * - 动态系统提示管理 / Dynamic System Prompt Management:
 *   - 文件注入：通过 `--system-prompt-file` 从外部文件加载系统提示，并通过 `--system-prompt-mode` 控制其行为（覆盖或追加）。
 *     File Injection: Loads system prompts from external files via `--system-prompt-file` and controls their behavior (overwrite or append) with `--system-prompt-mode`.
 *   - 实时同步：能够将请求中包含的系统提示实时写入 `configs/fetch_system_prompt.txt` 文件，便于开发者观察和调试。
 *     Real-time Synchronization: Capable of writing system prompts included in requests to the `fetch_system_prompt.txt` file in real-time, facilitating developer observation and debugging.
 * 
 * - 智能请求转换和修复：自动将 OpenAI 格式的请求转换为 Gemini 格式，包括角色映射（`assistant` -> `model`）、合并来自同一角色的连续消息以及修复缺失的 `role` 字段。
 *   Intelligent Request Conversion and Repair: Automatically converts OpenAI-formatted requests to Gemini format, including role mapping (`assistant` -> `model`), merging consecutive messages from the same role, and fixing missing `role` fields.
 * 
 * - 全面可控的日志系统：提供两种日志模式（控制台或文件），详细记录每个请求的输入和输出、剩余令牌有效性等信息，用于监控和调试。
 *   Comprehensive and Controllable Logging System: Provides two logging modes (console or file), detailing input and output of each request, remaining token validity, and other information for monitoring and debugging.
 * 
 * - 高度可配置的启动：支持通过命令行参数配置服务监听地址、端口、项目 ID、API 密钥和日志模式。
 *   Highly Configurable Startup: Supports configuring service listening address, port, project ID, API key, and logging mode via command-line parameters.
 *
 * 使用示例 / Usage Examples:
 * 
 * 基本用法 / Basic Usage:
 * node src/api-server.js
 * 
 * 服务器配置 / Server Configuration:
 * node src/api-server.js --host 0.0.0.0 --port 8080 --api-key your-secret-key
 * 
 * OpenAI 提供商 / OpenAI Provider:
 * node src/api-server.js --model-provider openai-custom --openai-api-key sk-xxx --openai-base-url https://api.openai.com/v1
 * 
 * Claude 提供商 / Claude Provider:
 * node src/api-server.js --model-provider claude-custom --claude-api-key sk-ant-xxx --claude-base-url https://api.anthropic.com
 * 
 * Gemini 提供商（使用 Base64 凭据的 OAuth）/ Gemini Provider (OAuth with Base64 credentials):
 * node src/api-server.js --model-provider gemini-cli --gemini-oauth-creds-base64 eyJ0eXBlIjoi... --project-id your-project-id
 * 
 * Gemini 提供商（使用凭据文件的 OAuth）/ Gemini Provider (OAuth with credentials file):
 * node src/api-server.js --model-provider gemini-cli --gemini-oauth-creds-file /path/to/credentials.json --project-id your-project-id
 * 
 * 系统提示管理 / System Prompt Management:
 * node src/api-server.js --system-prompt-file custom-prompt.txt --system-prompt-mode append
 * 
 * 日志配置 / Logging Configuration:
 * node src/api-server.js --log-prompts console
 * node src/api-server.js --log-prompts file --prompt-log-base-name my-logs
 * 
 * 完整示例 / Complete Example:
 * node src/api-server.js \
 *   --host 0.0.0.0 \
 *   --port 3000 \
 *   --api-key my-secret-key \
 *   --model-provider gemini-cli-oauth \
 *   --project-id my-gcp-project \
 *   --gemini-oauth-creds-file ./credentials.json \
 *   --system-prompt-file ./custom-system-prompt.txt \
 *   --system-prompt-mode overwrite \
 *   --log-prompts file \
 *   --prompt-log-base-name api-logs
 * 
 * 命令行参数 / Command Line Parameters:
 * --host <address>                    服务器监听地址 / Server listening address (default: 0.0.0.0)
 * --port <number>                     服务器监听端口 / Server listening port (default: 3000)
 * --api-key <key>                     身份验证所需的 API 密钥 / Required API key for authentication (default: 123456)
 * --model-provider <provider[,provider...]> AI 模型提供商 / AI model provider: openai-custom, claude-custom, gemini-cli-oauth, claude-kiro-oauth
 * --openai-api-key <key>             OpenAI API 密钥 / OpenAI API key (for openai-custom provider)
 * --openai-base-url <url>            OpenAI API 基础 URL / OpenAI API base URL (for openai-custom provider)
 * --claude-api-key <key>             Claude API 密钥 / Claude API key (for claude-custom provider)
 * --claude-base-url <url>            Claude API 基础 URL / Claude API base URL (for claude-custom provider)
 * --gemini-oauth-creds-base64 <b64>  Gemini OAuth 凭据的 Base64 字符串 / Gemini OAuth credentials as Base64 string
 * --gemini-oauth-creds-file <path>   Gemini OAuth 凭据 JSON 文件路径 / Path to Gemini OAuth credentials JSON file
 * --kiro-oauth-creds-base64 <b64>    Kiro OAuth 凭据的 Base64 字符串 / Kiro OAuth credentials as Base64 string
 * --kiro-oauth-creds-file <path>     Kiro OAuth 凭据 JSON 文件路径 / Path to Kiro OAuth credentials JSON file
 * --qwen-oauth-creds-file <path>     Qwen OAuth 凭据 JSON 文件路径 / Path to Qwen OAuth credentials JSON file
 * --project-id <id>                  Google Cloud 项目 ID / Google Cloud Project ID (for gemini-cli provider)
 * --system-prompt-file <path>        系统提示文件路径 / Path to system prompt file (default: configs/input_system_prompt.txt)
 * --system-prompt-mode <mode>        系统提示模式 / System prompt mode: overwrite or append (default: overwrite)
 * --log-prompts <mode>               提示日志模式 / Prompt logging mode: console, file, or none (default: none)
 * --prompt-log-base-name <name>      提示日志文件基础名称 / Base name for prompt log files (default: prompt_log)
 * --request-max-retries <number>     API 请求失败时，自动重试的最大次数。 / Max retries for API requests on failure (default: 3)
 * --request-base-delay <number>      自动重试之间的基础延迟时间（毫秒）。每次重试后延迟会增加。 / Base delay in milliseconds between retries, increases with each retry (default: 1000)
 * --cron-near-minutes <number>       OAuth 令牌刷新任务计划的间隔时间（分钟）。 / Interval for OAuth token refresh task in minutes (default: 15)
 * --cron-refresh-token <boolean>     是否开启 OAuth 令牌自动刷新任务 / Whether to enable automatic OAuth token refresh task (default: true)
 * --provider-pools-file <path>       提供商号池配置文件路径 / Path to provider pools configuration file (default: null)
 * --no-ui                           禁用前端管理界面 / Disable frontend management UI
 *
 */

import 'dotenv/config'; // Import dotenv and configure it
import '../converters/register-converters.js'; // 注册所有转换器
import { getProviderPoolManager } from './service-manager.js';
import { isRetryableNetworkError } from '../utils/common.js';

// 检测是否作为子进程运行
const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';

// 存储服务器实例，用于优雅关闭
let serverInstance = null;

/**
 * 发送消息给主进程
 * @param {Object} message - 消息对象
 */
function sendToMaster(message) {
    if (IS_WORKER_PROCESS && process.send) {
        process.send(message);
    }
}

/**
 * 设置子进程通信处理
 */
function setupWorkerCommunication() {
    if (!IS_WORKER_PROCESS) return;

    // 监听来自主进程的消息
    process.on('message', (message) => {
        if (!message || !message.type) return;

        logger.info('[Worker] Received message from master:', message.type);

        switch (message.type) {
            case 'shutdown':
                logger.info('[Worker] Shutdown requested by master');
                gracefulShutdown();
                break;
            case 'status':
                sendToMaster({
                    type: 'status',
                    data: {
                        pid: process.pid,
                        uptime: process.uptime(),
                        memoryUsage: process.memoryUsage()
                    }
                });
                break;
            default:
                logger.info('[Worker] Unknown message type:', message.type);
        }
    });

    // 监听断开连接
    process.on('disconnect', () => {
        logger.info('[Worker] Disconnected from master, shutting down...');
        gracefulShutdown();
    });
}

/**
 * 优雅关闭服务器
 */
async function gracefulShutdown() {
    logger.info('[Server] Initiating graceful shutdown...');

    // 停止所有插件
    try {
        const pluginManager = getPluginManager();
        if (pluginManager) {
            await pluginManager.destroyAll();
        }
    } catch (err) {
        logger.error('[Server] Error destroying plugins:', err.message);
    }

    // 停止 TLS sidecar
    try {
        await getTLSSidecar().stop();
    } catch { /* ignore */ }

    if (serverInstance) {
        serverInstance.close(() => {
            logger.info('[Server] HTTP server closed');
            process.exit(0);
        });

        // 设置超时，防止无限等待
        setTimeout(() => {
            logger.info('[Server] Shutdown timeout, forcing exit...');
            process.exit(1);
        }, 10000);
    } else {
        process.exit(0);
    }
}

/**
 * 设置进程信号处理
 */
function setupSignalHandlers() {
    process.on('SIGTERM', () => {
        logger.info('[Server] Received SIGTERM');
        gracefulShutdown();
    });

    process.on('SIGINT', () => {
        logger.info('[Server] Received SIGINT');
        gracefulShutdown();
    });

    process.on('uncaughtException', (error) => {
        logger.error('[Server] Uncaught exception:', error);
        
        // 检查是否为可重试的网络错误
        if (isRetryableNetworkError(error)) {
            logger.warn('[Server] Network error detected, continuing operation...');
            return; // 不退出程序，继续运行
        }
        
        // 对于其他严重错误，执行优雅关闭
        logger.error('[Server] Fatal error detected, initiating shutdown...');
        gracefulShutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
        
        // 检查是否为可重试的网络错误
        if (reason && isRetryableNetworkError(reason)) {
            logger.warn('[Server] Network error in promise rejection, continuing operation...');
            return; // 不退出程序，继续运行
        }
    });
}

// --- Server Initialization ---
async function startServer() {
    // Initialize configuration
    await initializeConfig(process.argv.slice(2), 'configs/config.json');

    // Ensure every installation starts with a unique admin password.
    await initializeAdminPassword();
    
    // 自动关联 configs 目录中的配置文件到对应的提供商
    // logger.info('[Initialization] Checking for unlinked provider configs...');
    // await autoLinkProviderConfigs(CONFIG);

    // Start TLS sidecar if enabled
    if (CONFIG.TLS_SIDECAR_ENABLED) {
        const sidecar = getTLSSidecar();
        const started = await sidecar.start({
            port: CONFIG.TLS_SIDECAR_PORT,
            binaryPath: CONFIG.TLS_SIDECAR_BINARY_PATH || undefined,
        });
        if (started) {
            logger.info('[Initialization] TLS sidecar started successfully');
        } else {
            logger.warn('[Initialization] TLS sidecar failed to start, falling back to Node.js TLS');
        }
    }

    // Initialize plugin system
    logger.info('[Initialization] Discovering and initializing plugins...');
    await discoverPlugins();
    const pluginManager = getPluginManager();
    await pluginManager.initAll(CONFIG);
    
    // Log loaded plugins
    const pluginList = await pluginManager.getPluginList();
    if (pluginList.length > 0) {
        logger.info(`[Plugins] Loaded ${pluginList.length} plugin(s):`);
        pluginList.forEach(p => {
            const status = p.enabled ? '✓' : '✗';
            logger.info(`  ${status} ${p.name} v${p.version} - ${p.description}`);
        });
    }

    // Initialize API services
    const services = await initApiService(CONFIG, true);
    
    // Initialize UI management features
    initializeUIManagement(CONFIG);
    
    // Initialize API management and get heartbeat function
    const heartbeatAndRefreshToken = initializeAPIManagement(services);
    
    // Create request handler
    const requestHandlerInstance = createRequestHandler(CONFIG, getProviderPoolManager());

    serverInstance = http.createServer({
        // 设置服务器级别的超时
        requestTimeout: 0, // 禁用请求超时（流式响应需要）
        headersTimeout: 60000, // 头部超时 60 秒
        keepAliveTimeout: 65000 // Keep-alive 超时
    }, requestHandlerInstance);

    // 设置服务器的最大连接数
    serverInstance.maxConnections = 1000;
    serverInstance.listen(CONFIG.SERVER_PORT, CONFIG.HOST, async () => {
        logger.info(`--- Unified API Server Configuration ---`);
        const configuredProviders = Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 0
            ? CONFIG.DEFAULT_MODEL_PROVIDERS
            : [CONFIG.MODEL_PROVIDER];
        const uniqueProviders = [...new Set(configuredProviders)];
        logger.info(`  Primary Model Provider: ${CONFIG.MODEL_PROVIDER}`);
        if (uniqueProviders.length > 1) {
            logger.info(`  Additional Model Providers: ${uniqueProviders.slice(1).join(', ')}`);
        }
        logger.info(`  System Prompt File: ${CONFIG.SYSTEM_PROMPT_FILE_PATH || 'Default'}`);
        logger.info(`  System Prompt Mode: ${CONFIG.SYSTEM_PROMPT_MODE}`);
        logger.info(`  Host: ${CONFIG.HOST}`);
        logger.info(`  Port: ${CONFIG.SERVER_PORT}`);
        logger.info(`  Required API Key: ${CONFIG.REQUIRED_API_KEY ? CONFIG.REQUIRED_API_KEY.slice(0, 4) + '****' : '(none)'}`);
        logger.info(`  Prompt Logging: ${CONFIG.PROMPT_LOG_MODE}${CONFIG.PROMPT_LOG_FILENAME ? ` (to ${CONFIG.PROMPT_LOG_FILENAME})` : ''}`);
        logger.info(`------------------------------------------`);
        logger.info(`\nUnified API Server running on http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}`);
        logger.info(`Supports multiple API formats:`);
        logger.info(`  • OpenAI-compatible: /v1/chat/completions, /v1/responses, /v1/models`);
        logger.info(`  • Gemini-compatible: /v1beta/models, /v1beta/models/{model}:generateContent`);
        logger.info(`  • Claude-compatible: /v1/messages`);
        logger.info(`  • Health check: /health`);
        logger.info(`  • UI Management Console: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/`);

        // Auto-open browser to UI (only if host is 0.0.0.0 or 127.0.0.1 and UI_ENABLED is true)
        if (CONFIG.UI_ENABLED) {
            try {
                const open = (await import('open')).default;
                // 作为子进程启动时，需要更长的延迟确保服务完全就绪
                const openDelay = IS_WORKER_PROCESS ? 3000 : 1000;
                setTimeout(() => {
                    let openUrl = `http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`;
                    if(CONFIG.HOST === '0.0.0.0'){
                        openUrl = `http://localhost:${CONFIG.SERVER_PORT}/login.html`;
                    }
                    open(openUrl)
                        .then(() => {
                            logger.info('[UI] Opened login page in default browser');
                        })
                        .catch(err => {
                            logger.info('[UI] Please open manually: http://' + CONFIG.HOST + ':' + CONFIG.SERVER_PORT + '/login.html');
                        });
                }, openDelay);
            } catch (err) {
                logger.info(`[UI] Login page available at: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`);
            }
        } else {
            logger.info(`[UI] UI is disabled.`);
        }

        if (CONFIG.CRON_REFRESH_TOKEN) {
            logger.info(`  • Cron Near Minutes: ${CONFIG.CRON_NEAR_MINUTES}`);
            logger.info(`  • Cron Refresh Token: ${CONFIG.CRON_REFRESH_TOKEN}`);
            // 每 CRON_NEAR_MINUTES 分钟执行一次心跳日志和令牌刷新
            setInterval(heartbeatAndRefreshToken, CONFIG.CRON_NEAR_MINUTES * 60 * 1000);
        }
        // 服务器完全启动后,执行初始健康检查
        const poolManager = getProviderPoolManager();
        if (poolManager) {
            logger.info('[Initialization] Performing initial health checks for provider pools...');
            poolManager.performInitialHealthChecks();
        }

        // 定时健康检查
        // 注意：无论初始 enabled 状态如何，都注册 reloadHealthCheckTimer，
        // 使得热更新时（从 disabled→enabled）config-api 能调用它启动 timer。
        const scheduledConfig = CONFIG.SCHEDULED_HEALTH_CHECK;
        {
            const DEFAULT_INTERVAL = CONFIG.CRON_NEAR_MINUTES * 60 * 1000;

            let isHealthCheckRunning = false;
            let healthCheckTimerId = null;

            // 定时健康检查函数（始终注册，无论初始 enabled 状态）
            const runHealthCheckTimer = (interval) => {
                // 清除旧的 timer
                if (healthCheckTimerId) {
                    clearInterval(healthCheckTimerId);
                    healthCheckTimerId = null;
                }
                // 重置运行状态，允许新的 timer 立即触发
                // 否则如果 reload 时正在运行，新 timer 的第一次触发会被跳过
                isHealthCheckRunning = false;

                // 设置定时任务
                // 设计决策：只验证最小值，不设最大值。
                // 前端有 max=3600000 (1小时) 的 UI 限制，但后端允许更大值以支持特殊需求。
                const safeInterval = (typeof interval === 'number' && interval >= HEALTH_CHECK.MIN_INTERVAL_MS) ? interval : DEFAULT_INTERVAL;
                healthCheckTimerId = setInterval(async () => {
                    if (isHealthCheckRunning) {
                        logger.debug('[ScheduledHealthCheck] Skipping - previous run still in progress');
                        return;
                    }
                    isHealthCheckRunning = true;
                    try {
                        await poolManager.performHealthChecks();
                    } catch (error) {
                        logger.error('[ScheduledHealthCheck] Error:', error);
                    } finally {
                        isHealthCheckRunning = false;
                    }
                }, safeInterval);
                logger.info(`[ScheduledHealthCheck] Scheduled every ${safeInterval}ms`);
                return safeInterval;
            };

            // 注册重载/停止函数到 globalThis（供 config-api 热更新使用）
            // 必须在 enabled 检查外注册，保证热更新时可访问
            globalThis.reloadHealthCheckTimer = runHealthCheckTimer;
            globalThis.stopHealthCheckTimer = () => {
                if (healthCheckTimerId) {
                    clearInterval(healthCheckTimerId);
                    healthCheckTimerId = null;
                    logger.info('[ScheduledHealthCheck] Timer stopped');
                }
            };

            if (scheduledConfig?.enabled) {
                let interval = scheduledConfig.interval;
                if (typeof interval !== 'number' || interval < HEALTH_CHECK.MIN_INTERVAL_MS) {
                    logger.warn(`[ScheduledHealthCheck] Invalid interval ${interval}, using default ${DEFAULT_INTERVAL}`);
                    interval = DEFAULT_INTERVAL;
                }

                // 启动时运行健康检查
                if (scheduledConfig.startupRun !== false) {
                    logger.info('[ScheduledHealthCheck] Running scheduled health check on startup...');
                    setTimeout(async () => {
                        try {
                            await poolManager.performHealthChecks();
                        } catch (error) {
                            logger.error('[ScheduledHealthCheck] Startup run error:', error);
                        }
                    }, 100);
                }

                // 设置定时任务
                const activeInterval = runHealthCheckTimer(interval);
                globalThis._activeHealthCheckInterval = activeInterval;
            }
        }

        // 如果是子进程，通知主进程已就绪
        if (IS_WORKER_PROCESS) {
            sendToMaster({ type: 'ready', pid: process.pid });
        }
    });
    return serverInstance; // Return the server instance for testing purposes
}

// 设置信号处理
setupSignalHandlers();

// 设置子进程通信
setupWorkerCommunication();

startServer().catch(err => {
    logger.error("[Server] Failed to start server:", err.message);
    process.exit(1);
});

// 导出用于外部调用
export { gracefulShutdown, sendToMaster };
