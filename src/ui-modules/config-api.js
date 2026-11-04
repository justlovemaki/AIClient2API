import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from '../core/config-manager.js';
import { serviceInstances } from '../providers/adapter.js';
import { initApiService } from '../services/service-manager.js';
import { getRequestBody } from '../utils/common.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import { HEALTH_CHECK, PASSWORD, NETWORK, RETRY } from '../utils/constants.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { validateCredentials, requireManagementAuth, requireAdminReauthentication } from './auth.js';
import { resolveSystemPromptPath, resolveProviderPoolsPath } from './config-file-policy.js';

function parseBooleanConfig(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return Boolean(value);
}

/**
 * 重载配置文件
 */
export async function reloadConfig(providerPoolManager) {
    try {
        const configPath = 'configs/config.json';
        // 使用文件锁进行重载，防止在写入期间读取
        return await withFileLock(configPath, async () => {
            // Import config manager dynamically
            const { initializeConfig } = await import('../core/config-manager.js');

            // Reload main config
            const newConfig = await initializeConfig(process.argv.slice(2), configPath);
            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = newConfig.providerPools;
                providerPoolManager.initializeProviderStatus(true);
            }

            // Update global CONFIG
            Object.assign(CONFIG, newConfig);
            logger.info('[UI API] Configuration reloaded:');

            // Update initApiService - 清空并重新初始化服务实例
            Object.keys(serviceInstances).forEach(key => delete serviceInstances[key]);
            initApiService(CONFIG);

            logger.info('[UI API] Configuration reloaded successfully');

            return newConfig;
        });
    } catch (error) {
        logger.error('[UI API] Failed to reload configuration:', error);
        throw error;
    }
}

/**
 * 获取配置
 */
