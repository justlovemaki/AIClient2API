// 提供商管理功能模块

import { providerStats, updateProviderStats } from './constants.js';
import { showToast, formatUptime, getProviderConfigs, getBaseProviderConfigs, bindOnce, escapeHtml } from './utils.js';
import { fileUploadHandler } from './file-upload.js';
import { t, getCurrentLanguage } from './i18n.js';
import { renderRoutingExamples } from './routing-examples.js';
import { updateModelsProviderConfigs } from './models-manager.js';
import { updateTutorialProviderConfigs } from './tutorial-manager.js';
import { updateUsageProviderConfigs } from './usage-manager.js';
import { updateConfigProviderConfigs } from './config-manager.js';
import { loadConfigList, updateProviderFilterOptions } from './upload-config-manager.js';
import { setServiceMode } from './event-handlers.js';

// 保存初始服务器时间和运行时间
let initialServerTime = null;
let initialUptime = null;
let initialLoadTime = null;
let isStaticProviderConfigsUpdated = false;
let cachedSupportedProviders = null;
let latestProvidersAccessInfo = null;

function navigateToSection(sectionId) {
    const navItem = document.querySelector(`.nav-item[data-section="${sectionId}"]`);
    if (navItem) {
        navItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return;
    }

    window.location.hash = `#${sectionId}`;
}

function initProvidersPageHelpers() {
    const openAccessBtn = document.getElementById('providersOpenQuickAccess');
    bindOnce(openAccessBtn, 'click', () => navigateToSection('access'), 'providersOpenQuickAccess');

    const openConfigBtn = document.getElementById('providersOpenConfig');
    bindOnce(openConfigBtn, 'click', () => navigateToSection('config'), 'providersOpenConfig');
}

function updateProvidersHandoffSummary(providers = {}, supportedProviders = []) {
    const providerGroups = Object.values(providers).filter(group => Array.isArray(group) && group.length > 0);
    const totalGroups = providerGroups.length;
    const allNodes = providerGroups.flat();
    const totalNodes = allNodes.length;
    const healthyNodes = allNodes.filter(node => node.isHealthy && !node.isDisabled).length;

    const groupsEl = document.getElementById('providersHandoffGroups');
    const healthyEl = document.getElementById('providersHandoffHealthyNodes');
    const defaultsEl = document.getElementById('providersHandoffDefaults');
    const nextStepEl = document.getElementById('providersHandoffNextStep');

    if (groupsEl) {
        groupsEl.textContent = totalGroups > 0
            ? t('providers.handoff.groupsReady', { count: totalGroups })
            : t('providers.handoff.groupsMissing');
    }

    if (healthyEl) {
        healthyEl.textContent = totalNodes > 0
            ? t('providers.handoff.healthyReady', { healthy: healthyNodes, total: totalNodes })
            : t('providers.handoff.healthyMissing');
    }

    const providerConfigs = getProviderConfigs(supportedProviders);
    const configMap = providerConfigs.reduce((map, config) => {
        map[config.id] = config;
        return map;
    }, {});
    const defaultProviders = latestProvidersAccessInfo?.defaultProviders || [];
    const defaultProviderNames = defaultProviders.map(id => configMap[id]?.name || id);

    if (defaultsEl) {
        defaultsEl.textContent = defaultProviderNames.length > 0
            ? defaultProviderNames.join(' / ')
            : t('providers.handoff.defaultsMissing');
    }

    if (nextStepEl) {
        if (totalNodes === 0) {
            nextStepEl.textContent = t('providers.handoff.nextStepAddNodes');
        } else if (defaultProviderNames.length === 0) {
            nextStepEl.textContent = t('providers.handoff.nextStepConfig');
        } else {
            nextStepEl.textContent = t('providers.handoff.nextStepAccess');
        }
    }
}

async function refreshProvidersHandoffSummary(providers = {}, supportedProviders = []) {
    try {
        latestProvidersAccessInfo = await window.apiClient.get('/access-info');
    } catch (error) {
        console.warn('Failed to load provider handoff summary:', error);
        latestProvidersAccessInfo = null;
    }

    updateProvidersHandoffSummary(providers, supportedProviders);
}

/**
 * 加载系统信息
 */
async function loadSystemInfo() {
    try {
        const data = await window.apiClient.get('/system');

        const appVersionEl = document.getElementById('appVersion');
        const nodeVersionEl = document.getElementById('nodeVersion');
        const serverTimeEl = document.getElementById('serverTime');
        const memoryUsageEl = document.getElementById('memoryUsage');
        const cpuUsageEl = document.getElementById('cpuUsage');
        const uptimeEl = document.getElementById('uptime');

        if (appVersionEl) appVersionEl.textContent = data.appVersion ? `v${data.appVersion}` : '--';
        
        // 自动检查更新
        if (data.appVersion) {
            checkUpdate(true);
        }

        if (nodeVersionEl) nodeVersionEl.textContent = data.nodeVersion || '--';
        if (memoryUsageEl) memoryUsageEl.textContent = data.memoryUsage || '--';
        if (cpuUsageEl) cpuUsageEl.textContent = data.cpuUsage || '--';
        
        // 保存初始时间用于本地计算
        if (data.serverTime && data.uptime !== undefined) {
            initialServerTime = new Date(data.serverTime);
            initialUptime = data.uptime;
            initialLoadTime = Date.now();
        }
        
        // 初始显示
        if (serverTimeEl) {
            serverTimeEl.textContent = data.serverTime ? new Date(data.serverTime).toLocaleString(getCurrentLanguage()) : '--';
        }
        if (uptimeEl) uptimeEl.textContent = data.uptime ? formatUptime(data.uptime) : '--';

        // 加载服务模式信息
        await loadServiceModeInfo();

    } catch (error) {
        console.error('Failed to load system info:', error);
    }
}

/**
 * 加载服务运行模式信息
 */
async function loadServiceModeInfo() {
    try {
        const data = await window.apiClient.get('/service-mode');
        
        const serviceModeEl = document.getElementById('serviceMode');
        const processPidEl = document.getElementById('processPid');
        const platformInfoEl = document.getElementById('platformInfo');
        
        // 更新服务模式到 event-handlers
        setServiceMode(data.mode || 'worker');
        
        // 更新重启/重载按钮显示
        updateRestartButton(data.mode);
        
        if (serviceModeEl) {
            const modeText = data.mode === 'worker'
                ? t('dashboard.serviceMode.worker')
                : t('dashboard.serviceMode.standalone');
            const canRestartIcon = data.canAutoRestart
                ? '<i class="fas fa-check-circle" style="color: #10b981; margin-left: 4px;" title="' + t('dashboard.serviceMode.canRestart') + '"></i>'
                : '';
            serviceModeEl.innerHTML = modeText;
        }
        
        if (processPidEl) {
            processPidEl.textContent = data.pid || '--';
        }
        
        if (platformInfoEl) {
            // 格式化平台信息
            const platformMap = {
                'win32': 'Windows',
                'darwin': 'macOS',
                'linux': 'Linux',
                'freebsd': 'FreeBSD'
            };
            platformInfoEl.textContent = platformMap[data.platform] || data.platform || '--';
        }
        
    } catch (error) {
        console.error('Failed to load service mode info:', error);
    }
}

/**
 * 根据服务模式更新重启/重载按钮显示
 * @param {string} mode - 服务模式 ('worker' 或 'standalone')
 */
function updateRestartButton(mode) {
    const restartBtn = document.getElementById('restartBtn');
    const restartBtnIcon = document.getElementById('restartBtnIcon');
    const restartBtnText = document.getElementById('restartBtnText');
    
    if (!restartBtn) return;
    
    if (mode === 'standalone') {
        // 独立模式：显示"重载"按钮
        if (restartBtnIcon) {
            restartBtnIcon.className = 'fas fa-sync-alt';
        }
        if (restartBtnText) {
            restartBtnText.textContent = t('header.reload');
            restartBtnText.setAttribute('data-i18n', 'header.reload');
        }
        restartBtn.setAttribute('aria-label', t('header.reload'));
        restartBtn.setAttribute('data-i18n-aria-label', 'header.reload');
        restartBtn.title = t('header.reload');
    } else {
        // 子进程模式：显示"重启"按钮
        if (restartBtnIcon) {
            restartBtnIcon.className = 'fas fa-redo';
        }
        if (restartBtnText) {
            restartBtnText.textContent = t('header.restart');
            restartBtnText.setAttribute('data-i18n', 'header.restart');
        }
        restartBtn.setAttribute('aria-label', t('header.restart'));
        restartBtn.setAttribute('data-i18n-aria-label', 'header.restart');
        restartBtn.title = t('header.restart');
    }
}

/**
 * 更新服务器时间和运行时间显示（本地计算）
 */
function updateTimeDisplay() {
    if (!initialServerTime || initialUptime === null || !initialLoadTime) {
        return;
    }

    const serverTimeEl = document.getElementById('serverTime');
    const uptimeEl = document.getElementById('uptime');

    // 计算经过的秒数
    const elapsedSeconds = Math.floor((Date.now() - initialLoadTime) / 1000);

    // 更新服务器时间
    if (serverTimeEl) {
        const currentServerTime = new Date(initialServerTime.getTime() + elapsedSeconds * 1000);
        serverTimeEl.textContent = currentServerTime.toLocaleString(getCurrentLanguage());
    }

    // 更新运行时间
    if (uptimeEl) {
        const currentUptime = initialUptime + elapsedSeconds;
        uptimeEl.textContent = formatUptime(currentUptime);
    }
}

/**
 * 加载提供商数据
 * @param {boolean} forceRefreshSupported - 是否强制刷新支持的提供商列表
 */
async function loadProviders(forceRefreshSupported = false) {
    try {
        initProvidersPageHelpers();
        // 获取合并后的数据（包括 providers 和 supportedProviders）
        const data = await window.apiClient.get('/providers');
        if (!data || !data.providers) return;

        const { providers, supportedProviders } = data;
        
        // 检查支持列表是否发生了变化（或者是否尚未初始化）
        const isChanged = !cachedSupportedProviders || 
                         supportedProviders.length !== cachedSupportedProviders.length ||
                         supportedProviders.some((p, i) => p !== cachedSupportedProviders[i]);

        // 如果强制刷新或是对象类型（可能是由事件触发），则也视为需要刷新
        const shouldForce = forceRefreshSupported === true || (typeof forceRefreshSupported === 'object');

        if (isChanged || shouldForce) {
            cachedSupportedProviders = supportedProviders;
            const providerConfigs = getProviderConfigs(cachedSupportedProviders);
            
            // 动态更新各个页面的提供商信息
            updateModelsProviderConfigs(providerConfigs);
            updateTutorialProviderConfigs(providerConfigs);
            updateUsageProviderConfigs(providerConfigs);
            updateConfigProviderConfigs(providerConfigs);
            updateProviderFilterOptions(providerConfigs);
            renderRoutingExamples(providerConfigs);
            
            isStaticProviderConfigsUpdated = true;
        }

        renderProviders(providers, cachedSupportedProviders);
        return data;
    } catch (error) {
        console.error('Failed to load providers:', error);
    }
}

async function loadProvidersPageData(forceRefreshSupported = false) {
    const data = await loadProviders(forceRefreshSupported);
    if (data?.providers) {
        await refreshProvidersHandoffSummary(data.providers, data.supportedProviders || cachedSupportedProviders || []);
    }
}

/**
 * 渲染提供商列表
 * @param {Object} providers - 提供商数据
 * @param {string[]} supportedProviders - 已注册的提供商类型列表
 */
function renderProviders(providers, supportedProviders = []) {
    const container = document.getElementById('providersList');
    if (!container) return;
    
    container.innerHTML = '';

    // 检查是否有提供商池数据
    const hasProviders = Object.keys(providers).length > 0;
    const statsGrid = document.querySelector('#providers .stats-grid');
    
    // 始终显示统计卡片
    if (statsGrid) statsGrid.style.display = 'grid';
    
    const providerConfigs = getProviderConfigs(supportedProviders);
    
    // 提取显示的 ID 顺序
    const providerDisplayOrder = providerConfigs.filter(c => c.visible !== false).map(c => c.id);
    
    // 建立 ID 到配置的映射，方便获取显示名称
    const configMap = providerConfigs.reduce((map, config) => {
        map[config.id] = config;
        return map;
    }, {});
    
    // 获取所有提供商类型并按指定顺序排序
    // 优先显示预定义的所有提供商类型，即使某些提供商没有数据也要显示
    let allProviderTypes;
    if (hasProviders) {
        // 合并预定义类型和实际存在的类型，确保显示所有预定义提供商
        const actualProviderTypes = Object.keys(providers);
        // 只保留配置中标记为 visible 的，或者不在配置中的（默认显示）
        allProviderTypes = [...new Set([...providerDisplayOrder, ...actualProviderTypes])];
    } else {
        allProviderTypes = providerDisplayOrder;
    }

    // 过滤掉明确设置为不显示的提供商
    const sortedProviderTypes = providerDisplayOrder.filter(type => allProviderTypes.includes(type))
        .concat(allProviderTypes.filter(type => !providerDisplayOrder.some(t => t === type) && !configMap[type]?.visible === false));
    
    // 计算总统计
    let totalAccounts = 0;
    let totalHealthy = 0;
    
    // 获取搜索关键词
    const searchInput = document.getElementById('providerSearchInput');
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';

    // 按照排序后的提供商类型渲染
    sortedProviderTypes.forEach((providerType) => {
        // 如果配置中明确设置为不显示，则跳过
        if (configMap[providerType] && configMap[providerType].visible === false) {
            return;
        }

        const accounts = hasProviders ? providers[providerType] || [] : [];

        // 搜索过滤逻辑
        if (searchTerm) {
            const displayName = (configMap[providerType]?.name || providerType).toLowerCase();
            const matchesType = displayName.includes(searchTerm) || providerType.toLowerCase().includes(searchTerm);
            const matchesNodes = accounts.some(acc => 
                (acc.customName || '').toLowerCase().includes(searchTerm) || 
                (acc.uuid || '').toLowerCase().includes(searchTerm) ||
                (acc.model || '').toLowerCase().includes(searchTerm)
            );
            
            if (!matchesType && !matchesNodes) {
                return;
            }
        }

        const providerDiv = document.createElement('div');
        providerDiv.className = 'provider-item';
        providerDiv.dataset.providerType = providerType;
        providerDiv.style.cursor = 'pointer';

        const healthyCount = accounts.filter(acc => acc.isHealthy && !acc.isDisabled).length;
        const totalCount = accounts.length;
        const usageCount = accounts.reduce((sum, acc) => sum + (acc.usageCount || 0), 0);
        const errorCount = accounts.reduce((sum, acc) => sum + (acc.errorCount || 0), 0);
        
        totalAccounts += totalCount;
        totalHealthy += healthyCount;

        // 更新全局统计变量
        if (!providerStats.providerTypeStats[providerType]) {
            providerStats.providerTypeStats[providerType] = {
                totalAccounts: 0,
                healthyAccounts: 0,
                totalUsage: 0,
                totalErrors: 0,
                lastUpdate: null
            };
        }
        
        const typeStats = providerStats.providerTypeStats[providerType];
        typeStats.totalAccounts = totalCount;
        typeStats.healthyAccounts = healthyCount;
        typeStats.totalUsage = usageCount;
        typeStats.totalErrors = errorCount;
        typeStats.lastUpdate = new Date().toISOString();

        // 为无数据状态设置特殊样式
        const isEmptyState = !hasProviders || totalCount === 0;
        const statusClass = isEmptyState ? 'status-empty' : (healthyCount === totalCount ? 'status-healthy' : 'status-unhealthy');
        const statusIcon = isEmptyState ? 'fa-info-circle' : (healthyCount === totalCount ? 'fa-check-circle' : 'fa-exclamation-triangle');
        const statusText = isEmptyState ? t('providers.status.empty') : t('providers.status.healthy', { healthy: healthyCount, total: totalCount });

        // 获取显示名称
        const displayName = configMap[providerType]?.name || providerType;

        providerDiv.innerHTML = `
            <div class="provider-header">
                <div class="provider-name">
                    <span class="provider-type-text">${displayName}</span>
                </div>
                <div class="provider-header-right">
                    ${configMap[providerType]?.registerUrl ? '' : generateAddGroupButton(providerType)}
                    ${generateRegisterButton(configMap[providerType])}
                    ${generateDocButton(configMap[providerType])}
                    ${generateAuthButton(providerType)}
                    <div class="provider-status ${statusClass}">
                        <i class="fas fa-${statusIcon}"></i>
                        <span>${statusText}</span>
                    </div>
                </div>
            </div>
            <div class="provider-stats">
                <div class="provider-stat">
                    <span class="provider-stat-label" data-i18n="providers.stat.totalAccounts">${t('providers.stat.totalAccounts')}</span>
                    <span class="provider-stat-value">${totalCount}</span>
                </div>
                <div class="provider-stat">
                    <span class="provider-stat-label" data-i18n="providers.stat.healthyAccounts">${t('providers.stat.healthyAccounts')}</span>
                    <span class="provider-stat-value">${healthyCount}</span>
                </div>
                <div class="provider-stat">
                    <span class="provider-stat-label" data-i18n="providers.stat.usageCount">${t('providers.stat.usageCount')}</span>
                    <span class="provider-stat-value">${usageCount}</span>
                </div>
                <div class="provider-stat">
                    <span class="provider-stat-label" data-i18n="providers.stat.errorCount">${t('providers.stat.errorCount')}</span>
                    <span class="provider-stat-value">${errorCount}</span>
                </div>
            </div>
        `;

        // 如果是空状态，添加特殊样式
        if (isEmptyState) {
            providerDiv.classList.add('empty-provider');
        }

        // 添加点击事件 - 整个提供商组都可以点击
        providerDiv.addEventListener('click', (e) => {
            e.preventDefault();
            openProviderManager(providerType);
        });

        container.appendChild(providerDiv);
        
        // 为添加分组按钮添加事件监听
        const addGroupBtn = providerDiv.querySelector('.add-group-btn');
        if (addGroupBtn) {
            addGroupBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                
                // 使用自定义的主题风格 Prompt
                showSimplePrompt(
                    t('providers.addGroup.title'),
                    t('providers.addGroup.suffixPlaceholder'),
                    async (suffix) => {
                        const cleanSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (!cleanSuffix) {
                            showToast(t('common.warning'), t('common.invalidSuffix'), 'warning');
                            return;
                        }
                        
                        const newProviderType = `${providerType}-${cleanSuffix}`;
                        
                        // 显示加载状态
                        addGroupBtn.disabled = true;
                        const originalHtml = addGroupBtn.innerHTML;
                        addGroupBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                        
                        try {
                            const response = await window.apiClient.post('/providers', {
                                providerType: newProviderType,
                                providerConfig: {
                                    customName: cleanSuffix.toUpperCase(),
                                    isHealthy: true,
                                    isDisabled: false,
                                    usageCount: 0,
                                    errorCount: 0
                                }
                            });
                            
                            if (response.success) {
                                showToast(t('common.success'), t('providers.addGroup.success'), 'success');
                                await loadProviders(true);
                                setTimeout(() => openProviderManager(newProviderType), 500);
                            } else {
                                throw new Error(response.error?.message || 'Unknown error');
                            }
                        } catch (error) {
                            console.error('Failed to add provider group:', error);
                            showToast(t('common.error'), t('providers.addGroup.error') + ': ' + error.message, 'error');
                            addGroupBtn.disabled = false;
                            addGroupBtn.innerHTML = originalHtml;
                        }
                    }
                );
            });
        }

        // 为授权按钮添加事件监听
        const authBtn = providerDiv.querySelector('.generate-auth-btn');
        if (authBtn) {
            authBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止事件冒泡到父元素
                handleGenerateAuthUrl(providerType);
            });
        }

        const registerBtns = providerDiv.querySelectorAll('.provider-register-btn');
        registerBtns.forEach(registerBtn => {
            registerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });
    });

    // 更新统计卡片数据
    const activeProviders = hasProviders ? Object.keys(providers).length : 0;
    updateProviderStatsDisplay(activeProviders, totalHealthy, totalAccounts);

    // 渲染仪表盘提供商状态概览
    renderProviderStatusOverview(providers, configMap, sortedProviderTypes);
}

