import { existsSync, readFileSync } from 'fs';
import { atomicWriteFile, withFileLock } from '../utils/file-lock.js';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { CONFIG } from '../core/config-manager.js';
import { parseProxyUrl } from '../utils/proxy-utils.js';
import { getRequestBody } from '../utils/common.js';
import { isValidVersionTag } from '../utils/version-tag.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const GITHUB_REPO = 'justlovemaki/AIClient2API';

function normalizeUpdateEntryName(name) {
    return name.toLowerCase().replace(/[. ]+$/, '');
}

function buildGitHubApiCandidates(repo) {
    const apiPath = `repos/${repo}/tags`;
    return [
        {
            name: 'gh-proxy.org',
            url: `https://gh-proxy.org/https://api.github.com/${apiPath}`
        },
        {
            name: 'hk.gh-proxy.org',
            url: `https://hk.gh-proxy.org/https://api.github.com/${apiPath}`
        },
        {
            name: 'cdn.gh-proxy.org',
            url: `https://cdn.gh-proxy.org/https://api.github.com/${apiPath}`
        },
                {
            name: 'edgeone.gh-proxy.org',
            url: `https://edgeone.gh-proxy.org/https://api.github.com/${apiPath}`
        },
        {
            name: 'github-direct',
            url: `https://api.github.com/${apiPath}`
        }
    ];
}

function buildTarballCandidates(repo, tag) {
    const safeTag = encodeURIComponent(tag);
    const githubTarballPath = `${repo}/archive/refs/tags/${safeTag}.tar.gz`;
    return [
        {
            name: 'gh-proxy.org',
            url: `https://gh-proxy.org/https://github.com/${githubTarballPath}`
        },
        {
            name: 'hk.gh-proxy.org',
            url: `https://hk.gh-proxy.org/https://github.com/${githubTarballPath}`
        },
        {
            name: 'cdn.gh-proxy.org',
            url: `https://cdn.gh-proxy.org/https://github.com/${githubTarballPath}`
        },
        {
            name: 'edgeone.gh-proxy.org',
            url: `https://edgeone.gh-proxy.org/https://github.com/${githubTarballPath}`
        },
        {
            name: 'gitclone.com',
            url: `https://gitclone.com/github.com/${githubTarballPath}`
        }
    ];
}

/**
 * 获取更新检查使用的代理配置
 * @returns {Object|null} 代理配置对象或 null
 */
function getUpdateProxyConfig() {
    if (!CONFIG || !CONFIG.PROXY_URL) {
        return null;
    }
    
    const proxyConfig = parseProxyUrl(CONFIG.PROXY_URL);
    if (proxyConfig) {
        logger.info(`[Update] Using ${proxyConfig.proxyType} proxy for update check: ${CONFIG.PROXY_URL}`);
    }
    return proxyConfig;
}

/**
 * 带代理支持的 fetch 封装
 * @param {string} url - 请求 URL
 * @param {Object} options - fetch 选项
 * @returns {Promise<Response>}
 */
async function fetchWithProxy(url, options = {}) {
    const proxyConfig = getUpdateProxyConfig();

    const method = options.method || 'GET';
    const headers = options.headers || {};
    const timeout = options.timeout || 0;
    const responseType = options.responseType || 'arraybuffer';
    const maxRedirects = options.redirect === 'manual' ? 0 : 5;

    try {
        const axiosOptions = {
            method,
            url,
            headers,
            data: options.body,
            timeout,
            responseType,
            maxRedirects,
            validateStatus: () => true
        };

        if (proxyConfig) {
            const urlObj = new URL(url);
            axiosOptions.httpAgent = urlObj.protocol === 'https:' ? proxyConfig.httpsAgent : proxyConfig.httpAgent;
            axiosOptions.httpsAgent = proxyConfig.httpsAgent;
            axiosOptions.proxy = false;
        }

        const response = await axios.request(axiosOptions);
        const payloadBuffer = Buffer.isBuffer(response.data)
            ? response.data
            : Buffer.from(response.data || '');

        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            statusText: response.statusText,
            async json() {
                return JSON.parse(payloadBuffer.toString('utf8'));
            },
            async arrayBuffer() {
                return payloadBuffer;
            }
        };
    } catch (error) {
        throw error;
    }
}

