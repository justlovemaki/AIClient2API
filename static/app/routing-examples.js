// 路径路由示例功能模块

import { showToast, copyToClipboard } from './utils.js';
import { t } from './i18n.js';

/**
 * 初始化路径路由示例功能
 */
function initRoutingExamples() {
    // 延迟初始化，确保所有DOM都加载完成
    setTimeout(() => {
        initProtocolTabs();
        initCopyButtons();
        initCardInteractions();
    }, 100);
}

/**
 * 初始化协议标签切换功能
 */
function initProtocolTabs() {
    // 使用事件委托方式绑定点击事件
    document.addEventListener('click', function(e) {
        // 检查点击的是不是协议标签或者其子元素
        const tab = e.target.classList.contains('protocol-tab') ? e.target : e.target.closest('.protocol-tab');
        
        if (tab) {
            e.preventDefault();
            e.stopPropagation();
            
            const targetProtocol = tab.dataset.protocol;
            const card = tab.closest('.routing-example-card');
            
            if (!card) {
                return;
            }
            
            // 移除当前卡片中所有标签和内容的活动状态
            const cardTabs = card.querySelectorAll('.protocol-tab');
            const cardContents = card.querySelectorAll('.protocol-content');
            
            cardTabs.forEach(t => t.classList.remove('active'));
            cardContents.forEach(c => c.classList.remove('active'));
            
            // 为当前标签和对应内容添加活动状态
            tab.classList.add('active');
            
            // 使用更精确的选择器来查找对应的内容
            const targetContent = card.querySelector(`.protocol-content[data-protocol="${targetProtocol}"]`);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        }
    });
}

/**
 * 初始化复制按钮功能
 */
function initCopyButtons() {
    document.addEventListener('click', async function(e) {
        if (e.target.closest('.copy-btn')) {
            e.stopPropagation();
            
            const button = e.target.closest('.copy-btn');
            const path = button.dataset.path;
            if (!path) return;
            
            try {
                const success = await copyToClipboard(path);
                if (success) {
                    showToast(t('common.success'), `${t('common.success')}: ${path}`, 'success');
                    
                    // 临时更改按钮图标
                    const icon = button.querySelector('i');
                    if (icon) {
                        const originalClass = icon.className;
                        icon.className = 'fas fa-check';
                        button.style.color = 'var(--success-color)';
                        
                        setTimeout(() => {
                            icon.className = originalClass;
                            button.style.color = '';
                        }, 2000);
                    }
                } else {
                    throw new Error('Copy failed');
                }
                
            } catch (error) {
                console.error('Failed to copy to clipboard:', error);
                showToast(t('common.error'), t('common.error'), 'error');
            }
        }
    });
}

/**
 * 初始化卡片交互功能
 */
function initCardInteractions() {
    const routingCards = document.querySelectorAll('.routing-example-card');
    
    routingCards.forEach(card => {
        // 添加悬停效果
        card.addEventListener('mouseenter', () => {
            card.style.transform = 'translateY(-4px)';
            card.style.boxShadow = 'var(--shadow-lg)';
        });
        
        card.addEventListener('mouseleave', () => {
            card.style.transform = '';
            card.style.boxShadow = '';
        });
        
    });
}

/**
 * 获取所有可用的路由端点
 * @returns {Array} 路由端点数组
 */