export async function handleGetConfig(req, res, currentConfig) {
    let systemPrompt = '';

    if (currentConfig.SYSTEM_PROMPT_FILE_PATH && existsSync(currentConfig.SYSTEM_PROMPT_FILE_PATH)) {
        try {
            const promptPath = await resolveSystemPromptPath(currentConfig.SYSTEM_PROMPT_FILE_PATH);
            systemPrompt = await fs.readFile(promptPath, 'utf-8');
        } catch (e) {
            logger.warn('[UI API] Failed to read system prompt file:', e.message);
        }
    }

    // 白名单过滤：只返回前端需要的字段，避免泄露凭据路径、内部状态等敏感信息
    const safeConfig = {
        HOST: currentConfig.HOST,
        SERVER_PORT: currentConfig.SERVER_PORT,
        MODEL_PROVIDER: currentConfig.MODEL_PROVIDER,
        DEFAULT_MODEL_PROVIDERS: currentConfig.DEFAULT_MODEL_PROVIDERS,
        SYSTEM_PROMPT_FILE_PATH: currentConfig.SYSTEM_PROMPT_FILE_PATH,
        SYSTEM_PROMPT_MODE: currentConfig.SYSTEM_PROMPT_MODE,
        PROMPT_LOG_BASE_NAME: currentConfig.PROMPT_LOG_BASE_NAME,
        PROMPT_LOG_MODE: currentConfig.PROMPT_LOG_MODE,
        REQUEST_MAX_RETRIES: currentConfig.REQUEST_MAX_RETRIES,
        REQUEST_BASE_DELAY: currentConfig.REQUEST_BASE_DELAY,
        MODEL_FALLBACK_ENABLED: currentConfig.MODEL_FALLBACK_ENABLED !== false,
        CREDENTIAL_SWITCH_MAX_RETRIES: currentConfig.CREDENTIAL_SWITCH_MAX_RETRIES,
        RATE_LIMIT_COOLDOWN_ENABLED: currentConfig.RATE_LIMIT_COOLDOWN_ENABLED,
        RATE_LIMIT_COOLDOWN_MS: currentConfig.RATE_LIMIT_COOLDOWN_MS,
        RATE_LIMIT_COOLDOWN_JITTER_MS: currentConfig.RATE_LIMIT_COOLDOWN_JITTER_MS,
        RATE_LIMIT_COOLDOWN_MAX_MS: currentConfig.RATE_LIMIT_COOLDOWN_MAX_MS,
        CRON_NEAR_MINUTES: currentConfig.CRON_NEAR_MINUTES,
        CRON_REFRESH_TOKEN: currentConfig.CRON_REFRESH_TOKEN,
        LOGIN_EXPIRY: currentConfig.LOGIN_EXPIRY,
        TRUST_PROXY: currentConfig.TRUST_PROXY,
        TRUSTED_PROXY_IPS: currentConfig.TRUSTED_PROXY_IPS,
        PROVIDER_POOLS_FILE_PATH: currentConfig.PROVIDER_POOLS_FILE_PATH,
        CODEX_IMAGE_HELPER_MODEL: currentConfig.CODEX_IMAGE_HELPER_MODEL,
        MAX_ERROR_COUNT: currentConfig.MAX_ERROR_COUNT,
        SYSTEM_PROMPT_REPLACEMENTS: currentConfig.SYSTEM_PROMPT_REPLACEMENTS,
        WARMUP_TARGET: currentConfig.WARMUP_TARGET,
        REFRESH_CONCURRENCY_PER_PROVIDER: currentConfig.REFRESH_CONCURRENCY_PER_PROVIDER,
        providerFallbackChain: currentConfig.providerFallbackChain,
        modelFallbackMapping: currentConfig.modelFallbackMapping,
        PROXY_URL: currentConfig.PROXY_URL,
        PROXY_ENABLED_PROVIDERS: currentConfig.PROXY_ENABLED_PROVIDERS,
        TLS_SIDECAR_ENABLED: currentConfig.TLS_SIDECAR_ENABLED,
        TLS_SIDECAR_ENABLED_PROVIDERS: currentConfig.TLS_SIDECAR_ENABLED_PROVIDERS,
        TLS_SIDECAR_PORT: currentConfig.TLS_SIDECAR_PORT,
        TLS_SIDECAR_PROXY_URL: currentConfig.TLS_SIDECAR_PROXY_URL,
        LOG_ENABLED: currentConfig.LOG_ENABLED,
        LOG_OUTPUT_MODE: currentConfig.LOG_OUTPUT_MODE,
        LOG_LEVEL: currentConfig.LOG_LEVEL,
        LOG_DIR: currentConfig.LOG_DIR,
        LOG_INCLUDE_REQUEST_ID: currentConfig.LOG_INCLUDE_REQUEST_ID,
        LOG_INCLUDE_TIMESTAMP: currentConfig.LOG_INCLUDE_TIMESTAMP,
        LOG_MAX_FILE_SIZE: currentConfig.LOG_MAX_FILE_SIZE,
        LOG_MAX_FILES: currentConfig.LOG_MAX_FILES,
        SCHEDULED_HEALTH_CHECK: currentConfig.SCHEDULED_HEALTH_CHECK,
        // 脱敏：只返回是否设置了 API Key，不返回原文
        REQUIRED_API_KEY: currentConfig.REQUIRED_API_KEY ? '******' : '',
        systemPrompt,
        isDefaultPassword: await validateCredentials('admin123'),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safeConfig));
    return true;
}

/**
 * 更新配置
 */
