// 工具函数
import { t, getCurrentLanguage } from './i18n.js';
import { apiClient } from './auth.js';

/**
 * 获取所有支持的提供商配置列表
 * @param {string[]} supportedProviders - 已注册的提供商类型列表
 * @returns {Object[]} 提供商配置对象数组
 */
/**
 * 获取所有基础提供商配置（母版）
 * @returns {Object[]} 基础提供商配置数组
 */
function getBaseProviderConfigs() {
    return [
        { 
            id: 'qiniu', 
            name: 'Qiniu Cloud AI', 
            icon: 'fa-cloud',
            registerUrl: 'https://s.qiniu.com/FRF7bq',
            docUrl: 'https://docs.modelink.ai/api-endpoints/overview'
        },
        { 
            id: 'fenno', 
            name: 'Fenno.ai', 
            icon: 'fa-code',
            registerUrl: 'https://api.fenno.ai/register?redirect=/purchase?tab=subscription%26group=16&aff=2EW65KEQC938'
        },
        {
            id: 'atlascloud',
            name: 'AtlasCloud',
            icon: 'fa-cloud',
            registerUrl: 'https://www.atlascloud.ai/console/coding-plan'
        },
        {
            id: 'orcarouter',
            name: 'OrcaRouter',
            icon: 'fa-cloud',
            registerUrl: 'https://www.orcarouter.ai/console'
        },
        { 
            id: 'forward-api', 
            name: 'NewAPI', 
            icon: 'fa-share-square'
        },
        { 
            id: 'gemini-cli-oauth', 
            name: t('dashboard.routing.nodeName.gemini'), 
            usageName: 'Gemini CLI',
            icon: 'fa-robot',
            defaultPath: 'configs/gemini/'
        },
        { 
            id: 'gemini-antigravity', 
            name: t('dashboard.routing.nodeName.antigravity'), 
            usageName: 'Antigravity',
            icon: 'fa-rocket',
            defaultPath: 'configs/antigravity/'
        },
        { 
            id: 'claude-kiro-oauth', 
            name: t('dashboard.routing.nodeName.kiro'), 
            usageName: 'Kiro',
            icon: 'fa-key',
            defaultPath: 'configs/kiro/'
        },
        { 
            id: 'openai-codex-oauth', 
            name: t('dashboard.routing.nodeName.codex'), 
            usageName: 'Codex',
            icon: 'fa-code',
            defaultPath: 'configs/codex/'
        },
        {
            id: 'grok-cli-oauth',
            name: t('dashboard.routing.nodeName.grokCli'),
            usageName: 'Grok CLI',
            icon: 'fa-terminal',
            defaultPath: 'configs/grok-cli/'
        },
        { 
            id: 'openai-qwen-oauth', 
            name: t('dashboard.routing.nodeName.qwen'), 
            icon: 'fa-cloud',
            defaultPath: 'configs/qwen/'
        },
        { 
            id: 'openai-iflow', 
            name: t('dashboard.routing.nodeName.iflow'), 
            icon: 'fa-stream',
            defaultPath: 'configs/iflow/'
        },
        { 
            id: 'grok-web', 
            name: t('dashboard.routing.nodeName.grok'), 
            usageName: 'Grok Web',
            icon: 'fa-user-secret'
        },
        { 
            id: 'openai-custom', 
            name: t('dashboard.routing.nodeName.openai'), 
            icon: 'fa-microchip'
        },
        { 
            id: 'claude-custom', 
            name: t('dashboard.routing.nodeName.claude'), 
            icon: 'fa-brain'
        },
        { 
            id: 'openaiResponses-custom', 
            name: 'OpenAI Responses', 
            icon: 'fa-reply-all'
        },
    ];
}

/**
 * 获取所有支持的提供商配置列表
 * @param {string[]} supportedProviders - 已注册的提供商类型列表
 * @returns {Object[]} 提供商配置对象数组
 */