/**
 * 跳转到特定的提供商节点
 * @param {string} type - 提供商类型
 * @param {string} uuid - 节点UUID
 * @param {Event} event - 事件对象
 */
window.jumpToProviderNode = function(type, uuid, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    // 切换到提供商页面
    const providersNav = document.querySelector('[data-section="providers"]');
    if (providersNav) {
        providersNav.click();
        // 延迟执行以确保页面切换完成
        setTimeout(() => {
            openProviderManager(type, uuid);
        }, 100);
    }
};

/**
 * 渲染仪表盘提供商状态概览
 * @param {Object} providers - 提供商数据
 * @param {Object} configMap - 提供商配置映射
 * @param {Array} sortedProviderTypes - 排序后的提供商类型
 */
function renderProviderStatusOverview(providers, configMap, sortedProviderTypes) {
    const grid = document.getElementById('providerStatusGrid');
    const panel = document.querySelector('.provider-status-panel');
    if (!grid || !panel) return;

    // 检查是否有任何实际可显示的提供商节点
    let hasVisibleNodes = false;
    const validProviderTypes = [];

    sortedProviderTypes.forEach(type => {
        const accounts = providers[type] || [];
        if (accounts.length > 0) {
            hasVisibleNodes = true;
            validProviderTypes.push(type);
        }
    });

    if (!hasVisibleNodes) {
        panel.style.display = 'none';
        
        // 没有数据时，自动展开仪表盘的高级信息（路径路由示例等）
        const dashboardDetails = document.querySelector('.dashboard-details');
        if (dashboardDetails) {
            dashboardDetails.open = true;
        }
        return;
    }

    panel.style.display = 'block';
    grid.innerHTML = '';

    validProviderTypes.forEach(type => {
        const accounts = providers[type];
        const displayName = configMap[type]?.name || type;
        const card = document.createElement('div');
        card.className = 'provider-status-card';
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            // 点击跳转到提供商管理页面并打开对应类型的管理弹窗
            const providersNav = document.querySelector('[data-section="providers"]');
            if (providersNav) {
                providersNav.click();
                setTimeout(() => openProviderManager(type), 100);
            }
        });

        const healthyCount = accounts.filter(acc => acc.isHealthy && !acc.isDisabled).length;
        const totalCount = accounts.length;
        const disabledCount = accounts.filter(acc => acc.isDisabled).length;
        const unhealthyCount = totalCount - healthyCount - disabledCount;

        const totalUsage = accounts.reduce((sum, acc) => sum + (acc.usageCount || 0), 0);
        const totalErrors = accounts.reduce((sum, acc) => sum + (acc.errorCount || 0), 0);

        card.innerHTML = `
            <div class="provider-info">
                <span class="provider-name" title="${displayName}">${displayName}</span>
                <span class="provider-count" style="font-size: 0.75rem; color: var(--text-secondary);">${healthyCount}/${totalCount}</span>
            </div>
            
            <div class="provider-nodes-summary">
                <span style="color: #10b981;"><i class="fas fa-check"></i> ${healthyCount}</span>
                <span style="color: #ef4444; ${unhealthyCount === 0 ? 'opacity: 0.3;' : ''}"><i class="fas fa-times"></i> ${unhealthyCount}</span>
                <span style="color: #9ca3af; ${disabledCount === 0 ? 'opacity: 0.3;' : ''}"><i class="fas fa-minus-circle"></i> ${disabledCount}</span>
            </div>

            <div class="node-dots">
                ${accounts.map(acc => {
                    let statusClass = 'healthy';
                    let statusTitle = acc.customName || acc.uuid;
                    if (acc.isDisabled) {
                        statusClass = 'disabled';
                        statusTitle += ` (${t('modal.provider.status.disabled')})`;
                    } else if (!acc.isHealthy) {
                        statusClass = 'unhealthy';
                        statusTitle += ` (${t('modal.provider.status.unhealthy')})`;
                    } else {
                        statusTitle += ` (${t('modal.provider.status.healthy')})`;
                    }
                    // 增加提示信息：用量和错误
                    statusTitle += `\n${t('providers.stat.usageCount')}: ${acc.usageCount || 0}\n${t('providers.stat.errorCount')}: ${acc.errorCount || 0}`;
                    
                    // 为圆点创建 HTML 字符串，添加点击跳转事件
                    return `<span class="node-dot ${statusClass}" title="${statusTitle}" onclick="window.jumpToProviderNode('${type}', '${acc.uuid}', event)"></span>`;
                }).join('')}
            </div>
            <div class="provider-stats-summary">
                <span><i class="fas fa-paper-plane" style="font-size: 0.7rem; opacity: 0.7;"></i> ${totalUsage}</span>
                <span><i class="fas fa-exclamation-circle" style="font-size: 0.7rem; opacity: 0.7;"></i> ${totalErrors}</span>
                <span class="success-rate">${totalUsage > 0 ? ((totalUsage - totalErrors) / totalUsage * 100).toFixed(1) + '%' : '--'}</span>
            </div>
        `;
        grid.appendChild(card);
    });
}

/**
 * 更新提供商统计信息
 * @param {number} activeProviders - 活跃提供商数
 * @param {number} healthyProviders - 健康提供商数
 * @param {number} totalAccounts - 总账户数
 */
function updateProviderStatsDisplay(activeProviders, healthyProviders, totalAccounts) {
    // 更新全局统计变量
    const newStats = {
        activeProviders,
        healthyProviders,
        totalAccounts,
        lastUpdateTime: new Date().toISOString()
    };
    
    updateProviderStats(newStats);
    
    // 计算总请求数和错误数
    let totalUsage = 0;
    let totalErrors = 0;
    Object.values(providerStats.providerTypeStats).forEach(typeStats => {
        totalUsage += typeStats.totalUsage || 0;
        totalErrors += typeStats.totalErrors || 0;
    });
    
    const finalStats = {
        ...newStats,
        totalRequests: totalUsage,
        totalErrors: totalErrors
    };
    
    updateProviderStats(finalStats);
    
    // 修改：根据使用次数统计"活跃提供商"和"活动连接"
    // "活跃提供商"：统计有使用次数(usageCount > 0)的提供商类型数量
    let activeProvidersByUsage = 0;
    Object.entries(providerStats.providerTypeStats).forEach(([providerType, typeStats]) => {
        if (typeStats.totalUsage > 0) {
            activeProvidersByUsage++;
        }
    });
    
    // "活动连接"：统计所有提供商账户的使用次数总和
    const activeConnections = totalUsage;
    
    // 更新页面显示
    const activeProvidersEl = document.getElementById('activeProviders');
    const healthyProvidersEl = document.getElementById('healthyProviders');
    const activeConnectionsEl = document.getElementById('activeConnections');
    
    if (activeProvidersEl) activeProvidersEl.textContent = activeProvidersByUsage;
    if (healthyProvidersEl) healthyProvidersEl.textContent = healthyProviders;
    if (activeConnectionsEl) activeConnectionsEl.textContent = activeConnections;
    
    // 打印调试信息到控制台
    console.log('Provider Stats Updated:', {
        activeProviders,
        activeProvidersByUsage,
        healthyProviders,
        totalAccounts,
        totalUsage,
        totalErrors,
        providerTypeStats: providerStats.providerTypeStats
    });
}

/**
 * 打开提供商管理模态框
 * @param {string} providerType - 提供商类型
 */
/**
 * 打开提供商管理模态框
 * @param {string} providerType - 提供商类型
 * @param {string} searchTerm - 初始搜索词
 */
async function openProviderManager(providerType, searchTerm = '') {
    try {
        const data = await window.apiClient.get(`/providers/${encodeURIComponent(providerType)}`);
        
        showProviderManagerModal(data, searchTerm);
    } catch (error) {
        console.error('Failed to load provider details:', error);
        showToast(t('common.error'), t('modal.provider.load.failed'), 'error');
    }
}

/**
 * 生成授权按钮HTML
 * @param {string} providerType - 提供商类型
 * @returns {string} 授权按钮HTML
 */
function generateAuthButton(providerType) {
    // 只为支持OAuth或批量导入的提供商显示授权按钮
    const oauthProviders = ['gemini-cli-oauth', 'gemini-antigravity', 'openai-qwen-oauth', 'claude-kiro-oauth', 'openai-iflow', 'openai-codex-oauth', 'grok-cli-oauth', 'grok-web'];

    if (!oauthProviders.includes(providerType)) {
        return '';
    }

    // Codex 提供商使用特殊图标
    if (providerType === 'openai-codex-oauth') {
        return `
            <button class="generate-auth-btn" title="生成 Codex OAuth 授权链接">
                <i class="fas fa-key"></i>
                <span data-i18n="providers.auth.generate">${t('providers.auth.generate')}</span>
            </button>
        `;
    }

    return `
        <button class="generate-auth-btn" title="生成OAuth授权链接">
            <i class="fas fa-key"></i>
            <span data-i18n="providers.auth.generate">${t('providers.auth.generate')}</span>
        </button>
    `;
}

/**
 * 生成提供商网站注册链接
 * @param {Object} providerConfig - 提供商配置
 * @returns {string} 链接HTML
 */
function generateRegisterButton(providerConfig) {
    if (!providerConfig?.registerUrl) {
        return '';
    }

    const safeUrl = escapeHtml(providerConfig.registerUrl);

    return `
        <a class="provider-register-btn" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${t('providers.register.title')}">
            <i class="fas fa-external-link-alt"></i>
            <span data-i18n="providers.register">${t('providers.register')}</span>
        </a>
    `;
}

/**
 * 生成提供商文档链接
 * @param {Object} providerConfig - 提供商配置
 * @returns {string} 链接HTML
 */
function generateDocButton(providerConfig) {
    if (!providerConfig?.docUrl) {
        return '';
    }

    const safeUrl = escapeHtml(providerConfig.docUrl);

    return `
        <a class="provider-register-btn" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${t('providers.docs.title')}">
            <i class="fas fa-book-open"></i>
            <span data-i18n="providers.docs">${t('providers.docs')}</span>
        </a>
    `;
}

/**
 * 显示一个极简的主题风格输入框
 * @param {string} title - 标题
 * @param {string} placeholder - 占位符
 * @param {function} callback - 确认回调
 */
function showSimplePrompt(title, placeholder, callback) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.style.zIndex = '3000';

    overlay.innerHTML = `
        <div class="modal-content" style="max-width: 320px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); border: 1px solid var(--border-color); padding: 20px;">
            <div style="margin-bottom: 12px; font-weight: 600; font-size: 14px; color: var(--text-primary);">${title}</div>
            <div style="display: flex; gap: 8px;">
                <input type="text" id="simple-prompt-input" placeholder="${placeholder}" style="flex: 1; padding: 8px 12px; border: 1.5px solid var(--border-color); border-radius: 6px; font-size: 13px; outline: none;">
                <button id="simple-prompt-submit" class="btn btn-primary btn-sm" style="padding: 0 12px; height: 34px; border-radius: 6px; font-size: 13px;">${t('common.confirm')}</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);
    
    const input = overlay.querySelector('#simple-prompt-input');
    const submitBtn = overlay.querySelector('#simple-prompt-submit');
    
    input.focus();
    
    const finish = () => {
        const val = input.value.trim();
        if (val) {
            overlay.remove();
            callback(val);
        }
    };
    
    submitBtn.onclick = finish;
    input.onkeydown = (e) => {
        if (e.key === 'Enter') finish();
        if (e.key === 'Escape') overlay.remove();
    };
    overlay.onclick = (e) => {
        if (e.target === overlay) overlay.remove();
    };
}

/**
 * 生成添加分组按钮HTML
 * @param {string} providerType - 提供商类型
 * @returns {string} 按钮HTML
 */
function generateAddGroupButton(providerType) {
    const allowedTypes = ['claude-custom', 'openai-custom', 'openaiResponses-custom', 'atlascloud', 'qiniu', 'fenno'];
    if (!allowedTypes.includes(providerType)) {
        return '';
    }

    return `
        <button class="add-group-btn" title="${t('providers.addGroup.title')}">
            <i class="fas fa-folder-plus"></i>
            <span data-i18n="providers.addGroup">${t('providers.addGroup')}</span>
        </button>
    `;
}

/**
 * 处理生成授权链接
 * @param {string} providerType - 提供商类型
 */
async function handleGenerateAuthUrl(providerType) {
    // 如果是 Kiro OAuth，先显示认证方式选择对话框
    if (providerType === 'claude-kiro-oauth') {
        showKiroAuthMethodSelector(providerType);
        return;
    }

    // 如果是 Gemini OAuth 或 Antigravity，显示认证方式选择对话框
    if (providerType === 'gemini-cli-oauth' || providerType === 'gemini-antigravity') {
        showGeminiAuthMethodSelector(providerType);
        return;
    }

    // 如果是 Codex OAuth，显示认证方式选择对话框
    if (providerType === 'openai-codex-oauth') {
        showCodexAuthMethodSelector(providerType);
        return;
    }

    if (providerType === 'grok-cli-oauth') {
        showGrokCliAuthMethodSelector(providerType);
        return;
    }

    // 如果是 Grok，显示认证方式选择对话框（目前仅支持批量导入，因为没有标准 OAuth）
    if (providerType === 'grok-web') {
        showGrokAuthMethodSelector(providerType);
        return;
    }

    await executeGenerateAuthUrl(providerType, {});
}

/**
 * 显示 Codex OAuth 认证方式选择对话框
 * @param {string} providerType - 提供商类型
 */
function showCodexAuthMethodSelector(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.gemini.selectMethod">${t('oauth.gemini.selectMethod')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-method-options" style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="auth-method-btn" data-method="oauth" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-key" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.codex.oauth">${t('oauth.codex.oauth')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.codex.oauthDesc">${t('oauth.codex.oauthDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="batch-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-import" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.codex.batchImport">${t('oauth.codex.batchImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.codex.batchImportDesc">${t('oauth.codex.batchImportDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="cpa-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-code" style="font-size: 24px; color: #6366f1;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.codex.cpaImport">${t('oauth.codex.cpaImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.codex.cpaImportDesc">${t('oauth.codex.cpaImportDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="sub2api-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-layer-group" style="font-size: 24px; color: #f59e0b;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.codex.sub2apiImport">${t('oauth.codex.sub2apiImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.codex.sub2apiImportDesc">${t('oauth.codex.sub2apiImportDesc')}</div>
                        </div>
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 认证方式选择按钮事件
    const methodBtns = modal.querySelectorAll('.auth-method-btn');
    methodBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = '#4285f4';
            btn.style.background = '#f8faff';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = '#e0e0e0';
            btn.style.background = 'white';
        });
        btn.addEventListener('click', async () => {
            const method = btn.dataset.method;
            modal.remove();
            
            if (method === 'batch-import') {
                showCodexBatchImportModal(providerType);
            } else if (method === 'cpa-import') {
                showCodexExternalImportModal(providerType, 'cpa');
            } else if (method === 'sub2api-import') {
                showCodexExternalImportModal(providerType, 'sub2api');
            } else {
                await executeGenerateAuthUrl(providerType, {});
            }
        });
    });
}

/**
 * 显示 Codex 批量导入模态框
 * @param {string} providerType - 提供商类型
 */
function showCodexBatchImportModal(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> <span data-i18n="oauth.codex.batchImport">${t('oauth.codex.batchImport')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="batch-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #1e40af;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.codex.importInstructions">${t('oauth.codex.importInstructions')}</span>
                    </p>
                </div>
                <div class="form-group">
                    <label for="batchCodexTokens" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.codex.tokensLabel">${t('oauth.codex.tokensLabel')}</span>
                    </label>
                    <textarea 
                        id="batchCodexTokens" 
                        rows="10" 
                        style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                        placeholder='${t('oauth.codex.tokensPlaceholder')}'
                        data-i18n-placeholder="oauth.codex.tokensPlaceholder"
                    ></textarea>
                </div>
                <div class="form-group" style="margin-top: 12px; margin-bottom: 16px;">
                    <details style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <summary style="padding: 12px; cursor: pointer; font-weight: 600; color: #374151; user-select: none;">
                            <i class="fas fa-code" style="color: #4285f4; margin-right: 8px;"></i>
                            <span data-i18n="oauth.codex.jsonExample">${t('oauth.codex.jsonExample')}</span>
                        </summary>
                        <div style="padding: 12px; background: #1f2937; border-radius: 0 0 8px 8px;">
                            <div style="color: #10b981; font-family: monospace; font-size: 12px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 单个凭据导入示例：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">{
  "access_token": "eyJhbG...",
  "id_token": "",
  "refresh_token": "",
  "token_type": "Bearer",
  "expires_in": 3600
}</pre>
                            </div>
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-top: 16px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 批量导入示例（JSON数组）：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">[
  {
    "access_token": "token1...",
    "chatgpt_account_id": "account1..."
  },
  {
    "access_token": "token2...",
    "refresh_token": ""
  }
]</pre>
                            </div>
                        </div>
                    </details>
                </div>
                <div class="batch-import-stats" id="codexBatchStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="oauth.codex.tokenCount">${t('oauth.codex.tokenCount')}</span>
                        <span id="codexTokenCountValue" style="font-weight: 600;">0</span>
                    </div>
                </div>
                <div class="batch-import-progress" id="codexBatchProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #4285f4;"></i>
                        <span data-i18n="oauth.codex.importing">${t('oauth.codex.importing')}</span>
                    </div>
                    <div class="progress-bar" style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="codexImportProgressBar" style="height: 100%; width: 0%; background: #4285f4; transition: width 0.3s;"></div>
                    </div>
                </div>
                <div class="batch-import-result" id="codexBatchResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary batch-import-submit" id="codexBatchSubmit">
                    <i class="fas fa-upload"></i>
                    <span data-i18n="oauth.codex.startImport">${t('oauth.codex.startImport')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const textarea = modal.querySelector('#batchCodexTokens');
    const statsDiv = modal.querySelector('#codexBatchStats');
    const tokenCountValue = modal.querySelector('#codexTokenCountValue');
    const progressDiv = modal.querySelector('#codexBatchProgress');
    const progressBar = modal.querySelector('#codexImportProgressBar');
    const resultDiv = modal.querySelector('#codexBatchResult');
    const submitBtn = modal.querySelector('#codexBatchSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    
    // 实时统计 token 数量
    textarea.addEventListener('input', () => {
        try {
            const val = textarea.value.trim();
            if (!val) {
                statsDiv.style.display = 'none';
                return;
            }
            const data = JSON.parse(val);
            const tokens = Array.isArray(data) ? data : [data];
            statsDiv.style.display = 'block';
            tokenCountValue.textContent = tokens.length;
        } catch (e) {
            statsDiv.style.display = 'none';
        }
    });
    
    // 关闭按钮事件
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 提交按钮事件
    submitBtn.onclick = async () => {
        let tokens = [];
        try {
            const val = textarea.value.trim();
            const data = JSON.parse(val);
            tokens = Array.isArray(data) ? data : [data];
        } catch (e) {
            showToast(t('common.error'), t('oauth.codex.noTokens'), 'error');
            return;
        }
        
        if (tokens.length === 0) {
            showToast(t('common.warning'), t('oauth.codex.noTokens'), 'warning');
            return;
        }
        
        // 禁用输入和按钮
        textarea.disabled = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        progressDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        progressBar.style.width = '0%';
        
        // 创建实时结果显示区域
        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #4285f4;"></i>
                <strong id="codexBatchProgressText">${t('oauth.codex.importingProgress', { current: 0, total: tokens.length })}</strong>
            </div>
            <div id="codexBatchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;
        
        const progressText = resultDiv.querySelector('#codexBatchProgressText');
        const resultsList = resultDiv.querySelector('#codexBatchResultsList');
        
        let importSuccess = false; // 标记是否导入成功

        try {
            const response = await fetch('/api/codex/batch-import-tokens', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ tokens })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                let eventType = '';
                let eventData = '';
                
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();
                        
                        if (eventType && eventData) {
                            try {
                                const data = JSON.parse(eventData);
                                
                                if (eventType === 'progress') {
                                    const { index, total, current } = data;
                                    const percentage = Math.round((index / total) * 100);
                                    progressBar.style.width = `${percentage}%`;
                                    progressText.textContent = t('oauth.codex.importingProgress', { current: index, total: total });
                                    
                                    const resultItem = document.createElement('div');
                                    resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                    if (current.success) {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>`;
                                    } else if (current.error === 'duplicate') {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.kiro.duplicateToken')}</span>
                                            ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                    } else {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                    }
                                    resultsList.appendChild(resultItem);
                                    resultsList.scrollTop = resultsList.scrollHeight;
                                } else if (eventType === 'complete') {
                                    progressBar.style.width = '100%';
                                    progressDiv.style.display = 'none';
                                    
                                    const isAllSuccess = data.failedCount === 0;
                                    const isAllFailed = data.successCount === 0;
                                    let resultClass, resultIcon, resultMessage;
                                    
                                    if (isAllSuccess) {
                                        resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                        resultIcon = 'fa-check-circle';
                                        resultMessage = t('oauth.codex.importSuccess', { count: data.successCount });
                                    } else if (isAllFailed) {
                                        resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                        resultIcon = 'fa-times-circle';
                                        resultMessage = t('oauth.codex.importAllFailed', { count: data.failedCount });
                                    } else {
                                        resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                        resultIcon = 'fa-exclamation-triangle';
                                        resultMessage = t('oauth.codex.importPartial', { success: data.successCount, failed: data.failedCount });
                                    }
                                    
                                    resultDiv.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                                    const headerDiv = resultDiv.querySelector('div:first-child');
                                    headerDiv.innerHTML = `<i class="fas ${resultIcon}"></i> <strong>${resultMessage}</strong>`;
                                    
                                    if (data.successCount > 0) {
                                        importSuccess = true;
                                        loadProviders();
                                        loadConfigList();
                                    }
                                } else if (eventType === 'error') {
                                    throw new Error(data.error);
                                }
                            } catch (parseError) {
                                console.warn('Failed to parse SSE data:', parseError);
                            }
                            eventType = '';
                            eventData = '';
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Codex Batch Import] Failed:', error);
            progressDiv.style.display = 'none';
            resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            resultDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.codex.importError')}: ${error.message}</strong>
                </div>
            `;
        } finally {
            cancelBtn.disabled = false;
            
            if (!importSuccess) {
                textarea.disabled = false;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-upload"></i> <span data-i18n="oauth.codex.startImport">${t('oauth.codex.startImport')}</span>`;
            } else {
                submitBtn.innerHTML = `<i class="fas fa-check"></i> <span>${t('common.confirm')}</span>`;
                submitBtn.disabled = false;
                submitBtn.onclick = () => modal.remove();
                cancelBtn.style.display = 'none';
            }
        }
    };
}