export async function handleUpdateConfig(req, res, currentConfig) {
    try {
        const body = await getRequestBody(req);
        const configPath = 'configs/config.json';
        return await withFileLock(configPath, () => _handleUpdateConfig(req, res, currentConfig, body));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    }
}
async function _handleUpdateConfig(req, res, currentConfig, body) {
    try {
        const newConfig = body;
        if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Configuration must be an object' } }));
            return true;
        }
        // Validate BEFORE changing any config/timers or touching files. Also check
        // an inherited legacy path when the request supplies only prompt content.
        let promptPath;
        if (newConfig.SYSTEM_PROMPT_FILE_PATH !== undefined || newConfig.systemPrompt !== undefined) {
            promptPath = await resolveSystemPromptPath(newConfig.SYSTEM_PROMPT_FILE_PATH ?? currentConfig.SYSTEM_PROMPT_FILE_PATH ?? 'configs/input_system_prompt.txt');
        }
        if (newConfig.systemPrompt !== undefined && typeof newConfig.systemPrompt !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'System prompt must be a string' } }));
            return true;
        }

        let providerPoolsPath;
        if (newConfig.PROVIDER_POOLS_FILE_PATH !== undefined && newConfig.PROVIDER_POOLS_FILE_PATH !== null && newConfig.PROVIDER_POOLS_FILE_PATH !== '') {
            providerPoolsPath = await resolveProviderPoolsPath(newConfig.PROVIDER_POOLS_FILE_PATH);
        }

        // Update config values in memory（含类型校验）
        if (newConfig.REQUIRED_API_KEY !== undefined) {
            if (typeof newConfig.REQUIRED_API_KEY === 'string') {
                // 如果是脱敏后的字符串，则忽略更新，保留原值
                if (newConfig.REQUIRED_API_KEY !== '******') {
                    currentConfig.REQUIRED_API_KEY = newConfig.REQUIRED_API_KEY;
                }
            }
        }
        if (newConfig.HOST !== undefined) {
            if (typeof newConfig.HOST === 'string' && newConfig.HOST.length > 0) currentConfig.HOST = newConfig.HOST;
        }
        if (newConfig.SERVER_PORT !== undefined) {
            const port = Number(newConfig.SERVER_PORT);
            if (Number.isInteger(port) && port >= NETWORK.MIN_PORT && port <= NETWORK.MAX_PORT) currentConfig.SERVER_PORT = port;
        }
        if (newConfig.MODEL_PROVIDER !== undefined) currentConfig.MODEL_PROVIDER = newConfig.MODEL_PROVIDER;
        if (newConfig.SYSTEM_PROMPT_FILE_PATH !== undefined) {
            currentConfig.SYSTEM_PROMPT_FILE_PATH = path.relative(process.cwd(), promptPath);
        }
        if (newConfig.SYSTEM_PROMPT_MODE !== undefined) currentConfig.SYSTEM_PROMPT_MODE = newConfig.SYSTEM_PROMPT_MODE;
        if (newConfig.SYSTEM_PROMPT_REPLACEMENTS !== undefined) {
            if (Array.isArray(newConfig.SYSTEM_PROMPT_REPLACEMENTS)) {
                currentConfig.SYSTEM_PROMPT_REPLACEMENTS = newConfig.SYSTEM_PROMPT_REPLACEMENTS;
            }
        }
        if (newConfig.PROMPT_LOG_BASE_NAME !== undefined) currentConfig.PROMPT_LOG_BASE_NAME = newConfig.PROMPT_LOG_BASE_NAME;
        if (newConfig.PROMPT_LOG_MODE !== undefined) currentConfig.PROMPT_LOG_MODE = newConfig.PROMPT_LOG_MODE;
        if (newConfig.REQUEST_MAX_RETRIES !== undefined) {
            const v = Number(newConfig.REQUEST_MAX_RETRIES);
            if (Number.isInteger(v) && v >= 0 && v <= RETRY.MAX_RETRIES) currentConfig.REQUEST_MAX_RETRIES = v;
        }
        if (newConfig.REQUEST_BASE_DELAY !== undefined) currentConfig.REQUEST_BASE_DELAY = newConfig.REQUEST_BASE_DELAY;
        if (newConfig.MODEL_FALLBACK_ENABLED !== undefined) currentConfig.MODEL_FALLBACK_ENABLED = parseBooleanConfig(newConfig.MODEL_FALLBACK_ENABLED);
        if (newConfig.CREDENTIAL_SWITCH_MAX_RETRIES !== undefined) currentConfig.CREDENTIAL_SWITCH_MAX_RETRIES = newConfig.CREDENTIAL_SWITCH_MAX_RETRIES;
        if (newConfig.RATE_LIMIT_COOLDOWN_ENABLED !== undefined) currentConfig.RATE_LIMIT_COOLDOWN_ENABLED = parseBooleanConfig(newConfig.RATE_LIMIT_COOLDOWN_ENABLED);
        if (newConfig.RATE_LIMIT_COOLDOWN_MS !== undefined) {
            const v = Number(newConfig.RATE_LIMIT_COOLDOWN_MS);
            if (Number.isInteger(v) && v >= 0) currentConfig.RATE_LIMIT_COOLDOWN_MS = v;
        }
        if (newConfig.RATE_LIMIT_COOLDOWN_JITTER_MS !== undefined) {
            const v = Number(newConfig.RATE_LIMIT_COOLDOWN_JITTER_MS);
            if (Number.isInteger(v) && v >= 0) currentConfig.RATE_LIMIT_COOLDOWN_JITTER_MS = v;
        }
        if (newConfig.RATE_LIMIT_COOLDOWN_MAX_MS !== undefined) {
            const v = Number(newConfig.RATE_LIMIT_COOLDOWN_MAX_MS);
            if (Number.isInteger(v) && v >= 0) currentConfig.RATE_LIMIT_COOLDOWN_MAX_MS = v;
        }
        if (newConfig.CRON_NEAR_MINUTES !== undefined) currentConfig.CRON_NEAR_MINUTES = newConfig.CRON_NEAR_MINUTES;
        if (newConfig.CRON_REFRESH_TOKEN !== undefined) currentConfig.CRON_REFRESH_TOKEN = newConfig.CRON_REFRESH_TOKEN;
        if (newConfig.LOGIN_EXPIRY !== undefined) currentConfig.LOGIN_EXPIRY = newConfig.LOGIN_EXPIRY;
        if (newConfig.TRUST_PROXY !== undefined) currentConfig.TRUST_PROXY = parseBooleanConfig(newConfig.TRUST_PROXY);
        if (newConfig.TRUSTED_PROXY_IPS !== undefined) {
            if (Array.isArray(newConfig.TRUSTED_PROXY_IPS)) {
                currentConfig.TRUSTED_PROXY_IPS = newConfig.TRUSTED_PROXY_IPS
                    .map(item => String(item).trim())
                    .filter(Boolean);
            } else if (typeof newConfig.TRUSTED_PROXY_IPS === 'string') {
                currentConfig.TRUSTED_PROXY_IPS = newConfig.TRUSTED_PROXY_IPS
                    .split(',')
                    .map(item => item.trim())
                    .filter(Boolean);
            }
        }
        if (newConfig.PROVIDER_POOLS_FILE_PATH !== undefined) currentConfig.PROVIDER_POOLS_FILE_PATH = providerPoolsPath ? path.relative(process.cwd(), providerPoolsPath) : null;
        if (newConfig.CODEX_IMAGE_HELPER_MODEL !== undefined && typeof newConfig.CODEX_IMAGE_HELPER_MODEL === 'string') {
            currentConfig.CODEX_IMAGE_HELPER_MODEL = newConfig.CODEX_IMAGE_HELPER_MODEL;
        }
        if (newConfig.MAX_ERROR_COUNT !== undefined) currentConfig.MAX_ERROR_COUNT = newConfig.MAX_ERROR_COUNT;
        if (newConfig.WARMUP_TARGET !== undefined) currentConfig.WARMUP_TARGET = newConfig.WARMUP_TARGET;
        if (newConfig.REFRESH_CONCURRENCY_PER_PROVIDER !== undefined) currentConfig.REFRESH_CONCURRENCY_PER_PROVIDER = newConfig.REFRESH_CONCURRENCY_PER_PROVIDER;
        if (newConfig.providerFallbackChain !== undefined) currentConfig.providerFallbackChain = newConfig.providerFallbackChain;
        if (newConfig.modelFallbackMapping !== undefined) currentConfig.modelFallbackMapping = newConfig.modelFallbackMapping;
        
        // Proxy settings
        if (newConfig.PROXY_URL !== undefined) currentConfig.PROXY_URL = newConfig.PROXY_URL;
        if (newConfig.PROXY_ENABLED_PROVIDERS !== undefined) currentConfig.PROXY_ENABLED_PROVIDERS = newConfig.PROXY_ENABLED_PROVIDERS;

        // TLS Sidecar settings
        if (newConfig.TLS_SIDECAR_ENABLED !== undefined) currentConfig.TLS_SIDECAR_ENABLED = newConfig.TLS_SIDECAR_ENABLED;
        if (newConfig.TLS_SIDECAR_ENABLED_PROVIDERS !== undefined) currentConfig.TLS_SIDECAR_ENABLED_PROVIDERS = newConfig.TLS_SIDECAR_ENABLED_PROVIDERS;
        if (newConfig.TLS_SIDECAR_PORT !== undefined) currentConfig.TLS_SIDECAR_PORT = newConfig.TLS_SIDECAR_PORT;
        if (newConfig.TLS_SIDECAR_PROXY_URL !== undefined) currentConfig.TLS_SIDECAR_PROXY_URL = newConfig.TLS_SIDECAR_PROXY_URL;

        // Log settings
        if (newConfig.LOG_ENABLED !== undefined) currentConfig.LOG_ENABLED = newConfig.LOG_ENABLED;
        if (newConfig.LOG_OUTPUT_MODE !== undefined) currentConfig.LOG_OUTPUT_MODE = newConfig.LOG_OUTPUT_MODE;
        if (newConfig.LOG_LEVEL !== undefined) currentConfig.LOG_LEVEL = newConfig.LOG_LEVEL;
        if (newConfig.LOG_DIR !== undefined) {
            const p = String(newConfig.LOG_DIR);
            // 防止路径遍历：解析后的绝对路径必须在工作目录内
            const resolved = path.resolve(process.cwd(), p);
            const cwd = process.cwd();

            // 使用 path.relative 和 path.isAbsolute 进行更严格的校验
            const relativePath = path.relative(cwd, resolved);
            const isInsideCwd = !path.isAbsolute(relativePath) && !relativePath.startsWith('..') && relativePath !== '..';

            // Windows 大小写不敏感兼容：仅在 Windows 平台统一转换为小写比较
            const isWindows = process.platform === 'win32';
            const normalizedResolved = (isWindows ? resolved.toLowerCase() : resolved).replace(/\\/g, '/');
            const normalizedCwd = (isWindows ? cwd.toLowerCase() : cwd).replace(/\\/g, '/');
            const startsWithCwd = normalizedResolved.startsWith(normalizedCwd + '/') || normalizedResolved === normalizedCwd;

            if (isInsideCwd && startsWithCwd) {
                currentConfig.LOG_DIR = p;
            } else {
                logger.warn(`[UI API] Rejected LOG_DIR traversal attempt: ${p}`);
            }
        }
        if (newConfig.LOG_INCLUDE_REQUEST_ID !== undefined) currentConfig.LOG_INCLUDE_REQUEST_ID = newConfig.LOG_INCLUDE_REQUEST_ID;
        if (newConfig.LOG_INCLUDE_TIMESTAMP !== undefined) currentConfig.LOG_INCLUDE_TIMESTAMP = newConfig.LOG_INCLUDE_TIMESTAMP;
        if (newConfig.LOG_MAX_FILE_SIZE !== undefined) currentConfig.LOG_MAX_FILE_SIZE = newConfig.LOG_MAX_FILE_SIZE;
        if (newConfig.LOG_MAX_FILES !== undefined) currentConfig.LOG_MAX_FILES = newConfig.LOG_MAX_FILES;

        // Scheduled Health Check settings
        if (newConfig.SCHEDULED_HEALTH_CHECK !== undefined) {
            const incoming = newConfig.SCHEDULED_HEALTH_CHECK;

            // 检测 enabled 状态变化（在更新配置之前保存旧状态）
            const prevConfig = currentConfig.SCHEDULED_HEALTH_CHECK || {};
            const wasEnabled = prevConfig.enabled === true;
            const nowEnabled = incoming?.enabled === true;

            const newInterval = (() => {
                const val = Number(incoming?.interval);
                return isNaN(val) ? HEALTH_CHECK.DEFAULT_INTERVAL_MS : Math.max(HEALTH_CHECK.MIN_INTERVAL_MS, Math.min(HEALTH_CHECK.MAX_INTERVAL_MS, val));
            })();

            // 先保存旧的 interval 用于比较
            const oldInterval = globalThis._activeHealthCheckInterval;

            // 更新配置
            currentConfig.SCHEDULED_HEALTH_CHECK = {
                enabled: nowEnabled,
                startupRun: incoming?.startupRun !== false,
                interval: newInterval,
                providerTypes: Array.isArray(incoming?.providerTypes) ? incoming.providerTypes : []
            };

            // 处理 timer 状态变化
            // 当 enabled 从 true -> false 时，清除 timer
            if (wasEnabled && !nowEnabled && globalThis.stopHealthCheckTimer) {
                globalThis.stopHealthCheckTimer();
                globalThis._activeHealthCheckInterval = undefined;
            }
            // 当 enabled 从 false -> true 时，启动 timer
            else if (!wasEnabled && nowEnabled && globalThis.reloadHealthCheckTimer) {
                globalThis._activeHealthCheckInterval = newInterval;
                globalThis.reloadHealthCheckTimer(newInterval);
            }
            // 当 enabled=true 且 interval 变化时，重启 timer
            else if (nowEnabled && newInterval !== oldInterval && globalThis.reloadHealthCheckTimer) {
                globalThis._activeHealthCheckInterval = newInterval;
                globalThis.reloadHealthCheckTimer(newInterval);
            }
        }

        // Handle system prompt update
        if (newConfig.systemPrompt !== undefined) {
            try {
                // Recheck links just before writing; do not silently report success on failure.
                await resolveSystemPromptPath(promptPath);
                await fs.mkdir(path.dirname(promptPath), { recursive: true });
                const relativePath = path.relative(process.cwd(), promptPath);
                await atomicWriteFile(promptPath, newConfig.systemPrompt, 'utf-8');

                // 广播更新事件
                broadcastEvent('config_update', {
                    action: 'update',
                    filePath: relativePath,
                    type: 'system_prompt',
                    timestamp: new Date().toISOString()
                });
                
                logger.info('[UI API] System prompt updated');
            } catch (e) {
                logger.warn('[UI API] Failed to write system prompt:', e.message);
                throw e;
            }
        }

        // Update config.json file
        try {
            const configPath = 'configs/config.json';
            
            // Create a clean config object for saving (exclude runtime-only properties)
            const configToSave = {
                REQUIRED_API_KEY: currentConfig.REQUIRED_API_KEY,
                SERVER_PORT: currentConfig.SERVER_PORT,
                HOST: currentConfig.HOST,
                MODEL_PROVIDER: currentConfig.MODEL_PROVIDER,
                SYSTEM_PROMPT_FILE_PATH: currentConfig.SYSTEM_PROMPT_FILE_PATH,
                SYSTEM_PROMPT_MODE: currentConfig.SYSTEM_PROMPT_MODE,
                SYSTEM_PROMPT_REPLACEMENTS: currentConfig.SYSTEM_PROMPT_REPLACEMENTS,
                PROMPT_LOG_BASE_NAME: currentConfig.PROMPT_LOG_BASE_NAME,
                PROMPT_LOG_MODE: currentConfig.PROMPT_LOG_MODE,
                REQUEST_MAX_RETRIES: currentConfig.REQUEST_MAX_RETRIES,
                REQUEST_BASE_DELAY: currentConfig.REQUEST_BASE_DELAY,
                CREDENTIAL_SWITCH_MAX_RETRIES: currentConfig.CREDENTIAL_SWITCH_MAX_RETRIES,
                RATE_LIMIT_COOLDOWN_ENABLED: currentConfig.RATE_LIMIT_COOLDOWN_ENABLED,
                RATE_LIMIT_COOLDOWN_MS: currentConfig.RATE_LIMIT_COOLDOWN_MS,
                RATE_LIMIT_COOLDOWN_JITTER_MS: currentConfig.RATE_LIMIT_COOLDOWN_JITTER_MS,
                RATE_LIMIT_COOLDOWN_MAX_MS: currentConfig.RATE_LIMIT_COOLDOWN_MAX_MS,
                CRON_NEAR_MINUTES: currentConfig.CRON_NEAR_MINUTES,
                CRON_REFRESH_TOKEN: currentConfig.CRON_REFRESH_TOKEN,
                LOGIN_EXPIRY: currentConfig.LOGIN_EXPIRY,
                TRUST_PROXY: currentConfig.TRUST_PROXY,
                TRUSTED_PROXY_IPS: currentConfig.TRUSTED_PROXY_IPS,
                PROVIDER_POOLS_FILE_PATH: currentConfig.PROVIDER_POOLS_FILE_PATH,
                CODEX_IMAGE_HELPER_MODEL: currentConfig.CODEX_IMAGE_HELPER_MODEL,
                MAX_ERROR_COUNT: currentConfig.MAX_ERROR_COUNT,
                WARMUP_TARGET: currentConfig.WARMUP_TARGET,
                REFRESH_CONCURRENCY_PER_PROVIDER: currentConfig.REFRESH_CONCURRENCY_PER_PROVIDER,
                providerFallbackChain: currentConfig.providerFallbackChain,
                modelFallbackMapping: currentConfig.modelFallbackMapping,
                PROXY_URL: currentConfig.PROXY_URL,
                PROXY_ENABLED_PROVIDERS: currentConfig.PROXY_ENABLED_PROVIDERS,
                LOG_ENABLED: currentConfig.LOG_ENABLED,
                LOG_OUTPUT_MODE: currentConfig.LOG_OUTPUT_MODE,
                LOG_LEVEL: currentConfig.LOG_LEVEL,
                LOG_DIR: currentConfig.LOG_DIR,
                LOG_INCLUDE_REQUEST_ID: currentConfig.LOG_INCLUDE_REQUEST_ID,
                LOG_INCLUDE_TIMESTAMP: currentConfig.LOG_INCLUDE_TIMESTAMP,
                LOG_MAX_FILE_SIZE: currentConfig.LOG_MAX_FILE_SIZE,
                LOG_MAX_FILES: currentConfig.LOG_MAX_FILES,
                TLS_SIDECAR_ENABLED: currentConfig.TLS_SIDECAR_ENABLED,
                TLS_SIDECAR_ENABLED_PROVIDERS: currentConfig.TLS_SIDECAR_ENABLED_PROVIDERS,
                TLS_SIDECAR_PORT: currentConfig.TLS_SIDECAR_PORT,
                TLS_SIDECAR_PROXY_URL: currentConfig.TLS_SIDECAR_PROXY_URL,
                SCHEDULED_HEALTH_CHECK: currentConfig.SCHEDULED_HEALTH_CHECK
            };

            await atomicWriteFile(configPath, JSON.stringify(configToSave, null, 2), { encoding: 'utf-8', mode: 0o600 });
            logger.info('[UI API] Configuration saved to configs/config.json');
            
            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'update',
                filePath: 'configs/config.json',
                type: 'main_config',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('[UI API] Failed to save configuration to file:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to save configuration to file: ' + error.message,
                    partial: true  // Indicate that memory config was updated but not saved
                }
            }));
            return true;
        }

        // Update the global CONFIG object to reflect changes immediately
        Object.assign(CONFIG, currentConfig);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Configuration updated successfully',
            details: 'Configuration has been updated in both memory and config.json file'
        }));
        return true;
    } catch (error) {
        res.writeHead(error.status === 403 ? 403 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
        return true;
    }
}

