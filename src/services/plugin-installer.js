import axios from 'axios';
import AdmZip from 'adm-zip';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';
import logger from '../utils/logger.js';
import { getPluginManager } from '../core/plugin-manager.js';
import {
    assertPathInside,
    normalizePluginArchiveEntryName,
    shouldScanPluginFile,
    validatePluginId,
    warnAboutPluginTextContent
} from '../core/plugin-security.js';

const DEFAULT_MARKET_URL = 'https://source.hex2077.dev/files/market.json';
const LOCAL_MARKET_FILE = path.join(process.cwd(), 'configs', 'market.json');
const PLUGINS_DIR = path.join(process.cwd(), 'src', 'plugins-user');
const MAX_PLUGIN_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 5;
const MAX_PLUGIN_EXTRACTED_BYTES = 20 * 1024 * 1024;
const MAX_PLUGIN_FILES = 1000;

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => Number.isNaN(part))) return true;

    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) ||
        a >= 224
    );
}

function isPrivateIPv6(ip) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('::ffff:')) {
        return isPrivateIPv4(normalized.slice(7));
    }
    return false;
}

function isBlockedAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return isPrivateIPv4(address);
    if (family === 6) return isPrivateIPv6(address);
    return true;
}

async function resolvePublicAddresses(hostname) {
    const normalizedHostname = hostname.replace(/^\[(.*)\]$/, '$1');
    const literalIpFamily = net.isIP(normalizedHostname);
    const addresses = literalIpFamily
        ? [{ address: normalizedHostname, family: literalIpFamily }]
        : await dns.lookup(normalizedHostname, { all: true, verbatim: true });

    if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
        throw new Error('[Security Hardening] Plugin download URL resolves to a blocked address');
    }

    return addresses;
}

function secureLookup(hostname, options, callback) {
    resolvePublicAddresses(hostname)
        .then((addresses) => {
            const family = options?.family;
            const selected = family ? addresses.find(address => address.family === family) : addresses[0];
            if (!selected) {
                callback(new Error('[Security Hardening] No allowed address for requested IP family'));
                return;
            }
            callback(null, selected.address, selected.family);
        })
        .catch(callback);
}

export async function validatePluginDownloadUrl(downloadUrl) {
    let url;
    try {
        url = new URL(downloadUrl);
    } catch (error) {
        throw new Error('[Security Hardening] Invalid plugin download URL');
    }

    if (url.protocol !== 'https:') {
        throw new Error('[Security Hardening] Plugin download URL must use https');
    }

    if (url.username || url.password) {
        throw new Error('[Security Hardening] Plugin download URL must not contain credentials');
    }

    await resolvePublicAddresses(url.hostname);

    return url.toString();
}

async function downloadPluginArchive(downloadUrl, redirectsRemaining = MAX_DOWNLOAD_REDIRECTS) {
    const safeUrl = await validatePluginDownloadUrl(downloadUrl);
    const response = await axios({
        method: 'get',
        url: safeUrl,
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 0,
        maxContentLength: MAX_PLUGIN_ZIP_BYTES,
        maxBodyLength: MAX_PLUGIN_ZIP_BYTES,
        lookup: secureLookup,
        validateStatus: status => (status >= 200 && status < 300) || (status >= 300 && status < 400)
    });

    if (response.status >= 300 && response.status < 400) {
        if (redirectsRemaining <= 0 || !response.headers.location) {
            throw new Error('[Security Hardening] Plugin download redirect is not allowed');
        }
        const redirectedUrl = new URL(response.headers.location, safeUrl).toString();
        return downloadPluginArchive(redirectedUrl, redirectsRemaining - 1);
    }

    const buffer = Buffer.from(response.data);
    if (buffer.length > MAX_PLUGIN_ZIP_BYTES) {
        throw new Error('[Security Hardening] Plugin package exceeds maximum allowed size');
    }
    return buffer;
}

export function validatePluginArchiveBuffer(buffer, label = 'plugin archive') {
    validatePluginId(label, 'plugin archive id');
    const zip = new AdmZip(buffer);
    const zipEntries = zip.getEntries();
    if (zipEntries.length > MAX_PLUGIN_FILES) throw new Error('Plugin archive contains too many entries');
    let extractedBytes = 0;
    const paths = new Set();

    for (const entry of zipEntries) {
        if (entry.isDirectory) continue;
        const relativePath = normalizePluginArchiveEntryName(entry.entryName, label);
        const key = relativePath.toLowerCase();
        if (paths.has(key)) throw new Error('Plugin archive contains duplicate paths');
        paths.add(key);
        extractedBytes += entry.header.size;
        if (extractedBytes > MAX_PLUGIN_EXTRACTED_BYTES) throw new Error('Plugin archive expands beyond size limit');
        if (!shouldScanPluginFile(relativePath)) continue;

        const content = entry.getData().toString('utf8');
        warnAboutPluginTextContent(content, `${label}/${relativePath}`);
    }
}