/**
 * 显示 Grok CLI OAuth 认证方式选择对话框
 * @param {string} providerType - 提供商类型
 */
function showGrokCliAuthMethodSelector(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.gemini.selectMethod">${t('oauth.gemini.selectMethod')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-method-options" style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="auth-method-btn" data-method="oauth" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-key" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.grokCli.oauth">${t('oauth.grokCli.oauth')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.grokCli.oauthDesc">${t('oauth.grokCli.oauthDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="batch-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-import" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.grokCli.batchImport">${t('oauth.grokCli.batchImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.grokCli.batchImportDesc">${t('oauth.grokCli.batchImportDesc')}</div>
                        </div>
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => modal.remove());
    });

    modal.querySelectorAll('.auth-method-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = '#10b981';
            btn.style.background = '#f0fdf4';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = '#e0e0e0';
            btn.style.background = 'white';
        });
        btn.addEventListener('click', async () => {
            const method = btn.dataset.method;
            modal.remove();

            if (method === 'batch-import') {
                showGrokCliBatchImportModal(providerType);
            } else {
                await executeGenerateAuthUrl(providerType, {});
            }
        });
    });
}

/**
 * 显示 Grok CLI OAuth Token 批量导入模态框
 * @param {string} providerType - 提供商类型
 */
function showGrokCliBatchImportModal(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-content" style="max-width: 620px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> <span data-i18n="oauth.grokCli.batchImport">${t('oauth.grokCli.batchImport')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="batch-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #1e40af;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.grokCli.importInstructions">${t('oauth.grokCli.importInstructions')}</span>
                    </p>
                </div>
                <div class="form-group">
                    <label for="batchGrokCliTokens" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.grokCli.tokensLabel">${t('oauth.grokCli.tokensLabel')}</span>
                    </label>
                    <textarea
                        id="batchGrokCliTokens"
                        rows="10"
                        style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                        placeholder='${t('oauth.grokCli.tokensPlaceholder')}'
                        data-i18n-placeholder="oauth.grokCli.tokensPlaceholder"
                    ></textarea>
                </div>
                <div class="form-group" style="margin-top: 12px; margin-bottom: 16px;">
                    <details style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <summary style="padding: 12px; cursor: pointer; font-weight: 600; color: #374151; user-select: none;">
                            <i class="fas fa-code" style="color: #10b981; margin-right: 8px;"></i>
                            <span data-i18n="oauth.grokCli.jsonExample">${t('oauth.grokCli.jsonExample')}</span>
                        </summary>
                        <div style="padding: 12px; background: #1f2937; border-radius: 0 0 8px 8px;">
                            <pre style="margin: 0; white-space: pre; overflow-x: auto; color: #34d399; font-family: monospace; font-size: 12px;">{
  "access_token": "eyJhbG...",
  "id_token": "",
  "refresh_token": "",
  "token_type": "Bearer",
  "expires_in": 3600,
  "email": "user@example.com",
  "sub": "xai-user-id"
}</pre>
                            <pre style="margin: 16px 0 0; white-space: pre; overflow-x: auto; color: #34d399; font-family: monospace; font-size: 12px;">[
  {
    "access_token": "token1...",
    "refresh_token": "refresh1..."
  },
  {
    "access_token": "token2..."
  }
]</pre>
                        </div>
                    </details>
                </div>
                <div class="batch-import-stats" id="grokCliBatchStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="oauth.grokCli.tokenCount">${t('oauth.grokCli.tokenCount')}</span>
                        <span id="grokCliTokenCountValue" style="font-weight: 600;">0</span>
                    </div>
                </div>
                <div class="batch-import-progress" id="grokCliBatchProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #10b981;"></i>
                        <span data-i18n="oauth.grokCli.importing">${t('oauth.grokCli.importing')}</span>
                    </div>
                    <div class="progress-bar" style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="grokCliImportProgressBar" style="height: 100%; width: 0%; background: #10b981; transition: width 0.3s;"></div>
                    </div>
                </div>
                <div class="batch-import-result" id="grokCliBatchResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary batch-import-submit" id="grokCliBatchSubmit">
                    <i class="fas fa-upload"></i>
                    <span data-i18n="oauth.grokCli.startImport">${t('oauth.grokCli.startImport')}</span>
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const textarea = modal.querySelector('#batchGrokCliTokens');
    const statsDiv = modal.querySelector('#grokCliBatchStats');
    const tokenCountValue = modal.querySelector('#grokCliTokenCountValue');
    const progressDiv = modal.querySelector('#grokCliBatchProgress');
    const progressBar = modal.querySelector('#grokCliImportProgressBar');
    const resultDiv = modal.querySelector('#grokCliBatchResult');
    const submitBtn = modal.querySelector('#grokCliBatchSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');

    textarea.addEventListener('input', () => {
        try {
            const val = textarea.value.trim();
            if (!val) {
                statsDiv.style.display = 'none';
                return;
            }
            const data = JSON.parse(val);
            const tokens = Array.isArray(data) ? data : [data];
            statsDiv.style.display = 'block';
            tokenCountValue.textContent = tokens.length;
        } catch {
            statsDiv.style.display = 'none';
        }
    });

    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => modal.remove());
    });

    submitBtn.onclick = async () => {
        let tokens = [];
        try {
            const val = textarea.value.trim();
            const data = JSON.parse(val);
            tokens = Array.isArray(data) ? data : [data];
        } catch {
            showToast(t('common.error'), t('oauth.grokCli.noTokens'), 'error');
            return;
        }

        if (tokens.length === 0) {
            showToast(t('common.warning'), t('oauth.grokCli.noTokens'), 'warning');
            return;
        }

        textarea.disabled = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        progressDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        progressBar.style.width = '0%';

        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #10b981;"></i>
                <strong id="grokCliBatchProgressText">${t('oauth.grokCli.importingProgress', { current: 0, total: tokens.length })}</strong>
            </div>
            <div id="grokCliBatchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;

        const progressText = resultDiv.querySelector('#grokCliBatchProgressText');
        const resultsList = resultDiv.querySelector('#grokCliBatchResultsList');
        let importSuccess = false;

        try {
            const response = await fetch('/api/grok-cli/batch-import-tokens', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ tokens })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                let eventType = '';
                let eventData = '';

                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();

                        if (eventType && eventData) {
                            try {
                                const data = JSON.parse(eventData);

                                if (eventType === 'progress') {
                                    const { index, total, current } = data;
                                    const percentage = Math.round((index / total) * 100);
                                    progressBar.style.width = `${percentage}%`;
                                    progressText.textContent = t('oauth.grokCli.importingProgress', { current: index, total: total });

                                    const resultItem = document.createElement('div');
                                    resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                    if (current.success) {
                                        const mode = current.accessTokenOnly ? ` <span style="color: #92400e;">(${t('oauth.grokCli.accessTokenOnly')})</span>` : '';
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>${mode}`;
                                    } else if (current.error === 'duplicate') {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.grokCli.duplicateToken')}</span>
                                            ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                    } else {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                    }
                                    resultsList.appendChild(resultItem);
                                    resultsList.scrollTop = resultsList.scrollHeight;
                                } else if (eventType === 'complete') {
                                    progressBar.style.width = '100%';
                                    progressDiv.style.display = 'none';

                                    const isAllSuccess = data.failedCount === 0;
                                    const isAllFailed = data.successCount === 0;
                                    let resultClass, resultIcon, resultMessage;

                                    if (isAllSuccess) {
                                        resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                        resultIcon = 'fa-check-circle';
                                        resultMessage = t('oauth.grokCli.importSuccess', { count: data.successCount });
                                    } else if (isAllFailed) {
                                        resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                        resultIcon = 'fa-times-circle';
                                        resultMessage = t('oauth.grokCli.importAllFailed', { count: data.failedCount });
                                    } else {
                                        resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                        resultIcon = 'fa-exclamation-triangle';
                                        resultMessage = t('oauth.grokCli.importPartial', { success: data.successCount, failed: data.failedCount });
                                    }

                                    resultDiv.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                                    const headerDiv = resultDiv.querySelector('div:first-child');
                                    headerDiv.innerHTML = `<i class="fas ${resultIcon}"></i> <strong>${resultMessage}</strong>`;

                                    if (data.successCount > 0) {
                                        importSuccess = true;
                                        loadProviders();
                                        loadConfigList();
                                    }
                                } else if (eventType === 'error') {
                                    throw new Error(data.error);
                                }
                            } catch (parseError) {
                                console.warn('Failed to parse SSE data:', parseError);
                            }
                            eventType = '';
                            eventData = '';
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Grok CLI Batch Import] Failed:', error);
            progressDiv.style.display = 'none';
            resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            resultDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.grokCli.importError')}: ${error.message}</strong>
                </div>
            `;
        } finally {
            cancelBtn.disabled = false;

            if (!importSuccess) {
                textarea.disabled = false;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-upload"></i> <span data-i18n="oauth.grokCli.startImport">${t('oauth.grokCli.startImport')}</span>`;
            } else {
                submitBtn.innerHTML = `<i class="fas fa-check"></i> <span>${t('common.confirm')}</span>`;
                submitBtn.disabled = false;
                submitBtn.onclick = () => modal.remove();
                cancelBtn.style.display = 'none';
            }
        }
    };
}

function getCodexExternalImportMeta(source) {
    const examples = {
        cpa: `{
  "type": "codex",
  "account_id": "account-id",
  "email": "user@example.com",
  "id_token": "",
  "access_token": "access-token",
  "refresh_token": "",
  "expired": "2026-05-31T11:40:33.000Z"
}`,
        sub2api: `{
  "exported_at": "2026-05-26T00:29:02Z",
  "accounts": [
    {
      "name": "user@example.com",
      "platform": "openai",
      "credentials": {
        "access_token": "access-token",
        "chatgpt_account_id": "account-id",
        "expires_at": 1780576407,
        "refresh_token": ""
      }
    }
  ]
}`
    };

    return {
        title: source === 'cpa' ? t('oauth.codex.cpaImport') : t('oauth.codex.sub2apiImport'),
        instructions: source === 'cpa' ? t('oauth.codex.cpaImportInstructions') : t('oauth.codex.sub2apiImportInstructions'),
        placeholder: source === 'cpa' ? t('oauth.codex.cpaImportPlaceholder') : t('oauth.codex.sub2apiImportPlaceholder'),
        example: examples[source]
    };
}

function getCodexExternalImportStats(source, data) {
    if (source === 'sub2api') {
        let accounts = [];
        if (Array.isArray(data)) {
            accounts = data;
        } else if (Array.isArray(data?.accounts)) {
            accounts = data.accounts;
        } else if (data?.credentials && typeof data.credentials === 'object') {
            accounts = [data];
        }
        const openaiAccounts = accounts.filter(account => !account.platform || account.platform === 'openai');
        const validAccounts = openaiAccounts.filter(account => account?.credentials?.access_token);
        return {
            total: accounts.length,
            valid: validAccounts.length,
            skipped: accounts.length - validAccounts.length
        };
    }

    const items = Array.isArray(data) ? data : [data];
    const validItems = items.filter(item => item?.access_token);
    return {
        total: items.length,
        valid: validItems.length,
        skipped: items.length - validItems.length
    };
}

/**
 * 显示 Codex CPA/sub2api 外部格式批量导入模态框
 * @param {string} providerType - 提供商类型
 * @param {'cpa'|'sub2api'} source - 外部来源
 */
function showCodexExternalImportModal(providerType, source) {
    const meta = getCodexExternalImportMeta(source);
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-content" style="max-width: 680px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> <span>${meta.title}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="batch-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #1e40af;">
                        <i class="fas fa-info-circle"></i>
                        <span>${meta.instructions}</span>
                    </p>
                </div>
                <div class="form-group">
                    <label for="codexExternalImportInput" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.codex.externalImportLabel">${t('oauth.codex.externalImportLabel')}</span>
                    </label>
                    <textarea
                        id="codexExternalImportInput"
                        rows="12"
                        style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                        placeholder="${meta.placeholder.replace(/"/g, '&quot;')}"
                    ></textarea>
                </div>
                <div class="form-group" style="margin-top: 12px; margin-bottom: 16px;">
                    <details style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <summary style="padding: 12px; cursor: pointer; font-weight: 600; color: #374151; user-select: none;">
                            <i class="fas fa-code" style="color: #4285f4; margin-right: 8px;"></i>
                            <span data-i18n="oauth.codex.jsonExample">${t('oauth.codex.jsonExample')}</span>
                        </summary>
                        <div style="padding: 12px; background: #1f2937; border-radius: 0 0 8px 8px;">
                            <pre style="margin: 0; white-space: pre; overflow-x: auto; color: #10b981; font-family: monospace; font-size: 12px;">${meta.example}</pre>
                        </div>
                    </details>
                </div>
                <div class="batch-import-stats" id="codexExternalImportStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 13px;">
                        <span>${t('oauth.codex.externalImportTotal')}: <strong id="codexExternalTotal">0</strong></span>
                        <span>${t('oauth.codex.externalImportValid')}: <strong id="codexExternalValid">0</strong></span>
                        <span>${t('oauth.codex.externalImportSkipped')}: <strong id="codexExternalSkipped">0</strong></span>
                    </div>
                </div>
                <div class="batch-import-progress" id="codexExternalImportProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #4285f4;"></i>
                        <span data-i18n="oauth.codex.importing">${t('oauth.codex.importing')}</span>
                    </div>
                    <div class="progress-bar" style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="codexExternalProgressBar" style="height: 100%; width: 0%; background: #4285f4; transition: width 0.3s;"></div>
                    </div>
                </div>
                <div class="batch-import-result" id="codexExternalImportResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary batch-import-submit" id="codexExternalImportSubmit">
                    <i class="fas fa-upload"></i>
                    <span data-i18n="oauth.codex.startImport">${t('oauth.codex.startImport')}</span>
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const textarea = modal.querySelector('#codexExternalImportInput');
    const statsDiv = modal.querySelector('#codexExternalImportStats');
    const totalValue = modal.querySelector('#codexExternalTotal');
    const validValue = modal.querySelector('#codexExternalValid');
    const skippedValue = modal.querySelector('#codexExternalSkipped');
    const progressDiv = modal.querySelector('#codexExternalImportProgress');
    const progressBar = modal.querySelector('#codexExternalProgressBar');
    const resultDiv = modal.querySelector('#codexExternalImportResult');
    const submitBtn = modal.querySelector('#codexExternalImportSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');

    textarea.addEventListener('input', () => {
        try {
            const val = textarea.value.trim();
            if (!val) {
                statsDiv.style.display = 'none';
                return;
            }
            const data = JSON.parse(val);
            const stats = getCodexExternalImportStats(source, data);
            statsDiv.style.display = 'block';
            totalValue.textContent = stats.total;
            validValue.textContent = stats.valid;
            skippedValue.textContent = stats.skipped;
        } catch {
            statsDiv.style.display = 'none';
        }
    });

    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => modal.remove());
    });

    submitBtn.onclick = async () => {
        let payload;
        try {
            payload = JSON.parse(textarea.value.trim());
        } catch {
            showToast(t('common.error'), t('oauth.codex.noTokens'), 'error');
            return;
        }

        textarea.disabled = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        progressDiv.style.display = 'block';
        progressBar.style.width = '0%';
        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #4285f4;"></i>
                <strong id="codexExternalProgressText">${t('oauth.codex.importingProgress', { current: 0, total: 0 })}</strong>
            </div>
            <div id="codexExternalResultsList" style="max-height: 220px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;

        const progressText = resultDiv.querySelector('#codexExternalProgressText');
        const resultsList = resultDiv.querySelector('#codexExternalResultsList');
        let importSuccess = false;

        try {
            const response = await fetch('/api/codex/import-external-credentials', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ source, payload })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                let eventType = '';
                let eventData = '';

                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();

                        if (eventType && eventData) {
                            const data = JSON.parse(eventData);
                            if (eventType === 'start') {
                                progressText.textContent = t('oauth.codex.importingProgress', { current: 0, total: data.total });
                            } else if (eventType === 'progress') {
                                const { index, total, current } = data;
                                progressBar.style.width = `${Math.round((index / total) * 100)}%`;
                                progressText.textContent = t('oauth.codex.importingProgress', { current: index, total });

                                const resultItem = document.createElement('div');
                                resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                if (current.success) {
                                    const mode = current.accessTokenOnly ? ` <span style="color: #92400e;">(${t('oauth.codex.accessTokenOnly')})</span>` : '';
                                    resultItem.innerHTML = `${escapeHtml(current.email || 'Codex')}: <span style="color: #166534;">✓ ${escapeHtml(current.path || '')}</span>${mode}`;
                                } else if (current.error === 'duplicate') {
                                    resultItem.innerHTML = `${escapeHtml(current.email || `#${current.index}`)}: <span style="color: #d97706;">⚠ ${escapeHtml(t('oauth.kiro.duplicateToken'))}</span>
                                        ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${escapeHtml(current.existingPath)})</span>` : ''}`;
                                } else {
                                    resultItem.innerHTML = `${escapeHtml(current.email || `#${current.index}`)}: <span style="color: #991b1b;">✗ ${escapeHtml(current.error || '')}</span>`;
                                }
                                resultsList.appendChild(resultItem);
                                resultsList.scrollTop = resultsList.scrollHeight;
                            } else if (eventType === 'complete') {
                                progressBar.style.width = '100%';
                                progressDiv.style.display = 'none';

                                const isAllSuccess = data.failedCount === 0;
                                const isAllFailed = data.successCount === 0;
                                let resultClass, resultIcon, resultMessage;
                                if (isAllSuccess) {
                                    resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                    resultIcon = 'fa-check-circle';
                                    resultMessage = t('oauth.codex.importSuccess', { count: data.successCount });
                                } else if (isAllFailed) {
                                    resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                    resultIcon = 'fa-times-circle';
                                    resultMessage = t('oauth.codex.importAllFailed', { count: data.failedCount });
                                } else {
                                    resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                    resultIcon = 'fa-exclamation-triangle';
                                    resultMessage = t('oauth.codex.importPartial', { success: data.successCount, failed: data.failedCount });
                                }

                                resultDiv.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                                resultDiv.querySelector('div:first-child').innerHTML = `<i class="fas ${resultIcon}"></i> <strong>${escapeHtml(resultMessage)}</strong>`;

                                if (data.successCount > 0) {
                                    importSuccess = true;
                                    loadProviders();
                                    loadConfigList();
                                }
                            } else if (eventType === 'error') {
                                throw new Error(data.error);
                            }
                            eventType = '';
                            eventData = '';
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Codex External Import] Failed:', error);
            progressDiv.style.display = 'none';
            resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            resultDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${escapeHtml(t('oauth.codex.importError'))}: ${escapeHtml(error.message)}</strong>
                </div>
            `;
        } finally {
            cancelBtn.disabled = false;
            if (!importSuccess) {
                textarea.disabled = false;
                submitBtn.disabled = false;
            } else {
                submitBtn.innerHTML = `<i class="fas fa-check"></i> <span>${t('common.confirm')}</span>`;
                submitBtn.disabled = false;
                submitBtn.onclick = () => modal.remove();
                cancelBtn.style.display = 'none';
            }
        }
    };
}

/**
 * 显示 Grok 认证方式选择对话框
 * @param {string} providerType - 提供商类型
 */
function showGrokAuthMethodSelector(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.gemini.selectMethod">${t('oauth.gemini.selectMethod')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-method-options" style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="auth-method-btn" data-method="batch-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-import" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.grok.batchImport">${t('oauth.grok.batchImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.grok.batchImportDesc">${t('oauth.grok.batchImportDesc')}</div>
                        </div>
                    </button>
                    <div style="padding: 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; font-size: 13px; color: #92400e;">
                        <i class="fas fa-info-circle"></i> Grok 目前仅支持通过 SSO Token 手动添加或批量导入。
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 认证方式选择按钮事件
    const methodBtns = modal.querySelectorAll('.auth-method-btn');
    methodBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = '#10b981';
            btn.style.background = '#f0fdf4';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = '#e0e0e0';
            btn.style.background = 'white';
        });
        btn.addEventListener('click', async () => {
            const method = btn.dataset.method;
            modal.remove();
            
            if (method === 'batch-import') {
                showGrokBatchImportModal(providerType);
            }
        });
    });
}

/**
 * 显示 Grok 批量导入模态框
 * @param {string} providerType - 提供商类型
 */
function showGrokBatchImportModal(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> <span data-i18n="oauth.grok.batchImport">${t('oauth.grok.batchImport')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="batch-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #1e40af;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.grok.importInstructions">${t('oauth.grok.importInstructions')}</span>
                    </p>
                </div>
                <div class="form-group">
                    <label for="batchGrokTokens" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.grok.tokensLabel">${t('oauth.grok.tokensLabel')}</span>
                    </label>
                    <textarea 
                        id="batchGrokTokens" 
                        rows="10" 
                        style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                        placeholder='${t('oauth.grok.tokensPlaceholder')}'
                        data-i18n-placeholder="oauth.grok.tokensPlaceholder"
                    ></textarea>
                </div>
                <div class="form-group" style="margin-top: 12px; margin-bottom: 16px;">
                    <details style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <summary style="padding: 12px; cursor: pointer; font-weight: 600; color: #374151; user-select: none;">
                            <i class="fas fa-code" style="color: #10b981; margin-right: 8px;"></i>
                            <span data-i18n="oauth.grok.jsonExample">${t('oauth.grok.jsonExample')}</span>
                        </summary>
                        <div style="padding: 12px; background: #1f2937; border-radius: 0 0 8px 8px;">
                            <div style="color: #10b981; font-family: monospace; font-size: 12px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 格式 1：纯文本（每行一个 SSO）</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto; color: #34d399;">sso_token_1_abc...
sso_token_2_def...</pre>
                            </div>
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-top: 16px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 格式 2：JSON 数组</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto; color: #34d399;">[
  "sso_token_1...",
  "sso_token_2..."
]</pre>
                            </div>
                        </div>
                    </details>
                </div>
                <div class="batch-import-stats" id="grokBatchStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="oauth.grok.tokenCount">${t('oauth.grok.tokenCount')}</span>
                        <span id="grokTokenCountValue" style="font-weight: 600;">0</span>
                    </div>
                </div>
                <div class="batch-import-progress" id="grokBatchProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #10b981;"></i>
                        <span data-i18n="oauth.grok.importing">${t('oauth.grok.importing')}</span>
                    </div>
                    <div class="progress-bar" style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="grokImportProgressBar" style="height: 100%; width: 0%; background: #10b981; transition: width 0.3s;"></div>
                    </div>
                </div>
                <div class="batch-import-result" id="grokBatchResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary batch-import-submit" id="grokBatchSubmit">
                    <i class="fas fa-upload"></i>
                    <span data-i18n="oauth.grok.startImport">${t('oauth.grok.startImport')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const textarea = modal.querySelector('#batchGrokTokens');
    const statsDiv = modal.querySelector('#grokBatchStats');
    const tokenCountValue = modal.querySelector('#grokTokenCountValue');
    const progressDiv = modal.querySelector('#grokBatchProgress');
    const progressBar = modal.querySelector('#grokImportProgressBar');
    const resultDiv = modal.querySelector('#grokBatchResult');
    const submitBtn = modal.querySelector('#grokBatchSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    
    // 自动检测输入
    textarea.addEventListener('input', () => {
        const content = textarea.value.trim();
        if (!content) {
            statsDiv.style.display = 'none';
            return;
        }
        
        let tokens = [];
        try {
            // 尝试解析为 JSON
            const parsed = JSON.parse(content);
            tokens = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            // 解析失败，按行分割
            tokens = content.split('\n').map(t => t.trim()).filter(t => t.length > 0);
        }
        
        tokenCountValue.textContent = tokens.length;
        statsDiv.style.display = 'block';
    });
    
    // 关闭
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => modal.remove());
    });
    
    // 提交
    submitBtn.onclick = async () => {
        const content = textarea.value.trim();
        if (!content) {
            showToast(t('common.error'), t('oauth.grok.noTokens'), 'error');
            return;
        }
        
        let tokens = [];
        try {
            const parsed = JSON.parse(content);
            tokens = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
            tokens = content.split('\n').map(t => t.trim()).filter(t => t.length > 0);
        }
        
        if (tokens.length === 0) {
            showToast(t('common.warning'), t('oauth.grok.noTokens'), 'warning');
            return;
        }
        
        // 开始导入
        textarea.disabled = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        progressDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        progressBar.style.width = '0%';
        
        // 创建实时结果显示区域
        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #10b981;"></i>
                <strong id="grokBatchProgressText">${t('oauth.grok.importingProgress', { current: 0, total: tokens.length })}</strong>
            </div>
            <div id="grokBatchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;
        
        const progressText = resultDiv.querySelector('#grokBatchProgressText');
        const resultsList = resultDiv.querySelector('#grokBatchResultsList');
        
        let importSuccess = false;

        try {
            const response = await fetch('/api/grok/batch-import-tokens', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ tokens })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                let eventType = '';
                let eventData = '';
                
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();
                        
                        if (eventType && eventData) {
                            try {
                                const data = JSON.parse(eventData);
                                
                                if (eventType === 'progress') {
                                    const { index, total, current } = data;
                                    const percentage = Math.round((index / total) * 100);
                                    progressBar.style.width = `${percentage}%`;
                                    progressText.textContent = t('oauth.grok.importingProgress', { current: index, total: total });
                                    
                                    const resultItem = document.createElement('div');
                                    resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                    if (current.success) {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>`;
                                        importSuccess = true;
                                    } else if (current.error === 'duplicate') {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.grok.duplicateToken')}</span>
                                            ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                    } else {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                    }
                                    resultsList.appendChild(resultItem);
                                    resultsList.scrollTop = resultsList.scrollHeight;
                                } else if (eventType === 'complete') {
                                    progressBar.style.width = '100%';
                                    progressDiv.style.display = 'none';
                                    
                                    const isAllSuccess = data.failedCount === 0;
                                    const isAllFailed = data.successCount === 0;
                                    let resultClass, resultIcon, resultMessage;
                                    
                                    if (isAllSuccess) {
                                        resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                        resultIcon = 'fa-check-circle';
                                        resultMessage = t('oauth.grok.importSuccess', { count: data.successCount });
                                    } else if (isAllFailed) {
                                        resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                        resultIcon = 'fa-times-circle';
                                        resultMessage = t('oauth.grok.importAllFailed', { count: data.failedCount });
                                    } else {
                                        resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                        resultIcon = 'fa-exclamation-triangle';
                                        resultMessage = t('oauth.grok.importPartial', { success: data.successCount, failed: data.failedCount });
                                    }
                                    
                                    // 移除加载图标并更新文案
                                    const headerWrapper = resultDiv.querySelector('div:first-child');
                                    headerWrapper.innerHTML = `<i class="fas ${resultIcon}" style="color: ${isAllFailed ? '#991b1b' : '#166534'};"></i> <strong>${resultMessage}</strong>`;
                                    
                                    // 刷新页面数据
                                    if (importSuccess) {
                                        setTimeout(() => {
                                            if (window.loadProviders) window.loadProviders();
                                            if (window.refreshProviderConfig) window.refreshProviderConfig(providerType);
                                        }, 1000);
                                    }
                                    
                                    // 恢复按钮
                                    submitBtn.innerHTML = `<i class="fas fa-check"></i> <span>${t('common.confirm')}</span>`;
                                    submitBtn.disabled = false;
                                    submitBtn.onclick = () => modal.remove();
                                    cancelBtn.style.display = 'none';
                                }
                            } catch (e) {
                                console.error('Error parsing SSE data:', e);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Grok Batch Import Error:', error);
            progressText.innerHTML = `<span style="color: #991b1b;">${t('oauth.grok.importError')}: ${error.message}</span>`;
            submitBtn.disabled = false;
            cancelBtn.disabled = false;
        }
    };
}