/**
 * 比较版本号
 * @param {string} v1 - 版本号1
 * @param {string} v2 - 版本号2
 * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
    // 移除 'v' 前缀（如果有）
    const clean1 = v1.replace(/^v/, '');
    const clean2 = v2.replace(/^v/, '');
    
    const parts1 = clean1.split('.').map(Number);
    const parts2 = clean2.split('.').map(Number);
    
    const maxLen = Math.max(parts1.length, parts2.length);
    
    for (let i = 0; i < maxLen; i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;
        
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }
    
    return 0;
}

/**
 * 通过 GitHub API 获取最近的版本列表
 * @param {number} limit - 限制返回的版本数量
 * @returns {Promise<string[]>} 版本列表
 */
async function getVersionsFromGitHub(limit = 10) {
    const candidates = buildGitHubApiCandidates(GITHUB_REPO);
    
    for (const candidate of candidates) {
        try {
            logger.info(`[Update] Fetching versions from GitHub API via ${candidate.name}...`);
            const response = await fetchWithProxy(candidate.url, {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'AIClient2API-UpdateChecker'
                },
                timeout: 10000
            });
            
            if (!response.ok) {
                throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
            }
            
            const tags = await response.json();
            
            if (!Array.isArray(tags) || tags.length === 0) {
                logger.warn(`[Update] No tags returned via ${candidate.name}`);
                continue;
            }
            
            // 提取版本号并排序
            const versions = tags
                .map(tag => tag.name)
                .filter(isValidVersionTag);
            
            if (versions.length === 0) {
                logger.warn(`[Update] No valid version tags found via ${candidate.name}`);
                continue;
            }
            
            versions.sort((a, b) => compareVersions(b, a));
            return versions.slice(0, limit);
        } catch (error) {
            logger.warn(`[Update] Failed to fetch versions via ${candidate.name}: ${error.message}`);
        }
    }
    
    logger.warn('[Update] All GitHub API proxy attempts failed');
    return [];
}

/**
 * 通过 GitHub API 获取最新版本
 * @returns {Promise<string|null>} 最新版本号或 null
 */
async function getLatestVersionFromGitHub() {
    const versions = await getVersionsFromGitHub(1);
    return versions.length > 0 ? versions[0] : null;
}

/**
 * 检查是否有新版本可用
 * 支持两种模式：
 * 1. Git 仓库模式：通过 git 命令获取最新 tag
 * 2. Docker/非 Git 模式：通过 GitHub API 获取最新版本
 * @returns {Promise<Object>} 更新信息
 */
export async function checkForUpdates() {
    const versionFilePath = path.join(process.cwd(), 'VERSION');
    
    // 读取本地版本
    let localVersion = 'unknown';
    try {
        if (existsSync(versionFilePath)) {
            localVersion = readFileSync(versionFilePath, 'utf-8').trim();
        }
    } catch (error) {
        logger.warn('[Update] Failed to read local VERSION file:', error.message);
    }
    
    // 检查是否在 git 仓库中
    let isGitRepo = false;
    try {
        await execAsync('git rev-parse --git-dir');
        isGitRepo = true;
    } catch (error) {
        isGitRepo = false;
        logger.info('[Update] Not in a Git repository, will use GitHub API to check for updates');
    }
    
    let latestTag = null;
    let availableVersions = [];
    let updateMethod = 'unknown';
    
    if (isGitRepo) {
        // Git 仓库模式：使用 git命令
        updateMethod = 'git';
        
        // 获取远程 tags
        try {
            logger.info('[Update] Fetching remote tags...');
            await execAsync('git fetch --tags');
        } catch (error) {
            logger.warn('[Update] Failed to fetch tags via git, falling back to GitHub API');
            // 如果 git fetch 失败，回退到 GitHub API
            availableVersions = await getVersionsFromGitHub(10);
            latestTag = availableVersions.length > 0 ? availableVersions[0] : null;
            updateMethod = 'github_api';
        }
        
        // 如果 git fetch 成功，获取最新的 tag 和可用的 tags
        if (!latestTag && updateMethod === 'git') {
            try {
                // 获取最近的 10 个 tag
                const { stdout } = await execAsync('git tag --sort=-v:refname');
                const tags = stdout.trim().split('\n').filter(isValidVersionTag);
                if (tags.length > 0) {
                    availableVersions = tags.slice(0, 10);
                    latestTag = availableVersions[0];
                }
            } catch (error) {
                logger.warn('[Update] Failed to get tags via git, falling back to GitHub API:', error.message);
                availableVersions = await getVersionsFromGitHub(10);
                latestTag = availableVersions.length > 0 ? availableVersions[0] : null;
                updateMethod = 'github_api';
            }
        }
    } else {
        // 非 Git 仓库模式（如 Docker 容器）：使用 GitHub API
        updateMethod = 'github_api';
        availableVersions = await getVersionsFromGitHub(10);
        latestTag = availableVersions.length > 0 ? availableVersions[0] : null;
    }
    
    if (!latestTag) {
        return {
            hasUpdate: false,
            localVersion,
            latestVersion: null,
            availableVersions: [],
            updateMethod,
            error: 'Unable to get latest version information'
        };
    }
    
    // 比较版本
    const comparison = compareVersions(latestTag, localVersion);
    const hasUpdate = comparison > 0;
    
    logger.info(`[Update] Local version: ${localVersion}, Latest version: ${latestTag}, Has update: ${hasUpdate}, Method: ${updateMethod}`);
    
    return {
        hasUpdate,
        localVersion,
        latestVersion: latestTag,
        availableVersions,
        updateMethod,
        error: null
    };
}

