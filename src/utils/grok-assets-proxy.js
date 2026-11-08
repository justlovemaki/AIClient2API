import axios from 'axios';
import logger from './logger.js';
import { configureAxiosProxy } from './proxy-utils.js';
import { MODEL_PROVIDER } from './common.js';

/**
 * 处理 Grok 资源代理请求
 * @param {http.IncomingMessage} req 原始请求
 * @param {http.ServerResponse} res 原始响应
 * @param {Object} config 全局配置
 * @param {Object} providerPoolManager 提供商号池管理器
 */
export async function handleGrokAssetsProxy(req, res, config, providerPoolManager) {
    try {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const targetUrl = requestUrl.searchParams.get('url');
        let ssoToken = requestUrl.searchParams.get('sso');
        const uuid = requestUrl.searchParams.get('uuid');

        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }

        // 优先尝试从 uuid 换取 token，提高安全性
        if (!ssoToken && uuid && providerPoolManager) {
            const providerConfig = providerPoolManager.findProviderByUuid(uuid);
            if (providerConfig) {
                ssoToken = providerConfig.GROK_COOKIE_TOKEN;
                logger.debug(`[Grok Proxy] Resolved SSO token from uuid: ${uuid}`);
            } else {
                logger.warn(`[Grok Proxy] Could not find provider configuration for uuid: ${uuid}`);
            }
        }

        if (!ssoToken) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing sso parameter or valid uuid' }));
            return;
        }

        // 清理 token
        if (ssoToken.startsWith('sso=')) {
            ssoToken = ssoToken.substring(4);
        }

        // 构造完整的 assets.grok.com URL（如果是相对路径）
        let finalTargetUrl = targetUrl;
        if (!targetUrl.startsWith('http')) {
            finalTargetUrl = `https://assets.grok.com${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;
        }

        // 验证域名安全，允许代理 Grok 相关域名
        try {
            const parsedTarget = new URL(finalTargetUrl);
            const allowedHostnames = ['assets.grok.com', 'imagine-public.x.ai', 'grok.com'];
            if (!allowedHostnames.includes(parsedTarget.hostname)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Forbidden: Only ${allowedHostnames.join(', ')} are allowed` }));
                return;
            }
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid target URL' }));
            return;
        }

        const headers = {
            'User-Agent': config.GROK_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
            'Cookie': `sso=${ssoToken}; sso-rw=${ssoToken}`,
            'Referer': 'https://grok.com/',
            'Accept': '*/*'
        };

        const axiosConfig = {
            method: 'get',
            url: finalTargetUrl,
            headers: headers,
            responseType: 'stream',
            timeout: 30000,
            validateStatus: false
        };

        // 配置代理
        configureAxiosProxy(axiosConfig, config, MODEL_PROVIDER.GROK_CLI);

        logger.debug(`[Grok Proxy] Proxying request to: ${finalTargetUrl}`);

        const response = await axios(axiosConfig);

        // 转发响应头
        const responseHeaders = {
            'Content-Type': response.headers['content-type'] || 'application/octet-stream',
            'Cache-Control': response.headers['cache-control'] || 'public, max-age=3600',
        };
        
        if (response.headers['content-length']) {
            responseHeaders['Content-Length'] = response.headers['content-length'];
        }

        res.writeHead(response.status, responseHeaders);

        // 管道传输数据
        response.data.pipe(res);

        response.data.on('error', (err) => {
            logger.error(`[Grok Proxy] Stream error: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end();
            } else {
                res.end();
            }
        });

    } catch (error) {
        logger.error(`[Grok Proxy] Error: ${error.message}`);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal Server Error', message: error.message }));
        } else {
            res.end();
        }
    }
}