/**
 * 显示 Kiro OAuth 认证方式选择对话框
 * @param {string} providerType - 提供商类型
 */
function showKiroAuthMethodSelector(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 550px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.kiro.selectMethod">${t('oauth.kiro.selectMethod')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-method-options" style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="auth-method-btn" data-method="api-key" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #10b981; border-radius: 8px; background: #f0fdf4; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-key" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #065f46;" data-i18n="oauth.kiro.apiKey">${t('oauth.kiro.apiKey')}</div>
                            <div style="font-size: 12px; color: #047857;" data-i18n="oauth.kiro.apiKeyDesc">${t('oauth.kiro.apiKeyDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="google" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fab fa-google" style="font-size: 24px; color: #4285f4;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.google">${t('oauth.kiro.google')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.googleDesc">${t('oauth.kiro.googleDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="github" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fab fa-github" style="font-size: 24px; color: #333;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.github">${t('oauth.kiro.github')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.githubDesc">${t('oauth.kiro.githubDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="builder-id" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fab fa-aws" style="font-size: 24px; color: #ff9900;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.awsBuilder">${t('oauth.kiro.awsBuilder')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.awsBuilderDesc">${t('oauth.kiro.awsBuilderDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="aws-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-cloud-upload-alt" style="font-size: 24px; color: #ff9900;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.awsImport">${t('oauth.kiro.awsImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.awsImportDesc">${t('oauth.kiro.awsImportDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="batch-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-import" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.batchImport">${t('oauth.kiro.batchImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.batchImportDesc">${t('oauth.kiro.batchImportDesc')}</div>
                        </div>
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 认证方式选择按钮事件
    const methodBtns = modal.querySelectorAll('.auth-method-btn');
    methodBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            if (btn.dataset.method === 'api-key') {
                btn.style.borderColor = '#059669';
                btn.style.background = '#ecfdf5';
            } else {
                btn.style.borderColor = '#00a67e';
                btn.style.background = '#f8fffe';
            }
        });
        btn.addEventListener('mouseleave', () => {
            if (btn.dataset.method === 'api-key') {
                btn.style.borderColor = '#10b981';
                btn.style.background = '#f0fdf4';
            } else {
                btn.style.borderColor = '#e0e0e0';
                btn.style.background = 'white';
            }
        });
        btn.addEventListener('click', async () => {
            const method = btn.dataset.method;
            modal.remove();
            
            if (method === 'api-key') {
                showKiroApiKeyModal(providerType);
            } else if (method === 'batch-import') {
                showKiroBatchImportModal();
            } else if (method === 'aws-import') {
                showKiroAwsImportModal();
            } else {
                await executeGenerateAuthUrl(providerType, { method });
            }
        });
    });
}

/**
 * 显示 Kiro API Key 直接添加模态框
 * @param {string} providerType - 提供商类型
 */
function showKiroApiKeyModal(providerType = 'claude-kiro-oauth') {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 550px;">
            <div class="modal-header">
                <h3><i class="fas fa-key" style="color: #10b981;"></i> <span data-i18n="oauth.kiro.apiKeyModalTitle">${t('oauth.kiro.apiKeyModalTitle')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="api-key-instructions" style="margin-bottom: 16px; padding: 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;">
                    <p style="margin: 0; font-size: 13px; color: #166534; line-height: 1.5;">
                        <i class="fas fa-shield-alt"></i>
                        <span data-i18n="oauth.kiro.apiKeyModalDesc">${t('oauth.kiro.apiKeyModalDesc')}</span>
                    </p>
                </div>
                <div class="form-group" style="margin-bottom: 16px;">
                    <label for="kiroApiKeyInput" style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.kiro.apiKeyInputLabel">${t('oauth.kiro.apiKeyInputLabel')}</span> <span style="color: #ef4444;">*</span>
                    </label>
                    <input 
                        type="password" 
                        id="kiroApiKeyInput" 
                        class="form-control"
                        style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px;"
                        placeholder="ksk_..."
                    />
                </div>
                <div class="form-group" style="margin-bottom: 16px;">
                    <label for="kiroApiKeyCustomName" style="display: block; margin-bottom: 6px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.kiro.apiKeyCustomNameLabel">${t('oauth.kiro.apiKeyCustomNameLabel')}</span> <span class="optional-tag">${t('config.optional')}</span>
                    </label>
                    <input 
                        type="text" 
                        id="kiroApiKeyCustomName" 
                        class="form-control"
                        style="width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px;"
                        placeholder="${t('oauth.kiro.apiKeyCustomNamePlaceholder')}"
                        data-i18n-placeholder="oauth.kiro.apiKeyCustomNamePlaceholder"
                    />
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary api-key-submit" id="kiroApiKeySubmit">
                    <i class="fas fa-check"></i>
                    <span data-i18n="common.save">${t('common.save')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const apiKeyInput = modal.querySelector('#kiroApiKeyInput');
    const customNameInput = modal.querySelector('#kiroApiKeyCustomName');
    const submitBtn = modal.querySelector('#kiroApiKeySubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    
    [closeBtn, cancelBtn].forEach(btn => btn.addEventListener('click', () => modal.remove()));
    
    submitBtn.onclick = async () => {
        const apiKey = apiKeyInput.value.trim();
        const customName = customNameInput.value.trim();
        
        if (!apiKey) {
            showToast(t('common.warning'), t('oauth.kiro.apiKeyEmptyError'), 'warning');
            apiKeyInput.focus();
            return;
        }
        
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>' + t('common.saving') + '</span>';
        
        try {
            const response = await window.apiClient.post('/providers', {
                providerType: providerType,
                providerConfig: {
                    customName: customName || 'Kiro-API-Key',
                    KIRO_API_KEY: apiKey,
                    isHealthy: true,
                    isDisabled: false,
                    checkHealth: true
                }
            });
            
            if (response.success) {
                showToast(t('common.success'), t('modal.provider.saveSuccess'), 'success');
                modal.remove();
                if (window.loadProviders) await window.loadProviders(true);
            } else {
                throw new Error(response.error?.message || response.message || 'Save failed');
            }
        } catch (error) {
            console.error('Failed to add Kiro API Key node:', error);
            showToast(t('common.error'), t('modal.provider.saveFailed') + ': ' + error.message, 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fas fa-check"></i> <span>' + t('common.save') + '</span>';
        }
    };
}

/**
 * 显示 Gemini OAuth 认证方式选择对话框
 * @param {string} providerType - 提供商类型
 */
function showGeminiAuthMethodSelector(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.gemini.selectMethod">${t('oauth.gemini.selectMethod')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-method-options" style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="auth-method-btn" data-method="oauth" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fab fa-google" style="font-size: 24px; color: #4285f4;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.gemini.oauth">${t('oauth.gemini.oauth')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.gemini.oauthDesc">${t('oauth.gemini.oauthDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="batch-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-import" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.gemini.batchImport">${t('oauth.gemini.batchImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.gemini.batchImportDesc">${t('oauth.gemini.batchImportDesc')}</div>
                        </div>
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 认证方式选择按钮事件
    const methodBtns = modal.querySelectorAll('.auth-method-btn');
    methodBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = '#4285f4';
            btn.style.background = '#f8faff';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = '#e0e0e0';
            btn.style.background = 'white';
        });
        btn.addEventListener('click', async () => {
            const method = btn.dataset.method;
            modal.remove();
            
            if (method === 'batch-import') {
                showGeminiBatchImportModal(providerType);
            } else {
                await executeGenerateAuthUrl(providerType, {});
            }
        });
    });
}

/**
 * 显示 Gemini 批量导入模态框
 * @param {string} providerType - 提供商类型
 */
