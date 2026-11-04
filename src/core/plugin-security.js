import { promises as fs } from 'fs';
import { existsSync, realpathSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const TEXT_FILE_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.json', '.html', '.css', '.txt', '.md', '.yml', '.yaml', '.env'
]);

// Advisory upload signals only: legitimate trusted plugins may use these APIs.
// Neither matching nor passing this list grants or revokes administrator trust.
export const DANGEROUS_PLUGIN_PATTERNS = [
    { pattern: /\b(?:node:)?child_process\b/i, reason: 'child_process system command API' },
    { pattern: /\b(?:spawn|exec|execFile|fork)\s*\(/i, reason: 'process execution call' },
    { pattern: /BEGIN OPENSSH PRIVATE KEY/i, reason: 'embedded OpenSSH private key' },
    { pattern: /\bssh\s+-R\b/i, reason: 'SSH reverse tunnel command' },
    { pattern: /StrictHostKeyChecking/i, reason: 'SSH host key bypass option' },
    { pattern: /localhost:2222/i, reason: 'localhost:2222 tunnel target' },
    { pattern: /\b(?:12222|12223)\b/i, reason: 'known reverse tunnel port' },
    { pattern: /\b(?:strix_|strix-|fixp_)/i, reason: 'known malicious plugin marker' }
];

const RESERVED_ROUTE_PREFIXES = [
    '/api/login',
    '/api/plugins',
    '/api/config',
    '/api/system',
    '/api/update',
    '/api/oauth',
    '/api/access',
    '/api/upload',
    '/api/health',
    '/api/help',
    '/api/example',
    '/api/grok/assets'
];

// Reviewed compatibility alias: only the Potluck USER endpoint authenticates
// with its own API key. Never exempt the adjacent /api/potluck admin namespace.
const BUILTIN_PUBLIC_ROUTE_ALIASES = new Map([
    ['api-potluck', new Set(['/api/potluckuser'])]
]);

export function auditSecurityEvent(event) {
    const payload = {
        time: new Date().toISOString(),
        ...event
    };
    logger.warn('[Security Hardening]', JSON.stringify(payload));
}

export function validatePluginId(pluginId, label = 'pluginId') {
    if (typeof pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(pluginId) ||
        Object.hasOwn(Object.prototype, pluginId) || pluginId === 'prototype') {
        throw new Error(`[Security Hardening] Invalid ${label}: only letters, numbers, "_" and "-" are allowed, length 1-64`);
    }
    return pluginId;
}

export function isInsidePath(basePath, targetPath) {
    const relativePath = path.relative(path.resolve(basePath), path.resolve(targetPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function assertPathInside(basePath, targetPath, message) {
    if (!isInsidePath(basePath, targetPath)) {
        throw new Error(message || `[Security Hardening] Path escapes allowed directory: ${targetPath}`);
    }
}

export function normalizePluginArchiveEntryName(entryName, pluginId) {
    validatePluginId(pluginId);

    if (typeof entryName !== 'string' || !entryName) {
        throw new Error('[Security Hardening] 插件包包含无效文件路径');
    }

    const normalizedSeparators = entryName.replace(/\\/g, '/');
    if (
        normalizedSeparators.includes('\0') ||
        normalizedSeparators.startsWith('/') ||
        normalizedSeparators.startsWith('//') ||
        /^[A-Za-z]:\//.test(normalizedSeparators) ||
        normalizedSeparators.includes(':')
    ) {
        throw new Error(`[Security Hardening] 插件包包含不安全路径: ${entryName}`);
    }

    let parts = normalizedSeparators.split('/').filter(Boolean);
    if (parts.includes('..')) {
        throw new Error(`[Security Hardening] 检测到 Zip Slip 路径穿越拦截: ${entryName}`);
    }

    if (parts[0] === pluginId) {
        parts = parts.slice(1);
    }

    if (parts.length === 0 || parts.includes('..')) {
        throw new Error(`[Security Hardening] 插件包包含无效文件路径: ${entryName}`);
    }

    const safeRelativePath = path.posix.normalize(parts.join('/'));
    if (safeRelativePath === '.' || safeRelativePath.startsWith('../') || path.posix.isAbsolute(safeRelativePath)) {
        throw new Error(`[Security Hardening] 检测到 Zip Slip 路径穿越拦截: ${entryName}`);
    }

    return safeRelativePath;
}

export function shouldScanPluginFile(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    return TEXT_FILE_EXTENSIONS.has(ext) || ext === '';
}

export function warnAboutPluginTextContent(content, label = 'plugin file') {
    const signals = DANGEROUS_PLUGIN_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(({ reason }) => reason);
    if (signals.length) auditSecurityEvent({ type: 'plugin_source_advisory', file: label, signals });
    return signals;
}

export async function scanPluginDirectory(pluginDir, label = pluginDir) {
    const resolvedPluginDir = path.resolve(pluginDir);
    const physicalPluginDir = existsSync(resolvedPluginDir) ? realpathSync(resolvedPluginDir) : resolvedPluginDir;

    async function walk(currentDir) {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            assertPathInside(resolvedPluginDir, entryPath);

            if (entry.isSymbolicLink()) {
                throw new Error(`[Security Hardening] 插件目录不允许包含符号链接: ${entryPath}`);
            }

            if (entry.isDirectory()) {
                const physicalEntryPath = realpathSync(entryPath);
                assertPathInside(physicalPluginDir, physicalEntryPath, `[Security Hardening] 插件目录真实路径越界: ${entryPath}`);
                await walk(entryPath);
                continue;
            }

            if (!entry.isFile() || !shouldScanPluginFile(entry.name)) continue;

            const content = await fs.readFile(entryPath, 'utf8');
            warnAboutPluginTextContent(content, `${label}/${path.relative(resolvedPluginDir, entryPath)}`);
        }
    }

    await walk(resolvedPluginDir);
}

function validateStaticPath(staticPath, pluginName) {
    if (typeof staticPath !== 'string' || !staticPath) {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" has invalid static path`);
    }
    const normalized = staticPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (
        normalized.includes('\0') ||
        normalized.includes('..') ||
        path.isAbsolute(staticPath) ||
        normalized.startsWith('api/')
    ) {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" static path is not allowed: ${staticPath}`);
    }
}

function validateRoute(route, pluginName, isUserPlugin) {
    if (!route || typeof route !== 'object') {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" has invalid route`);
    }
    if (typeof route.method !== 'string' || !/^(?:\*|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(route.method)) {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" route has invalid method`);
    }
    if (route.public !== undefined && typeof route.public !== 'boolean') {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" route.public must be a boolean`);
    }
    if (typeof route.handler !== 'function') {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" route handler must be a function`);
    }
    if (typeof route.path !== 'string') {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" route path must be a string`);
    }
    if (!route.path.startsWith('/api/') || !/^\/api\/[A-Za-z0-9_/-]+$/.test(route.path) ||
        route.path.slice(1).split('/').some(segment => !segment) || route.path.endsWith('/')) {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" route must stay under a specific /api/* path`);
    }
    const reviewedAlias = !isUserPlugin && BUILTIN_PUBLIC_ROUTE_ALIASES.get(pluginName)?.has(route.path);
    if (route.public === true && !reviewedAlias && route.path !== `/api/${pluginName}` && !route.path.startsWith(`/api/${pluginName}/`)) {
        throw new Error(`[Security Hardening] Public routes must use the plugin's own /api/${pluginName} namespace`);
    }
    if (RESERVED_ROUTE_PREFIXES.some(prefix => route.path === prefix || route.path.startsWith(prefix + '/'))) {
        throw new Error(`[Security Hardening] Plugin "${pluginName}" route conflicts with reserved API path: ${route.path}`);
    }
}

export function validatePluginExport(plugin, directoryName, isUserPlugin = false) {
    if (!plugin || typeof plugin !== 'object') {
        throw new Error(`[Security Hardening] Plugin "${directoryName}" did not export a plugin object`);
    }
    validatePluginId(plugin.name, 'plugin.name');
    if (isUserPlugin && plugin.name !== directoryName) {
        throw new Error(`[Security Hardening] User plugin name must match its directory: ${directoryName}`);
    }
    if (plugin.staticPaths !== undefined) {
        if (!Array.isArray(plugin.staticPaths)) {
            throw new Error(`[Security Hardening] Plugin "${plugin.name}" staticPaths must be an array`);
        }
        for (const staticPath of plugin.staticPaths) {
            validateStaticPath(staticPath, plugin.name);
        }
    }
    if (plugin.routes !== undefined) {
        if (!Array.isArray(plugin.routes)) {
            throw new Error(`[Security Hardening] Plugin "${plugin.name}" routes must be an array`);
        }
        for (const route of plugin.routes) {
            validateRoute(route, plugin.name, isUserPlugin);
        }
    }
}

export function resolvePluginStaticFile(plugin, requestPath) {
    if (!plugin?._baseDir || !Array.isArray(plugin.staticPaths)) return null;

    const normalizedRequestPath = requestPath.replace(/^\/+/, '');
    const staticPath = plugin.staticPaths.find(sp => {
        const normalized = String(sp).replace(/^\/+/, '');
        return normalizedRequestPath === normalized;
    });
    if (!staticPath) return null;

    const filePath = path.resolve(plugin._baseDir, String(staticPath).replace(/^\/+/, ''));
    const baseDir = path.resolve(plugin._baseDir);
    assertPathInside(baseDir, filePath, `[Security Hardening] Plugin static file path escapes plugin directory: ${requestPath}`);

    if (existsSync(filePath)) {
        const physicalBase = realpathSync(baseDir);
        const physicalFile = realpathSync(filePath);
        assertPathInside(physicalBase, physicalFile, `[Security Hardening] Plugin static file real path escapes plugin directory: ${requestPath}`);
    }

    return filePath;
}