/**
 * 执行更新操作
 * @param {string} targetTag - 目标版本 tag，如果未提供则更新到最新版本
 * @returns {Promise<Object>} 更新结果
 */
export async function performUpdate(targetTag = null) {
    if (targetTag !== null) {
        if (!isValidVersionTag(targetTag)) {
            throw new Error('Invalid version tag format');
        }
    }
    // 首先检查是否有更新
    const updateInfo = await checkForUpdates();
    
    if (updateInfo.error) {
        throw new Error(updateInfo.error);
    }
    
    // 如果未提供 targetTag，使用最新版本
    const latestTag = updateInfo.latestVersion;
    const finalTag = targetTag || latestTag;
    if (!isValidVersionTag(finalTag)) {
        throw new Error('Invalid version tag format');
    }
    
    // 如果是更新到最新版本，且当前已是最新版本
    if (!targetTag && !updateInfo.hasUpdate) {
        return {
            success: true,
            message: 'Already at the latest version',
            localVersion: updateInfo.localVersion,
            latestVersion: updateInfo.latestVersion,
            updated: false
        };
    }
    
    // 如果指定了 tag，但与本地版本相同
    if (targetTag && (targetTag === updateInfo.localVersion || targetTag === `v${updateInfo.localVersion}`)) {
        return {
            success: true,
            message: `Already at version ${targetTag}`,
            localVersion: updateInfo.localVersion,
            latestVersion: updateInfo.latestVersion,
            updated: false
        };
    }
    
    // 检查更新方式 - 如果是通过 GitHub API 获取的版本信息，说明不在 Git 仓库中
    if (updateInfo.updateMethod === 'github_api') {
        // Docker/非 Git 环境，通过下载 tarball 更新
        logger.info(`[Update] Running in Docker/non-Git environment, will download and extract tarball for ${finalTag}`);
        return await performTarballUpdate(updateInfo.localVersion, finalTag);
    }
    
    // Git checkout can overwrite ignored files if a target tag tracks them.
    // Refuse such releases BEFORE stash/checkout instead of replacing host keys.
    const { stdout: trackedRootEntries } = await execFileAsync('git', ['ls-tree', '-z', '--name-only', finalTag]);
    if (trackedRootEntries.split('\0').some(name => normalizeUpdateEntryName(name) === '.private')) {
        throw new Error('Refusing Git update: target version contains instance-private state (.private)');
    }

    logger.info(`[Update] Starting update to ${finalTag}...`);

    // 检查是否有未提交的更改
    try {
        const { stdout: statusOutput } = await execAsync('git status --porcelain');
        if (statusOutput.trim()) {
            // 有未提交的更改，先 stash
            logger.info('[Update] Stashing local changes...');
            await execAsync('git stash');
        }
    } catch (error) {
        logger.warn('[Update] Failed to check git status:', error.message);
    }
    
    // 执行 checkout 到目标 tag
    try {
        logger.info(`[Update] Checking out to ${finalTag}...`);
        await execFileAsync('git', ['checkout', finalTag]);
    } catch (error) {
        logger.error('[Update] Failed to checkout:', error.message);
        throw new Error(`Failed to switch to version ${finalTag}: ` + error.message);
    }
    
    // 更新 VERSION 文件（如果 tag 和 VERSION 文件不同步）
    const versionFilePath = path.join(process.cwd(), 'VERSION');
    try {
        const newVersion = finalTag.replace(/^v/, '');
        await withFileLock(versionFilePath, async () => {
            await atomicWriteFile(versionFilePath, newVersion, 'utf-8');
        });
        logger.info(`[Update] VERSION file updated to ${newVersion}`);
    } catch (error) {
        logger.warn('[Update] Failed to update VERSION file:', error.message);
    }
    
    // 检查是否需要安装依赖
    let needsRestart = false;
    try {
        // 确保本地版本号有 v 前缀，以匹配 git tag 格式
        const localVersionTag = updateInfo.localVersion.startsWith('v') ? updateInfo.localVersion : `v${updateInfo.localVersion}`;
        if (isValidVersionTag(localVersionTag) && isValidVersionTag(finalTag)) {
            const { stdout: diffOutput } = await execFileAsync('git', ['diff', `${localVersionTag}..${finalTag}`, '--name-only']);
            if (diffOutput.includes('package.json') || diffOutput.includes('package-lock.json')) {
                logger.info('[Update] package.json changed, running npm install...');
                await execAsync('npm install');
                needsRestart = true;
            }
        } else {
            logger.warn('[Update] Skipping package change check due to invalid version tag');
        }
    } catch (error) {
        logger.warn('[Update] Failed to check package changes:', error.message);
    }
    
    logger.info(`[Update] Update completed successfully to ${finalTag}`);
    
    return {
        success: true,
        message: `Successfully updated to version ${finalTag}`,
        localVersion: updateInfo.localVersion,
        latestVersion: latestTag,
        targetVersion: finalTag,
        updated: true,
        updateMethod: 'git',
        needsRestart: needsRestart,
        restartMessage: needsRestart ? 'Dependencies updated, recommend restarting service to apply changes' : null
    };
}