function showGeminiBatchImportModal(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> <span data-i18n="oauth.gemini.batchImport">${t('oauth.gemini.batchImport')}</span> (${providerType})</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="batch-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #1e40af;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.gemini.importInstructions">${t('oauth.gemini.importInstructions')}</span>
                    </p>
                </div>
                <div class="form-group">
                    <label for="batchGeminiTokens" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.gemini.tokensLabel">${t('oauth.gemini.tokensLabel')}</span>
                    </label>
                    <textarea 
                        id="batchGeminiTokens" 
                        rows="10" 
                        style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                        placeholder='${t('oauth.gemini.tokensPlaceholder')}'
                        data-i18n-placeholder="oauth.gemini.tokensPlaceholder"
                    ></textarea>
                </div>
                <div class="form-group" style="margin-top: 12px; margin-bottom: 16px;">
                    <details style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <summary style="padding: 12px; cursor: pointer; font-weight: 600; color: #374151; user-select: none;">
                            <i class="fas fa-code" style="color: #4285f4; margin-right: 8px;"></i>
                            <span data-i18n="oauth.gemini.jsonExample">${t('oauth.gemini.jsonExample')}</span>
                        </summary>
                        <div style="padding: 12px; background: #1f2937; border-radius: 0 0 8px 8px;">
                            <div style="color: #10b981; font-family: monospace; font-size: 12px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 单个凭据导入示例：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">{
  "access_token": "ya29.a0A...",
  "refresh_token": "1//0...",
  "scope": "https://www.googleapis.com/auth/cloud-platform",
  "token_type": "Bearer",
  "expiry_date": 1738590000000
}</pre>
                            </div>
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-top: 16px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 批量导入示例（JSON数组）：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">[
  {
    "access_token": "ya29.a0A1...",
    "refresh_token": "1//0..."
  },
  {
    "access_token": "ya29.a0A2...",
    "refresh_token": "1//0..."
  }
]</pre>
                            </div>
                        </div>
                    </details>
                </div>
                <div class="batch-import-stats" id="geminiBatchStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="oauth.gemini.tokenCount">${t('oauth.gemini.tokenCount')}</span>
                        <span id="geminiTokenCountValue" style="font-weight: 600;">0</span>
                    </div>
                </div>
                <div class="batch-import-progress" id="geminiBatchProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #4285f4;"></i>
                        <span data-i18n="oauth.gemini.importing">${t('oauth.gemini.importing')}</span>
                    </div>
                    <div class="progress-bar" style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="geminiImportProgressBar" style="height: 100%; width: 0%; background: #4285f4; transition: width 0.3s;"></div>
                    </div>
                </div>
                <div class="batch-import-result" id="geminiBatchResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary batch-import-submit" id="geminiBatchSubmit">
                    <i class="fas fa-upload"></i>
                    <span data-i18n="oauth.gemini.startImport">${t('oauth.gemini.startImport')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const textarea = modal.querySelector('#batchGeminiTokens');
    const statsDiv = modal.querySelector('#geminiBatchStats');
    const tokenCountValue = modal.querySelector('#geminiTokenCountValue');
    const progressDiv = modal.querySelector('#geminiBatchProgress');
    const progressBar = modal.querySelector('#geminiImportProgressBar');
    const resultDiv = modal.querySelector('#geminiBatchResult');
    const submitBtn = modal.querySelector('#geminiBatchSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    
    // 实时统计 token 数量
    textarea.addEventListener('input', () => {
        try {
            const val = textarea.value.trim();
            if (!val) {
                statsDiv.style.display = 'none';
                return;
            }
            const data = JSON.parse(val);
            const tokens = Array.isArray(data) ? data : [data];
            statsDiv.style.display = 'block';
            tokenCountValue.textContent = tokens.length;
        } catch (e) {
            statsDiv.style.display = 'none';
        }
    });
    
    // 关闭按钮事件
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 提交按钮事件
    submitBtn.onclick = async () => {
        let tokens = [];
        try {
            const val = textarea.value.trim();
            const data = JSON.parse(val);
            tokens = Array.isArray(data) ? data : [data];
        } catch (e) {
            showToast(t('common.error'), t('oauth.gemini.noTokens'), 'error');
            return;
        }
        
        if (tokens.length === 0) {
            showToast(t('common.warning'), t('oauth.gemini.noTokens'), 'warning');
            return;
        }
        
        // 禁用输入和按钮
        textarea.disabled = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        progressDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        progressBar.style.width = '0%';
        
        // 创建实时结果显示区域
        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #4285f4;"></i>
                <strong id="geminiBatchProgressText">${t('oauth.gemini.importingProgress', { current: 0, total: tokens.length })}</strong>
            </div>
            <div id="geminiBatchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;
        
        const progressText = resultDiv.querySelector('#geminiBatchProgressText');
        const resultsList = resultDiv.querySelector('#geminiBatchResultsList');
        
        let importSuccess = false; // 标记是否导入成功

        try {
            const response = await fetch('/api/gemini/batch-import-tokens', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ providerType, tokens })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                let eventType = '';
                let eventData = '';
                
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();
                        
                        if (eventType && eventData) {
                            try {
                                const data = JSON.parse(eventData);
                                
                                if (eventType === 'progress') {
                                    const { index, total, current } = data;
                                    const percentage = Math.round((index / total) * 100);
                                    progressBar.style.width = `${percentage}%`;
                                    progressText.textContent = t('oauth.gemini.importingProgress', { current: index, total: total });
                                    
                                    const resultItem = document.createElement('div');
                                    resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                    if (current.success) {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>`;
                                    } else if (current.error === 'duplicate') {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.kiro.duplicateToken')}</span>
                                            ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                    } else {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                    }
                                    resultsList.appendChild(resultItem);
                                    resultsList.scrollTop = resultsList.scrollHeight;
                                } else if (eventType === 'complete') {
                                    progressBar.style.width = '100%';
                                    progressDiv.style.display = 'none';
                                    
                                    const isAllSuccess = data.failedCount === 0;
                                    const isAllFailed = data.successCount === 0;
                                    let resultClass, resultIcon, resultMessage;
                                    
                                    if (isAllSuccess) {
                                        resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                        resultIcon = 'fa-check-circle';
                                        resultMessage = t('oauth.gemini.importSuccess', { count: data.successCount });
                                    } else if (isAllFailed) {
                                        resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                        resultIcon = 'fa-times-circle';
                                        resultMessage = t('oauth.gemini.importAllFailed', { count: data.failedCount });
                                    } else {
                                        resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                        resultIcon = 'fa-exclamation-triangle';
                                        resultMessage = t('oauth.gemini.importPartial', { success: data.successCount, failed: data.failedCount });
                                    }
                                    
                                    // 移除加载图标并更新文案
                                    const headerWrapper = resultDiv.querySelector('div:first-child');
                                    headerWrapper.innerHTML = `<i class="fas ${resultIcon}" style="color: ${isAllFailed ? '#991b1b' : '#166534'};"></i> <strong>${resultMessage}</strong>`;
                                    
                                    if (data.successCount > 0) {
                                        importSuccess = true;
                                        loadProviders();
                                        loadConfigList();
                                    }
                                } else if (eventType === 'error') {
                                    throw new Error(data.error);
                                }
                            } catch (parseError) {
                                console.warn('Failed to parse SSE data:', parseError);
                            }
                            eventType = '';
                            eventData = '';
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Gemini Batch Import] Failed:', error);
            progressDiv.style.display = 'none';
            resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            resultDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.gemini.importError')}: ${error.message}</strong>
                </div>
            `;
        } finally {
            cancelBtn.disabled = false;
            
            if (!importSuccess) {
                textarea.disabled = false;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-upload"></i> <span data-i18n="oauth.gemini.startImport">${t('oauth.gemini.startImport')}</span>`;
            } else {
                submitBtn.innerHTML = `<i class="fas fa-check"></i> <span>${t('common.confirm')}</span>`;
                submitBtn.disabled = false;
                submitBtn.onclick = () => modal.remove();
                cancelBtn.style.display = 'none';
            }
        }
    };
}

/**
 * 显示 Kiro 批量导入 refreshToken 模态框
 */
function showKiroBatchImportModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> <span data-i18n="oauth.kiro.batchImport">${t('oauth.kiro.batchImport')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="batch-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #166534;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.kiro.batchImportInstructions">${t('oauth.kiro.batchImportInstructions')}</span>
                    </p>
                </div>
                <div class="form-group">
                    <label for="batchRefreshTokens" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.kiro.refreshTokensLabel">${t('oauth.kiro.refreshTokensLabel')}</span>
                    </label>
                    <textarea 
                        id="batchRefreshTokens" 
                        rows="10" 
                        style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                        placeholder="${t('oauth.kiro.refreshTokensPlaceholder')}"
                        data-i18n-placeholder="oauth.kiro.refreshTokensPlaceholder"
                    ></textarea>
                </div>
                <div class="batch-import-stats" id="batchImportStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="oauth.kiro.tokenCount">${t('oauth.kiro.tokenCount')}</span>
                        <span id="tokenCountValue" style="font-weight: 600;">0</span>
                    </div>
                </div>
                <div class="batch-import-progress" id="batchImportProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #10b981;"></i>
                        <span data-i18n="oauth.kiro.importing">${t('oauth.kiro.importing')}</span>
                    </div>
                    <div class="progress-bar" style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="importProgressBar" style="height: 100%; width: 0%; background: #10b981; transition: width 0.3s;"></div>
                    </div>
                </div>
                <div class="batch-import-result" id="batchImportResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary batch-import-submit" id="batchImportSubmit">
                    <i class="fas fa-upload"></i>
                    <span data-i18n="oauth.kiro.startImport">${t('oauth.kiro.startImport')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const textarea = modal.querySelector('#batchRefreshTokens');
    const statsDiv = modal.querySelector('#batchImportStats');
    const tokenCountValue = modal.querySelector('#tokenCountValue');
    const progressDiv = modal.querySelector('#batchImportProgress');
    const progressBar = modal.querySelector('#importProgressBar');
    const resultDiv = modal.querySelector('#batchImportResult');
    const submitBtn = modal.querySelector('#batchImportSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    
    // 实时统计 token 数量
    textarea.addEventListener('input', () => {
        const tokens = textarea.value.split('\n').filter(line => line.trim());
        if (tokens.length > 0) {
            statsDiv.style.display = 'block';
            tokenCountValue.textContent = tokens.length;
        } else {
            statsDiv.style.display = 'none';
        }
    });
    
    // 关闭按钮事件
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 提交按钮事件 - 使用 SSE 流式响应实时显示进度
    submitBtn.onclick = async () => {
        const tokens = textarea.value.split('\n').filter(line => line.trim());
        
        if (tokens.length === 0) {
            showToast(t('common.warning'), t('oauth.kiro.noTokens'), 'warning');
            return;
        }
        
        // 禁用输入和按钮
        textarea.disabled = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        progressDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        progressBar.style.width = '0%';
        
        // 创建实时结果显示区域
        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #10b981;"></i>
                <strong id="batchProgressText">${t('oauth.kiro.importingProgress', { current: 0, total: tokens.length })}</strong>
            </div>
            <div id="batchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;
        
        const progressText = resultDiv.querySelector('#batchProgressText');
        const resultsList = resultDiv.querySelector('#batchResultsList');
        
        let successCount = 0;
        let failedCount = 0;
        const details = [];
        let importSuccess = false; // 标记是否导入成功
        
        try {
            // 使用 fetch + SSE 获取流式响应（需要带认证头）
            const response = await fetch('/api/kiro/batch-import-tokens', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ refreshTokens: tokens })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                
                // 解析 SSE 事件
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // 保留最后一个可能不完整的行
                
                let eventType = '';
                let eventData = '';
                
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();
                        
                        if (eventType && eventData) {
                            try {
                                const data = JSON.parse(eventData);
                                
                                if (eventType === 'start') {
                                    // 开始事件
                                    console.log(`[Batch Import] Starting import of ${data.total} tokens`);
                                } else if (eventType === 'progress') {
                                    // 进度更新
                                    const { index, total, current, successCount: sc, failedCount: fc } = data;
                                    successCount = sc;
                                    failedCount = fc;
                                    details.push(current);
                                    
                                    // 更新进度条
                                    const percentage = Math.round((index / total) * 100);
                                    progressBar.style.width = `${percentage}%`;
                                    
                                    // 更新进度文本
                                    progressText.textContent = t('oauth.kiro.importingProgress', { current: index, total: total });
                                    
                                    // 添加结果项
                                    const resultItem = document.createElement('div');
                                    resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                    
                                    if (current.success) {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>`;
                                    } else if (current.error === 'duplicate') {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.kiro.duplicateToken')}</span>
                                            ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                    } else {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                    }
                                    
                                    resultsList.appendChild(resultItem);
                                    // 自动滚动到底部
                                    resultsList.scrollTop = resultsList.scrollHeight;
                                    
                                } else if (eventType === 'complete') {
                                    // 完成事件
                                    progressBar.style.width = '100%';
                                    progressDiv.style.display = 'none';
                                    
                                    const isAllSuccess = data.failedCount === 0;
                                    const isAllFailed = data.successCount === 0;
                                    
                                    let resultClass, resultIcon, resultMessage;
                                    if (isAllSuccess) {
                                        resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                        resultIcon = 'fa-check-circle';
                                        resultMessage = t('oauth.kiro.importSuccess', { count: data.successCount });
                                    } else if (isAllFailed) {
                                        resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                        resultIcon = 'fa-times-circle';
                                        resultMessage = t('oauth.kiro.importAllFailed', { count: data.failedCount });
                                    } else {
                                        resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                        resultIcon = 'fa-exclamation-triangle';
                                        resultMessage = t('oauth.kiro.importPartial', { success: data.successCount, failed: data.failedCount });
                                    }
                                    
                                    // 更新结果区域样式
                                    resultDiv.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                                    
                                    // 更新标题
                                    const headerDiv = resultDiv.querySelector('div:first-child');
                                    headerDiv.innerHTML = `<i class="fas ${resultIcon}"></i> <strong>${resultMessage}</strong>`;
                                    
                                    // 如果有成功的，刷新提供商列表
                                    if (data.successCount > 0) {
                                        importSuccess = true;
                                        loadProviders();
                                        loadConfigList();
                                    }
                                    
                                } else if (eventType === 'error') {
                                    throw new Error(data.error);
                                }
                            } catch (parseError) {
                                console.warn('Failed to parse SSE data:', parseError);
                            }
                            
                            eventType = '';
                            eventData = '';
                        }
                    }
                }
            }
            
        } catch (error) {
            console.error('[Kiro Batch Import] Failed:', error);
            progressDiv.style.display = 'none';
            resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            resultDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.kiro.importError')}: ${error.message}</strong>
                </div>
            `;
        } finally {
            // 重新启用按钮
            cancelBtn.disabled = false;
            if (!importSuccess) {
                textarea.disabled = false;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-upload"></i> <span data-i18n="oauth.kiro.startImport">${t('oauth.kiro.startImport')}</span>`;
            } else {
                submitBtn.innerHTML = `<i class="fas fa-check"></i> <span>${t('common.confirm')}</span>`;
                submitBtn.disabled = false;
                submitBtn.onclick = () => modal.remove();
                cancelBtn.style.display = 'none';
            }
        }
    };
}

/**
 * 显示 Kiro AWS 账号导入模态框
 * 支持从 AWS SSO cache 目录导入凭据文件，或直接粘贴 JSON
 */
function showKiroAwsImportModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 700px;">
            <div class="modal-header">
                <h3><i class="fas fa-cloud-upload-alt" style="color: #ff9900;"></i> <span data-i18n="oauth.kiro.awsImport">${t('oauth.kiro.awsImport')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="aws-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #9a3412;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.kiro.awsImportInstructions">${t('oauth.kiro.awsImportInstructions')}</span>
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 12px; color: #c2410c;">
                        <i class="fas fa-folder-open"></i>
                        <code style="background: #fed7aa; padding: 2px 6px; border-radius: 4px;">C:\\Users\\{username}\\.aws\\sso\\cache</code>
                    </p>
                </div>
                
                <!-- 输入模式切换 -->
                <div class="input-mode-toggle" style="display: flex; gap: 8px; margin-bottom: 16px;">
                    <button class="mode-btn active" data-mode="file" style="flex: 1; padding: 10px 16px; border: 2px solid #ff9900; border-radius: 8px; background: #fff7ed; color: #9a3412; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-upload"></i>
                        <span data-i18n="oauth.kiro.awsModeFile">${t('oauth.kiro.awsModeFile')}</span>
                    </button>
                    <button class="mode-btn" data-mode="json" style="flex: 1; padding: 10px 16px; border: 2px solid #d1d5db; border-radius: 8px; background: white; color: #6b7280; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-code"></i>
                        <span data-i18n="oauth.kiro.awsModeJson">${t('oauth.kiro.awsModeJson')}</span>
                    </button>
                </div>
                
                <!-- 文件上传模式 -->
                <div class="file-mode-section" id="fileModeSection">
                    <div class="form-group" style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                            <span data-i18n="oauth.kiro.awsUploadFiles">${t('oauth.kiro.awsUploadFiles')}</span>
                        </label>
                        <div class="aws-file-upload-area" style="border: 2px dashed #d1d5db; border-radius: 8px; padding: 24px; text-align: center; cursor: pointer; transition: all 0.2s;">
                            <input type="file" id="awsFilesInput" multiple accept=".json" style="display: none;">
                            <i class="fas fa-cloud-upload-alt" style="font-size: 36px; color: #9ca3af; margin-bottom: 8px;"></i>
                            <p style="margin: 0; color: #6b7280;" data-i18n="oauth.kiro.awsDragDrop">${t('oauth.kiro.awsDragDrop')}</p>
                            <p style="margin: 4px 0 0 0; font-size: 12px; color: #9ca3af;" data-i18n="oauth.kiro.awsClickUpload">${t('oauth.kiro.awsClickUpload')}</p>
                        </div>
                        <p style="margin: 8px 0 0 0; font-size: 12px; color: #6b7280;">
                            <i class="fas fa-lightbulb" style="color: #f59e0b;"></i>
                            <span data-i18n="oauth.kiro.awsFileHint">${t('oauth.kiro.awsFileHint')}</span>
                        </p>
                    </div>
                    
                    <div class="aws-files-list" id="awsFilesList" style="display: none; margin-bottom: 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <label style="font-weight: 600; color: #374151;" data-i18n="oauth.kiro.awsSelectedFiles">${t('oauth.kiro.awsSelectedFiles')}</label>
                            <button id="clearFilesBtn" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 4px; transition: all 0.2s;">
                                <i class="fas fa-trash-alt"></i>
                                <span data-i18n="oauth.kiro.awsClearFiles">${t('oauth.kiro.awsClearFiles')}</span>
                            </button>
                        </div>
                        <div id="awsFilesContainer" style="background: #f9fafb; border-radius: 8px; padding: 12px;"></div>
                    </div>
                </div>
                
                <!-- JSON 输入模式 -->
                <div class="json-mode-section" id="jsonModeSection" style="display: none;">
                    <div class="form-group" style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                            <span data-i18n="oauth.kiro.awsJsonInput">${t('oauth.kiro.awsJsonInput')}</span>
                        </label>
                        <textarea 
                            id="awsJsonInput" 
                            rows="12" 
                            style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                            placeholder="${t('oauth.kiro.awsJsonPlaceholderSimple')}"
                            data-i18n-placeholder="oauth.kiro.awsJsonPlaceholderSimple"
                        ></textarea>
                        <p style="margin: 8px 0 0 0; font-size: 12px; color: #6b7280;">
                            <i class="fas fa-lightbulb" style="color: #f59e0b;"></i>
                            <span data-i18n="oauth.kiro.awsJsonHint">${t('oauth.kiro.awsJsonHint')}</span>
                        </p>
                    </div>
                    <details style="margin-bottom: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <summary style="padding: 12px; cursor: pointer; font-weight: 600; color: #374151; user-select: none;">
                            <i class="fas fa-code" style="color: #ff9900; margin-right: 8px;"></i>
                            <span data-i18n="oauth.kiro.awsJsonExample">${t('oauth.kiro.awsJsonExample')}</span>
                        </summary>
                        <div style="padding: 12px; background: #1f2937; border-radius: 0 0 8px 8px;">
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-bottom: 12px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 单个凭据导入示例：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">{
  "clientId": "VYZBSTx3Q7QEq1W3Wn8c5nVzLWVhc3QtMQ",
  "clientSecret": "eyJraWQi...OAMc",
  "expiresAt": "2026-01-09T04:43:18.079944400+00:00",
  "accessToken": "aoaAAAAAGlgghoSqRgQK...2tfhmdNZDA",
  "authMethod": "IdC",
  "provider": "BuilderId",
  "refreshToken": "aorAAAAAGn...uKw+E3",
  "region": "us-east-1"
}</pre>
                            </div>
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-top: 16px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 批量导入示例（JSON数组）：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">[
  {
    "clientId": "VYZBSTx3Q7QEq1W3Wn8c5nVzLWVhc3QtMQ",
    "clientSecret": "eyJraWQi...OAMc",
    "accessToken": "aoaAAAAAGlgghoSqRgQK...2tfhmdNZDA",
    "refreshToken": "aorAAAAAGn...uKw+E3",
    "region": "us-east-1"
  },
  {
    "clientId": "AnotherClientId123",
    "clientSecret": "eyJraWQi...xyz",
    "accessToken": "aoaAAAAAGlgghoSqRgQK...abc",
    "refreshToken": "aorAAAAAGn...def",
    "region": "us-west-2",
    "idcRegion": "us-west-2"
  }
]</pre>
                            </div>
                            <div style="color: #fbbf24; font-size: 11px; margin-top: 12px; padding: 8px; background: rgba(251, 191, 36, 0.1); border-radius: 4px;">
                                <i class="fas fa-info-circle"></i>
                                <strong>注意：</strong>AWS企业用户需要额外添加 <code style="background: rgba(0,0,0,0.3); padding: 2px 4px; border-radius: 2px;">idcRegion</code> 字段
                            </div>
                        </div>
                    </details>
                </div>
                
                <div class="aws-validation-result" id="awsValidationResult" style="display: none; margin-bottom: 16px; padding: 12px; border-radius: 8px;"></div>
                
                <div class="aws-json-preview" id="awsJsonPreview" style="display: none; margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <i class="fas fa-eye"></i>
                        <span data-i18n="oauth.kiro.awsPreviewJson">${t('oauth.kiro.awsPreviewJson')}</span>
                    </label>
                    <pre id="awsJsonContent" style="background: #1f2937; color: #10b981; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all;"></pre>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary aws-import-submit" id="awsImportSubmit" disabled>
                    <i class="fas fa-check"></i>
                    <span data-i18n="oauth.kiro.awsConfirmImport">${t('oauth.kiro.awsConfirmImport')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const fileInput = modal.querySelector('#awsFilesInput');
    const uploadArea = modal.querySelector('.aws-file-upload-area');
    const filesListDiv = modal.querySelector('#awsFilesList');
    const filesContainer = modal.querySelector('#awsFilesContainer');
    const clearFilesBtn = modal.querySelector('#clearFilesBtn');
    const validationResult = modal.querySelector('#awsValidationResult');
    const jsonPreview = modal.querySelector('#awsJsonPreview');
    const jsonContent = modal.querySelector('#awsJsonContent');
    const submitBtn = modal.querySelector('#awsImportSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    const modeBtns = modal.querySelectorAll('.mode-btn');
    const fileModeSection = modal.querySelector('#fileModeSection');
    const jsonModeSection = modal.querySelector('#jsonModeSection');
    const jsonInputTextarea = modal.querySelector('#awsJsonInput');
    
    let uploadedFiles = [];
    let mergedCredentials = null;
    let currentMode = 'file';
    
    // 清空文件按钮事件
    clearFilesBtn.addEventListener('click', () => {
        uploadedFiles = [];
        filesContainer.innerHTML = '';
        filesListDiv.style.display = 'none';
        validationResult.style.display = 'none';
        jsonPreview.style.display = 'none';
        submitBtn.disabled = true;
        mergedCredentials = null;
        // 清空 file input
        fileInput.value = '';
    });
    
    // 清空按钮 hover 效果
    clearFilesBtn.addEventListener('mouseenter', () => {
        clearFilesBtn.style.background = '#fef2f2';
    });
    clearFilesBtn.addEventListener('mouseleave', () => {
        clearFilesBtn.style.background = 'none';
    });
    
    // 模式切换
    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode === currentMode) return;
            
            currentMode = mode;
            
            // 更新按钮样式
            modeBtns.forEach(b => {
                if (b.dataset.mode === mode) {
                    b.style.borderColor = '#ff9900';
                    b.style.background = '#fff7ed';
                    b.style.color = '#9a3412';
                    b.classList.add('active');
                } else {
                    b.style.borderColor = '#d1d5db';
                    b.style.background = 'white';
                    b.style.color = '#6b7280';
                    b.classList.remove('active');
                }
            });
            
            // 切换显示区域
            if (mode === 'file') {
                fileModeSection.style.display = 'block';
                jsonModeSection.style.display = 'none';
                // 重新验证文件模式的内容
                validateAndPreview();
            } else {
                fileModeSection.style.display = 'none';
                jsonModeSection.style.display = 'block';
                // 验证 JSON 输入
                validateJsonInput();
            }
        });
    });
    
    // JSON 输入实时验证
    jsonInputTextarea.addEventListener('input', () => {
        validateJsonInput();
    });
    
    // 验证 JSON 输入
    function validateJsonInput() {
        const inputValue = jsonInputTextarea.value.trim();
        
        if (!inputValue) {
            validationResult.style.display = 'none';
            jsonPreview.style.display = 'none';
            submitBtn.disabled = true;
            mergedCredentials = null;
            return;
        }
        
        try {
            mergedCredentials = JSON.parse(inputValue);
            validateAndShowResult();
        } catch (error) {
            validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            validationResult.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-exclamation-triangle"></i>
                    <strong data-i18n="oauth.kiro.awsJsonParseError">${t('oauth.kiro.awsJsonParseError')}</strong>
                </div>
                <p style="margin: 8px 0 0 0; font-size: 12px;">${error.message}</p>
            `;
            jsonPreview.style.display = 'none';
            submitBtn.disabled = true;
            mergedCredentials = null;
        }
    }
    
    // 文件上传区域交互
    uploadArea.addEventListener('click', () => fileInput.click());
    
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#ff9900';
        uploadArea.style.background = '#fffbeb';
    });
    
    uploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#d1d5db';
        uploadArea.style.background = 'transparent';
    });
    
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#d1d5db';
        uploadArea.style.background = 'transparent';
        
        const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.json'));
        if (files.length > 0) {
            processFiles(files);
        }
    });
    
    fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files);
        if (files.length > 0) {
            processFiles(files);
        }
    });
    
    // 处理上传的文件（支持追加）
    async function processFiles(files) {
        for (const file of files) {
            // 检查是否已存在同名文件
            const existingIndex = uploadedFiles.findIndex(f => f.name === file.name);
            
            try {
                const content = await readFileAsText(file);
                const json = JSON.parse(content);
                
                if (existingIndex >= 0) {
                    // 替换已存在的同名文件
                    uploadedFiles[existingIndex] = {
                        name: file.name,
                        content: json
                    };
                    showToast(t('common.info'), t('oauth.kiro.awsFileReplaced', { filename: file.name }), 'info');
                } else {
                    // 追加新文件
                    uploadedFiles.push({
                        name: file.name,
                        content: json
                    });
                }
            } catch (error) {
                console.error(`Failed to parse ${file.name}:`, error);
                showToast(t('common.error'), t('oauth.kiro.awsParseError', { filename: file.name }), 'error');
            }
        }
        
        // 重新渲染文件列表
        renderFilesList();
        
        filesListDiv.style.display = uploadedFiles.length > 0 ? 'block' : 'none';
        
        // 清空 file input 以便可以再次选择相同文件
        fileInput.value = '';
        
        validateAndPreview();
    }
    
    // 渲染文件列表
    function renderFilesList() {
        filesContainer.innerHTML = '';
        
        for (const file of uploadedFiles) {
            const fileDiv = document.createElement('div');
            fileDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px; background: white; border-radius: 4px; margin-bottom: 4px;';
            fileDiv.dataset.filename = file.name;
            
            const fields = Object.keys(file.content).slice(0, 5).join(', ');
            const moreFields = Object.keys(file.content).length > 5 ? '...' : '';
            
            fileDiv.innerHTML = `
                <div style="flex: 1; min-width: 0;">
                    <i class="fas fa-file-code" style="color: #ff9900; margin-right: 8px;"></i>
                    <span style="font-weight: 500;">${file.name}</span>
                    <div style="font-size: 11px; color: #6b7280; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fields}${moreFields}</div>
                </div>
                <button class="remove-file-btn" data-filename="${file.name}" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 4px 8px; margin-left: 8px; flex-shrink: 0;">
                    <i class="fas fa-times"></i>
                </button>
            `;
            filesContainer.appendChild(fileDiv);
        }
        
        // 添加删除文件按钮事件
        filesContainer.querySelectorAll('.remove-file-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filename = e.currentTarget.dataset.filename;
                uploadedFiles = uploadedFiles.filter(f => f.name !== filename);
                renderFilesList();
                filesListDiv.style.display = uploadedFiles.length > 0 ? 'block' : 'none';
                validateAndPreview();
            });
        });
    }
    
    // 验证并预览（文件模式）
    function validateAndPreview() {
        if (currentMode !== 'file') return;
        
        if (uploadedFiles.length === 0) {
            validationResult.style.display = 'none';
            jsonPreview.style.display = 'none';
            submitBtn.disabled = true;
            mergedCredentials = null;
            return;
        }
        
        // 智能合并所有文件的内容
        // 如果多个文件都有 expiresAt，使用包含 refreshToken 的文件中的 expiresAt
        mergedCredentials = {};
        let expiresAtFromRefreshTokenFile = null;
        
        for (const file of uploadedFiles) {
            // 如果这个文件包含 refreshToken，记录它的 expiresAt
            if (file.content.refreshToken && file.content.expiresAt) {
                expiresAtFromRefreshTokenFile = file.content.expiresAt;
            }
            Object.assign(mergedCredentials, file.content);
        }
        
        // 如果找到了包含 refreshToken 的文件的 expiresAt，使用它
        if (expiresAtFromRefreshTokenFile) {
            mergedCredentials.expiresAt = expiresAtFromRefreshTokenFile;
        }
        
        validateAndShowResult();
    }
    
    // 验证并显示结果（通用）
    function validateAndShowResult() {
        if (!mergedCredentials) {
            validationResult.style.display = 'none';
            jsonPreview.style.display = 'none';
            submitBtn.disabled = true;
            return;
        }
        
        // 检查是否为批量导入（数组）
        const isBatchImport = Array.isArray(mergedCredentials);
        
        if (isBatchImport) {
            // 批量导入模式：验证数组中的每个对象
            let allValid = true;
            const credentialsValidation = mergedCredentials.map((cred, index) => {
                const hasClientId = !!cred.clientId;
                const hasClientSecret = !!cred.clientSecret;
                const hasAccessToken = !!cred.accessToken;
                const hasRefreshToken = !!cred.refreshToken;
                const isValid = hasClientId && hasClientSecret && hasAccessToken && hasRefreshToken;
                
                if (!isValid) allValid = false;
                
                return {
                    index: index + 1,
                    isValid,
                    fields: [
                        { key: 'clientId', has: hasClientId },
                        { key: 'clientSecret', has: hasClientSecret },
                        { key: 'accessToken', has: hasAccessToken },
                        { key: 'refreshToken', has: hasRefreshToken }
                    ]
                };
            });
            
            // 构建批量验证结果HTML
            const credentialsHtml = credentialsValidation.map(cv => {
                const statusIcon = cv.isValid ? '✓' : '✗';
                const statusColor = cv.isValid ? '#166534' : '#991b1b';
                const fieldsHtml = cv.fields.map(f => `
                    <span style="margin-right: 8px;">${f.key}: ${f.has
                        ? `<code style="background: #dcfce7; padding: 1px 4px; border-radius: 2px; color: #166534;">✓</code>`
                        : `<code style="background: #fecaca; padding: 1px 4px; border-radius: 2px; color: #991b1b;">✗</code>`
                    }</span>
                `).join('');
                
                return `
                    <div style="padding: 8px; margin-bottom: 4px; background: ${cv.isValid ? '#f0fdf4' : '#fef2f2'}; border: 1px solid ${cv.isValid ? '#bbf7d0' : '#fecaca'}; border-radius: 4px;">
                        <div style="font-weight: 600; color: ${statusColor}; margin-bottom: 4px;">
                            ${statusIcon} 凭据 ${cv.index}
                        </div>
                        <div style="font-size: 12px; color: #6b7280;">
                            ${fieldsHtml}
                        </div>
                    </div>
                `;
            }).join('');
            
            if (allValid) {
                validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                        <i class="fas fa-check-circle"></i>
                        <strong>批量验证通过 (${mergedCredentials.length} 个凭据)</strong>
                    </div>
                    <div style="max-height: 200px; overflow-y: auto;">
                        ${credentialsHtml}
                    </div>
                `;
                submitBtn.disabled = false;
            } else {
                const validCount = credentialsValidation.filter(cv => cv.isValid).length;
                const invalidCount = credentialsValidation.length - validCount;
                validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>批量验证失败</strong>
                        <span style="font-weight: normal; font-size: 12px;">(${invalidCount} 个凭据缺少必需字段)</span>
                    </div>
                    <div style="max-height: 200px; overflow-y: auto;">
                        ${credentialsHtml}
                    </div>
                    <p style="margin: 12px 0 0 0; font-size: 12px; padding: 8px; background: #fee2e2; border-radius: 4px;">
                        <i class="fas fa-lightbulb" style="color: #dc2626;"></i>
                        请确保每个凭据都包含所有必需字段：clientId, clientSecret, accessToken, refreshToken
                    </p>
                `;
                submitBtn.disabled = true;
            }
            
            // 显示 JSON 预览（批量模式）
            jsonPreview.style.display = 'block';
            const previewData = mergedCredentials.map(cred => {
                const preview = { ...cred };
                if (preview.clientSecret) {
                    preview.clientSecret = preview.clientSecret.substring(0, 8) + '...' + preview.clientSecret.slice(-4);
                }
                if (preview.accessToken) {
                    preview.accessToken = preview.accessToken.substring(0, 20) + '...' + preview.accessToken.slice(-10);
                }
                if (preview.refreshToken) {
                    preview.refreshToken = preview.refreshToken.substring(0, 10) + '...' + preview.refreshToken.slice(-6);
                }
                return preview;
            });
            jsonContent.textContent = JSON.stringify(previewData, null, 2);
            
        } else {
            // 单个导入模式：原有逻辑
            const hasClientId = !!mergedCredentials.clientId;
            const hasClientSecret = !!mergedCredentials.clientSecret;
            const hasAccessToken = !!mergedCredentials.accessToken;
            const hasRefreshToken = !!mergedCredentials.refreshToken;
            
            // 所有四个字段都必须存在
            const isValid = hasClientId && hasClientSecret && hasAccessToken && hasRefreshToken;
            
            // 构建字段状态列表
            const fieldsList = [
                { key: 'clientId', has: hasClientId },
                { key: 'clientSecret', has: hasClientSecret },
                { key: 'accessToken', has: hasAccessToken },
                { key: 'refreshToken', has: hasRefreshToken }
            ];
            
            const fieldsHtml = fieldsList.map(f => `
                <li>${f.key}: ${f.has
                    ? `<code style="background: #dcfce7; padding: 1px 4px; border-radius: 2px; color: #166534;">✓ ${t('common.found')}</code>`
                    : `<code style="background: #fecaca; padding: 1px 4px; border-radius: 2px; color: #991b1b;">✗ ${t('common.missing')}</code>`
                }</li>
            `).join('');
            
            if (isValid) {
                validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-check-circle"></i>
                        <strong data-i18n="oauth.kiro.awsValidationSuccess">${t('oauth.kiro.awsValidationSuccess')}</strong>
                    </div>
                    <ul style="margin: 8px 0 0 24px; font-size: 13px; list-style: none; padding: 0;">
                        ${fieldsHtml}
                    </ul>
                `;
                submitBtn.disabled = false;
            } else {
                const missingCount = fieldsList.filter(f => !f.has).length;
                validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>${t('oauth.kiro.awsValidationFailed')}</strong>
                        <span style="font-weight: normal; font-size: 12px;">(${t('oauth.kiro.awsMissingFields', { count: missingCount })})</span>
                    </div>
                    <ul style="margin: 8px 0 0 24px; font-size: 13px; list-style: none; padding: 0;">
                        ${fieldsHtml}
                    </ul>
                    <p style="margin: 12px 0 0 0; font-size: 12px; padding: 8px; background: #fee2e2; border-radius: 4px;">
                        <i class="fas fa-lightbulb" style="color: #dc2626;"></i>
                        <span data-i18n="oauth.kiro.awsUploadMore">${t('oauth.kiro.awsUploadMore')}</span>
                    </p>
                `;
                submitBtn.disabled = true;
            }
            
            // 显示 JSON 预览（单个模式）
            jsonPreview.style.display = 'block';
            
            // 隐藏敏感信息的部分内容
            const previewData = { ...mergedCredentials };
            if (previewData.clientSecret) {
                previewData.clientSecret = previewData.clientSecret.substring(0, 8) + '...' + previewData.clientSecret.slice(-4);
            }
            if (previewData.accessToken) {
                previewData.accessToken = previewData.accessToken.substring(0, 20) + '...' + previewData.accessToken.slice(-10);
            }
            if (previewData.refreshToken) {
                previewData.refreshToken = previewData.refreshToken.substring(0, 10) + '...' + previewData.refreshToken.slice(-6);
            }
            
            jsonContent.textContent = JSON.stringify(previewData, null, 2);
        }
    }
    
    // 读取文件内容
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    }
    
    // 关闭按钮事件
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 提交按钮事件
    submitBtn.addEventListener('click', async () => {
        if (!mergedCredentials) {
            showToast(t('common.warning'), t('oauth.kiro.awsNoCredentials'), 'warning');
            return;
        }
        
        // 检查是否为批量导入（数组）
        const isBatchImport = Array.isArray(mergedCredentials);
        
        // 禁用按钮和输入
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <span>${t('oauth.kiro.awsImporting')}</span>`;
        
        if (currentMode === 'json') {
            jsonInputTextarea.disabled = true;
        }
        
        let importSuccess = false; // 标记是否导入成功
        
        try {
            if (isBatchImport) {
                // 批量导入模式 - 使用 SSE 流式响应
                // 确保每个凭据都有 authMethod
                const credentialsToImport = mergedCredentials.map(cred => ({
                    ...cred,
                    authMethod: cred.authMethod || 'builder-id'
                }));
                
                // 创建进度显示区域
                validationResult.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <i class="fas fa-spinner fa-spin" style="color: #ff9900;"></i>
                        <strong id="awsBatchProgressText">${t('oauth.kiro.importingProgress', { current: 0, total: credentialsToImport.length })}</strong>
                    </div>
                    <div class="progress-bar" style="margin: 8px 0; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="awsImportProgressBar" style="height: 100%; width: 0%; background: #ff9900; transition: width 0.3s;"></div>
                    </div>
                    <div id="awsBatchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
                `;
                
                const progressText = validationResult.querySelector('#awsBatchProgressText');
                const progressBar = validationResult.querySelector('#awsImportProgressBar');
                const resultsList = validationResult.querySelector('#awsBatchResultsList');
                
                // 使用 fetch + SSE 获取流式响应
                const response = await fetch('/api/kiro/import-aws-credentials', {
                    method: 'POST',
                    headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ credentials: credentialsToImport })
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                
                let successCount = 0;
                let failedCount = 0;
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    
                    // 解析 SSE 事件
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    
                    let eventType = '';
                    let eventData = '';
                    
                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            eventType = line.substring(7).trim();
                        } else if (line.startsWith('data: ')) {
                            eventData = line.substring(6).trim();
                            
                            if (eventType && eventData) {
                                try {
                                    const data = JSON.parse(eventData);
                                    
                                    if (eventType === 'start') {
                                        console.log(`[AWS Batch Import] Starting import of ${data.total} credentials`);
                                    } else if (eventType === 'progress') {
                                        const { index, total, current, successCount: sc, failedCount: fc } = data;
                                        successCount = sc;
                                        failedCount = fc;
                                        
                                        // 更新进度条
                                        const percentage = Math.round((index / total) * 100);
                                        progressBar.style.width = `${percentage}%`;
                                        
                                        // 更新进度文本
                                        progressText.textContent = t('oauth.kiro.importingProgress', { current: index, total: total });
                                        
                                        // 添加结果项
                                        const resultItem = document.createElement('div');
                                        resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                        
                                        if (current.success) {
                                            resultItem.innerHTML = `凭据 ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>`;
                                        } else if (current.error === 'duplicate') {
                                            resultItem.innerHTML = `凭据 ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.kiro.duplicateCredentials')}</span>
                                                ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                        } else {
                                            resultItem.innerHTML = `凭据 ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                        }
                                        
                                        resultsList.appendChild(resultItem);
                                        resultsList.scrollTop = resultsList.scrollHeight;
                                        
                                    } else if (eventType === 'complete') {
                                        progressBar.style.width = '100%';
                                        
                                        const isAllSuccess = data.failedCount === 0;
                                        const isAllFailed = data.successCount === 0;
                                        
                                        let resultClass, resultIcon, resultMessage;
                                        if (isAllSuccess) {
                                            resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                            resultIcon = 'fa-check-circle';
                                            resultMessage = t('oauth.kiro.awsImportSuccess') + ` (${data.successCount})`;
                                        } else if (isAllFailed) {
                                            resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                            resultIcon = 'fa-times-circle';
                                            resultMessage = t('oauth.kiro.awsImportAllFailed', { count: data.failedCount });
                                        } else {
                                            resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                            resultIcon = 'fa-exclamation-triangle';
                                            resultMessage = t('oauth.kiro.importPartial', { success: data.successCount, failed: data.failedCount });
                                        }
                                        
                                        validationResult.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                                        
                                        const headerDiv = validationResult.querySelector('div:first-child');
                                        headerDiv.innerHTML = `<i class="fas ${resultIcon}"></i> <strong>${resultMessage}</strong>`;
                                        
                                        // 如果有成功的，标记为成功并刷新提供商列表
                                        if (data.successCount > 0) {
                                            importSuccess = true;
                                            loadProviders();
                                            loadConfigList();
                                        }
                                        
                                    } else if (eventType === 'error') {
                                        throw new Error(data.error);
                                    }
                                } catch (parseError) {
                                    console.warn('Failed to parse SSE data:', parseError);
                                }
                                
                                eventType = '';
                                eventData = '';
                            }
                        }
                    }
                }
                
            } else {
                // 单个导入模式
                // 确保 authMethod 为 builder-id（AWS 账号模式）
                if (!mergedCredentials.authMethod) {
                    mergedCredentials.authMethod = 'builder-id';
                }
                
                let response;
                try {
                    response = await window.apiClient.post('/kiro/import-aws-credentials', {
                        credentials: mergedCredentials
                    });
                } catch (error) {
                    // 如果是 409 冲突且是重复错误，我们从 error 对象中提取 data，以便后续的重复处理逻辑可以运行
                    if (error.status === 409 && error.data && error.data.error === 'duplicate') {
                        response = error.data;
                    } else {
                        throw error;
                    }
                }
                
                if (response.success) {
                    importSuccess = true;
                    showToast(t('common.success'), t('oauth.kiro.awsImportSuccess'), 'success');
                    modal.remove();
                    
                    // 刷新提供商列表和配置列表
                    loadProviders();
                    loadConfigList();
                } else if (response.error === 'duplicate') {
                    // 显示重复凭据警告
                    const existingPath = response.existingPath || '';
                    showToast(t('common.warning'), t('oauth.kiro.duplicateCredentials') + (existingPath ? ` (${existingPath})` : ''), 'warning');
                } else {
                    showToast(t('common.error'), response.error || t('oauth.kiro.awsImportFailed'), 'error');
                }
            }
        } catch (error) {
            console.error('AWS import failed:', error);
            
            // 更新错误显示
            validationResult.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            validationResult.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.kiro.awsImportFailed')}: ${error.message}</strong>
                </div>
            `;
            
            showToast(t('common.error'), t('oauth.kiro.awsImportFailed') + ': ' + error.message, 'error');
        } finally {
            // 取消按钮始终可用
            cancelBtn.disabled = false;
            
            // 只有在导入失败时才重新启用提交按钮
            if (!importSuccess) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-check"></i> <span data-i18n="oauth.kiro.awsConfirmImport">${t('oauth.kiro.awsConfirmImport')}</span>`;
                
                if (currentMode === 'json') {
                    jsonInputTextarea.disabled = false;
                }
            } else {
                // 导入成功后，保持提交按钮禁用状态，并显示成功图标
                submitBtn.innerHTML = `<i class="fas fa-check-circle"></i> <span>${t('common.success')}</span>`;
            }
        }
    });
}

/**
 * 执行生成授权链接
 * @param {string} providerType - 提供商类型
 * @param {Object} extraOptions - 额外选项
 */
async function executeGenerateAuthUrl(providerType, extraOptions = {}) {
    try {
        showToast(t('common.info'), t('modal.provider.auth.initializing'), 'info');
        
        // 使用 fileUploadHandler 中的 getProviderKey 获取目录名称
        const providerDir = fileUploadHandler.getProviderKey(providerType);

        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/generate-auth-url`,
            {
                saveToConfigs: true,
                providerDir: providerDir,
                ...extraOptions
            }
        );
        
        if (response.success && response.authUrl) {
            // 如果提供了 targetInputId，设置成功监听器
            if (extraOptions.targetInputId) {
                const targetInputId = extraOptions.targetInputId;
                const handleSuccess = (e) => {
                    const data = e.detail;
                    if (data.provider === providerType && data.relativePath) {
                        const input = document.getElementById(targetInputId);
                        if (input) {
                            input.value = data.relativePath;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            showToast(t('common.success'), t('modal.provider.auth.success'), 'success');
                        }
                        window.removeEventListener('oauth_success_event', handleSuccess);
                    }
                };
                window.addEventListener('oauth_success_event', handleSuccess);
            }

            // 显示授权信息模态框
            showAuthModal(response.authUrl, response.authInfo);
        } else {
            showToast(t('common.error'), t('modal.provider.auth.failed'), 'error');
        }
    } catch (error) {
        console.error('生成授权链接失败:', error);
        showToast(t('common.error'), t('modal.provider.auth.failed') + `: ${error.message}`, 'error');
    }
}

/**
 * 获取提供商的授权文件路径
 * @param {string} provider - 提供商类型
 * @returns {string} 授权文件路径
 */
function getAuthFilePath(provider) {
    const authFilePaths = {
        'gemini-cli-oauth': '~/.gemini/oauth_creds.json',
        'gemini-antigravity': '~/.antigravity/oauth_creds.json',
        'openai-qwen-oauth': '~/.qwen/oauth_creds.json',
        'claude-kiro-oauth': '~/.aws/sso/cache/kiro-auth-token.json',
        'openai-iflow': '~/.iflow/oauth_creds.json'
    };
    return authFilePaths[provider] || (getCurrentLanguage() === 'en-US' ? 'Unknown Path' : '未知路径');
}

/**
 * 显示授权信息模态框
 * @param {string} authUrl - 授权URL
 * @param {Object} authInfo - 授权信息
 */
function showAuthModal(authUrl, authInfo) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    // 获取授权文件路径
    const authFilePath = getAuthFilePath(authInfo.provider);
    
    // 获取需要开放的端口号（从 authInfo 或当前页面 URL）
    const requiredPort = authInfo.callbackPort || authInfo.port || window.location.port || '3000';
    const isDeviceFlow = authInfo.provider === 'openai-qwen-oauth' || (authInfo.provider === 'claude-kiro-oauth' && authInfo.authMethod === 'builder-id');

    let instructionsHtml = '';
    if (authInfo.provider === 'openai-qwen-oauth') {
        instructionsHtml = `
            <div class="auth-instructions">
                <h4 data-i18n="oauth.modal.steps">${t('oauth.modal.steps')}</h4>
                <ol>
                    <li data-i18n="oauth.modal.step1">${t('oauth.modal.step1')}</li>
                    <li data-i18n="oauth.modal.step2.qwen">${t('oauth.modal.step2.qwen')}</li>
                    <li data-i18n="oauth.modal.step3">${t('oauth.modal.step3')}</li>
                    <li data-i18n="oauth.modal.step4.qwen" data-i18n-params='{"min":"${Math.floor(authInfo.expiresIn / 60)}"}'>${t('oauth.modal.step4.qwen', { min: Math.floor(authInfo.expiresIn / 60) })}</li>
                </ol>
            </div>
        `;
    } else if (authInfo.provider === 'claude-kiro-oauth') {
        const methodDisplay = authInfo.authMethod === 'builder-id' ? 'AWS Builder ID' : `Social (${authInfo.socialProvider || 'Google'})`;
        const methodAccount = authInfo.authMethod === 'builder-id' ? 'AWS Builder ID' : authInfo.socialProvider || 'Google';
        instructionsHtml = `
            <div class="auth-instructions">
                <h4 data-i18n="oauth.modal.steps">${t('oauth.modal.steps')}</h4>
                <p><strong data-i18n="oauth.kiro.authMethodLabel">${t('oauth.kiro.authMethodLabel')}</strong> ${methodDisplay}</p>
                ${authInfo.authMethod !== 'builder-id' ? `
                <div style="margin-bottom: 12px; padding: 10px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; font-size: 13px; color: #1e40af; line-height: 1.4;">
                    <i class="fas fa-info-circle"></i> <span data-i18n-html="oauth.kiro.manualHint">${t('oauth.kiro.manualHint')}</span>
                </div>
                ` : ''}
                <ol>
                    <li data-i18n="oauth.kiro.step1">${t('oauth.kiro.step1')}</li>
                    <li data-i18n="oauth.kiro.step2" data-i18n-params='{"method":"${methodAccount}"}'>${t('oauth.kiro.step2', { method: methodAccount })}</li>
                    <li data-i18n="oauth.kiro.step3">${t('oauth.kiro.step3')}</li>
                    <li data-i18n="oauth.kiro.step4">${t('oauth.kiro.step4')}</li>
                </ol>
            </div>
        `;
    } else if (authInfo.provider === 'openai-iflow') {
        instructionsHtml = `
            <div class="auth-instructions">
                <h4 data-i18n="oauth.modal.steps">${t('oauth.modal.steps')}</h4>
                <ol>
                    <li data-i18n="oauth.iflow.step1">${t('oauth.iflow.step1')}</li>
                    <li data-i18n="oauth.iflow.step2">${t('oauth.iflow.step2')}</li>
                    <li data-i18n="oauth.iflow.step3">${t('oauth.iflow.step3')}</li>
                    <li data-i18n="oauth.iflow.step4">${t('oauth.iflow.step4')}</li>
                </ol>
            </div>
        `;
    } else {
        instructionsHtml = `
            <div class="auth-instructions">
                <h4 data-i18n="oauth.modal.steps">${t('oauth.modal.steps')}</h4>
                <ol>
                    <li data-i18n="oauth.modal.step1">${t('oauth.modal.step1')}</li>
                    <li data-i18n="oauth.modal.step2.google">${t('oauth.modal.step2.google')}</li>
                    <li data-i18n="oauth.modal.step4.google">${t('oauth.modal.step4.google')}</li>
                    <li data-i18n="oauth.modal.step3">${t('oauth.modal.step3')}</li>
                </ol>
            </div>
        `;
    }
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.modal.title">${t('oauth.modal.title')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-info">
                    <p><strong data-i18n="oauth.modal.provider">${t('oauth.modal.provider')}</strong> ${authInfo.provider}</p>
                    <div class="port-info-section" style="margin: 12px 0; padding: 12px; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; position: relative;">
                        ${(authInfo.provider === 'claude-kiro-oauth' && authInfo.authMethod === 'builder-id') ? `
                        <button class="regenerate-builder-id-btn" title="${t('common.generate')}" style="position: absolute; top: 12px; right: 12px; background: none; border: 1px solid #d97706; border-radius: 4px; cursor: pointer; color: #d97706; padding: 4px 8px;">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                        ` : ''}
                        <div style="margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                            <i class="fas fa-network-wired" style="color: #d97706;"></i>
                            <strong data-i18n="oauth.modal.requiredPort">${t('oauth.modal.requiredPort')}</strong>
                            ${isDeviceFlow ?
                                `<code style="background: #fff; padding: 2px 8px; border-radius: 4px; font-weight: bold; color: #d97706;">${requiredPort}</code>` :
                                `<div style="display: flex; align-items: center; gap: 4px;">
                                    <input type="number" class="auth-port-input" value="${requiredPort}" style="width: 80px; padding: 2px 8px; border: 1px solid #d97706; border-radius: 4px; font-weight: bold; color: #d97706; background: white;">
                                    <button class="regenerate-port-btn" title="${t('common.generate')}" style="background: none; border: 1px solid #d97706; border-radius: 4px; cursor: pointer; color: #d97706; padding: 2px 6px;">
                                        <i class="fas fa-sync-alt"></i>
                                    </button>
                                </div>`
                            }
                        </div>
                        <p style="margin: 8px 0 0 0; font-size: 0.85rem; color: #92400e;" data-i18n="oauth.modal.portNote">${t('oauth.modal.portNote')}</p>
                        ${(authInfo.provider === 'claude-kiro-oauth' && authInfo.authMethod === 'builder-id') ? `
                        <div class="builder-id-url-section" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #fcd34d;">
                            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: #92400e;">
                                <i class="fas fa-link"></i>
                                <span data-i18n="oauth.kiro.builderIDStartURL">${t('oauth.kiro.builderIDStartURL') || 'Builder ID Start URL'}</span>
                                <span style="font-weight: normal; color: #b45309;">(${t('common.optional') || '可选'})</span>
                            </label>
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <input type="text" class="builder-id-start-url-input"
                                    value="${authInfo.builderIDStartURL || 'https://view.awsapps.com/start'}"
                                    placeholder="https://view.awsapps.com/start"
                                    style="flex: 1; padding: 6px 10px; border: 1px solid #fcd34d; border-radius: 4px; font-size: 13px; color: #92400e; background: white;"
                                />
                            </div>
                            <p style="margin: 6px 0 0 0; font-size: 0.75rem; color: #b45309;">
                                <i class="fas fa-info-circle"></i>
                                <span data-i18n="oauth.kiro.builderIDStartURLHint">${t('oauth.kiro.builderIDStartURLHint') || '如果您使用 AWS IAM Identity Center，请输入您的 Start URL'}</span>
                            </p>
                        </div>
                        <div class="builder-id-region-section" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #fcd34d;">
                            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: #92400e;">
                                <i class="fas fa-globe"></i>
                                <span>AWS Region</span>
                            </label>
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <input type="text" class="builder-id-region-input"
                                    value="${authInfo.region || 'us-east-1'}"
                                    placeholder="us-east-1"
                                    style="flex: 1; padding: 6px 10px; border: 1px solid #fcd34d; border-radius: 4px; font-size: 13px; color: #92400e; background: white;"
                                />
                            </div>
                        </div>
                        ` : ''}
                    </div>
                    ${instructionsHtml}
                    <div class="auth-url-section">
                        <label data-i18n="oauth.modal.urlLabel">${t('oauth.modal.urlLabel')}</label>
                        <div class="auth-url-container">
                            <input type="text" readonly value="${authUrl}" class="auth-url-input">
                            <button class="copy-btn" data-i18n="oauth.modal.copyTitle" title="复制链接">
                                <i class="fas fa-copy"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="open-auth-btn">
                    <i class="fas fa-external-link-alt"></i>
                    <span data-i18n="oauth.modal.openInBrowser">${t('oauth.modal.openInBrowser')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 重新生成按钮事件
    const regenerateBtn = modal.querySelector('.regenerate-port-btn');
    if (regenerateBtn) {
        regenerateBtn.onclick = async () => {
            const newPort = modal.querySelector('.auth-port-input').value;
            if (newPort && newPort !== requiredPort) {
                modal.remove();
                // 构造重新请求的参数
                const options = { ...authInfo, port: newPort };
                // 移除不需要传递回后端的字段
                delete options.provider;
                delete options.redirectUri;
                delete options.callbackPort;
                
                await executeGenerateAuthUrl(authInfo.provider, options);
            }
        };
    }

    // Builder ID Start URL 重新生成按钮事件
    const regenerateBuilderIdBtn = modal.querySelector('.regenerate-builder-id-btn');
    if (regenerateBuilderIdBtn) {
        regenerateBuilderIdBtn.onclick = async () => {
            const builderIdStartUrl = modal.querySelector('.builder-id-start-url-input').value.trim();
            const region = modal.querySelector('.builder-id-region-input').value.trim();
            modal.remove();
            // 构造重新请求的参数
            const options = {
                ...authInfo,
                builderIDStartURL: builderIdStartUrl || 'https://view.awsapps.com/start',
                region: region || 'us-east-1'
            };
            // 移除不需要传递回后端的字段
            delete options.provider;
            delete options.redirectUri;
            delete options.callbackPort;
            
            await executeGenerateAuthUrl(authInfo.provider, options);
        };
    }

    // 复制链接按钮
    const copyBtn = modal.querySelector('.copy-btn');
    copyBtn.addEventListener('click', () => {
        const input = modal.querySelector('.auth-url-input');
        input.select();
        document.execCommand('copy');
        showToast(t('common.success'), t('oauth.success.msg'), 'success');
    });
    
    // 在浏览器中打开按钮
    const openBtn = modal.querySelector('.open-auth-btn');
    openBtn.addEventListener('click', () => {
        // Kiro Google/GitHub 授权使用新标签页打开，并提示开启 F12
        const isKiroSocial = authInfo.provider === 'claude-kiro-oauth' && authInfo.authMethod === 'social';
        let authWindow;

        if (isKiroSocial) {
            authWindow = window.open(authUrl, '_blank');
            showToast(t('common.info'), '已在新标签页打开授权，建议按 F12 开启开发者工具以查看过程日志', 'info');
        } else {
            // 使用子窗口打开，以便监听 URL 变化
            const width = 600;
            const height = 700;
            const left = (window.screen.width - width) / 2 + 600;
            const top = (window.screen.height - height) / 2;
            
            authWindow = window.open(
                authUrl,
                'OAuthAuthWindow',
                `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`
            );
        }

        let pollTimer = null;
        const cleanupAuthListeners = () => {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            window.removeEventListener('oauth_success_event', handleOAuthSuccess);
            window.removeEventListener('message', handlePopupMessage);
        };

        // 监听 OAuth 成功事件，自动关闭窗口和模态框
        const handleOAuthSuccess = () => {
            if (authWindow && !authWindow.closed) {
                authWindow.close();
            }
            modal.remove();
            cleanupAuthListeners();
            
            // 授权成功后刷新配置和提供商列表
            loadProviders();
            loadConfigList();
        };

        // 回调页主动 postMessage 时，优先使用父页面关闭子窗口
        const handlePopupMessage = (event) => {
            if (event.origin !== window.location.origin) {
                return;
            }

            const data = event.data;
            if (!data || data.type !== 'oauth-popup-complete') {
                return;
            }

            if (data.provider && data.provider !== authInfo.provider) {
                return;
            }

            handleOAuthSuccess();
        };

        window.addEventListener('oauth_success_event', handleOAuthSuccess);
        window.addEventListener('message', handlePopupMessage);
        
        if (authWindow) {
            showToast(t('common.info'), t('oauth.window.opened'), 'info');
            
            // 添加手动输入回调 URL 的 UI
            const urlSection = modal.querySelector('.auth-url-section');
            if (urlSection && !modal.querySelector('.manual-callback-section')) {
            const manualInputHtml = `
                <div class="manual-callback-section" style="margin-top: 20px; padding: 15px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px;">
                    <h4 style="color: #92400e; margin-bottom: 8px;"><i class="fas fa-exclamation-circle"></i> <span data-i18n="oauth.manual.title">${t('oauth.manual.title')}</span></h4>
                    <p style="font-size: 0.875rem; color: #b45309; margin-bottom: 10px;" data-i18n-html="oauth.manual.desc">${t('oauth.manual.desc')}</p>
                    <div class="auth-url-container" style="display: flex; gap: 5px;">
                        <input type="text" class="manual-callback-input" data-i18n="oauth.manual.placeholder" placeholder="粘贴回调 URL (包含 code=...) 或 kiro:// 链接" style="flex: 1; padding: 8px; border: 1px solid #fcd34d; border-radius: 4px; background: white; color: black;">
                        <button class="btn btn-success apply-callback-btn" style="padding: 8px 15px; white-space: nowrap; background: #059669; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            <i class="fas fa-check"></i> <span data-i18n="oauth.manual.submit">${t('oauth.manual.submit')}</span>
                        </button>
                    </div>
                </div>
            `;
            urlSection.insertAdjacentHTML('afterend', manualInputHtml);
            }

            const manualInput = modal.querySelector('.manual-callback-input');
            const applyBtn = modal.querySelector('.apply-callback-btn');

            // 处理回调 URL 的核心逻辑
            const processCallback = (urlStr, isManualInput = false) => {
                try {
                    // 尝试清理 URL（允许 kiro:// 协议）
                    let cleanUrlStr = urlStr.trim();

                    // 如果只输入了 code (没有 :// 且不包含 ?)，尝试自动补全为包含 code 和 state (sessionId) 的完整 callback URL
                    if (isManualInput && !cleanUrlStr.includes('://') && !cleanUrlStr.includes('?')) {
                        let state = authInfo.sessionId || '';
                        if (!state && authUrl) {
                            try {
                                const parsedAuthUrl = new URL(authUrl);
                                state = parsedAuthUrl.searchParams.get('state') || '';
                            } catch (e) {}
                        }
                        const baseUrl = authInfo.redirectUri || `http://127.0.0.1:${authInfo.port || 56121}/callback`;
                        cleanUrlStr = `${baseUrl}?code=${cleanUrlStr}${state ? '&state=' + state : ''}`;
                        console.log('Detected code only input, auto-completing callback URL:', cleanUrlStr);
                    }

                    const match = cleanUrlStr.match(/(https?|kiro):\/\/[^\s]+/);
                    if (match) {
                        cleanUrlStr = match[0];
                    }
                    
                    // 替换 kiro://kiro.kiroAgent 为本地 HTTP 地址
                    if (cleanUrlStr.startsWith('kiro://kiro.kiroAgent')) {
                        const localPort = authInfo.port || 19876;
                        cleanUrlStr = cleanUrlStr.replace('kiro://kiro.kiroAgent', `http://localhost:${localPort}`);
                        console.log('Detected Kiro deep link, converted to local HTTP:', cleanUrlStr);
                    }

                    const url = new URL(cleanUrlStr);
                    
                    if (url.searchParams.has('code') || url.searchParams.has('token')) {
                        if (pollTimer) {
                            clearInterval(pollTimer);
                            pollTimer = null;
                        }
                        // 构造本地可处理的 URL，只修改 hostname，保持原始 URL 的端口号不变
                        const localUrl = new URL(url.href);
                        localUrl.hostname = window.location.hostname;
                        localUrl.protocol = window.location.protocol;
                        
                        showToast(t('common.info'), t('oauth.processing'), 'info');
                        
                        // 如果是手动输入，直接通过 fetch 请求处理，然后关闭子窗口
                        if (isManualInput) {
                            // 通过服务端API处理手动输入的回调URL
                            window.apiClient.post('/oauth/manual-callback', {
                                provider: authInfo.provider,
                                callbackUrl: url.href, //使用localhost访问
                                authMethod: authInfo.authMethod
                            })
                                .then(response => {
                                    if (response.success) {
                                        console.log('OAuth 回调处理成功');
                                        handleOAuthSuccess();
                                        showToast(t('common.success'), t('oauth.success.msg'), 'success');
                                    } else {
                                        console.error('OAuth 回调处理失败:', response.error);
                                        showToast(t('common.error'), response.error || t('oauth.error.process'), 'error');
                                    }
                                })
                                .catch(err => {
                                    console.error('OAuth 回调请求失败:', err);
                                    showToast(t('common.error'), t('oauth.error.process'), 'error');
                                });
                        } else {
                            // 自动监听模式：优先在子窗口中跳转（如果没关）
                            if (authWindow && !authWindow.closed) {
                                authWindow.location.href = localUrl.href;
                            } else {
                                // 备选方案：通过 fetch 请求
                                // 通过 fetch 请求本地服务器处理回调
                                fetch(localUrl.href)
                                    .then(response => {
                                        if (response.ok) {
                                            console.log('OAuth 回调处理成功');
                                        } else {
                                            console.error('OAuth 回调处理失败:', response.status);
                                        }
                                    })
                                    .catch(err => {
                                        console.error('OAuth 回调请求失败:', err);
                                    });
                            }
                        }
                        
                    } else {
                        showToast(t('common.warning'), t('oauth.invalid.url'), 'warning');
                    }
                } catch (err) {
                    console.error('处理回调失败:', err);
                    showToast(t('common.error'), t('oauth.error.format'), 'error');
                }
            };

            applyBtn.addEventListener('click', () => {
                processCallback(manualInput.value, true);
            });

            // 启动定时器轮询子窗口 URL
            pollTimer = setInterval(() => {
                try {
                    if (authWindow.closed) {
                        cleanupAuthListeners();
                        return;
                    }
                    // 如果能读到说明回到了同域
                    const currentUrl = authWindow.location.href;
                    if (currentUrl && (currentUrl.includes('code=') || currentUrl.includes('token='))) {
                        processCallback(currentUrl);
                    }
                } catch (e) {
                    // 跨域受限是正常的
                }
            }, 1000);
        } else {
            showToast(t('common.error'), t('oauth.window.blocked'), 'error');
        }
    });
    
}

