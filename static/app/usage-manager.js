// 用量管理模块

import { showToast, bindOnce, getBaseProviderConfigs } from './utils.js';
import { getAuthHeaders } from './auth.js';
import { t, getCurrentLanguage } from './i18n.js';

// 提供商配置缓存
let currentProviderConfigs = null;
let usagePageDataPromise = null;

/**
 * 更新提供商配置
 * @param {Array} configs - 提供商配置列表
 */
export function updateUsageProviderConfigs(configs) {
    currentProviderConfigs = configs;
}

/**
 * 初始化用量管理功能
 */
export function initUsageManager() {
    const refreshBtn = document.getElementById('refreshUsageBtn');
    bindOnce(refreshBtn, 'click', refreshUsage, 'refreshUsage');
}

/**
 * 加载页面数据
 */
export function loadUsagePageData() {
    if (usagePageDataPromise) {
        return usagePageDataPromise;
    }

    usagePageDataPromise = Promise.all([
        loadUsage(),
        loadSupportedProviders()
    ]).finally(() => {
        usagePageDataPromise = null;
    });

    return usagePageDataPromise;
}

/**
 * 加载支持用量查询的提供商列表
 */
async function loadSupportedProviders() {
    const listEl = document.getElementById('supportedProvidersList');
    if (!listEl) return;

    try {
        const response = await fetch('/api/usage/supported-providers', {
            method: 'GET',
            headers: getAuthHeaders()
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const providers = await response.json();
        
        listEl.innerHTML = '';
        const displayOrder = currentProviderConfigs ? currentProviderConfigs.map(c => c.id) : providers;

        displayOrder.forEach(providerId => {
            if (!providers.includes(providerId)) return;
            if (currentProviderConfigs) {
                const config = currentProviderConfigs.find(c => c.id === providerId);
                if (config && config.visible === false) return;
            }

            const tag = document.createElement('span');
            tag.className = 'provider-tag';
            tag.textContent = getProviderDisplayName(providerId);
            tag.title = t('usage.doubleClickToRefresh');
            tag.addEventListener('dblclick', () => refreshProviderUsage(providerId));
            listEl.appendChild(tag);
        });
    } catch (error) {
        console.error('获取支持的提供商列表失败:', error);
        listEl.innerHTML = `<span class="error-text">${t('usage.failedToLoad')}</span>`;
    }
}

/**
 * 加载用量数据
 */
export async function loadUsage() {
    const loadingEl = document.getElementById('usageLoading');
    const errorEl = document.getElementById('usageError');
    const contentEl = document.getElementById('usageContent');

    if (loadingEl) loadingEl.style.display = 'block';
    if (errorEl) errorEl.style.display = 'none';

    try {
        const response = await fetch('/api/usage', { method: 'GET', headers: getAuthHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        
        if (loadingEl) loadingEl.style.display = 'none';
        renderUsageData(data, contentEl);
        updateTimeInfo(data);
    } catch (error) {
        console.error('获取用量数据失败:', error);
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            errorEl.style.display = 'block';
            document.getElementById('usageErrorMessage').textContent = error.message;
        }
    }
}

/**
 * 刷新全部用量
 */
export async function refreshUsage() {
    const refreshBtn = document.getElementById('refreshUsageBtn');
    if (refreshBtn) refreshBtn.disabled = true;

    try {
        // 使用更明显的反馈：显示加载中的 Toast
        showToast(t('usage.loading'), 'info');
        
        const response = await fetch('/api/usage?refresh=true', { method: 'GET', headers: getAuthHeaders() });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // 渲染数据
        renderUsageData(data, document.getElementById('usageContent'));
        updateTimeInfo(data);
        
        // 成功提示
        showToast(t('common.refresh.success'), 'success');
    } catch (error) {
        console.error('刷新用量失败:', error);
        showToast(t('common.error'), error.message || t('common.requestFailed'), 'error');
    } finally {
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

/**
 * 刷新单个实例
 */
export async function refreshSingleInstanceUsage(providerType, uuid, displayName) {
    try {
        showToast(t('usage.refreshingInstance', { name: displayName }), 'info');
        const response = await fetch(`/api/usage/${providerType}/${uuid}?refresh=true`, { 
            method: 'GET', 
            headers: getAuthHeaders() 
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        // 局部更新该实例的卡片
        if (data && data.uuid) {
            updateSingleInstanceCard(providerType, data);
            showToast(t('common.refresh.success'), 'success');
        } else {
            await loadUsage();
        }
    } catch (error) {
        console.error('刷新单个实例用量失败:', error);
        showToast(error.message || t('common.requestFailed'), 'error');
    }
}

async function resetSingleInstanceUsage(providerType, uuid, displayName, buttonEl) {
    const confirmed = window.confirm(t('usage.codex.resetConfirm', { name: displayName }));
    if (!confirmed) {
        return;
    }

    const originalDisabled = buttonEl?.disabled;
    if (buttonEl) {
        buttonEl.disabled = true;
    }

    try {
        showToast(t('common.info'), t('usage.codex.resetting', { name: displayName }), 'info');

        const response = await fetch(`/api/usage/${providerType}/${uuid}/reset`, {
            method: 'POST',
            headers: getAuthHeaders()
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        if (data?.instance?.uuid) {
            updateSingleInstanceCard(providerType, data.instance);
        } else {
            await refreshSingleInstanceUsage(providerType, uuid, displayName);
        }

        showToast(t('common.success'), t('usage.codex.resetSuccess'), 'success');
    } catch (error) {
        console.error('重置单个实例用量失败:', error);
        showToast(t('common.error'), error.message || t('common.requestFailed'), 'error');
    } finally {
        if (buttonEl) {
            buttonEl.disabled = originalDisabled || false;
        }
    }
}

/**
 * 更新单个实例卡片 (局部更新 DOM)
 */
function updateSingleInstanceCard(providerType, instanceData) {
    const container = document.getElementById('usageContent');
    if (!container) return;

    const group = container.querySelector(`.usage-provider-group[data-provider="${providerType}"]`);
    if (!group) return;

    const grid = group.querySelector('.usage-cards-grid');
    if (!grid) return;

    // 找到该实例的卡片。卡片本身没有 data-uuid 属性，我们需要通过内部的 span 查找或添加它
    // 在 createInstanceUsageCard 中，我们可以为卡片添加 data-uuid
    const cards = grid.querySelectorAll('.usage-instance-card');
    let targetCard = null;
    
    for (const card of cards) {
        if (card.getAttribute('data-uuid') === instanceData.uuid) {
            targetCard = card;
            break;
        }
    }

    if (targetCard) {
        const isCollapsed = targetCard.classList.contains('collapsed');
        const newCard = createInstanceUsageCard(instanceData, providerType);
        newCard.classList.toggle('collapsed', isCollapsed);
        grid.replaceChild(newCard, targetCard);
    }
}

/**
 * 刷新单个提供商
 */
export async function refreshProviderUsage(providerType) {
    try {
        showToast(t('usage.refreshingProvider', { name: getProviderDisplayName(providerType) }), 'info');
        const response = await fetch(`/api/usage/${providerType}?refresh=true`, { method: 'GET', headers: getAuthHeaders() });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        const data = await response.json();
        
        // 如果返回了全量数据或该提供商的数据，尝试局部更新
        if (data.providers && data.providers[providerType]) {
            updateSingleProviderGroup(providerType, data.providers[providerType]);
            updateTimeInfo(data);
        } else {
            await loadUsage();
        }
        
        showToast(t('common.refresh.success'), 'success');
    } catch (error) {
        console.error('刷新提供商用量失败:', error);
        showToast(error.message || t('common.requestFailed'), 'error');
    }
}

/**
 * 更新单个提供商分组 (局部更新 DOM)
 */
function updateSingleProviderGroup(providerType, providerData) {
    const container = document.getElementById('usageContent');
    if (!container) return;

    const existingGroup = container.querySelector(`.usage-provider-group[data-provider="${providerType}"]`);
    const instances = (providerData.instances || []).filter(i => !i.isDisabled && !i.error?.includes('not initialized'));
    
    if (instances.length === 0) {
        if (existingGroup) existingGroup.remove();
        if (container.children.length === 0) {
            renderUsageData({ providers: {} }, container);
        }
        return;
    }

    const newGroup = createProviderGroup(providerType, instances);
    if (existingGroup) {
        // 保留展开/折叠状态
        if (!existingGroup.classList.contains('collapsed')) {
            newGroup.classList.remove('collapsed');
        }
        container.replaceChild(newGroup, existingGroup);
    } else {
        // 如果原本没有，则按顺序插入或直接追加
        container.appendChild(newGroup);
        // 这里简化处理，实际可能需要根据 displayOrder 重新排序
    }
}

/**
 * 更新时间相关信息
 */
function updateTimeInfo(data) {
    if (data.serverTime) {
        const el = document.getElementById('serverTimeValue');
        if (el) el.textContent = new Date(data.serverTime).toLocaleString(getCurrentLanguage());
    }
    
    const lastUpdateEl = document.getElementById('usageLastUpdate');
    if (lastUpdateEl) {
        const timeStr = new Date(data.timestamp || Date.now()).toLocaleString(getCurrentLanguage());
        const key = data.fromCache ? 'usage.lastUpdateCache' : 'usage.lastUpdate';
        lastUpdateEl.textContent = t(key, { time: timeStr });
        // 恢复国际化属性以便动态切换语言
        lastUpdateEl.setAttribute('data-i18n', key);
        lastUpdateEl.setAttribute('data-i18n-params', JSON.stringify({ time: timeStr }));
    }
}

/**
 * 渲染数据
 */
function renderUsageData(data, container) {
    if (!container) return;
    container.innerHTML = '';

    if (!data?.providers || Object.keys(data.providers).length === 0) {
        container.innerHTML = `<div class="usage-empty"><p>${t('usage.noData')}</p></div>`;
        return;
    }

    const groupedInstances = {};
    for (const [type, pData] of Object.entries(data.providers)) {
        if (currentProviderConfigs?.find(c => c.id === type)?.visible === false) continue;
        const valid = (pData.instances || []).filter(i => !i.isDisabled && !i.error?.includes('not initialized'));
        if (valid.length > 0) groupedInstances[type] = valid;
    }

    const displayOrder = currentProviderConfigs ? currentProviderConfigs.map(c => c.id) : Object.keys(groupedInstances);
    displayOrder.forEach(type => {
        if (groupedInstances[type]) container.appendChild(createProviderGroup(type, groupedInstances[type]));
    });
}

/**
 * 创建分组
 */
function createProviderGroup(providerType, instances) {
    const group = document.createElement('div');
    group.className = 'usage-provider-group collapsed';
    group.setAttribute('data-provider', providerType);
    
    const successCount = instances.filter(i => i.success).length;
    group.innerHTML = `
        <div class="usage-group-header">
            <div class="usage-group-title">
                <i class="fas fa-chevron-right toggle-icon"></i>
                <i class="${getProviderIcon(providerType)} provider-icon"></i>
                <span class="provider-name">${getProviderDisplayName(providerType)}</span>
                <span class="instance-count">${t('usage.group.instances', { count: instances.length })}</span>
                <span class="success-count ${successCount === instances.length ? 'all-success' : ''}">${t('usage.group.success', { count: successCount, total: instances.length })}</span>
            </div>
            <div class="usage-group-actions">
                <button class="btn-toggle-cards"><i class="fas fa-expand-alt"></i></button>
            </div>
        </div>
        <div class="usage-group-content"><div class="usage-cards-grid"></div></div>
    `;
    
    group.querySelector('.usage-group-title').onclick = () => group.classList.toggle('collapsed');
    
    const toggleBtn = group.querySelector('.btn-toggle-cards');
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        const cards = group.querySelectorAll('.usage-instance-card');
        const allCollapsed = Array.from(cards).every(card => card.classList.contains('collapsed'));
        cards.forEach(card => card.classList.toggle('collapsed', !allCollapsed));
        const icon = toggleBtn.querySelector('i');
        icon.className = allCollapsed ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
    };
    
    const grid = group.querySelector('.usage-cards-grid');
    instances.forEach(inst => grid.appendChild(createInstanceUsageCard(inst, providerType)));

    return group;
}

/**
 * 创建实例卡片 (全面适配新结构)
 */
function createInstanceUsageCard(instance, providerType) {
    const card = document.createElement('div');
    card.className = `usage-instance-card ${instance.success ? 'success' : 'error'} collapsed`;
    card.setAttribute('data-uuid', instance.uuid);

    const usage = instance.usage || {};
    const summary = usage.summary || { usedPercent: 0, status: 'normal' };
    const user = usage.user || {};
    const displayName = user.email || instance.name || instance.uuid;
    const providerDisplayName = getProviderDisplayName(providerType);
    const resetAvailableCount = summary.resetAvailableCount ?? 0;
    const canResetQuota = providerType === 'openai-codex-oauth' && instance.success && summary.resetAvailableCount !== undefined;
    const quotaStateLabel = getQuotaStateLabel(summary);
    const codexResetButtonLabel = `${t('usage.codex.resetActionShort')} ${t('usage.codex.resetCredits', { count: resetAvailableCount })}`;

    // 使用后端返回的 planClass，如果缺失则兜底
    const planClass = summary.planClass || 'plan-default';

    card.innerHTML = `
        <div class="usage-card-collapsed-summary">
            <div class="collapsed-summary-row collapsed-summary-name-row">
                <i class="fas fa-chevron-right usage-toggle-icon"></i>
                <span class="collapsed-name" title="${displayName} ${t('usage.clickToManage')}" onclick="event.stopPropagation(); window.jumpToProviderNode('${providerType}', '${instance.uuid}', event)">${displayName}</span>
                ${summary.plan ? `<span class="collapsed-plan-badge ${planClass}">${summary.plan}</span>` : ''}
                ${instance.success ? '<i class="fas fa-check-circle status-success"></i>' : '<i class="fas fa-times-circle status-error"></i>'}
            </div>
            ${instance.success && quotaStateLabel ? `
            <div class="collapsed-summary-row collapsed-summary-usage-row"><span>${quotaStateLabel}</span></div>
            ` : instance.success ? `
            <div class="collapsed-summary-row collapsed-summary-usage-row">
                <div class="collapsed-progress-bar ${summary.status}"><div class="progress-fill" style="width: ${summary.usedPercent}%"></div></div>
                <span class="collapsed-percent">
                    ${summary.unit === 'percent' 
                        ? `${summary.usedPercent.toFixed(1)}%` 
                        : `${formatNumber(summary.totalUsed || 0)} / ${formatNumber(summary.totalLimit || 0)}`
                    }
                </span>
            </div>
            ` : (instance.error ? `<div class="collapsed-summary-row collapsed-summary-usage-row"><span class="collapsed-error">${t('common.error')}</span></div>` : '')}
        </div>
        <div class="usage-card-expanded-content">
            <div class="usage-instance-header">
                <div class="instance-header-top">
                    <div class="instance-provider-type" title="${providerDisplayName}"><i class="${getProviderIcon(providerType)}"></i><span>${providerDisplayName}</span></div>
                    <div class="instance-status-badges">
                        ${canResetQuota ? `<button class="btn-reset-usage btn-reset-usage-inline" title="${t('usage.codex.resetAction')}" data-tooltip="${codexResetButtonLabel}" ${resetAvailableCount > 0 ? '' : 'disabled'}><i class="fas fa-rotate-left"></i></button>` : ''}
                        ${instance.configFilePath ? `<button class="btn-download-config" title="${t('usage.card.downloadConfig')}"><i class="fas fa-download"></i></button>` : ''}
                        <button class="btn-refresh-usage" title="${t('usage.card.refresh')}"><i class="fas fa-sync-alt"></i></button>
                        ${instance.isDisabled ? `<span class="badge badge-disabled">${t('usage.card.status.disabled')}</span>` : `<span class="badge ${instance.isHealthy ? 'badge-healthy' : 'badge-unhealthy'}">${t(instance.isHealthy ? 'usage.card.status.healthy' : 'usage.card.status.unhealthy')}</span>`}
                    </div>
                </div>
                <div class="instance-name"><span class="instance-name-text" title="${displayName}">${displayName}</span></div>
                <div class="instance-user-info">
                    ${user.label ? `<span class="user-email"><i class="fas fa-envelope"></i> ${user.label}</span>` : ''}
                </div>
            </div>
            <div class="usage-instance-content"></div>
        </div>
    `;

    card.querySelector('.usage-card-collapsed-summary').onclick = () => card.classList.toggle('collapsed');
    
    if (instance.configFilePath) {
        card.querySelector('.btn-download-config').onclick = (e) => { e.stopPropagation(); downloadConfigFile(instance.configFilePath); };
    }
    
    card.querySelector('.btn-refresh-usage').onclick = (e) => { 
        e.stopPropagation(); 
        refreshSingleInstanceUsage(providerType, instance.uuid, displayName); 
    };

    const resetBtn = card.querySelector('.btn-reset-usage');
    if (resetBtn) {
        resetBtn.onclick = (e) => {
            e.stopPropagation();
            resetSingleInstanceUsage(providerType, instance.uuid, displayName, resetBtn);
        };
    }

    const contentArea = card.querySelector('.usage-instance-content');
    if (instance.error) {
        contentArea.innerHTML = `<div class="usage-error-message"><i class="fas fa-exclamation-triangle"></i> <span>${instance.error}</span></div>`;
    } else if (instance.usage) {
        contentArea.appendChild(renderUsageDetails(instance.usage));
    }

    return card;
}

/**
 * 渲染用量详情 (全面适配新结构)
 */
function renderUsageDetails(usage) {
    const container = document.createElement('div');
    container.className = 'usage-details';

    const { summary, items } = usage;
    const quotaStateLabel = getQuotaStateLabel(summary);
    if (quotaStateLabel) {
        const state = document.createElement('div');
        state.className = 'usage-section';
        const label = summary.quotaType ? `${getCopilotQuotaLabel(summary.quotaType)}：` : '';
        state.textContent = label + quotaStateLabel;
        container.appendChild(state);
    }

    if (typeof summary?.usedPercent === 'number') {
        const total = document.createElement('div');
        total.className = 'usage-section total-usage';
        total.innerHTML = `
            <div class="total-usage-header">
                <span class="total-label"><i class="fas fa-chart-pie"></i> <span>${summary.quotaType ? getCopilotQuotaLabel(summary.quotaType) : t('usage.card.totalUsage')}</span></span>
                <span class="total-value">${summary.usedPercent.toFixed(1)}%</span>
            </div>
            <div class="progress-bar ${summary.status}"><div class="progress-fill" style="width: ${summary.usedPercent}%"></div></div>
            <div class="total-footer">
                ${summary.resetAt ? `<div class="total-reset-info"><i class="fas fa-history"></i> ${t('usage.card.resetAt', { time: formatDate(summary.resetAt) })}</div>` : ''}
            </div>
        `;
        container.appendChild(total);
    }

    if (items?.length > 0) {
        const breakdown = document.createElement('div');
        breakdown.className = 'usage-section usage-breakdown-compact';
        items.forEach(item => {
            const val = item.unit === 'percent' ? `${item.percent.toFixed(1)}%` : `${formatNumber(item.used)} / ${formatNumber(item.limit)}`;
            const label = summary?.quotaType ? t('usage.copilot.requestsUsed') : item.label;
            const itemEl = document.createElement('div');
            itemEl.className = 'breakdown-item-compact';
            itemEl.innerHTML = `
                <div class="breakdown-header-compact"><span class="breakdown-name">${label}</span><span class="breakdown-usage">${val}</span></div>
                <div class="progress-bar-small ${item.status}"><div class="progress-fill" style="width: ${item.percent}%"></div></div>
                ${item.resetAt ? `<div class="extra-usage-info reset-time"><i class="fas fa-history"></i> ${formatDate(item.resetAt)}</div>` : ''}
            `;
            breakdown.appendChild(itemEl);
        });
        container.appendChild(breakdown);
    }

    return container;
}

function getQuotaStateLabel(summary) {
    if (summary?.quotaState === 'unavailable') return t('usage.copilot.unavailable');
    if (summary?.quotaState === 'unlimited') return t('usage.copilot.unlimited');
    return '';
}

function getCopilotQuotaLabel(type) {
    if (type === 'premium_interactions') return t('usage.copilot.premiumInteractions');
    if (type === 'chat') return t('usage.copilot.chat');
    if (type === 'completions') return t('usage.copilot.completions');
    return t('usage.card.totalUsage');
}

function getProviderDisplayName(type) {
    return getProviderMeta(type).name;
}

function getProviderIcon(type) {
    const icon = getProviderMeta(type).icon;
    return icon.startsWith('fa-') ? `fas ${icon}` : icon;
}

function getProviderMeta(type) {
    const config = currentProviderConfigs?.find(c => c.id === type) || getBaseProviderConfigs().find(c => c.id === type);
    return {
        name: config?.usageName || config?.shortName || config?.name || type,
        icon: config?.icon || 'fa-server'
    };
}

async function downloadConfigFile(path) {
    try {
        const response = await fetch(`/api/upload-configs/download/${encodeURIComponent(path)}`, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = path.split(/[/\\]/).pop();
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToast(t('common.success'), t('usage.card.downloadSuccess'), 'success');
    } catch (error) {
        showToast(t('common.error'), t('usage.card.downloadFailed') + ': ' + error.message, 'error');
    }
}

function formatNumber(num) {
    if (num === null || num === undefined) return '0.00';
    return (Math.ceil(num * 100) / 100).toFixed(2);
}

function formatDate(str) {
    if (!str) return '--';
    try {
        return new Date(str).toLocaleString(getCurrentLanguage(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return str;
    }
}