/**
 * 通过下载 tarball 执行更新（用于 Docker/非 Git 环境）
 * @param {string} localVersion - 本地版本
 * @param {string} latestTag - 最新版本 tag
 * @returns {Promise<Object>} 更新结果
 */
async function performTarballUpdate(localVersion, latestTag) {
    const tarballCandidates = buildTarballCandidates(GITHUB_REPO, latestTag);
    const appDir = process.cwd();
    const tempDir = path.join(appDir, '.update_temp');
    const tarballPath = path.join(tempDir, 'update.tar.gz');
    
    // 在 try 块外部声明变量，确保 catch 块可以访问并进行灾难恢复
    const pluginsUserPath = path.join(appDir, 'src', 'plugins-user');
    const pluginsUserBackupPath = path.join(tempDir, 'plugins-user_backup');
    let hasPluginsUserBackup = false;
    
    logger.info(`[Update] Starting tarball update to ${latestTag}...`);
    
    try {
        // 1. 创建临时目录
        await fs.mkdir(tempDir, { recursive: true });
        logger.info('[Update] Created temp directory');
        
        // 2. 循环下载 tarball，成功后跳过后续代理
        logger.info('[Update] Downloading tarball via proxy candidates...');
        let downloadSucceeded = false;
        let lastDownloadError = null;
        
        for (const candidate of tarballCandidates) {
            try {
                logger.info(`[Update] Trying tarball download via ${candidate.name}: ${candidate.url}`);
                logger.info(`[Update] Request URL: ${candidate.url}`);
                const response = await fetchWithProxy(candidate.url, {
                    headers: {
                        'User-Agent': 'AIClient2API-Updater'
                    },
                    redirect: 'follow'
                });
                
                if (!response.ok) {
                    throw new Error(`Failed to download tarball: ${response.status} ${response.statusText}`);
                }
                
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                await fs.writeFile(tarballPath, buffer);
                logger.info(`[Update] Downloaded tarball via ${candidate.name} (${buffer.length} bytes)`);
                downloadSucceeded = true;
                break;
            } catch (downloadError) {
                lastDownloadError = downloadError;
                logger.warn(`[Update] Tarball download failed via ${candidate.name}: ${downloadError.message}`);
            }
        }
        
        if (!downloadSucceeded) {
            throw new Error(`All tarball proxy attempts failed${lastDownloadError ? `: ${lastDownloadError.message}` : ''}`);
        }
        
        // 3. 解压 tarball
        logger.info('[Update] Extracting tarball...');
        // Relative archive paths also work with GNU tar in Windows Git Bash:
        // an absolute C:\\... archive argument is otherwise parsed as remote C:.
        const relativeArchive = path.relative(appDir, tarballPath).split(path.sep).join('/');
        const relativeTempDir = path.relative(appDir, tempDir).split(path.sep).join('/');
        await execFileAsync('tar', ['-xzf', relativeArchive, '-C', relativeTempDir], { cwd: appDir });
        
        // 4. 找到解压后的目录（格式通常是 repo-name-tag）
        const extractedItems = await fs.readdir(tempDir);
        const extractedDir = extractedItems.find(item =>
            item.startsWith('AIClient-2-API-') || item.startsWith('AIClient2API-')
        );
        
        if (!extractedDir) {
            throw new Error('Could not find extracted directory');
        }
        
        const sourcePath = path.join(tempDir, extractedDir);
        logger.info(`[Update] Extracted to: ${sourcePath}`);
        
        // 5. 备份当前的 package.json 用于比较
        const oldPackageJson = existsSync(path.join(appDir, 'package.json'))
            ? readFileSync(path.join(appDir, 'package.json'), 'utf-8')
            : null;
        
        // 备份 src/plugins-user 目录（如果存在）
        if (existsSync(pluginsUserPath)) {
            logger.info(`[Update] Backing up plugins-user from ${pluginsUserPath} to ${pluginsUserBackupPath}...`);
            await fs.rename(pluginsUserPath, pluginsUserBackupPath);
            hasPluginsUserBackup = true;
        }
        
        // 5.5 在解压前删除 src/ 和 static/ 目录，确保旧代码被完全清除
        const dirsToClean = ['src', 'static'];
        for (const dirName of dirsToClean) {
            const dirPath = path.join(appDir, dirName);
            if (existsSync(dirPath)) {
                logger.info(`[Update] Removing old ${dirName}/ directory before extraction...`);
                await fs.rm(dirPath, { recursive: true, force: true });
                logger.info(`[Update] Old ${dirName}/ directory removed`);
            }
        }
        
        // 6. 定义需要保留的目录和文件（不被覆盖）
        const preservePaths = [
            'configs',           // 用户配置目录
            '.private',          // 本机签名密钥/私有状态：升级包不能提供或替换
            'node_modules',      // 依赖目录
            '.update_temp',      // 临时更新目录
            'logs',              // 日志目录
            'tls-sidecar',        // TLS Sidecar 目录
            'plugins-user'            // 根目录下的插件目录 (保持向后兼容)
        ];
        
        // 7. 复制新文件到应用目录
        logger.info('[Update] Copying new files...');
        const sourceItems = await fs.readdir(sourcePath);
        
        for (const item of sourceItems) {
            // 跳过需要保留的目录
            // Protect private state even if an archive accidentally packages it,
            // including case/trailing-dot aliases on Windows/macOS filesystems.
            const normalizedItem = normalizeUpdateEntryName(item);
            if (preservePaths.includes(normalizedItem)) {
                logger.info(`[Update] Skipping preserved path: ${item}`);
                continue;
            }
            
            const srcItemPath = path.join(sourcePath, item);
            const destItemPath = path.join(appDir, item);
            
            // 删除旧文件/目录（如果存在）
            if (existsSync(destItemPath)) {
                const stat = await fs.stat(destItemPath);
                if (stat.isDirectory()) {
                    await fs.rm(destItemPath, { recursive: true, force: true });
                } else {
                    await fs.unlink(destItemPath);
                }
            }
            
            // 复制新文件/目录
            await copyRecursive(srcItemPath, destItemPath);
            logger.info(`[Update] Copied: ${item}`);
        }
        
        // 7.5 恢复备份的 plugins-user 目录
        if (hasPluginsUserBackup) {
            const targetPluginsUserPath = path.join(appDir, 'src', 'plugins-user');
            logger.info(`[Update] Restoring plugins-user to ${targetPluginsUserPath}...`);
            if (existsSync(targetPluginsUserPath)) {
                await fs.rm(targetPluginsUserPath, { recursive: true, force: true });
            }
            // 确保 src 目录存在（正常情况下已被拷贝出来，但以防万一）
            await fs.mkdir(path.dirname(targetPluginsUserPath), { recursive: true });
            await fs.rename(pluginsUserBackupPath, targetPluginsUserPath);
            logger.info(`[Update] plugins-user restored successfully`);
        }
        
        // 8. 检查是否需要更新依赖
        let needsRestart = true; // tarball 更新后总是建议重启
        let needsNpmInstall = false;
        
        if (oldPackageJson) {
            const newPackageJson = readFileSync(path.join(appDir, 'package.json'), 'utf-8');
            if (oldPackageJson !== newPackageJson) {
                logger.info('[Update] package.json changed, running npm install...');
                needsNpmInstall = true;
                try {
                    await execAsync('npm install', { cwd: appDir });
                    logger.info('[Update] npm install completed');
                } catch (npmError) {
                    logger.error('[Update] npm install failed:', npmError.message);
                    // 不抛出错误，继续更新流程
                }
            }
        }
        
        // 9. 清理临时目录
        logger.info('[Update] Cleaning up...');
        await fs.rm(tempDir, { recursive: true, force: true });
        
        logger.info(`[Update] Tarball update completed successfully to ${latestTag}`);
        
        return {
            success: true,
            message: `Successfully updated to version ${latestTag}`,
            localVersion: localVersion,
            latestVersion: latestTag,
            updated: true,
            updateMethod: 'tarball',
            needsRestart: needsRestart,
            needsNpmInstall: needsNpmInstall,
            restartMessage: 'Code updated, please restart the service to apply changes'
        };
        
    } catch (error) {
        // 灾难恢复：如果备份了 plugins-user 且升级失败，尝试将其移回原位
        try {
            if (hasPluginsUserBackup && existsSync(pluginsUserBackupPath)) {
                const targetPluginsUserPath = path.join(appDir, 'src', 'plugins-user');
                logger.info(`[Update] Update failed. Restoring plugins-user to original location for disaster recovery...`);
                // 确保目标父目录 src 存在
                await fs.mkdir(path.dirname(targetPluginsUserPath), { recursive: true });
                if (existsSync(targetPluginsUserPath)) {
                    await fs.rm(targetPluginsUserPath, { recursive: true, force: true });
                }
                await fs.rename(pluginsUserBackupPath, targetPluginsUserPath);
                logger.info(`[Update] Disaster recovery: plugins-user restored successfully`);
            }
        } catch (restoreError) {
            logger.error('[Update] Disaster recovery failed to restore plugins-user:', restoreError.message);
        }

        // 清理临时目录
        try {
            if (existsSync(tempDir)) {
                await fs.rm(tempDir, { recursive: true, force: true });
            }
        } catch (cleanupError) {
            logger.warn('[Update] Failed to cleanup temp directory:', cleanupError.message);
        }
        
        logger.error('[Update] Tarball update failed:', error.message);
        throw new Error(`Tarball update failed: ${error.message}`);
    }
}

/**
 * 递归复制文件或目录
 * @param {string} src - 源路径
 * @param {string} dest - 目标路径
 */
async function copyRecursive(src, dest) {
    const stat = await fs.stat(src);
    
    if (stat.isDirectory()) {
        await fs.mkdir(dest, { recursive: true });
        const items = await fs.readdir(src);
        for (const item of items) {
            await copyRecursive(path.join(src, item), path.join(dest, item));
        }
    } else {
        await fs.copyFile(src, dest);
    }
}

/**
 * 检查更新
 */
export async function handleCheckUpdate(req, res) {
    try {
        const updateInfo = await checkForUpdates();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updateInfo));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to check for updates:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to check for updates: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 执行更新
 */
export async function handlePerformUpdate(req, res) {
    try {
        const body = await getRequestBody(req);
        const version = body?.version || null;
        
        const updateResult = await performUpdate(version);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updateResult));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to perform update:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Update failed: ' + error.message
            }
        }));
        return true;
    }
}