/**
 * 重载配置文件
 */
export async function handleReloadConfig(req, res, providerPoolManager) {
    try {
        // 调用重载配置函数
        const newConfig = await reloadConfig(providerPoolManager);
        
        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'reload',
            filePath: 'configs/config.json',
            providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null,
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Configuration files reloaded successfully',
            details: {
                configReloaded: true,
                configPath: 'configs/config.json',
                providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null
            }
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to reload config files:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to reload configuration files: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 更新管理员密码
 */
export async function handleUpdateAdminPassword(req, res) {
    if (!await requireManagementAuth(req, res)) return true;
    try {
        const body = await getRequestBody(req, { maxBytes: 10 * 1024 });
        const { password, currentPassword } = body;

        if (typeof password !== 'string' || password.trim() === '') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Password cannot be empty',
                    messageCode: 'common.passwordEmpty'
                }
            }));
            return true;
        }

        if (password.trim().length < PASSWORD.MIN_LENGTH) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `Password must be at least ${PASSWORD.MIN_LENGTH} characters`,
                    messageCode: 'common.passwordTooShort'
                }
            }));
            return true;
        }

        if (!await requireAdminReauthentication(req, res, currentPassword)) return true;

        // 使用 PBKDF2 哈希存储密码，避免明文写入文件
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await new Promise((resolve, reject) =>
            crypto.pbkdf2(password.trim(), salt, PASSWORD.PBKDF2_ITERATIONS, PASSWORD.PBKDF2_KEYLEN, PASSWORD.PBKDF2_DIGEST, (err, key) =>
                err ? reject(err) : resolve(key.toString('hex'))
            )
        );
        const stored = `pbkdf2:${salt}:${hash}`;

        const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');

        // 使用文件锁和原子化写入
        await withFileLock(pwdFilePath, async () => {
            await atomicWriteFile(pwdFilePath, stored, { encoding: 'utf-8', mode: 0o600 });
        });

        logger.info('[UI API] Admin password updated successfully');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Admin password updated successfully'
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to update admin password:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to update password: ' + error.message
            }
        }));
        return true;
    }
}
