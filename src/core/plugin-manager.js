/**
 * 插件管理器 - 可插拔插件系统核心
 * 
 * 功能：
 * 1. 插件注册与加载
 * 2. 生命周期管理（init/destroy）
 * 3. 扩展点管理（中间件、路由、钩子）
 * 4. 插件配置管理
 */

import { atomicWriteFile, withFileLock } from '../utils/file-lock.js';
import { promises as fs } from 'fs';
import logger from '../utils/logger.js';
import { existsSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { requireManagementAuth } from '../ui-modules/auth.js';
import {
    auditSecurityEvent,
    isInsidePath,
    validatePluginExport,
    validatePluginId
} from './plugin-security.js';
import {
    getPluginPackageHash,
    createPluginApproval,
    isValidPluginApproval,
    pluginTrustError,
    verifyPluginApproval,
    verifyPluginApprovalSignature,
    PLUGIN_TRUST_MODE
} from './plugin-trust.js';

// 插件配置文件路径
const PLUGINS_CONFIG_FILE = path.join(process.cwd(), 'configs', 'plugins.json');

// 插件目录
const BUILTIN_PLUGINS_DIR = path.join(process.cwd(), 'src', 'plugins');
const USER_PLUGINS_DIR = path.join(process.cwd(), 'src', 'plugins-user');

// 默认禁用的插件列表
const DEFAULT_DISABLED_PLUGINS = ['api-potluck', 'ai-monitor', 'model-usage-stats', 'ip-node-proxy'];
const PLUGIN_OPERATION_TIMEOUT_MS = 10000;
const PLUGIN_MAX_ERROR_COUNT = 3;

function isUserPlugin(plugin) {
    return !!(plugin?._baseDir && isInsidePath(USER_PLUGINS_DIR, plugin._baseDir));
}

function routeMatches(route, method, requestPath) {
    return (route.method === '*' || route.method.toUpperCase() === method) &&
        (requestPath === route.path || requestPath.startsWith(route.path + '/'));
}

function isPublicPluginRoute(plugin, route) {
    return route.public === true && !!plugin._baseDir &&
        isInsidePath(BUILTIN_PLUGINS_DIR, plugin._baseDir);
}

/**
 * 插件类型常量
 */
export const PLUGIN_TYPE = {
    AUTH: 'auth',           // 认证插件，参与认证流程
    MIDDLEWARE: 'middleware' // 普通中间件，不参与认证
};

/**
 * 插件接口定义（JSDoc 类型）
 * @typedef {Object} Plugin
 * @property {string} name - 插件名称（唯一标识）
 * @property {string} version - 插件版本
 * @property {string} [description] - 插件描述
 * @property {string} [type] - 插件类型：'auth'（认证插件）或 'middleware'（普通中间件，默认）
 * @property {boolean} [enabled] - 是否启用（默认 true）
 * @property {number} [_priority] - 优先级，数字越小越先执行（默认 100）
 * @property {boolean} [_builtin] - 是否为内置插件（内置插件最后执行）
 * @property {Function} [init] - 初始化钩子 (config) => Promise<void>
 * @property {Function} [destroy] - 销毁钩子 () => Promise<void>
 * @property {Function} [middleware] - 请求中间件 (req, res, requestUrl, config) => Promise<{handled: boolean, data?: Object}>
 * @property {Function} [authenticate] - 认证方法（仅 type='auth' 时有效）(req, res, requestUrl, config) => Promise<{handled: boolean, authorized: boolean|null, error?: Object, data?: Object}>
 * @property {Array<{method: string, path: string, public?: boolean, handler: Function}>} [routes] - 路由默认私有；仅可信内置插件可显式公开
 * @property {string[]} [staticPaths] - 静态文件路径（相对于 static 目录）
 * @property {Object} [hooks] - 钩子函数
 * @property {Function} [hooks.onBeforeRequest] - 请求前钩子 (req, config) => Promise<void>
 * @property {Function} [hooks.onAfterResponse] - 响应后钩子 (req, res, config) => Promise<void>
 * @property {Function} [hooks.onContentGenerated] - 内容生成后钩子 (config) => Promise<void>
 */

/**
 * 插件管理器类
 */
class PluginManager {
    constructor() {
        /** @type {Map<string, Plugin>} */
        this.plugins = new Map();
        /** @type {Object} */
        this.pluginsConfig = { plugins: {} };
        /** @type {boolean} */
        this.initialized = false;
        /** @type {Object} */
        this.config = null; // 存储服务器全局配置
        this.trustedUserPlugins = new WeakMap(); // Only loader-approved objects can be registered.
        this.loadedUserHashes = new Map(); // ESM dependency caches cannot safely hot-update packages.
    }

    /**
     * 加载插件配置文件
     * 永远生成默认配置，如果本地文件存在则合并，但不覆盖 enabled 字段
     */
    async loadConfig() {
        try {
            // 1. 永远生成默认配置
            const defaultConfig = await this.generateDefaultConfig();
            
            // 2. 如果本地文件存在，读取并合并
            if (existsSync(PLUGINS_CONFIG_FILE)) {
                const content = await fs.readFile(PLUGINS_CONFIG_FILE, 'utf8');
                const localConfig = JSON.parse(content);
                if (!localConfig || !localConfig.plugins || typeof localConfig.plugins !== 'object' || Array.isArray(localConfig.plugins)) {
                    throw new Error('Invalid plugins.json: plugins must be an object');
                }

                // 3. 合并配置：遍历默认配置中的所有插件
                for (const [pluginName, defaultPluginConfig] of Object.entries(defaultConfig.plugins)) {
                    const localPluginConfig = localConfig.plugins?.[pluginName];
                    
                    if (localPluginConfig !== undefined) {
                        if (!localPluginConfig || typeof localPluginConfig !== 'object' || Array.isArray(localPluginConfig) ||
                            (Object.hasOwn(localPluginConfig, 'enabled') && typeof localPluginConfig.enabled !== 'boolean')) {
                            throw new Error(`Invalid configuration for plugin "${pluginName}"`);
                        }
                        // 本地配置存在，合并但保留本地的 enabled 字段
                        defaultConfig.plugins[pluginName] = {
                            ...defaultPluginConfig,
                            ...localPluginConfig,
                            enabled: localPluginConfig.enabled ?? defaultPluginConfig.enabled
                        };
                    }
                    // 如果本地配置不存在该插件，使用默认配置
                }
            }
            
            // Legacy enabled:true is NOT approval. Verify the complete package before import.
            for (const [name, settings] of Object.entries(defaultConfig.plugins)) {
                if (!this.isUserPluginName(name)) continue;
                if (settings.enabled !== true) {
                    settings.enabled = false;
                    continue;
                }
                try {
                    await verifyPluginApproval(path.join(USER_PLUGINS_DIR, name), settings.approval);
                } catch (error) {
                    settings.enabled = false;
                    auditSecurityEvent({ type: 'plugin_approval_rejected', plugin: name, reason: error.code || 'package_unreadable' });
                }
            }
            this.pluginsConfig = defaultConfig;
            await this.saveConfig();
        } catch (error) {
            logger.error('[PluginManager] Failed to load config:', error.message);
            // Never replace a failed read/write with an empty, default-enabled config.
            // Abort startup/re-init before any lifecycle hook can run.
            this.initialized = false;
            for (const plugin of this.plugins.values()) plugin._enabled = false;
            throw error;
        }
    }

    /**
     * 扫描插件目录生成默认配置
     * @returns {Promise<Object>} 默认插件配置
     */
    async generateDefaultConfig() {
        const defaultConfig = { plugins: {} };
        const dirs = [BUILTIN_PLUGINS_DIR, USER_PLUGINS_DIR];
        
        for (const pluginsDir of dirs) {
            try {
                if (!existsSync(pluginsDir)) {
                    continue;
                }
                
                const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
                
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    try {
                        validatePluginId(entry.name, 'plugin directory name');
                    } catch (error) {
                        logger.warn(`[PluginManager] Skipping plugin directory "${entry.name}": ${error.message}`);
                        continue;
                    }
                    
                    const pluginPath = path.join(pluginsDir, entry.name, 'index.js');
                    if (!existsSync(pluginPath)) continue;
                    
                    try {
                        if (pluginsDir === USER_PLUGINS_DIR) {
                            // Uploaded packages may not shadow host-shipped plugins.
                            if (Object.hasOwn(defaultConfig.plugins, entry.name)) continue;
                            defaultConfig.plugins[entry.name] = {
                                enabled: false,
                                description: ''
                            };
                            logger.info(`[PluginManager] Found user plugin for default config: ${entry.name}`);
                            continue;
                        }

                        // 动态导入插件以获取其元信息
                        const pluginModule = await import(pathToFileURL(pluginPath).href);
                        const plugin = pluginModule.default || pluginModule;
                        
                        if (plugin && plugin.name) {
                            // 检查是否在默认禁用列表中
                            const enabled = !DEFAULT_DISABLED_PLUGINS.includes(plugin.name);
                            defaultConfig.plugins[plugin.name] = {
                                enabled: enabled,
                                description: plugin.description || ''
                            };
                            logger.info(`[PluginManager] Found plugin for default config: ${plugin.name} in ${pluginsDir}`);
                        }
                    } catch (importError) {
                        // 如果导入失败，使用目录名作为插件名
                        // 检查是否在默认禁用列表中
                        const enabled = !DEFAULT_DISABLED_PLUGINS.includes(entry.name);
                        defaultConfig.plugins[entry.name] = {
                            enabled: enabled,
                            description: ''
                        };
                        logger.warn(`[PluginManager] Could not import plugin ${entry.name}, using directory name:`, importError.message);
                    }
                }
            } catch (error) {
                logger.error(`[PluginManager] Failed to scan plugins directory ${pluginsDir}:`, error.message);
                throw error;
            }
        }
        
        return defaultConfig;
    }

    /**
     * 保存插件配置文件
     */
    async saveConfig() {
        try {
            const dir = path.dirname(PLUGINS_CONFIG_FILE);
            if (!existsSync(dir)) {
                await fs.mkdir(dir, { recursive: true });
            }
            await atomicWriteFile(PLUGINS_CONFIG_FILE, JSON.stringify(this.pluginsConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
            logger.error('[PluginManager] Failed to save config:', error.message);
            throw error;
        }
    }

    /**
     * 注册插件
     * @param {Plugin} plugin - 插件对象
     */
    register(plugin) {
        if (!plugin.name) {
            throw new Error('Plugin must have a name');
        }
        if (isUserPlugin(plugin) && !this.trustedUserPlugins.has(plugin)) {
            throw pluginTrustError('PLUGIN_APPROVAL_REQUIRED', 'User plugins must be loaded through the approval-checked loader');
        }
        validatePluginExport(plugin, plugin.name, isUserPlugin(plugin));
        const existing = this.plugins.get(plugin.name);
        if (existing && existing._placeholder) {
            this.plugins.set(plugin.name, plugin);
            logger.info(`[PluginManager] Replaced placeholder plugin: ${plugin.name} v${plugin.version || '1.0.0'}`);
            return;
        }
        if (existing) {
            logger.warn(`[PluginManager] Plugin "${plugin.name}" is already registered, skipping`);
            return;
        }
        this.plugins.set(plugin.name, plugin);
        logger.info(`[PluginManager] Registered plugin: ${plugin.name} v${plugin.version || '1.0.0'}`);
    }

    registerPlaceholder(name, description = '', baseDir = null) {
        validatePluginId(name);
        if (this.plugins.has(name)) return;
        this.plugins.set(name, {
            name,
            version: '1.0.0',
            description,
            _enabled: false,
            _placeholder: true,
            _baseDir: baseDir
        });
        logger.info(`[PluginManager] Registered disabled plugin placeholder: ${name}`);
    }

    /**
     * 初始化所有已启用的插件
     * @param {Object} config - 服务器配置
     */
    async initAll(config) {
        this.config = config;
        await this.loadConfig();
        
        for (const [name, plugin] of this.plugins) {
            const pluginConfig = this.pluginsConfig.plugins[name] || {};
            const enabled = pluginConfig.enabled === true; // Only a successfully loaded explicit configuration enables dispatch.
            if (isUserPlugin(plugin)) {
                plugin._enabled = false;
                if (pluginConfig.enabled === true) {
                    try {
                        await this.loadAndInitPlugin(name);
                    } catch (error) {
                        this.recordPluginError(plugin, 'approved-load', error);
                        this.pluginsConfig.plugins[name].enabled = false;
                        await this.saveConfig();
                    }
                }
                continue;
            }

            if (!enabled || plugin._placeholder) {
                plugin._enabled = false;
                logger.info(`[PluginManager] Plugin "${name}" is disabled, skipping init`);
                continue;
            }

            try {
                if (typeof plugin.init === 'function') {
                    await this.executePluginOperation(plugin, 'init', () => plugin.init(config));
                    logger.info(`[PluginManager] Initialized plugin: ${name}`);
                }
                plugin._enabled = true;
            } catch (error) {
                this.recordPluginError(plugin, 'init', error);
                plugin._enabled = false;
            }
        }
        
        this.initialized = true;
    }

    /**
     * 销毁所有插件
     */
    async destroyAll() {
        for (const [name, plugin] of this.plugins) {
            if (!plugin._enabled) continue;
            
            try {
                if (typeof plugin.destroy === 'function') {
                    await this.executePluginOperation(plugin, 'destroy', () => plugin.destroy());
                    logger.info(`[PluginManager] Destroyed plugin: ${name}`);
                }
            } catch (error) {
                this.recordPluginError(plugin, 'destroy', error);
            }
        }
        this.initialized = false;
    }

    /**
     * 检查插件是否启用
     * @param {string} name - 插件名称
     * @returns {boolean}
     */
    isEnabled(name) {
        const plugin = this.plugins.get(name);
        return plugin && plugin._enabled === true;
    }

    /**
     * 获取所有启用的插件（按优先级排序）
     * 优先级数字越小越先执行，内置插件（_builtin: true）最后执行
     * @returns {Plugin[]}
     */
    getEnabledPlugins() {
        return Array.from(this.plugins.values())
            .filter(p => p._enabled && !p._placeholder && (!isUserPlugin(p) || this.trustedUserPlugins.has(p)))
            .sort((a, b) => {
                // 内置插件排在最后
                const aBuiltin = a._builtin ? 1 : 0;
                const bBuiltin = b._builtin ? 1 : 0;
                if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin;
                
                // 按优先级排序（数字越小越先执行）
                const aPriority = a._priority || 100;
                const bPriority = b._priority || 100;
                return aPriority - bPriority;
            });
    }

    /**
     * 获取所有认证插件（按优先级排序）
     * @returns {Plugin[]}
     */
    getAuthPlugins() {
        return this.getEnabledPlugins().filter(p =>
            p.type === PLUGIN_TYPE.AUTH && typeof p.authenticate === 'function'
        );
    }

    /**
     * 获取所有普通中间件插件（按优先级排序）
     * @returns {Plugin[]}
     */
    getMiddlewarePlugins() {
        return this.getEnabledPlugins().filter(p =>
            p.type !== PLUGIN_TYPE.AUTH && typeof p.middleware === 'function'
        );
    }

    /**
     * 执行认证流程
     * 只有 type='auth' 的插件会参与认证
     *
     * 认证插件返回值说明：
     * - { handled: true } - 请求已被处理（如发送了错误响应），停止后续处理
     * - { authorized: true, data: {...} } - 认证成功，可附带数据
     * - { authorized: false } - 认证失败，已发送错误响应
     * - { authorized: null } - 此插件不处理该请求，继续下一个认证插件
     *
     * @param {http.IncomingMessage} req - HTTP 请求
     * @param {http.ServerResponse} res - HTTP 响应
     * @param {URL} requestUrl - 解析后的 URL
     * @param {Object} config - 服务器配置
     * @returns {Promise<{handled: boolean, authorized: boolean}>}
     */
    async executeAuth(req, res, requestUrl, config) {
        const authPlugins = this.getAuthPlugins();
        
        for (const plugin of authPlugins) {
            try {
                const result = await this.executePluginOperation(plugin, 'authenticate', () => plugin.authenticate(req, res, requestUrl, config));
                
                if (!result) continue;
                
                // 如果请求已被处理（如发送了错误响应），停止执行
                if (result.handled) {
                    return { handled: true, authorized: false };
                }
                
                // 如果认证失败，停止执行
                if (result.authorized === false) {
                    return { handled: true, authorized: false };
                }
                
                // 如果认证成功，合并数据并返回
                if (result.authorized === true) {
                    if (result.data) {
                        Object.assign(config, result.data);
                    }
                    return { handled: false, authorized: true };
                }
                
                // authorized === null 表示此插件不处理，继续下一个
            } catch (error) {
                this.recordPluginError(plugin, 'authenticate', error);
            }
        }
        
        // 没有任何认证插件处理，返回未授权
        return { handled: false, authorized: false };
    }

    /**
     * 执行普通中间件
     * 只有 type!='auth' 的插件会执行
     *
     * 中间件返回值说明：
     * - { handled: true } - 请求已被处理，停止后续处理
     * - { handled: false, data: {...} } - 继续处理，可附带数据
     * - null/undefined - 继续执行下一个中间件
     *
     * @param {http.IncomingMessage} req - HTTP 请求
     * @param {http.ServerResponse} res - HTTP 响应
     * @param {URL} requestUrl - 解析后的 URL
     * @param {Object} config - 服务器配置
     * @returns {Promise<{handled: boolean}>}
     */
    async executeMiddleware(req, res, requestUrl, config) {
        const middlewarePlugins = this.getMiddlewarePlugins();
        
        for (const plugin of middlewarePlugins) {
            try {
                const result = await this.executePluginOperation(plugin, 'middleware', () => plugin.middleware(req, res, requestUrl, config));
                
                if (!result) continue;
                
                // 如果请求已被处理，停止执行
                if (result.handled) {
                    return { handled: true };
                }
                
                // 合并数据
                if (result.data) {
                    Object.assign(config, result.data);
                }
            } catch (error) {
                this.recordPluginError(plugin, 'middleware', error);
            }
        }
        
        return { handled: false };
    }

    /**
     * 执行所有插件的路由处理
     * @param {string} method - HTTP 方法
     * @param {string} path - 请求路径
     * @param {http.IncomingMessage} req - HTTP 请求
     * @param {http.ServerResponse} res - HTTP 响应
     * @param {Object} [config] - 当前请求配置
     * @returns {Promise<boolean>} - 是否已处理
     */
    isPublicRoute(method, requestPath) {
        return this.getEnabledPlugins().some(plugin => Array.isArray(plugin.routes) &&
            plugin.routes.some(route => routeMatches(route, method, requestPath) && isPublicPluginRoute(plugin, route)));
    }

    async executeRoutes(method, path, req, res, config) {
        for (const plugin of this.getEnabledPlugins()) {
            if (!Array.isArray(plugin.routes)) continue;
            
            for (const route of plugin.routes) {
                if (routeMatches(route, method, path)) {
                    // Defense in depth: protect direct callers as well as HTTP dispatch.
                    if (!isPublicPluginRoute(plugin, route) && !await requireManagementAuth(req, res)) return true;
                    try {
                        const handled = await this.executePluginOperation(plugin, `route:${route.path}`, () => route.handler(method, path, req, res, config));
                        if (handled) return true;
                    } catch (error) {
                        this.recordPluginError(plugin, `route:${route.path}`, error);
                    }
                }
            }
        }

        for (const plugin of this.plugins.values()) {
            if (plugin._enabled || !Array.isArray(plugin.routes)) continue;

            for (const route of plugin.routes) {
                if (routeMatches(route, method, path)) {
                    if (!await requireManagementAuth(req, res)) return true;
                    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        success: false,
                        error: {
                            message: `插件未启用：${plugin.name}`,
                            code: 'PLUGIN_DISABLED'
                        }
                    }));
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 获取所有插件的静态文件路径
     * @returns {string[]}
     */
    getStaticPaths() {
        const paths = [];
        for (const plugin of this.plugins.values()) {
            if (Array.isArray(plugin.staticPaths)) {
                paths.push(...plugin.staticPaths);
            }
        }
        return paths;
    }

    /**
     * 检查路径是否是插件静态文件
     * @param {string} path - 请求路径
     * @returns {boolean}
     */
    isPluginStaticPath(path) {
        const staticPaths = this.getStaticPaths();
        return staticPaths.some(sp => path === sp || path === '/' + sp);
    }

    /**
     * 获取静态路径所属插件
     * @param {string} path - 请求路径
     * @returns {Plugin|null}
     */
    getPluginByStaticPath(path) {
        for (const plugin of this.plugins.values()) {
            if (!Array.isArray(plugin.staticPaths)) continue;

            const matched = plugin.staticPaths.some(sp => path === sp || path === '/' + sp);
            if (matched) {
                return plugin;
            }
        }

        return null;
    }

    /**
     * 执行钩子函数
     * @param {string} hookName - 钩子名称
     * @param  {...any} args - 钩子参数
     */
    async executeHook(hookName, ...args) {
        for (const plugin of this.getEnabledPlugins()) {
            if (!plugin.hooks || typeof plugin.hooks[hookName] !== 'function') continue;
            
            try {
                await this.executePluginOperation(plugin, `hook:${hookName}`, () => plugin.hooks[hookName](...args));
            } catch (error) {
                this.recordPluginError(plugin, `hook:${hookName}`, error);
            }
        }
    }

    executePluginOperation(plugin, operationName, fn) {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`Plugin operation timed out after ${PLUGIN_OPERATION_TIMEOUT_MS}ms`));
            }, PLUGIN_OPERATION_TIMEOUT_MS);
            if (timeoutId.unref) timeoutId.unref();
        });

        return Promise.race([
            Promise.resolve().then(fn),
            timeoutPromise
        ]).then(result => {
            plugin._errorCount = 0;
            return result;
        }).finally(() => clearTimeout(timeoutId));
    }

    recordPluginError(plugin, operationName, error) {
        plugin._errorCount = (plugin._errorCount || 0) + 1;
        logger.error(`[PluginManager] ${operationName} error in plugin "${plugin.name}":`, error.message);
        auditSecurityEvent({
            type: 'plugin_error',
            plugin: plugin.name,
            operation: operationName,
            error: error.message,
            errorCount: plugin._errorCount
        });

        if (plugin._errorCount >= PLUGIN_MAX_ERROR_COUNT) {
            plugin._enabled = false;
            logger.error(`[PluginManager] Plugin "${plugin.name}" disabled after ${plugin._errorCount} consecutive errors`);
            auditSecurityEvent({
                type: 'plugin_disabled',
                plugin: plugin.name,
                reason: 'max_error_count',
                errorCount: plugin._errorCount
            });
        }
    }

    /** Whether a name resolves to an installed user package, not a builtin. */
    isUserPluginName(name) {
        validatePluginId(name);
        const registered = this.plugins.get(name);
        if (registered?._baseDir) return isUserPlugin(registered);
        return !existsSync(path.join(BUILTIN_PLUGINS_DIR, name)) && existsSync(path.join(USER_PLUGINS_DIR, name));
    }

    /** List metadata without importing disabled packages. @returns {Promise<Object[]>} */
    async getPluginList() {
        const list = [];
        for (const [name, plugin] of this.plugins) {
            const pluginConfig = this.pluginsConfig.plugins[name] || {};
            const userPlugin = isUserPlugin(plugin);
            let packageHash = null;
            let blockedReason = null;
            let approved = false;
            if (userPlugin) {
                try {
                    packageHash = await getPluginPackageHash(plugin._baseDir);
                    if (isValidPluginApproval(pluginConfig.approval) && pluginConfig.approval.sha256 === packageHash) {
                        try { approved = await verifyPluginApprovalSignature(name, pluginConfig.approval); }
                        catch { /* A forged/lost-key receipt needs reapproval, not package repair. */ }
                    }
                } catch (error) {
                    blockedReason = 'Plugin package cannot be checked; repair its files before approving it';
                }
            }
            list.push({
                name: plugin.name,
                version: plugin.version || '1.0.0',
                description: plugin.description || pluginConfig.description || '',
                enabled: plugin._enabled === true,
                hasMiddleware: typeof plugin.middleware === 'function',
                hasRoutes: Array.isArray(plugin.routes) && plugin.routes.length > 0,
                hasHooks: plugin.hooks && Object.keys(plugin.hooks).length > 0,
                isBuiltin: !userPlugin,
                trustMode: userPlugin ? PLUGIN_TRUST_MODE : 'builtin',
                requiresApproval: userPlugin && !approved,
                packageHash,
                blockedReason
            });
        }
        return list;
    }

    /**
     * 启用/禁用插件
     * @param {string} name - 插件名称
     * @param {boolean} enabled - 是否启用
     */
    async setPluginEnabled(name, enabled, options = {}) {
        validatePluginId(name);
        if (typeof enabled !== 'boolean') throw new Error('Enabled status must be a boolean');
        return withFileLock(`${PLUGINS_CONFIG_FILE}:operations`, () => this._setPluginEnabled(name, enabled, options));
    }

    async _setPluginEnabled(name, enabled, options) {
        const plugin = this.plugins.get(name);
        const userPlugin = this.isUserPluginName(name);
        const previous = this.pluginsConfig.plugins[name] || {};
        let approval = previous.approval;
        if (enabled && userPlugin) {
            if (options.trust !== true || typeof options.packageHash !== 'string' || !/^[a-f0-9]{64}$/.test(options.packageHash)) {
                throw pluginTrustError('PLUGIN_TRUST_REQUIRED', 'Review the package hash and explicitly accept that this plugin runs with server privileges');
            }
            const hash = await getPluginPackageHash(path.join(USER_PLUGINS_DIR, name));
            if (hash !== options.packageHash) {
                throw pluginTrustError('PLUGIN_PACKAGE_CHANGED', 'Plugin files changed; refresh the plugin list and approve again', 409);
            }
            if (this.loadedUserHashes.has(name) && this.loadedUserHashes.get(name) !== hash) {
                throw pluginTrustError('PLUGIN_RESTART_REQUIRED', 'This package changed after being loaded; restart the service before approving it again', 409);
            }
            approval = await createPluginApproval(name, hash);
        }
        this.pluginsConfig.plugins[name] = { ...previous, enabled, ...(approval ? { approval } : {}) };
        try {
            if (enabled) {
                if (!plugin || plugin._placeholder) {
                    await this.loadAndInitPlugin(name);
                } else {
                    if (!plugin._enabled && typeof plugin.init === 'function') {
                        await this.executePluginOperation(plugin, 'init', () => plugin.init(this.config));
                    }
                    plugin._enabled = true;
                    plugin._errorCount = 0;
                }
            } else if (plugin) {
                // Revoke dispatch first; destroy() must not keep a plugin enabled on failure.
                const wasEnabled = plugin._enabled;
                plugin._enabled = false;
                if (wasEnabled && typeof plugin.destroy === 'function') {
                    await this.executePluginOperation(plugin, 'destroy', () => plugin.destroy());
                }
            }
            await this.saveConfig();
            if (enabled && userPlugin) auditSecurityEvent({ type: 'plugin_trusted', plugin: name, sha256: approval.sha256 });
        } catch (error) {
            const loaded = this.plugins.get(name);
            if (loaded) loaded._enabled = false;
            this.pluginsConfig.plugins[name] = { ...previous, enabled: false };
            await this.saveConfig();
            throw error;
        }
    }

    /**
     * 卸载插件
     * @param {string} name - 插件名称
     */
    async uninstallPlugin(name) {
        validatePluginId(name);
        return withFileLock(`${PLUGINS_CONFIG_FILE}:operations`, () => this._uninstallPlugin(name));
    }

    async _uninstallPlugin(name) {
        // 只能卸载用户插件
        const pluginDir = path.join(USER_PLUGINS_DIR, name);
        
        if (!isInsidePath(USER_PLUGINS_DIR, pluginDir)) {
            throw new Error('不合法的插件名称');
        }
        
        if (!existsSync(pluginDir)) {
            throw new Error('插件不存在或为内置插件，无法卸载');
        }
        
        const plugin = this.plugins.get(name);
        if (plugin) {
            if (plugin._enabled && typeof plugin.destroy === 'function') {
                try {
                    await this.executePluginOperation(plugin, 'destroy', () => plugin.destroy());
                } catch (error) {
                    logger.error(`[PluginManager] Failed to destroy plugin ${name} during uninstall:`, error.message);
                }
            }
            this.plugins.delete(name);
        }
        
        // 从配置中移除
        if (this.pluginsConfig.plugins[name]) {
            delete this.pluginsConfig.plugins[name];
            await this.saveConfig();
        }
        
        // 删除文件目录
        await fs.rm(pluginDir, { recursive: true, force: true });
        logger.info(`[PluginManager] Uninstalled plugin: ${name}`);
    }

    /**
     * 加载并初始化单个插件（用于热插拔）
     * @param {string} name - 插件目录名
     */
    async loadAndInitPlugin(name) {
        validatePluginId(name);
        const userPlugin = this.isUserPluginName(name);
        const pluginPath = path.join(userPlugin ? USER_PLUGINS_DIR : BUILTIN_PLUGINS_DIR, name, 'index.js');
        const settings = this.pluginsConfig.plugins[name] || {};
        let hash;
        if (userPlugin) {
            if (settings.enabled !== true) throw pluginTrustError('PLUGIN_APPROVAL_REQUIRED', 'Enable and approve this plugin before loading it');
            hash = await verifyPluginApproval(path.dirname(pluginPath), settings.approval);
            if (this.loadedUserHashes.has(name) && this.loadedUserHashes.get(name) !== hash) {
                throw pluginTrustError('PLUGIN_RESTART_REQUIRED', 'Restart the service before loading a changed package', 409);
            }
        }
        if (!existsSync(pluginPath)) throw new Error(`Plugin entry not found for "${name}"`);
        const existing = this.plugins.get(name);
        if (existing && !existing._placeholder) throw new Error(`Plugin "${name}" is already loaded`);

        try {
            // Approval happens BEFORE import: top-level code already has host privileges.
            if (userPlugin) this.loadedUserHashes.set(name, hash);
            const pluginModule = await import(`${pathToFileURL(pluginPath).href}?approval=${hash || Date.now()}`);
            const plugin = pluginModule.default || pluginModule;
            validatePluginExport(plugin, name, userPlugin);
            plugin._baseDir = path.dirname(pluginPath);
            plugin._enabled = false;
            if (userPlugin) this.trustedUserPlugins.set(plugin, hash);
            this.register(plugin); // Visible during init(), but not dispatched until init succeeds.
            if (typeof plugin.init === 'function') {
                await this.executePluginOperation(plugin, 'init', () => plugin.init(this.config));
            }
            plugin._enabled = true;
            plugin._errorCount = 0;
            logger.info(`[PluginManager] Plugin ${name} loaded and initialized (${userPlugin ? 'administrator-trusted, NOT sandboxed' : 'builtin'})`);
            return plugin;
        } catch (error) {
            logger.error(`[PluginManager] Failed to load and init plugin ${name}:`, error.message);
            throw error;
        }
    }
}