/**
 * 获取插件市场列表
 * @param {string} [url] - 可选的更新 URL，如果提供则从该地址抓取并覆盖本地缓存
 */
export async function fetchMarketPlugins(url = null) {
    const targetUrl = url || DEFAULT_MARKET_URL;
    
    try {
        // 优先从网络获取
        const response = await axios.get(targetUrl, { timeout: 10000 });
        const marketData = response.data;

        // 成功获取后更新本地缓存
        try {
            await fs.mkdir(path.dirname(LOCAL_MARKET_FILE), { recursive: true });
            await fs.writeFile(LOCAL_MARKET_FILE, JSON.stringify(marketData, null, 2), 'utf8');
        } catch (saveError) {
            logger.warn('[PluginInstaller] Failed to cache market data locally:', saveError.message);
        }

        return marketData;
    } catch (error) {
        // 网络请求失败，尝试使用本地缓存
        if (existsSync(LOCAL_MARKET_FILE)) {
            try {
                logger.info(`[PluginInstaller] Using local market cache due to fetch error: ${error.message}`);
                const content = await fs.readFile(LOCAL_MARKET_FILE, 'utf8');
                return JSON.parse(content);
            } catch (localError) {
                logger.error('[PluginInstaller] Failed to read local market cache:', localError.message);
            }
        }

        logger.error('[PluginInstaller] Failed to fetch market index:', error.message);
        throw new Error('获取插件市场失败（网络请求失败且无可用本地缓存）：' + error.message);
    }
}

/**
 * 内部通用的安装逻辑
 * @private
 */
async function _executeInstallFromBuffer(id, zipBuffer) {
    validatePluginId(id);
    const pluginPath = path.join(PLUGINS_DIR, id);
    // No replacement of host-shipped code or previously installed packages.
    // In particular, never follow a pre-existing destination symlink.
    if (existsSync(path.join(process.cwd(), 'src', 'plugins', id))) {
        throw new Error('Cannot replace a built-in plugin');
    }
    await fs.mkdir(PLUGINS_DIR, { recursive: true });
    if ((await fs.lstat(PLUGINS_DIR)).isSymbolicLink()) throw new Error('Plugin directory must not be a symbolic link');
    try {
        await fs.lstat(pluginPath);
        throw new Error('Plugin already exists; uninstall it before installing another package');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    validatePluginArchiveBuffer(zipBuffer, id);
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();

    const stagingPath = await fs.mkdtemp(path.join(PLUGINS_DIR, '.install-'));
    try {
        for (const entry of zipEntries) {
            if (entry.isDirectory) continue;
            const relativePath = normalizePluginArchiveEntryName(entry.entryName, id);
            const targetPath = path.resolve(stagingPath, relativePath);
            assertPathInside(stagingPath, targetPath);
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, entry.getData(), { flag: 'wx' });
        }
        if (!existsSync(path.join(stagingPath, 'index.js'))) {
            throw new Error('插件包内未找到 index.js 入口文件');
        }
        // Atomic publication of a complete, disabled package; never import it here.
        await fs.rename(stagingPath, pluginPath);
        const pluginManager = getPluginManager();
        await pluginManager.setPluginEnabled(id, false);
        pluginManager.registerPlaceholder(id, '', pluginPath);
        return true;
    } finally {
        await fs.rm(stagingPath, { recursive: true, force: true });
    }
}

/**
 * 下载并安装插件
 */
export async function installPlugin(pluginInfo) {
    const { id, downloadUrl } = pluginInfo;
    validatePluginId(id);

    try {
        const zipBuffer = await downloadPluginArchive(downloadUrl);
        await _executeInstallFromBuffer(id, zipBuffer);
        return true;
    } catch (error) {
        logger.error(`[PluginInstaller] Installation failed for ${id}:`, error.message);
        throw error;
    }
}

/**
 * 从上传的文件安装插件
 */
export async function installPluginFromBuffer(pluginId, buffer) {
    validatePluginId(pluginId);

    try {
        if (buffer.length > MAX_PLUGIN_ZIP_BYTES) {
            throw new Error('[Security Hardening] Plugin package exceeds maximum allowed size');
        }
        await _executeInstallFromBuffer(pluginId, buffer);
        return true;
    } catch (error) {
        logger.error(`[PluginInstaller] Upload installation failed:`, error.message);
        throw error;
    }
}