function getProviderConfigs(supportedProviders = []) {
    const baseConfigs = getBaseProviderConfigs();

    const result = [];
    const usedIds = new Set();

    // 1. 遍历基础配置，使其按照定义顺序排列，并且让带后缀的自定义提供商紧跟在它的基础母版后面
    baseConfigs.forEach(baseConfig => {
        const isSupported = supportedProviders.includes(baseConfig.id);
        result.push({ ...baseConfig, visible: isSupported });
        usedIds.add(baseConfig.id);

        // 紧接着寻找匹配该基础 ID 的带后缀的自定义类型（例如 openai-custom-test）
        supportedProviders.forEach(providerId => {
            if (usedIds.has(providerId)) return;

            if (providerId.startsWith(baseConfig.id + '-')) {
                const suffix = providerId.substring(baseConfig.id.length + 1);
                result.push({
                    ...baseConfig,
                    id: providerId,
                    name: `${baseConfig.name} (${suffix})`,
                    visible: true
                });
                usedIds.add(providerId);
            }
        });
    });

    // 2. 安全兜底：如果还有一些 supportedProviders 既不匹配任何基础 ID 也不匹配任何前缀，就追加到最后
    supportedProviders.forEach(providerId => {
        if (!usedIds.has(providerId)) {
            result.push({
                id: providerId,
                name: providerId,
                icon: 'fa-server',
                visible: true
            });
            usedIds.add(providerId);
        }
    });

    return result;
}

/**
 * 格式化运行时间
 * @param {number} seconds - 秒数
 * @returns {string} 格式化的时间字符串
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (getCurrentLanguage() === 'en-US') {
        return `${days}d ${hours}h ${minutes}m ${secs}s`;
    }
    return `${days}天 ${hours}小时 ${minutes}分 ${secs}秒`;
}

/**
 * HTML转义
 * @param {string} text - 要转义的文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 显示提示消息
 * @param {string} title - 提示标题 (可选，旧接口为 message)
 * @param {string} message - 提示消息
 * @param {string} type - 消息类型 (info, success, error)
 */