// 单例实例
const pluginManager = new PluginManager();

/**
 * 自动发现并加载插件
 * 扫描内置和用户插件目录
 */
export async function discoverPlugins() {
    const dirs = [BUILTIN_PLUGINS_DIR, USER_PLUGINS_DIR];
    await pluginManager.loadConfig();
    
    for (const pluginsDir of dirs) {
        try {
            if (!existsSync(pluginsDir)) {
                if (pluginsDir === USER_PLUGINS_DIR) {
                    await fs.mkdir(pluginsDir, { recursive: true });
                    logger.info(`[PluginManager] Created user plugins directory: ${pluginsDir}`);
                }
                continue;
            }
            
            const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
            
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                
                const pluginPath = path.join(pluginsDir, entry.name, 'index.js');
                if (!existsSync(pluginPath)) continue;
                try {
                    validatePluginId(entry.name, 'plugin directory name');
                } catch (error) {
                    logger.warn(`[PluginManager] Skipping plugin directory "${entry.name}": ${error.message}`);
                    continue;
                }

                const pluginConfig = pluginManager.pluginsConfig.plugins[entry.name] || {};
                if (pluginsDir === USER_PLUGINS_DIR) {
                    pluginManager.registerPlaceholder(entry.name, pluginConfig.description || '', path.dirname(pluginPath));
                    logger.info(`[PluginManager] User plugin "${entry.name}" discovered without executing code; approval is checked during init`);
                    continue;
                }

                try {
                    // Only trusted, host-shipped modules may execute in this process.
                    const pluginModule = await import(pathToFileURL(pluginPath).href);
                    const plugin = pluginModule.default || pluginModule;
                    
                    if (plugin && plugin.name) {
                        plugin._baseDir = path.dirname(pluginPath);
                        validatePluginExport(plugin, entry.name, pluginsDir === USER_PLUGINS_DIR);
                        pluginManager.register(plugin);
                    }
                } catch (error) {
                    logger.error(`[PluginManager] Failed to load plugin from ${entry.name} in ${pluginsDir}:`, error.message);
                }
            }
        } catch (error) {
            logger.error(`[PluginManager] Failed to discover plugins in ${pluginsDir}:`, error.message);
        }
    }
}

/**
 * 获取插件管理器实例
 * @returns {PluginManager}
 */
export function getPluginManager() {
    return pluginManager;
}

// 导出类和实例
export { PluginManager, pluginManager };