function getAvailableRoutes() {
    return [
        {
            provider: 'forward-api',
            name: t('dashboard.routing.nodeName.newapi'),
            paths: {
                openai: '/forward-api/v1/chat/completions',
                claude: '/forward-api/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'claude-custom',
            name: t('dashboard.routing.nodeName.claude'),
            paths: {
                openai: '/claude-custom/v1/chat/completions',
                claude: '/claude-custom/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'claude-kiro-oauth',
            name: t('dashboard.routing.nodeName.kiro'),
            paths: {
                openai: '/claude-kiro-oauth/v1/chat/completions',
                claude: '/claude-kiro-oauth/v1/messages'
            },
            description: t('dashboard.routing.free'),
            badge: t('dashboard.routing.free'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-custom',
            name: t('dashboard.routing.nodeName.openai'),
            paths: {
                openai: '/openai-custom/v1/chat/completions',
                claude: '/openai-custom/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'atlascloud',
            name: 'AtlasCloud',
            paths: {
                openai: '/atlascloud/v1/chat/completions',
                claude: '/atlascloud/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'orcarouter',
            name: 'OrcaRouter',
            paths: {
                openai: '/orcarouter/v1/chat/completions',
                claude: '/orcarouter/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'qiniu',
            name: 'Qiniu Cloud AI',
            paths: {
                openai: '/qiniu/v1/chat/completions',
                claude: '/qiniu/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'fenno',
            name: 'Fenno.ai',
            paths: {
                openai: '/fenno/v1/chat/completions',
                claude: '/fenno/v1/messages'
            },
            description: t('dashboard.routing.official'),
            badge: t('dashboard.routing.official'),
            badgeClass: 'official'
        },
        {
            provider: 'gemini-cli-oauth',
            name: t('dashboard.routing.nodeName.gemini'),
            paths: {
                openai: '/gemini-cli-oauth/v1/chat/completions',
                claude: '/gemini-cli-oauth/v1/messages'
            },
            description: t('dashboard.routing.oauth'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'gemini-antigravity',
            name: t('dashboard.routing.nodeName.antigravity'),
            paths: {
                openai: '/gemini-antigravity/v1/chat/completions',
                claude: '/gemini-antigravity/v1/messages'
            },
            description: t('dashboard.routing.experimental'),
            badge: t('dashboard.routing.experimental'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-qwen-oauth',
            name: t('dashboard.routing.nodeName.qwen'),
            paths: {
                openai: '/openai-qwen-oauth/v1/chat/completions',
                claude: '/openai-qwen-oauth/v1/messages'
            },
            description: t('dashboard.routing.description.qwen'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-iflow',
            name: t('dashboard.routing.nodeName.iflow'),
            paths: {
                openai: '/openai-iflow/v1/chat/completions',
                claude: '/openai-iflow/v1/messages'
            },
            description: t('dashboard.routing.oauth'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openai-codex-oauth',
            name: t('dashboard.routing.nodeName.codex'),
            paths: {
                openai: '/openai-codex-oauth/v1/chat/completions',
                claude: '/openai-codex-oauth/v1/messages'
            },
            description: t('dashboard.routing.oauth'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'grok-cli-oauth',
            name: t('dashboard.routing.nodeName.grokCli'),
            paths: {
                openai: '/grok-cli-oauth/v1/responses',
                claude: '/grok-cli-oauth/v1/messages'
            },
            description: t('dashboard.routing.oauth'),
            badge: t('dashboard.routing.oauth'),
            badgeClass: 'oauth'
        },
        {
            provider: 'openaiResponses-custom',
            name: t('dashboard.routing.nodeName.responses'),
            paths: {
                openai: '/openaiResponses-custom/v1/responses',
                claude: '/openaiResponses-custom/v1/messages'
            },
            description: t('dashboard.routing.description.responses'),
            badge: t('dashboard.routing.badge.responses'),
            badgeClass: 'responses'
        },
        {
            provider: 'grok-web',
            name: t('dashboard.routing.nodeName.grok'),
            paths: {
                openai: '/grok-web/v1/chat/completions',
                claude: '/grok-web/v1/messages'
            },
            description: t('dashboard.routing.free'),
            badge: t('dashboard.routing.free'),
            badgeClass: 'oauth'
        }
    ];
}

/**
 * 高亮显示特定提供商路由
 * @param {string} provider - 提供商标识
 */
function highlightProviderRoute(provider) {
    const card = document.querySelector(`[data-provider="${provider}"]`);
    if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.borderColor = 'var(--success-color)';
        card.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.1)';
        
        setTimeout(() => {
            card.style.borderColor = '';
            card.style.boxShadow = '';
        }, 3000);
        
        showToast(t('common.success'), t('common.success') + `: ${provider}`, 'success');
    }
}

/**
 * 复制curl命令示例
 * @param {string} provider - 提供商标识
 * @param {Object} options - 选项参数
 */
async function copyCurlExample(provider, options = {}) {
    const routes = getAvailableRoutes();
    let route = routes.find(r => r.provider === provider);
    
    // 如果没找到，尝试匹配前缀
    if (!route) {
        const baseRoute = routes.find(r => provider.startsWith(r.provider + '-'));
        if (baseRoute) {
            route = {
                ...baseRoute,
                provider: provider,
                paths: {
                    openai: `/${provider}/v1/chat/completions`,
                    claude: `/${provider}/v1/messages`
                }
            };
        }
    }

    if (!route) {
        showToast(t('common.error'), t('common.error'), 'error');
        return;
    }
    
    const { protocol = 'openai', model = 'default-model', message = 'Hello!' } = options;
    const path = route.paths[protocol];
    
    if (!path) {
        showToast(t('common.error'), t('common.error'), 'error');
        return;
    }
    
    const hostname = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 
                     `http://${window.location.host}` : 
                     `${window.location.protocol}//${window.location.host}`;
                     
    let curlCommand = '';
    
    // 获取基础提供商ID（去掉后缀）
    const baseProviderId = routes.find(r => provider.startsWith(r.provider))?.provider || provider;
    
    // 根据不同提供商和协议生成对应的curl命令
    switch (baseProviderId) {
        case 'claude-custom':
        case 'claude-kiro-oauth':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'atlascloud':
        case 'orcarouter':
        case 'qiniu':
        case 'fenno':
        case 'openai-custom':
        case 'openai-qwen-oauth':
        case 'openai-iflow':
        case 'openai-codex-oauth':
        case 'forward-api':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'gemini-cli-oauth':
        case 'gemini-antigravity':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "max_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
            
        case 'openaiResponses-custom':
        case 'grok-cli-oauth':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "input": "${message}",
    "max_output_tokens": 1000
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
        case 'grok-web':
            if (protocol === 'openai') {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}],
    "stream": true
  }'`;
            } else {
                curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
            }
            break;
        default:
            // 通用默认模板
            curlCommand = `curl ${hostname}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "${message}"}]
  }'`;
    }
    
    if (!curlCommand) {
        showToast(t('common.error'), t('common.error'), 'error');
        return;
    }

    try {
        const success = await copyToClipboard(curlCommand);
        if (success) {
            showToast(t('common.success'), t('common.copy.success'), 'success');
        } else {
            throw new Error('Copy failed');
        }
    } catch (error) {
        console.error('Failed to copy curl command:', error);
        showToast(t('common.error'), t('common.error'), 'error');
    }
}

/**
 * 动态渲染路径路由示例
 * @param {Array} providerConfigs - 提供商配置列表
 */
function renderRoutingExamples(providerConfigs) {
    const container = document.querySelector('.routing-examples-grid');
    if (!container) return;

    container.innerHTML = '';
    
    // 获取路由端点基础信息
    const routes = getAvailableRoutes();
    
    // 图标映射
    const iconMap = {
        'forward-api': 'fa-share-square',
        'gemini-cli-oauth': 'fa-gem',
        'gemini-antigravity': 'fa-rocket',
        'openai-custom': 'fa-comments',
        'atlascloud': 'fa-cloud',
        'orcarouter': 'fa-cloud',
        'qiniu': 'fa-cloud',
        'fenno': 'fa-code',
        'claude-custom': 'fa-brain',
        'claude-kiro-oauth': 'fa-robot',
        'openai-qwen-oauth': 'fa-code',
        'openaiResponses-custom': 'fa-comment-alt',
        'openai-iflow': 'fa-wind',
        'openai-codex-oauth': 'fa-keyboard',
        'grok-cli-oauth': 'fa-terminal',
        'grok-web': 'fa-search'
    };

    // 默认模型映射 (用于 curl 示例)
    const modelMap = {
        'gemini-cli-oauth': 'gemini-3-flash-preview',
        'gemini-antigravity': 'gemini-3-flash',
        'claude-custom': 'claude-sonnet-4-5',
        'claude-kiro-oauth': 'claude-sonnet-4-5',
        'openai-custom': 'gpt-5.5',
        'atlascloud': 'gpt-5.5',
        'orcarouter': 'orcarouter/auto',
        'qiniu': 'gpt-5.5',
        'fenno': 'gpt-5.5',
        'openai-qwen-oauth': 'qwen3-coder-plus',
        'openai-iflow': 'qwen3-max',
        'openai-codex-oauth': 'gpt-5',
        'openaiResponses-custom': 'gpt-5.5',
        'grok-web': 'grok-4.3',
        'grok-cli-oauth': 'grok-4.3',
        'forward-api': 'gpt-5.5'
    };

    providerConfigs.forEach(config => {
        if (config.visible === false) return;
        
        let routeInfo = routes.find(r => r.provider === config.id);
        
        // 如果没找到，则创建一个默认的，并尝试继承基础类型的徽章
        if (!routeInfo) {
            // 尝试查找基础类型的路由信息以获取徽章
            let baseRouteInfo = null;
            for (const r of routes) {
                if (config.id.startsWith(r.provider + '-')) {
                    baseRouteInfo = r;
                    break;
                }
            }

            routeInfo = {
                provider: config.id,
                name: config.name,
                paths: {
                    openai: `/${config.id}/v1/chat/completions`,
                    claude: `/${config.id}/v1/messages`
                },
                description: baseRouteInfo ? baseRouteInfo.description : t('dashboard.routing.oauth'),
                badge: baseRouteInfo ? baseRouteInfo.badge : t('dashboard.routing.oauth'),
                badgeClass: baseRouteInfo ? baseRouteInfo.badgeClass : 'oauth'
            };
        }

        // 确定图标：尝试精确匹配，然后尝试前缀匹配
        let icon = iconMap[config.id];
        if (!icon) {
            for (const baseId in iconMap) {
                if (config.id.startsWith(baseId + '-')) {
                    icon = iconMap[baseId];
                    break;
                }
            }
        }
        icon = icon || 'fa-route';

        // 确定默认模型：尝试精确匹配，然后尝试前缀匹配
        let defaultModel = modelMap[config.id];
        if (!defaultModel) {
            for (const baseId in modelMap) {
                if (config.id.startsWith(baseId + '-')) {
                    defaultModel = modelMap[baseId];
                    break;
                }
            }
        }
        defaultModel = defaultModel || 'default-model';
        const hostname = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 
                         `http://${window.location.host}` : 
                         `${window.location.protocol}//${window.location.host}`;
        const openaiRequestExample = routeInfo.paths.openai.includes('/v1/responses')
            ? `    "model": "${defaultModel}",
    "input": "Hello!",
    "max_output_tokens": 1000`
            : `    "model": "${defaultModel}",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1000`;

        const card = document.createElement('div');
        card.className = 'routing-example-card';
        card.dataset.provider = `${config.id}-card`;
        
        card.innerHTML = `
            <div class="routing-card-header">
                <i class="fas ${icon}"></i>
                <h4>${routeInfo.name}</h4>
                <span class="provider-badge ${routeInfo.badgeClass}">${routeInfo.badge}</span>
            </div>
            <div class="routing-card-content">
                <div class="protocol-tabs">
                    <button class="protocol-tab ${config.id === 'openai-codex-oauth' ? '' : 'active'}" data-protocol="openai" data-i18n="dashboard.routing.openai">${t('dashboard.routing.openai')}</button>
                    <button class="protocol-tab ${config.id === 'openai-codex-oauth' ? 'active' : ''}" data-protocol="claude" data-i18n="dashboard.routing.claude">${t('dashboard.routing.claude')}</button>
                </div>
                
                <div class="protocol-content ${config.id === 'openai-codex-oauth' ? '' : 'active'}" data-protocol="openai">
                    <div class="endpoint-info">
                        <label data-i18n="dashboard.routing.endpoint">${t('dashboard.routing.endpoint')}</label>
                        <code class="endpoint-path">${routeInfo.paths.openai}</code>
                    </div>
                    <div class="usage-example">
                        <label data-i18n="dashboard.routing.exampleOpenAI">${t('dashboard.routing.exampleOpenAI')}</label>
                        <pre><code>curl ${hostname}${routeInfo.paths.openai} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
${openaiRequestExample}
  }'</code></pre>
                    </div>
                </div>
                
                <div class="protocol-content ${config.id === 'openai-codex-oauth' ? 'active' : ''}" data-protocol="claude">
                    <div class="endpoint-info">
                        <label data-i18n="dashboard.routing.endpoint">${t('dashboard.routing.endpoint')}</label>
                        <code class="endpoint-path">${routeInfo.paths.claude}</code>
                    </div>
                    <div class="usage-example">
                        <label data-i18n="dashboard.routing.exampleClaude">${t('dashboard.routing.exampleClaude')}</label>
                        <pre><code>curl ${hostname}${routeInfo.paths.claude} \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{
    "model": "${defaultModel}",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</code></pre>
                    </div>
                </div>
            </div>
        `;
        
        container.appendChild(card);
    });

    // 重新初始化卡片交互
    initCardInteractions();
}

export {
    initRoutingExamples,
    getAvailableRoutes,
    highlightProviderRoute,
    copyCurlExample,
    renderRoutingExamples
};
