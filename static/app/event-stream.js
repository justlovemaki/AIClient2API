// Server-Sent Events处理模块

import { eventSource, setEventSource, elements, addLog, autoScroll } from './constants.js';
import { t } from './i18n.js';
import { authManager } from './auth.js';

/**
 * Server-Sent Events初始化
 */
function initEventStream() {
    if (eventSource) {
        eventSource.close();
    }

    // 从 AuthManager 获取 token 并作为 URL 参数传递
    const token = authManager.getToken();
    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
    const newEventSource = new EventSource(url);
    setEventSource(newEventSource);

    newEventSource.onopen = () => {
        updateServerStatus(true);
        console.log('EventStream connected');
    };

    newEventSource.onerror = () => {
        updateServerStatus(false);
        console.log('EventStream disconnected');
    };

    newEventSource.addEventListener('log', (event) => {
        const data = JSON.parse(event.data);
        addLogEntry(data);
    });

    newEventSource.addEventListener('provider', (event) => {
        const data = JSON.parse(event.data);
        updateProviderStatus(data);
    });

    newEventSource.addEventListener('oauth_success', (event) => {
        const data = JSON.parse(event.data);
        showToast(t('common.success'), `${t('common.success')} (${data.provider})`, 'success');
        // 发送自定义事件，以便其他模块（如生成凭据逻辑）可以接收到详细信息
        window.dispatchEvent(new CustomEvent('oauth_success_event', { detail: data }));
    });

    newEventSource.addEventListener('provider_update', (event) => {
        const data = JSON.parse(event.data);
        handleProviderUpdate(data);
    });

    newEventSource.addEventListener('config_update', (event) => {
        const data = JSON.parse(event.data);
        handleConfigUpdate(data);
    });
}

/**
 * 添加日志条目
 * @param {Object} logData - 日志数据
 */
function addLogEntry(logData) {
    addLog(logData);
    
    if (!elements.logsContainer) return;
    
    while (elements.logsContainer.children.length >= 100) {
        elements.logsContainer.removeChild(elements.logsContainer.firstElementChild);
    }
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';

    const date = new Date(logData.timestamp || Date.now());
    const timeStr = date.toLocaleTimeString();
    const level = (logData.level || 'info').toLowerCase();
    const levelClass = `log-level-${level}`;

    logEntry.innerHTML = `
        <span class="log-time">[${timeStr}]</span>
        <span class="${levelClass}">[${level.toUpperCase()}]</span>
        <span class="log-message">${escapeHtml(logData.message || '')}</span>
    `;

    elements.logsContainer.appendChild(logEntry);

    if (autoScroll) {
        requestAnimationFrame(() => {
            if (elements.logsContainer) {
                elements.logsContainer.scrollTop = elements.logsContainer.scrollHeight;
            }
        });
    }
}

/**
 * 更新服务器状态
 * @param {boolean} connected - 连接状态
 */
function updateServerStatus(connected) {
    if (!elements.serverStatus) return;
    
    const statusBadge = elements.serverStatus;
    const icon = statusBadge.querySelector('i');
    const text = statusBadge.querySelector('span') || statusBadge.childNodes[1];

    if (connected) {
        statusBadge.classList.remove('error');
        icon.style.color = 'var(--success-color)';
        statusBadge.innerHTML = `<i class="fas fa-circle"></i> <span data-i18n="header.status.connected">${t('header.status.connected')}</span>`;
    } else {
        statusBadge.classList.add('error');
        icon.style.color = 'var(--danger-color)';
        statusBadge.innerHTML = `<i class="fas fa-circle"></i> <span data-i18n="header.status.disconnected">${t('header.status.disconnected')}</span>`;
    }
}

/**
 * 更新提供商状态
 * @param {Object} data - 提供商数据
 */
function updateProviderStatus(data) {
    // 触发重新加载提供商列表
    if (typeof loadProviders === 'function') {
        loadProviders();
    }
}

/**
 * 处理提供商更新事件
 * @param {Object} data - 更新数据
 */
function handleProviderUpdate(data) {
    if (data.action && data.providerType) {
        // 如果当前打开的模态框是更新事件的提供商类型，则刷新该模态框
        const modal = document.querySelector('.provider-modal');
        if (modal && modal.getAttribute('data-provider-type') === data.providerType) {
            if (typeof refreshProviderConfig === 'function') {
                refreshProviderConfig(data.providerType);
            }
        } else {
            // 否则更新主界面的提供商列表
            if (typeof loadProviders === 'function') {
                loadProviders();
            }
        }
    }
}

// 导入工具函数
import { escapeHtml, showToast } from './utils.js';

// 需要从其他模块导入的函数
let loadProviders;
let refreshProviderConfig;
let loadConfigList;

export function setProviderLoaders(providerLoader, providerRefresher) {
    loadProviders = providerLoader;
    refreshProviderConfig = providerRefresher;
}

export function setConfigLoaders(configLoader) {
    loadConfigList = configLoader;
}

/**
 * 处理配置更新事件
 * @param {Object} data - 更新数据
 */
function handleConfigUpdate(data) {
    console.log('[ConfigUpdate] 收到配置更新事件:', data);
    
    // 根据操作类型进行相应处理
    switch (data.action) {
        case 'delete':
            // 文件删除事件，直接刷新配置文件列表
            if (loadConfigList) {
                loadConfigList();
                console.log('[ConfigUpdate] 配置文件列表已刷新（文件删除）');
            }
            break;
            
        case 'add':
        case 'update':
            // 文件添加或更新事件，刷新配置文件列表
            if (loadConfigList) {
                loadConfigList();
                console.log('[ConfigUpdate] 配置文件列表已刷新（文件更新）');
            }
            break;
            
        default:
            // 未知操作类型，也刷新列表以确保同步
            if (loadConfigList) {
                loadConfigList();
                console.log('[ConfigUpdate] 配置文件列表已刷新（默认）');
            }
            break;
    }
}

export {
    initEventStream,
    addLogEntry,
    updateServerStatus,
    updateProviderStatus,
    handleProviderUpdate
};
