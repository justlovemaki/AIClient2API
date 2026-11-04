import { getPluginManager } from '../core/plugin-manager.js';
import logger from '../utils/logger.js';
import { getRequestBody } from '../utils/common.js';
import { broadcastEvent } from './event-broadcast.js';
import { fetchMarketPlugins, installPlugin, installPluginFromBuffer } from '../services/plugin-installer.js';
import multer from 'multer';
import path from 'path';
import { requireManagementAuth, requireAdminReauthentication } from './auth.js';

// 配置插件上传
const storage = multer.memoryStorage();
const pluginUpload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB 限制
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() === '.zip') {
            cb(null, true);
        } else {
            cb(new Error('只支持上传 .zip 格式的插件包'), false);
        }
    }
});

/**
 * 获取插件列表
 */
export async function handleGetPlugins(req, res) {
    try {
        const pluginManager = getPluginManager();
        const plugins = await pluginManager.getPluginList();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ plugins }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to get plugins:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get plugins list: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 上传并安装插件
 */
export async function handleUploadPlugin(req, res) {
    if (!await requireManagementAuth(req, res)) return true;
    return new Promise((resolve) => {
        pluginUpload.single('file')(req, res, async (err) => {
            if (err) {
                logger.error('[UI API] Plugin upload validation failed:', err);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: '插件上传失败' } }));
                return resolve(true);
            }

            try {
                if (!req.file) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: '未选择文件' } }));
                    return resolve(true);
                }

                const pluginId = req.body.pluginId || path.parse(req.file.originalname).name;
                await installPluginFromBuffer(pluginId, req.file.buffer);

                // 广播事件
                broadcastEvent('plugin_update', {
                    action: 'install',
                    pluginId,
                    timestamp: new Date().toISOString()
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: '插件上传并安装成功' }));
                resolve(true);
            } catch (error) {
                logger.error('[UI API] Failed to upload plugin:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: '插件安装失败' } }));
                resolve(true);
            }
        });
    });
}


/**
 * 获取插件市场列表
 */
export async function handleGetMarketPlugins(req, res) {
    try {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const updateUrl = urlObj.searchParams.get('url');
        
        const marketPlugins = await fetchMarketPlugins(updateUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ plugins: marketPlugins }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to fetch market plugins:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: error.message
            }
        }));
        return true;
    }
}

/**
 * 安装插件
 */
export async function handleInstallPlugin(req, res) {
    if (!await requireManagementAuth(req, res)) return true;
    try {
        const body = await getRequestBody(req);
        const { plugin } = body;

        if (!plugin || !plugin.id || !plugin.downloadUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: '无效的插件信息' } }));
            return true;
        }

        await installPlugin(plugin);

        // 广播安装成功事件
        broadcastEvent('plugin_update', {
            action: 'install',
            pluginId: plugin.id,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `插件 ${plugin.id} 安装成功` }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to install plugin:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: '插件安装失败'
            }
        }));
        return true;
    }
}

/**
 * 切换插件状态
 */
export async function handleTogglePlugin(req, res, pluginName) {
    if (!await requireManagementAuth(req, res)) return true;
    try {
        const body = await getRequestBody(req, { maxBytes: 10 * 1024 });
        const { enabled, password, trust, packageHash } = body;

        if (typeof enabled !== 'boolean') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Enabled status must be a boolean'
                }
            }));
            return true;
        }

        if (enabled && !await requireAdminReauthentication(req, res, password)) return true;
        const pluginManager = getPluginManager();
        await pluginManager.setPluginEnabled(pluginName, enabled, { trust, packageHash });

        // 广播更新事件
        broadcastEvent('plugin_update', {
            action: 'toggle',
            pluginName,
            enabled,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Plugin ${pluginName} ${enabled ? 'enabled' : 'disabled'} successfully`,
            plugin: {
                name: pluginName,
                enabled
            }
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to toggle plugin:', error);
        const trustError = ['PLUGIN_TRUST_REQUIRED', 'PLUGIN_APPROVAL_REQUIRED', 'PLUGIN_PACKAGE_CHANGED', 'PLUGIN_PACKAGE_INVALID', 'PLUGIN_RESTART_REQUIRED'].includes(error.code);
        res.writeHead(trustError ? error.status : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                code: trustError ? error.code : 'PLUGIN_TOGGLE_FAILED',
                message: trustError ? error.message : 'Failed to toggle plugin'
            }
        }));
        return true;
    }
}

/**
 * 卸载插件
 */
export async function handleUninstallPlugin(req, res, pluginName) {
    if (!await requireManagementAuth(req, res)) return true;
    try {
        const pluginManager = getPluginManager();
        await pluginManager.uninstallPlugin(pluginName);

        // 广播更新事件
        broadcastEvent('plugin_update', {
            action: 'uninstall',
            pluginName,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Plugin ${pluginName} uninstalled successfully`
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to uninstall plugin:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to uninstall plugin: ' + error.message
            }
        }));
        return true;
    }
}