function showToast(title, message, type = 'info') {
    // 兼容旧接口 (message, type)
    if (arguments.length === 2 && (message === 'success' || message === 'error' || message === 'info' || message === 'warning')) {
        type = message;
        message = title;
        title = t(`common.${type}`);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 4px;">${escapeHtml(title)}</div>
        <div>${escapeHtml(message)}</div>
    `;

    // 获取toast容器
    const toastContainer = document.getElementById('toastContainer') || document.querySelector('.toast-container');
    if (toastContainer) {
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 3000);
    }
}

/**
 * 获取字段显示文案
 * @param {string} key - 字段键
 * @returns {string} 显示文案
 */
function getFieldLabel(key) {
    const labelMap = {
        'customName': t('modal.provider.customName') + ' ' + t('config.optional'),
        'checkModelName': t('modal.provider.checkModelName') + ' ' + t('config.optional'),
        'checkHealth': t('modal.provider.healthCheckLabel'),
        'concurrencyLimit': t('modal.provider.concurrencyLimit') + ' ' + t('config.optional'),
        'queueLimit': t('modal.provider.queueLimit') + ' ' + t('config.optional'),
        'OPENAI_API_KEY': 'OpenAI API Key',
        'OPENAI_BASE_URL': 'OpenAI Base URL',
        'CLAUDE_API_KEY': 'Claude API Key',
        'CLAUDE_BASE_URL': 'Claude Base URL',
        'PROJECT_ID': t('modal.provider.field.projectId'),
        'GEMINI_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'KIRO_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'QWEN_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'IFLOW_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'CODEX_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'GROK_CLI_OAUTH_CREDS_FILE_PATH': t('modal.provider.field.oauthPath'),
        'GROK_COOKIE_TOKEN': t('modal.provider.field.ssoToken'),
        'GROK_CF_CLEARANCE': t('modal.provider.field.cfClearance'),
        'GROK_CF_BM': t('modal.provider.field.cfBm'),

        'GROK_USER_AGENT': t('modal.provider.field.userAgent'),
        'GEMINI_BASE_URL': 'Gemini Base URL',
        'KIRO_BASE_URL': t('modal.provider.field.baseUrl'),
        'KIRO_REFRESH_URL': t('modal.provider.field.refreshUrl'),
        'KIRO_REFRESH_IDC_URL': t('modal.provider.field.refreshIdcUrl'),
        'QWEN_BASE_URL': 'Qwen Base URL',
        'QWEN_OAUTH_BASE_URL': t('modal.provider.field.oauthBaseUrl'),
        'ANTIGRAVITY_BASE_URL_DAILY': t('modal.provider.field.dailyBaseUrl'),
        'ANTIGRAVITY_BASE_URL_AUTOPUSH': t('modal.provider.field.autopushBaseUrl'),
        'IFLOW_BASE_URL': t('modal.provider.field.iflowBaseUrl'),
        'CODEX_BASE_URL': t('modal.provider.field.codexBaseUrl'),
        'GROK_BASE_URL': t('modal.provider.field.grokBaseUrl'),
        'FORWARD_API_KEY': 'Forward API Key',
        'FORWARD_BASE_URL': 'Forward Base URL',
        'FORWARD_HEADER_NAME': t('modal.provider.field.headerName'),
        'FORWARD_HEADER_VALUE_PREFIX': t('modal.provider.field.headerPrefix'),
        'USE_SYSTEM_PROXY_FORWARD': t('modal.provider.field.useSystemProxy')
    };
    
    return labelMap[key] || key;
}

/**
 * 获取提供商类型的字段配置
 * @param {string} providerType - 提供商类型
 * @returns {Array} 字段配置数组
 */
function getProviderTypeFields(providerType) {
    // 基础配置字段定义
    const fieldConfigs = {
        'openai-custom': [
            {
                id: 'OPENAI_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: 'sk-...'
            },
            {
                id: 'OPENAI_BASE_URL',
                label: 'OpenAI Base URL',
                type: 'text',
                placeholder: 'https://api.openai.com/v1'
            }
        ],
        'atlascloud': [
            {
                id: 'OPENAI_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: 'sk-...'
            },
            {
                id: 'OPENAI_BASE_URL',
                label: 'OpenAI Base URL',
                type: 'text',
                placeholder: 'https://api.atlascloud.ai/v1'
            }
        ],
        'orcarouter': [
            {
                id: 'OPENAI_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: 'sk-orca-...'
            },
            {
                id: 'OPENAI_BASE_URL',
                label: 'OpenAI Base URL',
                type: 'text',
                placeholder: 'https://api.orcarouter.ai/v1'
            }
        ],
        'qiniu': [
            {
                id: 'OPENAI_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: 'sk-...'
            },
            {
                id: 'OPENAI_BASE_URL',
                label: 'OpenAI Base URL',
                type: 'text',
                placeholder: 'https://api.qnaigc.com/v1'
            }
        ],
        'fenno': [
            {
                id: 'OPENAI_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: 'sk-...'
            },
            {
                id: 'OPENAI_BASE_URL',
                label: 'OpenAI Base URL',
                type: 'text',
                placeholder: 'https://api.fenno.ai/v1'
            }
        ],
        'openaiResponses-custom': [
            {
                id: 'OPENAI_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: 'sk-...'
            },
            {
                id: 'OPENAI_BASE_URL',
                label: 'OpenAI Base URL',
                type: 'text',
                placeholder: 'https://api.openai.com/v1'
            }
        ],
        'claude-custom': [
            {
                id: 'CLAUDE_API_KEY',
                label: 'Claude API Key',
                type: 'password',
                placeholder: 'sk-ant-...'
            },
            {
                id: 'CLAUDE_BASE_URL',
                label: 'Claude Base URL',
                type: 'text',
                placeholder: 'https://api.anthropic.com'
            }
        ],
        'gemini-cli-oauth': [
            {
                id: 'PROJECT_ID',
                label: t('modal.provider.field.projectId'),
                type: 'text',
                placeholder: t('modal.provider.field.projectId.placeholder')
            },
            {
                id: 'GEMINI_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.gemini.placeholder')
            },
            {
                id: 'GEMINI_BASE_URL',
                label: `Gemini Base URL <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://cloudcode-pa.googleapis.com'
            }
        ],
        'claude-kiro-oauth': [
            {
                id: 'KIRO_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.kiro.placeholder')
            },
            {
                id: 'KIRO_BASE_URL',
                label: `${t('modal.provider.field.baseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse'
            },
            {
                id: 'KIRO_REFRESH_URL',
                label: `${t('modal.provider.field.refreshUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken'
            },
            {
                id: 'KIRO_REFRESH_IDC_URL',
                label: `${t('modal.provider.field.refreshIdcUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://oidc.{{region}}.amazonaws.com/token'
            }
        ],
        'openai-qwen-oauth': [
            {
                id: 'QWEN_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.qwen.placeholder')
            },
            {
                id: 'QWEN_BASE_URL',
                label: `Qwen Base URL <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://portal.qwen.ai/v1'
            },
            {
                id: 'QWEN_OAUTH_BASE_URL',
                label: `${t('modal.provider.field.oauthBaseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://chat.qwen.ai'
            }
        ],
        'gemini-antigravity': [
            {
                id: 'PROJECT_ID',
                label: `${t('modal.provider.field.projectId')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: t('modal.provider.field.projectId.optional.placeholder')
            },
            {
                id: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.antigravity.placeholder')
            },
            {
                id: 'ANTIGRAVITY_BASE_URL_DAILY',
                label: `${t('modal.provider.field.dailyBaseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://daily-cloudcode-pa.sandbox.googleapis.com'
            },
            {
                id: 'ANTIGRAVITY_BASE_URL_AUTOPUSH',
                label: `${t('modal.provider.field.autopushBaseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://autopush-cloudcode-pa.sandbox.googleapis.com'
            }
        ],
        'openai-iflow': [
            {
                id: 'IFLOW_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.iflow.placeholder')
            },
            {
                id: 'IFLOW_BASE_URL',
                label: `iFlow Base URL <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://iflow.cn/api'
            }
        ],
        'openai-codex-oauth': [
            {
                id: 'CODEX_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: t('modal.provider.field.oauthPath.codex.placeholder')
            },
            {
                id: 'CODEX_EMAIL',
                label: `${t('modal.provider.field.email')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'email',
                placeholder: t('modal.provider.field.email.placeholder')
            },
            {
                id: 'CODEX_BASE_URL',
                label: `${t('modal.provider.field.codexBaseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://api.openai.com/v1/codex'
            }
        ],
        'grok-cli-oauth': [
            {
                id: 'GROK_CLI_OAUTH_CREDS_FILE_PATH',
                label: t('modal.provider.field.oauthPath'),
                type: 'text',
                placeholder: 'configs/grok-cli/..._xai-..._oauth_creds.json'
            },
            {
                id: 'GROK_CLI_EMAIL',
                label: `${t('modal.provider.field.email')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'email',
                placeholder: t('modal.provider.field.email.placeholder')
            },
            {
                id: 'GROK_CLI_BASE_URL',
                label: `xAI Base URL <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://api.x.ai/v1'
            }
        ],
        'grok-web': [
            {
                id: 'GROK_COOKIE_TOKEN',
                label: t('modal.provider.field.ssoToken'),
                type: 'password',
                placeholder: 'sso cookie token'
            },
            {
                id: 'GROK_BASE_URL',
                label: `${t('modal.provider.field.grokBaseUrl')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'https://grok.com'
            },
            {
                id: 'GROK_CF_CLEARANCE',
                label: `${t('modal.provider.field.cfClearance')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'cf_clearance cookie value'
            },
            {
                id: 'GROK_CF_BM',
                label: `${t('modal.provider.field.cfBm')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: '__cf_bm cookie value'
            },
            {
                id: 'GROK_USER_AGENT',
                label: `${t('modal.provider.field.userAgent')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'Mozilla/5.0 ...'
            },
            {
                id: 'GROK_STATSIG_ID',
                label: `${t('modal.provider.field.statsigId')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'x-statsig-id header value'
            }
        ],
        'forward-api': [
            {
                id: 'FORWARD_API_KEY',
                label: t('modal.provider.field.apiKey'),
                type: 'password',
                placeholder: t('modal.provider.field.apiKey.placeholder')
            },
            {
                id: 'FORWARD_BASE_URL',
                label: t('modal.provider.field.baseUrl'),
                type: 'text',
                placeholder: 'https://api.example.com'
            },
            {
                id: 'FORWARD_HEADER_NAME',
                label: `${t('modal.provider.field.headerName')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'Authorization'
            },
            {
                id: 'FORWARD_HEADER_VALUE_PREFIX',
                label: `${t('modal.provider.field.headerPrefix')} <span class="optional-tag">${t('config.optional')}</span>`,
                type: 'text',
                placeholder: 'Bearer '
            }
        ]
    };

    // 1. 尝试精确匹配
    if (fieldConfigs[providerType]) {
        return fieldConfigs[providerType];
    }

    // 2. 尝试匹配前缀 (例如 openai-custom-test -> openai-custom)
    for (const baseType in fieldConfigs) {
        if (providerType.startsWith(baseType + '-')) {
            return fieldConfigs[baseType];
        }
    }

    return [];
}

/**
 * 调试函数：获取当前提供商统计信息
 * @param {Object} providerStats - 提供商统计对象
 * @returns {Object} 扩展的统计信息
 */
function getProviderStats(providerStats) {
    return {
        ...providerStats,
        // 添加计算得出的统计信息
        successRate: providerStats.totalRequests > 0 ? 
            ((providerStats.totalRequests - providerStats.totalErrors) / providerStats.totalRequests * 100).toFixed(2) + '%' : '0%',
        avgUsagePerProvider: providerStats.activeProviders > 0 ? 
            Math.round(providerStats.totalRequests / providerStats.activeProviders) : 0,
        healthRatio: providerStats.totalAccounts > 0 ? 
            (providerStats.healthyProviders / providerStats.totalAccounts * 100).toFixed(2) + '%' : '0%'
    };
}

/**
 * 通用 API 请求函数
 * @param {string} url - API 端点 URL
 * @param {Object} options - fetch 选项
 * @returns {Promise<any>} 响应数据
 */
async function apiRequest(url, options = {}) {
    // 如果 URL 以 /api 开头，去掉它（因为 apiClient.request 会自动添加）
    const endpoint = url.startsWith('/api') ? url.slice(4) : url;
    return apiClient.request(endpoint, options);
}

/**
 * 复制文本到剪贴板（带兼容性回退）
 * @param {string} text - 要复制的文本
 * @returns {Promise<boolean>} 是否成功
 */
async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.warn('navigator.clipboard failed, trying fallback:', err);
        }
    }

    // Fallback: 使用 textarea 模拟复制
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
    } catch (err) {
        console.error('Fallback copy failed:', err);
        return false;
    }
}

/**
 * 只为元素绑定一次事件
 * @param {HTMLElement|null} element - 需要绑定事件的元素
 * @param {string} eventName - 事件名称
 * @param {Function} handler - 事件处理函数
 * @param {string} key - 绑定标识，避免同一元素重复绑定同一类事件
 * @returns {boolean} 是否完成了本次绑定
 */
function bindOnce(element, eventName, handler, key = eventName) {
    if (!element) {
        return false;
    }

    if (!markOnce(element, key)) {
        return false;
    }

    element.addEventListener(eventName, handler);
    return true;
}

/**
 * 为元素记录一次性初始化状态
 * @param {HTMLElement|null} element - 需要标记的元素
 * @param {string} key - 标识名称
 * @returns {boolean} 是否是首次标记
 */
function markOnce(element, key) {
    if (!element) {
        return false;
    }

    const boundKey = `bound${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    if (element.dataset[boundKey]) {
        return false;
    }

    element.dataset[boundKey] = 'true';
    return true;
}

// 导出所有工具函数
export {
    formatUptime,
    escapeHtml,
    showToast,
    getFieldLabel,
    getProviderTypeFields,
    getProviderConfigs,
    getBaseProviderConfigs,
    getProviderStats,
    apiRequest,
    copyToClipboard,
    bindOnce,
    markOnce
};
