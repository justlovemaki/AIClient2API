/**
 * 提供商工具模块
 * 包含 ui-manager.js 和 service-manager.js 共用的工具函数
 */

import * as path from 'path';
import logger from './logger.js';
import { promises as fs } from 'fs';

/**
 * 提供商目录映射配置
 * 定义目录名称到提供商类型的映射关系
 */
export const PROVIDER_MAPPINGS = [
    {
        // Kiro OAuth 配置
        dirName: 'kiro',
        patterns: ['configs/kiro/', '/kiro/', 'kiro-auth-token'],
        providerType: 'claude-kiro-oauth',
        credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH',
        defaultCheckModel: 'claude-haiku-4-5',
        displayName: 'Claude Kiro OAuth',
        needsProjectId: false,
        urlKeys: ['KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL']
    },
    {
        // Gemini CLI OAuth 配置
        dirName: 'gemini',
        patterns: ['configs/gemini/', '/gemini/', '/.gemini/', 'configs/gemini-cli/'],
        providerType: 'gemini-cli-oauth',
        credPathKey: 'GEMINI_OAUTH_CREDS_FILE_PATH',
        defaultCheckModel: 'gemini-2.5-flash',
        displayName: 'Gemini CLI OAuth',
        needsProjectId: true,
        urlKeys: ['GEMINI_BASE_URL']
    },
    {
        // Qwen OAuth 配置
        dirName: 'qwen',
        patterns: ['configs/qwen/', '/qwen/'],
        providerType: 'openai-qwen-oauth',
        credPathKey: 'QWEN_OAUTH_CREDS_FILE_PATH',
        defaultCheckModel: 'qwen3-coder-plus',
        defaultCheckHealth: true,
        displayName: 'Qwen OAuth',
        needsProjectId: false,
        urlKeys: ['QWEN_BASE_URL', 'QWEN_OAUTH_BASE_URL']
    },
    {
        // Antigravity OAuth 配置
        dirName: 'antigravity',
        patterns: ['configs/antigravity/', '/antigravity/', '/.antigravity/'],
        providerType: 'gemini-antigravity',
        credPathKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        defaultCheckModel: 'gemini-2.5-computer-use-preview-10-2025',
        displayName: 'Gemini Antigravity',
        needsProjectId: true,
        urlKeys: ['ANTIGRAVITY_BASE_URL_DAILY', 'ANTIGRAVITY_BASE_URL_AUTOPUSH']
    },
    {
        // iFlow 配置
        dirName: 'iflow',
        patterns: ['configs/iflow/', '/iflow/'],
        providerType: 'openai-iflow',
        credPathKey: 'IFLOW_TOKEN_FILE_PATH',
        defaultCheckModel: 'gpt-4o',
        displayName: 'iFlow API',
        needsProjectId: false,
        urlKeys: ['IFLOW_BASE_URL']
    },
    {
        // Codex OAuth 配置
        dirName: 'codex',
        patterns: ['configs/codex/', '/codex/', '/.codex/'],
        providerType: 'openai-codex-oauth',
        credPathKey: 'CODEX_OAUTH_CREDS_FILE_PATH',
        defaultCheckModel: 'gpt-5.4',
        displayName: 'OpenAI Codex OAuth',
        needsProjectId: false,
        urlKeys: ['CODEX_BASE_URL']
    },
    {
        // Grok CLI OAuth 配置
        dirName: 'grok-cli',
        patterns: ['configs/grok-cli/', '/grok-cli/', '/.grok-cli/'],
        providerType: 'grok-cli-oauth',
        credPathKey: 'GROK_CLI_OAUTH_CREDS_FILE_PATH',
        defaultCheckModel: 'grok-3-mini',
        displayName: 'Grok CLI OAuth',
        needsProjectId: false,
        urlKeys: ['GROK_CLI_BASE_URL']
    },
];

/**
 * 生成 UUID
 * 兼容旧版 Node.js（<14.17.0）：如果 crypto.randomUUID 不存在则使用 Math.random 回退方案
 * @returns {string} UUID 字符串
 */
export function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // 回退方案：使用 Math.random 生成标准 UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * 标准化路径，用于跨平台兼容
 * @param {string} filePath - 文件路径
 * @returns {string} 使用正斜杠的标准化路径
 */
export function normalizePath(filePath) {
    if (!filePath) return filePath;
    
    // 使用 path 模块标准化，然后转换为正斜杠
    const normalized = path.normalize(filePath);
    return normalized.replace(/\\/g, '/');
}