/**
 * 显示需要重启的提示模态框
 * @param {string} version - 更新到的版本号
 */
function showRestartRequiredModal(version) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay restart-required-modal';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content restart-modal-content" style="max-width: 420px;">
            <div class="modal-header restart-modal-header">
                <h3><i class="fas fa-check-circle" style="color: #10b981;"></i> <span data-i18n="dashboard.update.restartTitle">${t('dashboard.update.restartTitle')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body" style="text-align: center; padding: 20px;">
                <p style="font-size: 1rem; color: #374151; margin: 0;" data-i18n="dashboard.update.restartMsg" data-i18n-params='{"version":"${version}"}'>${t('dashboard.update.restartMsg', { version })}</p>
            </div>
            <div class="modal-footer">
                <button class="btn restart-confirm-btn">
                    <i class="fas fa-check"></i>
                    <span data-i18n="common.confirm">${t('common.confirm')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const confirmBtn = modal.querySelector('.restart-confirm-btn');
    
    const closeModal = () => {
        modal.remove();
    };
    
    closeBtn.addEventListener('click', closeModal);
    confirmBtn.addEventListener('click', closeModal);
    
    // 点击遮罩层关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });
}

/**
 * 比较两个版本号
 * @param {string} v1 - 版本号1
 * @param {string} v2 - 版本号2
 * @returns {number} 1: v1 > v2, -1: v1 < v2, 0: v1 == v2
 */
function compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    const s1 = v1.replace(/^v/, '').split('.');
    const s2 = v2.replace(/^v/, '').split('.');
    for (let i = 0; i < Math.max(s1.length, s2.length); i++) {
        const n1 = parseInt(s1[i] || 0, 10);
        const n2 = parseInt(s2[i] || 0, 10);
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}

/**
 * 根据所选版本更新更新按钮文字
 * @param {string} selectedVersion - 所选版本
 * @param {string} localVersion - 本地版本
 */
function updateUpdateBtnText(selectedVersion, localVersion) {
    const updateBtn = document.getElementById('performUpdateBtn');
    if (!updateBtn || !selectedVersion || !localVersion) return;
    
    const span = updateBtn.querySelector('span');
    if (!span) return;
    
    if (compareVersions(selectedVersion, localVersion) < 0) {
        span.textContent = t('dashboard.update.downgrade');
    } else {
        span.textContent = t('dashboard.update.perform');
    }
}

/**
 * 检查更新
 * @param {boolean} silent - 是否静默检查（不显示 Toast）
 */
async function checkUpdate(silent = false) {
    const checkBtn = document.getElementById('checkUpdateBtn');
    const updateBtn = document.getElementById('performUpdateBtn');
    const updateBadge = document.getElementById('updateBadge');
    const latestVersionText = document.getElementById('latestVersionText');
    const versionSelectWrapper = document.getElementById('versionSelectWrapper');
    const versionSelect = document.getElementById('versionSelect');
    const checkBtnIcon = checkBtn?.querySelector('i');
    const checkBtnText = checkBtn?.querySelector('span');

    try {
        if (!silent && checkBtn) {
            checkBtn.disabled = true;
            if (checkBtnIcon) checkBtnIcon.className = 'fas fa-spinner fa-spin';
            if (checkBtnText) checkBtnText.textContent = t('dashboard.update.checking');
        }

        const data = await window.apiClient.get('/check-update');

        // 处理版本列表
        if (versionSelect && data.availableVersions && data.availableVersions.length > 0) {
            versionSelect.innerHTML = '';
            data.availableVersions.forEach(version => {
                const option = document.createElement('option');
                option.value = version;
                option.textContent = version;
                // 如果是最新版本，增加标识
                if (version === data.latestVersion) {
                    option.textContent += ` (${t('dashboard.update.latest') || 'Latest'})`;
                }
                // 如果是当前版本，增加标识
                if (version === data.localVersion || version === `v${data.localVersion}`) {
                    option.textContent += ` (${t('dashboard.update.current') || 'Current'})`;
                    option.selected = true;
                }
                versionSelect.appendChild(option);
            });
            
            if (versionSelectWrapper) versionSelectWrapper.style.display = 'block';
            
            // 更新本地版本数据集，确保监听器能拿到最新值
            if (versionSelect) {
                versionSelect.dataset.localVersion = data.localVersion;
            }

            if (updateBtn) {
                updateBtn.style.display = 'inline-flex';
                // 初始化按钮文字
                updateUpdateBtnText(versionSelect.value, data.localVersion);
            }
            
            // 绑定版本切换事件
            if (versionSelect && !versionSelect.dataset.listenerAdded) {
                versionSelect.addEventListener('change', () => {
                    updateUpdateBtnText(versionSelect.value, versionSelect.dataset.localVersion);
                });
                versionSelect.dataset.listenerAdded = 'true';
            }
        }

        if (data.hasUpdate) {
            if (updateBadge) updateBadge.style.display = 'inline-flex';
            if (latestVersionText) latestVersionText.textContent = data.latestVersion;
            
            // 如果有新版本且未选择特定版本，默认选中最新
            if (versionSelect && data.latestVersion) {
                versionSelect.value = data.latestVersion;
                updateUpdateBtnText(versionSelect.value, data.localVersion);
            }

            if (!silent) {
                showToast(t('common.info'), t('dashboard.update.hasUpdate', { version: data.latestVersion }), 'info');
            }
        } else {
            if (updateBadge) updateBadge.style.display = 'none';
            if (!silent) {
                showToast(t('common.info'), t('dashboard.update.upToDate'), 'success');
            }
        }
    } catch (error) {
        console.error('Check update failed:', error);
        if (!silent) {
            showToast(t('common.error'), t('dashboard.update.failed', { error: error.message }), 'error');
        }
    } finally {
        if (checkBtn) {
            checkBtn.disabled = false;
            if (checkBtnIcon) checkBtnIcon.className = 'fas fa-sync-alt';
            if (checkBtnText) checkBtnText.textContent = t('dashboard.update.check');
        }
    }
}

/**
 * 执行更新
 */
async function performUpdate() {
    const updateBtn = document.getElementById('performUpdateBtn');
    const versionSelect = document.getElementById('versionSelect');
    const selectedVersion = versionSelect?.value || '';

    if (!confirm(t('dashboard.update.confirmMsg', { version: selectedVersion }))) {
        return;
    }

    const updateBtnIcon = updateBtn?.querySelector('i');
    const updateBtnText = updateBtn?.querySelector('span');

    try {
        if (updateBtn) {
            updateBtn.disabled = true;
            if (updateBtnIcon) updateBtnIcon.className = 'fas fa-spinner fa-spin';
            if (updateBtnText) updateBtnText.textContent = t('dashboard.update.updating');
        }

        showToast(t('common.info'), t('dashboard.update.updating'), 'info');

        const data = await window.apiClient.post('/update', { version: selectedVersion });

        if (data.success) {
            if (data.updated) {
                // 代码已更新，直接调用重启服务
                showToast(t('common.success'), t('dashboard.update.success'), 'success');
                
                // 自动重启服务
                await restartServiceAfterUpdate();
            } else {
                // 已是目标版本
                showToast(t('common.info'), data.message || t('dashboard.update.upToDate'), 'info');
            }
        }
    } catch (error) {
        console.error('Update failed:', error);
        showToast(t('common.error'), t('dashboard.update.failed', { error: error.message }), 'error');
    } finally {
        if (updateBtn) {
            updateBtn.disabled = false;
            if (updateBtnIcon) updateBtnIcon.className = 'fas fa-download';
            updateUpdateBtnText(versionSelect.value, versionSelect.dataset.localVersion);
        }
    }
}

/**
 * 更新后自动重启服务
 */
async function restartServiceAfterUpdate() {
    try {
        showToast(t('common.info'), t('header.restart.requesting'), 'info');
        
        const token = localStorage.getItem('authToken');
        const response = await fetch('/api/restart-service', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : ''
            }
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            showToast(t('common.success'), result.message || t('header.restart.success'), 'success');
            
            // 如果是 worker 模式，服务会自动重启，等待几秒后刷新页面
            if (result.mode === 'worker') {
                setTimeout(() => {
                    showToast(t('common.info'), t('header.restart.reconnecting'), 'info');
                    // 等待服务重启后刷新页面
                    setTimeout(() => {
                        window.location.reload();
                    }, 3000);
                }, 2000);
            }
        } else {
            // 显示错误信息
            const errorMsg = result.message || result.error?.message || t('header.restart.failed');
            showToast(t('common.error'), errorMsg, 'error');
            
            // 如果是独立模式，显示提示
            if (result.mode === 'standalone') {
                showToast(t('common.info'), result.hint, 'warning');
            }
        }
    } catch (error) {
        console.error('Restart after update failed:', error);
        showToast(t('common.error'), t('header.restart.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 显示添加提供商组模态框
 * @param {string} defaultBaseType - 默认的基础类型
 */
function showAddProviderGroupModal(defaultBaseType = null) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.style.zIndex = '2000';
    
    // 获取所有基础母版配置，并过滤掉当前已经存在的“自定义组”
    // 确保下拉菜单只显示纯净的基础类型（如 openai-custom），而不显示已有的带后缀组
    const allBaseConfigs = getBaseProviderConfigs();
    const baseTypes = allBaseConfigs.filter(config => {
        // 1. 必须在后端支持的列表中
        const isSupported = cachedSupportedProviders.includes(config.id);
        
        // 2. 限制只能添加特定类型的配置组 (Claude Custom, OpenAI Custom, OpenAI Responses)
        const allowedTypes = ['claude-custom', 'openai-custom', 'openaiResponses-custom', 'atlascloud', 'qiniu', 'fenno'];
        const isAllowed = allowedTypes.includes(config.id);
        
        return isSupported && isAllowed;
    });

    let optionsHtml = baseTypes.map(type => {
        const selected = (defaultBaseType && type.id === defaultBaseType) ? 'selected' : '';
        return `<option value="${type.id}" ${selected}>${type.name}</option>`;
    }).join('');

    const selectedConfig = allBaseConfigs.find(c => c.id === defaultBaseType);
    const baseTypeSectionHtml = defaultBaseType ? `
        <div class="form-group" style="margin-bottom: 15px;">
            <label style="display: block; margin-bottom: 5px; font-weight: 600;" data-i18n="providers.addGroup.baseType">${t('providers.addGroup.baseType')}</label>
            <div style="padding: 10px 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; display: flex; align-items: center; gap: 8px;">
                <i class="fas ${selectedConfig?.icon || 'fa-robot'}" style="color: #6b7280;"></i>
                <span style="font-weight: 500; color: #374151;">${selectedConfig?.name || defaultBaseType}</span>
            </div>
            <input type="hidden" id="groupBaseType" value="${defaultBaseType}">
        </div>
    ` : `
        <div class="form-group" style="margin-bottom: 15px;">
            <label style="display: block; margin-bottom: 5px; font-weight: 600;" data-i18n="providers.addGroup.baseType">${t('providers.addGroup.baseType')}</label>
            <select id="groupBaseType" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
                ${optionsHtml}
            </select>
        </div>
    `;

    modal.innerHTML = `
        <div class="modal-content" style="max-width: 450px;">
            <div class="modal-header">
                <h3><i class="fas fa-folder-plus"></i> <span data-i18n="providers.addGroup.title">${t('providers.addGroup.title')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                ${baseTypeSectionHtml}
                <div class="form-group">
                    <label style="display: block; margin-bottom: 5px; font-weight: 600;" data-i18n="providers.addGroup.suffix">${t('providers.addGroup.suffix')}</label>
                    <input type="text" id="groupSuffix" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" 
                           placeholder="${t('providers.addGroup.suffixPlaceholder')}" data-i18n-placeholder="providers.addGroup.suffixPlaceholder">
                    <small style="color: #666; font-size: 12px; margin-top: 5px; display: block;">
                        示例: ${selectedConfig?.id || 'openai-custom'} + prod -> ${selectedConfig?.id || 'openai-custom'}-prod
                    </small>
                </div>
            </div>
            <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                <button class="btn btn-secondary modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary modal-submit">
                    <i class="fas fa-check"></i> <span data-i18n="common.confirm">${t('common.confirm')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    const submitBtn = modal.querySelector('.modal-submit');
    const suffixInput = modal.querySelector('#groupSuffix');
    const baseTypeSelect = modal.querySelector('#groupBaseType');

    const closeModal = () => modal.remove();
    
    [closeBtn, cancelBtn].forEach(btn => btn.addEventListener('click', closeModal));
    
    submitBtn.addEventListener('click', async () => {
        const baseType = baseTypeSelect.value;
        const suffix = suffixInput.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        
        if (!suffix) {
            showToast(t('common.warning'), t('common.invalidSuffix'), 'warning');
            return;
        }
        
        const newProviderType = `${baseType}-${suffix}`;
        
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        
        try {
            // 创建一个带后缀的新提供商组，并添加一个初始的空配置（或者让用户在随后的模态框中添加）
            // 这里我们先创建一个临时的空配置，这样组就会在 dashboard 中显示出来
            const response = await window.apiClient.post('/providers', {
                providerType: newProviderType,
                providerConfig: {
                    customName: suffix.toUpperCase(),
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 0,
                    errorCount: 0
                }
            });
            
            if (response.success) {
                showToast(t('common.success'), t('providers.addGroup.success'), 'success');
                closeModal();
                // 重新加载提供商列表，强制刷新支持的类型
                await loadProviders(true);
                // 自动打开新创建的组的管理界面
                setTimeout(() => openProviderManager(newProviderType), 500);
            } else {
                throw new Error(response.error?.message || 'Unknown error');
            }
        } catch (error) {
            console.error('Failed to add provider group:', error);
            showToast(t('common.error'), t('providers.addGroup.error') + ': ' + error.message, 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fas fa-check"></i> <span>${t('common.confirm')}</span>`;
        }
    });
}

export {
    loadSystemInfo,
    updateTimeDisplay,
    loadProviders,
    loadProvidersPageData,
    openProviderManager,
    showAuthModal,
    executeGenerateAuthUrl,
    handleGenerateAuthUrl,
    checkUpdate,
    performUpdate,
    showAddProviderGroupModal
};