/**
 * 从路径中提取文件名
 * @param {string} filePath - 文件路径
 * @returns {string} 文件名
 */
export function getFileName(filePath) {
    return path.basename(filePath);
}

/**
 * 格式化相对路径为当前系统的路径格式
 * @param {string} relativePath - 相对路径
 * @returns {string} 格式化后的路径（带有 ./ 或 .\ 前缀）
 */
export function formatSystemPath(relativePath) {
    if (!relativePath) return relativePath;
    
    // 根据操作系统判断使用对应的路径分隔符
    const isWindows = process.platform === 'win32';
    const separator = isWindows ? '\\' : '/';
    // 统一转换路径分隔符为当前系统的分隔符
    const systemPath = relativePath.replace(/[\/\\]/g, separator);
    return systemPath.startsWith('.' + separator) ? systemPath : '.' + separator + systemPath;
}

/**
 * 检查两个路径是否指向同一文件（跨平台兼容）
 * @param {string} path1 - 第一个路径
 * @param {string} path2 - 第二个路径
 * @returns {boolean} 如果路径指向同一文件则返回 true
 */
export function pathsEqual(path1, path2) {
    if (!path1 || !path2) return false;
    
    try {
        // 标准化两个路径
        const normalized1 = normalizePath(path1);
        const normalized2 = normalizePath(path2);
        
        // 直接匹配
        if (normalized1 === normalized2) {
            return true;
        }
        
        // 移除开头的 './' 后比较
        const clean1 = normalized1.replace(/^\.\//, '');
        const clean2 = normalized2.replace(/^\.\//, '');
        
        if (clean1 === clean2) {
            return true;
        }
        
        // 检查一个是否是另一个的子集（用于相对路径与绝对路径比较）
        if (normalized1.endsWith('/' + clean2) || normalized2.endsWith('/' + clean1)) {
            return true;
        }
        
        return false;
    } catch (error) {
        logger.warn(`[Path Comparison] Error comparing paths: ${path1} vs ${path2}`, error.message);
        return false;
    }
}

/**
 * 检查文件路径是否正在被使用（跨平台兼容）
 * @param {string} relativePath - 相对路径
 * @param {string} fileName - 文件名
 * @param {Set} usedPaths - 已使用路径的集合
 * @returns {boolean} 如果文件正在被使用则返回 true
 */
export function isPathUsed(relativePath, fileName, usedPaths) {
    if (!relativePath) return false;
    
    // 标准化相对路径
    const normalizedRelativePath = normalizePath(relativePath);
    const cleanRelativePath = normalizedRelativePath.replace(/^\.\//, '');
    
    // 从相对路径获取文件名
    const relativeFileName = getFileName(normalizedRelativePath);
    
    // 遍历所有已使用路径进行匹配
    for (const usedPath of usedPaths) {
        if (!usedPath) continue;
        
        // 1. 直接路径匹配
        if (pathsEqual(relativePath, usedPath) || pathsEqual(relativePath, './' + usedPath)) {
            return true;
        }
        
        // 2. 标准化路径匹配
        if (pathsEqual(normalizedRelativePath, usedPath) ||
            pathsEqual(normalizedRelativePath, './' + usedPath)) {
            return true;
        }
        
        // 3. 清理后的路径匹配
        if (pathsEqual(cleanRelativePath, usedPath) ||
            pathsEqual(cleanRelativePath, './' + usedPath)) {
            return true;
        }
        
        // 4. 文件名匹配（确保不是误匹配）
        const usedFileName = getFileName(usedPath);
        if (usedFileName === fileName || usedFileName === relativeFileName) {
            // 确保是同一个目录下的文件
            const usedDir = path.dirname(usedPath);
            const relativeDir = path.dirname(normalizedRelativePath);
            
            if (pathsEqual(usedDir, relativeDir) ||
                pathsEqual(usedDir, cleanRelativePath.replace(/\/[^\/]+$/, '')) ||
                pathsEqual(relativeDir.replace(/^\.\//, ''), usedDir.replace(/^\.\//, ''))) {
                return true;
            }
        }
        
        // 5. 绝对路径匹配（Windows 和 Unix）
        try {
            const resolvedUsedPath = path.resolve(usedPath);
            const resolvedRelativePath = path.resolve(relativePath);
            
            if (resolvedUsedPath === resolvedRelativePath) {
                return true;
            }
        } catch (error) {
            // 忽略路径解析错误
        }
    }
    
    return false;
}

/**
 * 根据文件路径检测提供商类型
 * @param {string} normalizedPath - 标准化的文件路径（小写，正斜杠）
 * @returns {Object|null} 提供商映射对象，如果未检测到则返回 null
 */
export function detectProviderFromPath(normalizedPath) {
    // 遍历映射关系，查找匹配的提供商
    for (const mapping of PROVIDER_MAPPINGS) {
        for (const pattern of mapping.patterns) {
            if (normalizedPath.includes(pattern)) {
                return {
                    providerType: mapping.providerType,
                    credPathKey: mapping.credPathKey,
                    defaultCheckModel: mapping.defaultCheckModel,
                    displayName: mapping.displayName,
                    needsProjectId: mapping.needsProjectId,
                    urlKeys: mapping.urlKeys
                };
            }
        }
    }

    return null;
}

/**
 * 根据目录名获取提供商映射
 * @param {string} dirName - 目录名称
 * @returns {Object|null} 提供商映射对象，如果未找到则返回 null
 */
export function getProviderMappingByDirName(dirName) {
    return PROVIDER_MAPPINGS.find(m => m.dirName === dirName) || null;
}

/**
 * 验证文件是否是有效的 OAuth 凭据文件
 * @param {string} filePath - 文件路径
 * @returns {Promise<boolean>} 是否有效
 */
export async function isValidOAuthCredentials(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf8');
        const jsonData = JSON.parse(content);
        
        // 检查是否包含 OAuth 相关字段
        // 凭据通常包含 access_token/accessToken, refresh_token/refreshToken, client_id 等字段
        // 支持下划线命名（access_token）和驼峰命名（accessToken）两种格式
        if (jsonData.access_token || jsonData.refresh_token ||
            jsonData.accessToken || jsonData.refreshToken ||
            jsonData.client_id || jsonData.client_secret ||
            jsonData.token || jsonData.credentials) {
            return true;
        }
        
        // 也可能是包含嵌套结构的凭据文件
        if (jsonData.installed || jsonData.web) {
            return true;
        }
        
        return false;
    } catch (error) {
        // 如果无法解析，认为不是有效的凭据文件
        return false;
    }
}

/**
 * 创建新的提供商配置对象
 * @param {Object} options - 配置选项
 * @param {string} options.credPathKey - 凭据路径键名
 * @param {string} options.credPath - 凭据文件路径
 * @param {string} options.defaultCheckModel - 默认检测模型
 * @param {boolean} options.needsProjectId - 是否需要 PROJECT_ID
 * @param {Array} options.urlKeys - 可选的 URL 配置项键名列表
 * @returns {Object} 新的提供商配置对象
 */
export function createProviderConfig(options) {
    const { credPathKey, credPath, defaultCheckModel, defaultCheckHealth, needsProjectId, urlKeys } = options;
    
    const newProvider = {
        [credPathKey]: credPath,
        uuid: generateUUID(),
        checkModelName: defaultCheckModel,
        checkHealth: defaultCheckHealth ?? false,
        isHealthy: true,
        isDisabled: false,
        lastUsed: null,
        usageCount: 0,
        errorCount: 0,
        lastErrorTime: null,
        lastHealthCheckTime: null,
        lastHealthCheckModel: null,
        lastErrorMessage: null
    };
    
    // 如果需要 PROJECT_ID，添加空字符串占位
    if (needsProjectId) {
        newProvider.PROJECT_ID = '';
    }

    // 初始化可选的 URL 配置项
    if (urlKeys && Array.isArray(urlKeys)) {
        urlKeys.forEach(key => {
            newProvider[key] = '';
        });
    }
    
    return newProvider;
}

/**
 * 将路径添加到已使用路径集合（标准化多种格式）
 * @param {Set} usedPaths - 已使用路径的集合
 * @param {string} filePath - 要添加的文件路径
 */
export function addToUsedPaths(usedPaths, filePath) {
    if (!filePath) return;
    
    const normalizedPath = filePath.replace(/\\/g, '/');
    usedPaths.add(filePath);
    usedPaths.add(normalizedPath);
    if (normalizedPath.startsWith('./')) {
        usedPaths.add(normalizedPath.slice(2));
    } else {
        usedPaths.add('./' + normalizedPath);
    }
}

/**
 * 检查路径是否已关联（用于自动关联检测）
 * @param {string} relativePath - 相对路径
 * @param {Set} linkedPaths - 已关联路径的集合
 * @returns {boolean} 是否已关联
 */
export function isPathLinked(relativePath, linkedPaths) {
    return linkedPaths.has(relativePath) ||
           linkedPaths.has('./' + relativePath) ||
           linkedPaths.has(relativePath.replace(/^\.\//, ''));
}
