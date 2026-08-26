// 配置管理模块

import { showToast, formatUptime, copyToClipboard, bindOnce } from './utils.js';
import { handleProviderChange, handleGeminiCredsTypeChange, handleKiroCredsTypeChange } from './event-handlers.js';
import { t } from './i18n.js';
import { loadSectionIfActive } from './navigation.js';

// 提供商配置缓存
let currentProviderConfigs = null;
let lastLoadedConfigData = null;
let isCurrentPasswordDefault = false;

function getSelectedModelProviders() {
    const modelProviderEl = document.getElementById('modelProvider');
    if (!modelProviderEl) {
        return [];
    }

    return Array.from(modelProviderEl.querySelectorAll('.provider-tag.selected')).map(tag => ({
        id: tag.getAttribute('data-value'),
        name: tag.querySelector('span')?.textContent?.trim() || tag.getAttribute('data-value') || ''
    }));
}

function maskApiKey(value) {
    if (!value) {
        return t('config.handoff.keyMissing');
    }

    if (value.length <= 8) {
        return t('config.handoff.keyReadyShort', { key: value });
    }

    return t('config.handoff.keyReady', {
        prefix: value.slice(0, 4),
        suffix: value.slice(-4)
    });
}

function updateConfigHandoffSummary() {
    const apiKeyValue = document.getElementById('apiKey')?.value?.trim() || '';
    const selectedProviders = getSelectedModelProviders();
    const keyStatusEl = document.getElementById('configHandoffKeyStatus');
    const providersEl = document.getElementById('configHandoffProviders');
    const passwordStatusEl = document.getElementById('configHandoffPasswordStatus');

    if (keyStatusEl) {
        keyStatusEl.textContent = maskApiKey(apiKeyValue);
    }

    if (providersEl) {
        providersEl.textContent = selectedProviders.length > 0
            ? selectedProviders.map(provider => provider.name).join(' / ')
            : t('config.handoff.providersMissing');
    }

    if (passwordStatusEl) {
        if (isCurrentPasswordDefault) {
            passwordStatusEl.textContent = t('config.handoff.passwordDefault');
            passwordStatusEl.style.color = 'var(--danger-color)';
        } else {
            passwordStatusEl.textContent = t('config.handoff.passwordSafe');
            passwordStatusEl.style.color = 'var(--success-color)';
        }
    }
}

function navigateToSection(sectionId) {
    const navItem = document.querySelector(`.nav-item[data-section="${sectionId}"]`);
    if (navItem) {
        navItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return;
    }

    window.location.hash = `#${sectionId}`;
}

function showChangePasswordModal() {
    // 移除已存在的模态框
    const existingModal = document.querySelector('.handoff-password-modal');
    if (existingModal) {
        existingModal.remove();
    }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay handoff-password-modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 450px;">
            <div class="modal-header">
                <h3>
                    <i class="fas fa-key"></i>
                    <span data-i18n="config.handoff.changePasswordTitle">${t('config.handoff.changePasswordTitle') || '修改后台登录密码'}</span>
                </h3>
                <button class="modal-close" type="button" aria-label="${t('common.close') || '关闭'}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body" style="padding: 1.5rem;">
                <form id="handoffPasswordForm" onsubmit="return false;">
                    <div class="form-group" style="margin-bottom: 1.25rem;">
                        <label for="handoffNewPassword" style="display: block; margin-bottom: 0.5rem; font-weight: 600; font-size: 0.9rem;" data-i18n="config.advanced.adminPassword">${t('config.advanced.adminPassword') || '新密码'}</label>
                        <div class="password-input-wrapper" style="position: relative; display: flex; align-items: center;">
                            <input type="password" id="handoffNewPassword" class="form-control" style="width: 100%; padding-right: 2.5rem;" autocomplete="new-password" required>
                            <button type="button" class="password-toggle" data-target="handoffNewPassword" style="position: absolute; right: 0.75rem; background: none; border: none; cursor: pointer; color: var(--text-secondary);">
                                <i class="fas fa-eye"></i>
                            </button>
                        </div>
                    </div>
                    <div class="form-group" style="margin-bottom: 1rem;">
                        <label for="handoffConfirmPassword" style="display: block; margin-bottom: 0.5rem; font-weight: 600; font-size: 0.9rem;" data-i18n="config.handoff.confirmPassword">${t('config.handoff.confirmPassword') || '确认新密码'}</label>
                        <div class="password-input-wrapper" style="position: relative; display: flex; align-items: center;">
                            <input type="password" id="handoffConfirmPassword" class="form-control" style="width: 100%; padding-right: 2.5rem;" autocomplete="new-password" required>
                            <button type="button" class="password-toggle" data-target="handoffConfirmPassword" style="position: absolute; right: 0.75rem; background: none; border: none; cursor: pointer; color: var(--text-secondary);">
                                <i class="fas fa-eye"></i>
                            </button>
                        </div>
                    </div>
                    <small class="form-text" style="color: var(--text-secondary); display: block; margin-bottom: 1rem;" data-i18n="config.handoff.passwordHelpText">
                        <i class="fas fa-info-circle"></i> ${t('config.handoff.passwordHelpText') || '密码长度必须至少为 12 位，且修改后需要重新登录。'}
                    </small>
                </form>
            </div>
            <div class="modal-footer" style="display: flex; gap: 1rem; justify-content: flex-end; padding: 1rem 1.5rem; background: var(--bg-secondary); border-top: 1px solid var(--border-color); border-radius: 0 0 var(--radius-xl) var(--radius-xl);">
                <button type="button" class="btn btn-secondary cancel-btn" data-i18n="common.cancel">${t('common.cancel') || '取消'}</button>
                <button type="button" class="btn btn-danger confirm-btn">
                    <i class="fas fa-save"></i> <span data-i18n="common.confirm">${t('common.confirm') || '确定'}</span>
                </button>
            </div>
        </div>
    `;

    // 绑定密码切换显示/隐藏事件
    modal.querySelectorAll('.password-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = btn.getAttribute('data-target');
            const input = modal.querySelector(`#${targetId}`);
            if (input) {
                const isPassword = input.type === 'password';
                input.type = isPassword ? 'text' : 'password';
                btn.querySelector('i').className = isPassword ? 'fas fa-eye-slash' : 'fas fa-eye';
            }
        });
    });

    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.cancel-btn');
    const confirmBtn = modal.querySelector('.confirm-btn');

    const handleClose = () => {
        modal.remove();
    };

    closeBtn.addEventListener('click', handleClose);
    cancelBtn.addEventListener('click', handleClose);

    confirmBtn.addEventListener('click', async () => {
        const newPasswordEl = modal.querySelector('#handoffNewPassword');
        const confirmPasswordEl = modal.querySelector('#handoffConfirmPassword');
        const newPassword = newPasswordEl.value;
        const confirmPassword = confirmPasswordEl.value;

        if (!newPassword) {
            showToast(t('common.error'), t('common.passwordEmpty') || '密码不能为空', 'error');
            newPasswordEl.focus();
            return;
        }

        if (newPassword.length < 12) {
            showToast(t('common.error'), t('common.passwordTooShort') || '密码长度至少为 12 位', 'error');
            newPasswordEl.focus();
            return;
        }

        if (newPassword !== confirmPassword) {
            showToast(t('common.error'), t('config.handoff.passwordMismatch') || '两次输入的新密码不一致', 'error');
            confirmPasswordEl.focus();
            return;
        }

        try {
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <span data-i18n="config.handoff.saving">${t('config.handoff.saving') || '保存中...'}</span>`;
            
            await window.apiClient.post('/admin-password', { password: newPassword });
            
            showToast(t('common.success'), t('config.handoff.passwordUpdated') || '密码修改成功，即将重新登录...', 'success');
            
            // 延迟退出并重新登录
            setTimeout(() => {
                if (typeof window.logout === 'function') {
                    window.logout();
                } else {
                    localStorage.removeItem('authToken');
                    localStorage.removeItem('authTokenExpiry');
                    window.location.href = '/login.html';
                }
            }, 1500);
        } catch (error) {
            console.error('Failed to change admin password:', error);
            showToast(t('common.error'), t('common.error') + ': ' + error.message, 'error');
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = `<i class="fas fa-save"></i> <span data-i18n="common.confirm">${t('common.confirm') || '确定'}</span>`;
        }
    });

    // ESC键关闭模态框
    const handleEscKey = (event) => {
        if (event.key === 'Escape') {
            handleClose();
            document.removeEventListener('keydown', handleEscKey);
        }
    };
    document.addEventListener('keydown', handleEscKey);

    document.body.appendChild(modal);
}

function initConfigPageHelpers() {
    const apiKeyEl = document.getElementById('apiKey');
    if (apiKeyEl && !apiKeyEl.dataset.handoffBound) {
        const update = () => updateConfigHandoffSummary();
        apiKeyEl.addEventListener('input', update);
        apiKeyEl.addEventListener('change', update);
        apiKeyEl.dataset.handoffBound = 'true';
    }

    const openAccessBtn = document.getElementById('configOpenQuickAccess');
    bindOnce(openAccessBtn, 'click', () => navigateToSection('access'), 'configOpenQuickAccess');

    const saveAndAccessBtn = document.getElementById('configSaveAndAccess');
    bindOnce(saveAndAccessBtn, 'click', async () => {
        await saveConfiguration({ navigateToAccess: true });
    }, 'configSaveAndAccess');

    const changePwdBtn = document.getElementById('configHandoffChangePwdBtn');
    bindOnce(changePwdBtn, 'click', () => showChangePasswordModal(), 'configHandoffChangePwdBtn');
}

/**
 * 更新提供商配置并重新渲染配置页面的提供商选择标签
 * @param {Array} configs - 提供商配置列表
 */
function updateConfigProviderConfigs(configs) {
    currentProviderConfigs = configs;
    
    // 渲染基础设置中的模型提供商选择
    const modelProviderEl = document.getElementById('modelProvider');
    if (modelProviderEl) {
        renderProviderTags(modelProviderEl, configs, true);
        if (lastLoadedConfigData) {
            const providers = Array.isArray(lastLoadedConfigData.DEFAULT_MODEL_PROVIDERS)
                ? lastLoadedConfigData.DEFAULT_MODEL_PROVIDERS
                : (typeof lastLoadedConfigData.MODEL_PROVIDER === 'string' ? lastLoadedConfigData.MODEL_PROVIDER.split(',') : []);
            const tags = Array.from(modelProviderEl.querySelectorAll('.provider-tag'));
            providers.forEach(id => {
                const tag = tags.find(t => t.getAttribute('data-value') === id);
                if (tag) {
                    tag.classList.add('selected');
                    modelProviderEl.appendChild(tag);
                }
            });
            updatePinnedStatus(modelProviderEl);
        }
    }
    
    // 渲染代理设置中的提供商选择
    const proxyProvidersEl = document.getElementById('proxyProviders');
    if (proxyProvidersEl) {
        renderProviderTags(proxyProvidersEl, configs, false);
        if (lastLoadedConfigData) {
            const enabledProviders = lastLoadedConfigData.PROXY_ENABLED_PROVIDERS || [];
            proxyProvidersEl.querySelectorAll('.provider-tag').forEach(tag => {
                if (enabledProviders.includes(tag.getAttribute('data-value'))) {
                    tag.classList.add('selected');
                }
            });
        }
    }

    // 渲染 TLS Sidecar 设置中的提供商选择
    const tlsSidecarProvidersEl = document.getElementById('tlsSidecarProviders');
    if (tlsSidecarProvidersEl) {
        renderProviderTags(tlsSidecarProvidersEl, configs, false);
        if (lastLoadedConfigData) {
            const enabledProviders = lastLoadedConfigData.TLS_SIDECAR_ENABLED_PROVIDERS || [];
            tlsSidecarProvidersEl.querySelectorAll('.provider-tag').forEach(tag => {
                if (enabledProviders.includes(tag.getAttribute('data-value'))) {
                    tag.classList.add('selected');
                }
            });
        }
    }

    // 渲染定时健康检查的提供商选择
    const scheduledHealthCheckProvidersEl = document.getElementById('scheduledHealthCheckProviders');
    if (scheduledHealthCheckProvidersEl) {
        renderProviderTags(scheduledHealthCheckProvidersEl, configs, false);
    }
}

/**
 * 渲染提供商标签按钮
 * @param {HTMLElement} container - 容器元素
 * @param {Array} configs - 提供商配置列表
 * @param {boolean} isRequired - 是否至少需要选择一个（用于点击事件逻辑）
 */
function renderProviderTags(container, configs, isRequired) {
    // 过滤掉不可见的提供商
    const visibleConfigs = configs.filter(c => c.visible !== false);
    
    const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    
    // 如果是预加载模型提供商选择，添加置顶图标
    const isModelProviderSelect = container.id === 'modelProvider';
    
    container.innerHTML = visibleConfigs.map(c => `
        <button type="button" class="provider-tag" data-value="${escHtml(c.id)}">
            <i class="fas ${escHtml(c.icon || 'fa-server')}"></i>
            <span>${escHtml(c.name)}</span>
            ${isModelProviderSelect ? `<span class="tag-pin-icon" title="${t('config.pin') || '设为默认 (置顶)'}"><i class="fas fa-thumbtack"></i></span>` : ''}
        </button>
    `).join('');
    
    // 为新生成的标签添加点击事件
    const tags = container.querySelectorAll('.provider-tag');
    tags.forEach(tag => {
        tag.addEventListener('click', (e) => {
            // 如果点击的是置顶图标
            if (e.target.closest('.tag-pin-icon')) {
                e.preventDefault();
                e.stopPropagation();
                
                // 置顶逻辑：将其移动到容器最前面并设为选中
                tag.classList.add('selected');
                container.prepend(tag);
                
                // 更新视觉样式
                updatePinnedStatus(container);
                if (container.id === 'modelProvider') {
                    updateConfigHandoffSummary();
                }
                return;
            }

            e.preventDefault();
            const isSelected = tag.classList.contains('selected');
            
            if (isRequired) {
                const selectedCount = container.querySelectorAll('.provider-tag.selected').length;
                // 如果当前是选中状态且只剩一个选中的，不允许取消
                if (isSelected && selectedCount === 1) {
                    showToast(t('common.warning'), t('config.modelProviderRequired'), 'warning');
                    return;
                }
            }
            
            // 切换选中状态
            tag.classList.toggle('selected');
            
            // 如果取消选中了当前置顶的，重新计算置顶状态
            if (!tag.classList.contains('selected') && isModelProviderSelect) {
                updatePinnedStatus(container);
            }

            if (container.id === 'modelProvider') {
                updateConfigHandoffSummary();
            }
        });
    });
}

/**
 * 更新置顶状态的视觉表现
 * @param {HTMLElement} container 
 */
function updatePinnedStatus(container) {
    const tags = container.querySelectorAll('.provider-tag');
    tags.forEach((tag, index) => {
        // 第一个被选中的即为“置顶”的默认提供商
        const isFirstSelected = tag.classList.contains('selected') && 
            index === Array.from(tags).findIndex(t => t.classList.contains('selected'));
        
        if (isFirstSelected) {
            tag.classList.add('pinned');
        } else {
            tag.classList.remove('pinned');
        }
    });
}

/**
 * 初始化系统提示词替换规则 UI
 */
function initReplacementsUI() {
    const addBtn = document.getElementById('addReplacementBtn');
    if (addBtn && !addBtn.dataset.listenerAttached) {
        addBtn.addEventListener('click', () => {
            addReplacementRow('', '');
        });
        addBtn.dataset.listenerAttached = 'true';
    }
}

/**
 * 添加一条替换规则行
 * @param {string} oldVal - 查找内容
 * @param {string} newVal - 替换内容
 */
function addReplacementRow(oldVal = '', newVal = '') {
    const container = document.getElementById('systemPromptReplacementsContainer');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'replacement-row';
    row.innerHTML = `
        <input type="text" class="form-control replacement-old" placeholder="${t('config.advanced.replacement.old')}" value="${oldVal}">
        <input type="text" class="form-control replacement-new" placeholder="${t('config.advanced.replacement.new')}" value="${newVal}">
        <button type="button" class="remove-replacement-btn" title="${t('config.advanced.replacement.remove')}">
            <i class="fas fa-trash-alt"></i>
        </button>
    `;

    // 绑定删除按钮事件
    const removeBtn = row.querySelector('.remove-replacement-btn');
    removeBtn.addEventListener('click', () => {
        row.remove();
    });

    container.appendChild(row);
}

/**
 * 加载配置
 */
async function loadConfiguration() {
    try {
        initConfigPageHelpers();

        // 确保提供商配置已加载，因为渲染配置项（如 MODEL_PROVIDER 标签）依赖它
        if (currentProviderConfigs === null && typeof window.loadProviders === 'function') {
            await window.loadProviders();
        }

        const data = await window.apiClient.get('/config');
        lastLoadedConfigData = data;

        // 初始化替换规则 UI
        initReplacementsUI();
        const replacementsContainer = document.getElementById('systemPromptReplacementsContainer');
        if (replacementsContainer) {
            replacementsContainer.innerHTML = '';
            if (data.SYSTEM_PROMPT_REPLACEMENTS && Array.isArray(data.SYSTEM_PROMPT_REPLACEMENTS)) {
                data.SYSTEM_PROMPT_REPLACEMENTS.forEach(r => {
                    addReplacementRow(r.old || '', r.new || '');
                });
            }
        }

        // 基础配置
        const apiKeyEl = document.getElementById('apiKey');
        const hostEl = document.getElementById('host');
        const portEl = document.getElementById('port');
        const modelProviderEl = document.getElementById('modelProvider');
        const systemPromptEl = document.getElementById('systemPrompt');

        if (apiKeyEl) apiKeyEl.value = data.REQUIRED_API_KEY || '';
        if (hostEl) hostEl.value = data.HOST || '127.0.0.1';
        if (portEl) portEl.value = data.SERVER_PORT || 3000;
        
        if (modelProviderEl) {
            // 处理多选 MODEL_PROVIDER
            const providers = Array.isArray(data.DEFAULT_MODEL_PROVIDERS)
                ? data.DEFAULT_MODEL_PROVIDERS
                : (typeof data.MODEL_PROVIDER === 'string' ? data.MODEL_PROVIDER.split(',') : []);
            
            const tags = Array.from(modelProviderEl.querySelectorAll('.provider-tag'));
            
            // 按照 providers 数组的顺序重新排列 DOM 中的标签
            providers.forEach(id => {
                const tag = tags.find(t => t.getAttribute('data-value') === id);
                if (tag) {
                    tag.classList.add('selected');
                    modelProviderEl.appendChild(tag); // 依次移到末尾实现重排
                }
            });
            
            // 处理未选中的标签
            tags.forEach(tag => {
                const value = tag.getAttribute('data-value');
                if (!providers.includes(value)) {
                    tag.classList.remove('selected');
                    modelProviderEl.appendChild(tag); // 移到最后
                }
            });
            
            // 如果没有任何选中的，默认选中第一个（保持兼容性）
            const anySelected = Array.from(modelProviderEl.querySelectorAll('.provider-tag.selected')).length > 0;
            if (!anySelected && tags.length > 0) {
                tags[0].classList.add('selected');
            }
            
            // 更新置顶视觉样式
            updatePinnedStatus(modelProviderEl);
        }
        
        if (systemPromptEl) systemPromptEl.value = data.systemPrompt || '';

        // 高级配置参数
        const systemPromptFilePathEl = document.getElementById('systemPromptFilePath');
        const systemPromptModeEl = document.getElementById('systemPromptMode');
        const promptLogBaseNameEl = document.getElementById('promptLogBaseName');
        const promptLogModeEl = document.getElementById('promptLogMode');
        const requestMaxRetriesEl = document.getElementById('requestMaxRetries');
        const requestBaseDelayEl = document.getElementById('requestBaseDelay');
        const modelFallbackEnabledEl = document.getElementById('modelFallbackEnabled');
        const cronNearMinutesEl = document.getElementById('cronNearMinutes');
        const cronRefreshTokenEl = document.getElementById('cronRefreshToken');
        const loginExpiryEl = document.getElementById('loginExpiry');
        const providerPoolsFilePathEl = document.getElementById('providerPoolsFilePath');

        const maxErrorCountEl = document.getElementById('maxErrorCount');
        const warmupTargetEl = document.getElementById('warmupTarget');
        const refreshConcurrencyPerProviderEl = document.getElementById('refreshConcurrencyPerProvider');
        const providerFallbackChainEl = document.getElementById('providerFallbackChain');
        const modelFallbackMappingEl = document.getElementById('modelFallbackMapping');
        const rateLimitCooldownEnabledEl = document.getElementById('rateLimitCooldownEnabled');
        const rateLimitCooldownMsEl = document.getElementById('rateLimitCooldownMs');

        if (systemPromptFilePathEl) systemPromptFilePathEl.value = data.SYSTEM_PROMPT_FILE_PATH || 'configs/input_system_prompt.txt';
        if (systemPromptModeEl) systemPromptModeEl.value = data.SYSTEM_PROMPT_MODE || 'append';
        if (promptLogBaseNameEl) promptLogBaseNameEl.value = data.PROMPT_LOG_BASE_NAME || 'prompt_log';
        if (promptLogModeEl) promptLogModeEl.value = data.PROMPT_LOG_MODE || 'none';
        if (requestMaxRetriesEl) requestMaxRetriesEl.value = data.REQUEST_MAX_RETRIES || 3;
        if (requestBaseDelayEl) requestBaseDelayEl.value = data.REQUEST_BASE_DELAY || 1000;
        if (modelFallbackEnabledEl) modelFallbackEnabledEl.checked = data.MODEL_FALLBACK_ENABLED !== false;
        
        // 坏凭证切换最大重试次数
        const credentialSwitchMaxRetriesEl = document.getElementById('credentialSwitchMaxRetries');
        if (credentialSwitchMaxRetriesEl) credentialSwitchMaxRetriesEl.value = data.CREDENTIAL_SWITCH_MAX_RETRIES || 5;
        if (rateLimitCooldownEnabledEl) rateLimitCooldownEnabledEl.checked = data.RATE_LIMIT_COOLDOWN_ENABLED || false;
        if (rateLimitCooldownMsEl) rateLimitCooldownMsEl.value = data.RATE_LIMIT_COOLDOWN_MS ?? 30000;
        
        if (cronNearMinutesEl) cronNearMinutesEl.value = data.CRON_NEAR_MINUTES || 1;
        if (cronRefreshTokenEl) cronRefreshTokenEl.checked = data.CRON_REFRESH_TOKEN || false;
        if (loginExpiryEl) loginExpiryEl.value = data.LOGIN_EXPIRY || 3600;
        if (providerPoolsFilePathEl) providerPoolsFilePathEl.value = data.PROVIDER_POOLS_FILE_PATH || '';
        if (maxErrorCountEl) maxErrorCountEl.value = data.MAX_ERROR_COUNT || 10;
        if (warmupTargetEl) warmupTargetEl.value = data.WARMUP_TARGET || 0;
        if (refreshConcurrencyPerProviderEl) refreshConcurrencyPerProviderEl.value = data.REFRESH_CONCURRENCY_PER_PROVIDER || 1;
        
        // 加载 Fallback 链配置
        if (providerFallbackChainEl) {
            if (data.providerFallbackChain && typeof data.providerFallbackChain === 'object') {
                providerFallbackChainEl.value = JSON.stringify(data.providerFallbackChain, null, 2);
            } else {
                providerFallbackChainEl.value = '';
            }
        }

        // 加载 Model Fallback 映射配置
        if (modelFallbackMappingEl) {
            if (data.modelFallbackMapping && typeof data.modelFallbackMapping === 'object') {
                modelFallbackMappingEl.value = JSON.stringify(data.modelFallbackMapping, null, 2);
            } else {
                modelFallbackMappingEl.value = '';
            }
        }
        
        // 加载代理配置
        const proxyUrlEl = document.getElementById('proxyUrl');
        if (proxyUrlEl) proxyUrlEl.value = data.PROXY_URL || '';
        
        // 加载启用代理的提供商 (标签按钮)
        const proxyProvidersEl = document.getElementById('proxyProviders');
        if (proxyProvidersEl) {
            const enabledProviders = data.PROXY_ENABLED_PROVIDERS || [];
            const proxyTags = proxyProvidersEl.querySelectorAll('.provider-tag');
            
            proxyTags.forEach(tag => {
                const value = tag.getAttribute('data-value');
                if (enabledProviders.includes(value)) {
                    tag.classList.add('selected');
                } else {
                    tag.classList.remove('selected');
                }
            });
        }
        
        // 加载日志配置
        const logEnabledEl = document.getElementById('logEnabled');
        const logOutputModeEl = document.getElementById('logOutputMode');
        const logLevelEl = document.getElementById('logLevel');
        const logDirEl = document.getElementById('logDir');
        const logIncludeRequestIdEl = document.getElementById('logIncludeRequestId');
        const logIncludeTimestampEl = document.getElementById('logIncludeTimestamp');
        const logMaxFileSizeEl = document.getElementById('logMaxFileSize');
        const logMaxFilesEl = document.getElementById('logMaxFiles');
        
        if (logEnabledEl) logEnabledEl.checked = data.LOG_ENABLED !== false;
        if (logOutputModeEl) logOutputModeEl.value = data.LOG_OUTPUT_MODE || 'all';
        if (logLevelEl) logLevelEl.value = data.LOG_LEVEL || 'info';
        if (logDirEl) logDirEl.value = data.LOG_DIR || 'logs';
        if (logIncludeRequestIdEl) logIncludeRequestIdEl.checked = data.LOG_INCLUDE_REQUEST_ID !== false;
        if (logIncludeTimestampEl) logIncludeTimestampEl.checked = data.LOG_INCLUDE_TIMESTAMP !== false;
        if (logMaxFileSizeEl) logMaxFileSizeEl.value = data.LOG_MAX_FILE_SIZE || 10485760;
        if (logMaxFilesEl) logMaxFilesEl.value = data.LOG_MAX_FILES || 10;
        
        // TLS Sidecar 配置
        const tlsSidecarEnabledEl = document.getElementById('tlsSidecarEnabled');
        const tlsSidecarPortEl = document.getElementById('tlsSidecarPort');
        const tlsSidecarProxyUrlEl = document.getElementById('tlsSidecarProxyUrl');
        const tlsSidecarProvidersEl = document.getElementById('tlsSidecarProviders');

        if (tlsSidecarEnabledEl) tlsSidecarEnabledEl.checked = data.TLS_SIDECAR_ENABLED || false;
        if (tlsSidecarPortEl) tlsSidecarPortEl.value = data.TLS_SIDECAR_PORT || 9090;
        if (tlsSidecarProxyUrlEl) tlsSidecarProxyUrlEl.value = data.TLS_SIDECAR_PROXY_URL || '';
        
        if (tlsSidecarProvidersEl) {
            const enabledProviders = data.TLS_SIDECAR_ENABLED_PROVIDERS || [];
            const tags = tlsSidecarProvidersEl.querySelectorAll('.provider-tag');
            tags.forEach(tag => {
                const value = tag.getAttribute('data-value');
                if (enabledProviders.includes(value)) {
                    tag.classList.add('selected');
                } else {
                    tag.classList.remove('selected');
                }
            });
        }
        
        // 定时健康检查配置
        const scheduledHealthCheckEnabledEl = document.getElementById('scheduledHealthCheckEnabled');
        const scheduledHealthCheckStartupRunEl = document.getElementById('scheduledHealthCheckStartupRun');
        const scheduledHealthCheckIntervalEl = document.getElementById('scheduledHealthCheckInterval');
        
        if (data.SCHEDULED_HEALTH_CHECK) {
            if (scheduledHealthCheckEnabledEl) scheduledHealthCheckEnabledEl.checked = data.SCHEDULED_HEALTH_CHECK.enabled === true;
            if (scheduledHealthCheckStartupRunEl) scheduledHealthCheckStartupRunEl.checked = data.SCHEDULED_HEALTH_CHECK.startupRun !== false;
            if (scheduledHealthCheckIntervalEl) scheduledHealthCheckIntervalEl.value = data.SCHEDULED_HEALTH_CHECK.interval || 600000;
        } else {
            if (scheduledHealthCheckEnabledEl) scheduledHealthCheckEnabledEl.checked = true;
            if (scheduledHealthCheckStartupRunEl) scheduledHealthCheckStartupRunEl.checked = true;
            if (scheduledHealthCheckIntervalEl) scheduledHealthCheckIntervalEl.value = 600000;
        }
        
        // 加载定时健康检查的供应商选择
        const scheduledHealthCheckProvidersEl = document.getElementById('scheduledHealthCheckProviders');
        if (scheduledHealthCheckProvidersEl) {
            const enabledProviders = data.SCHEDULED_HEALTH_CHECK?.providerTypes || [];
            const tags = scheduledHealthCheckProvidersEl.querySelectorAll('.provider-tag');
            tags.forEach(tag => {
                const value = tag.getAttribute('data-value');
                if (enabledProviders.includes(value)) {
                    tag.classList.add('selected');
                } else {
                    tag.classList.remove('selected');
                }
            });
        }
        
        // 定时健康检查间隔快捷按钮（防止重复绑定）
        const intervalQuickBtns = document.querySelectorAll('#scheduledHealthCheckInterval + .quick-select-btns button');
        intervalQuickBtns.forEach(btn => {
            if (btn.dataset.listenerAttached) return; // 防止重复绑定
            btn.dataset.listenerAttached = 'true';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const value = parseInt(btn.getAttribute('data-value'));
                if (scheduledHealthCheckIntervalEl) {
                    scheduledHealthCheckIntervalEl.value = value;
                }
            });
        });

        isCurrentPasswordDefault = data.isDefaultPassword === true;
        updateConfigHandoffSummary();
        
    } catch (error) {
        console.error('Failed to load configuration:', error);
    }
}

/**
 * 保存配置
 */
async function saveConfiguration(options = {}) {
    const { navigateToAccess: shouldNavigateToAccess = false } = options;
    const modelProviderEl = document.getElementById('modelProvider');
    let selectedProviders = [];
    if (modelProviderEl) {
        // 从标签按钮中获取选中的提供商
        selectedProviders = Array.from(modelProviderEl.querySelectorAll('.provider-tag.selected'))
            .map(tag => tag.getAttribute('data-value'));
    }

    // 校验：必须至少勾选一个
    if (selectedProviders.length === 0) {
        showToast(t('common.error'), t('config.modelProviderRequired'), 'error');
        return;
    }

    const config = {
        REQUIRED_API_KEY: document.getElementById('apiKey')?.value || '',
        HOST: document.getElementById('host')?.value || '127.0.0.1',
        SERVER_PORT: parseInt(document.getElementById('port')?.value || 3000),
        MODEL_PROVIDER: selectedProviders.length > 0 ? selectedProviders.join(',') : 'gemini-cli-oauth',
        systemPrompt: document.getElementById('systemPrompt')?.value || '',
    };

    // 获取后台登录密码（如果有输入）
    const adminPassword = document.getElementById('adminPassword')?.value || '';

    // 保存高级配置参数
    config.SYSTEM_PROMPT_FILE_PATH = document.getElementById('systemPromptFilePath')?.value || 'configs/input_system_prompt.txt';
    config.SYSTEM_PROMPT_MODE = document.getElementById('systemPromptMode')?.value || 'append';
    
    // 收集系统提示词内容替换规则
    const replacements = [];
    const replacementRows = document.querySelectorAll('.replacement-row');
    replacementRows.forEach(row => {
        const oldVal = row.querySelector('.replacement-old')?.value || '';
        const newVal = row.querySelector('.replacement-new')?.value || '';
        if (oldVal) {
            replacements.push({ old: oldVal, new: newVal });
        }
    });
    config.SYSTEM_PROMPT_REPLACEMENTS = replacements;

    config.PROMPT_LOG_BASE_NAME = document.getElementById('promptLogBaseName')?.value || '';
    config.PROMPT_LOG_MODE = document.getElementById('promptLogMode')?.value || '';
    config.REQUEST_MAX_RETRIES = parseInt(document.getElementById('requestMaxRetries')?.value || 3);
    config.REQUEST_BASE_DELAY = parseInt(document.getElementById('requestBaseDelay')?.value || 1000);
    config.MODEL_FALLBACK_ENABLED = document.getElementById('modelFallbackEnabled')?.checked !== false;
    config.CREDENTIAL_SWITCH_MAX_RETRIES = parseInt(document.getElementById('credentialSwitchMaxRetries')?.value || 5);
    config.RATE_LIMIT_COOLDOWN_ENABLED = document.getElementById('rateLimitCooldownEnabled')?.checked || false;
    config.RATE_LIMIT_COOLDOWN_MS = parseInt(document.getElementById('rateLimitCooldownMs')?.value || 30000);
    config.CRON_NEAR_MINUTES = parseInt(document.getElementById('cronNearMinutes')?.value || 1);
    config.CRON_REFRESH_TOKEN = document.getElementById('cronRefreshToken')?.checked || false;
    config.LOGIN_EXPIRY = parseInt(document.getElementById('loginExpiry')?.value || 3600);
    config.PROVIDER_POOLS_FILE_PATH = document.getElementById('providerPoolsFilePath')?.value || '';
    config.MAX_ERROR_COUNT = parseInt(document.getElementById('maxErrorCount')?.value || 10);
    config.WARMUP_TARGET = parseInt(document.getElementById('warmupTarget')?.value || 0);
    config.REFRESH_CONCURRENCY_PER_PROVIDER = parseInt(document.getElementById('refreshConcurrencyPerProvider')?.value || 1);
    
    // 保存 Fallback 链配置
    const fallbackChainValue = document.getElementById('providerFallbackChain')?.value?.trim() || '';
    if (fallbackChainValue) {
        try {
            config.providerFallbackChain = JSON.parse(fallbackChainValue);
        } catch (e) {
            showToast(t('common.error'), t('config.advanced.fallbackChainInvalid') || 'Fallback 链配置格式无效，请输入有效的 JSON', 'error');
            return;
        }
    } else {
        config.providerFallbackChain = {};
    }

    // 保存 Model Fallback 映射配置
    const modelFallbackMappingValue = document.getElementById('modelFallbackMapping')?.value?.trim() || '';
    if (modelFallbackMappingValue) {
        try {
            config.modelFallbackMapping = JSON.parse(modelFallbackMappingValue);
        } catch (e) {
            showToast(t('common.error'), t('config.advanced.modelFallbackMappingInvalid') || 'Model Fallback 映射配置格式无效，请输入有效的 JSON', 'error');
            return;
        }
    } else {
        config.modelFallbackMapping = {};
    }
    
    // 保存代理配置
    config.PROXY_URL = document.getElementById('proxyUrl')?.value?.trim() || null;
    
    // 获取启用代理的提供商列表 (从标签按钮)
    const proxyProvidersEl = document.getElementById('proxyProviders');
    if (proxyProvidersEl) {
        config.PROXY_ENABLED_PROVIDERS = Array.from(proxyProvidersEl.querySelectorAll('.provider-tag.selected'))
            .map(tag => tag.getAttribute('data-value'));
    } else {
        config.PROXY_ENABLED_PROVIDERS = [];
    }
    
    // 保存日志配置
    config.LOG_ENABLED = document.getElementById('logEnabled')?.checked !== false;
    config.LOG_OUTPUT_MODE = document.getElementById('logOutputMode')?.value || 'all';
    config.LOG_LEVEL = document.getElementById('logLevel')?.value || 'info';
    config.LOG_DIR = document.getElementById('logDir')?.value || 'logs';
    config.LOG_INCLUDE_REQUEST_ID = document.getElementById('logIncludeRequestId')?.checked !== false;
    config.LOG_INCLUDE_TIMESTAMP = document.getElementById('logIncludeTimestamp')?.checked !== false;
    config.LOG_MAX_FILE_SIZE = parseInt(document.getElementById('logMaxFileSize')?.value || 10485760);
    config.LOG_MAX_FILES = parseInt(document.getElementById('logMaxFiles')?.value || 10);
    
    // TLS Sidecar 配置
    config.TLS_SIDECAR_ENABLED = document.getElementById('tlsSidecarEnabled')?.checked || false;
    config.TLS_SIDECAR_PORT = parseInt(document.getElementById('tlsSidecarPort')?.value || 9090);
    config.TLS_SIDECAR_PROXY_URL = document.getElementById('tlsSidecarProxyUrl')?.value?.trim() || null;
    
    const tlsSidecarProvidersEl = document.getElementById('tlsSidecarProviders');
    if (tlsSidecarProvidersEl) {
        config.TLS_SIDECAR_ENABLED_PROVIDERS = Array.from(tlsSidecarProvidersEl.querySelectorAll('.provider-tag.selected'))
            .map(tag => tag.getAttribute('data-value'));
    } else {
        config.TLS_SIDECAR_ENABLED_PROVIDERS = [];
    }
    
    // 定时健康检查配置
    const scheduledHealthCheckProvidersEl = document.getElementById('scheduledHealthCheckProviders');
    const scheduledHealthCheckProviderTypes = scheduledHealthCheckProvidersEl
        ? Array.from(scheduledHealthCheckProvidersEl.querySelectorAll('.provider-tag.selected'))
            .map(tag => tag.getAttribute('data-value'))
        : [];
    
    // 验证并规范化 interval 值
    const rawInterval = parseInt(document.getElementById('scheduledHealthCheckInterval')?.value);
    const validatedInterval = isNaN(rawInterval) ? 600000 : Math.max(60000, Math.min(3600000, rawInterval));
    
    config.SCHEDULED_HEALTH_CHECK = {
        enabled: document.getElementById('scheduledHealthCheckEnabled')?.checked !== false,
        startupRun: document.getElementById('scheduledHealthCheckStartupRun')?.checked !== false,
        interval: validatedInterval,
        providerTypes: scheduledHealthCheckProviderTypes
    };

    try {
        await window.apiClient.post('/config', config);
        lastLoadedConfigData = config;
        
        // 如果输入了新密码，单独保存密码
        let passwordUpdated = false;
        if (adminPassword) {
            try {
                await window.apiClient.post('/admin-password', { password: adminPassword });
                // 清空密码输入框
                const adminPasswordEl = document.getElementById('adminPassword');
                if (adminPasswordEl) adminPasswordEl.value = '';
                showToast(t('common.success'), t('common.passwordUpdated') || '密码已更新，即将重新登录...', 'success');
                passwordUpdated = true;
            } catch (pwdError) {
                console.error('Failed to save admin password:', pwdError);
                showToast(t('common.error'), t('common.error') + ': ' + pwdError.message, 'error');
                return; // 终止执行
            }
        }
        
        await window.apiClient.post('/reload-config');
        
        if (passwordUpdated) {
            setTimeout(() => {
                if (typeof window.logout === 'function') {
                    window.logout();
                } else {
                    localStorage.removeItem('authToken');
                    localStorage.removeItem('authTokenExpiry');
                    window.location.href = '/login.html';
                }
            }, 1500);
            return;
        }

        showToast(t('common.success'), t('common.configSaved'), 'success');

        if (window.loadAccessInfo) {
            await window.loadAccessInfo();
        }

        updateConfigHandoffSummary();
        
        // 检查当前是否在提供商池管理页面，如果是则刷新数据
        const refreshedProviders = await loadSectionIfActive('providers');
        if (refreshedProviders) {
            showToast(t('common.success'), t('common.providerPoolRefreshed'), 'success');
        }

        if (shouldNavigateToAccess) {
            navigateToSection('access');
        }
    } catch (error) {
        console.error('Failed to save configuration:', error);
        showToast(t('common.error'), t('common.error') + ': ' + error.message, 'error');
    }
}

/**
 * 自动生成 API 密钥
 */
function generateApiKey() {
    const apiKeyEl = document.getElementById('apiKey');
    if (!apiKeyEl) return;
    
    // 生成 32 位 16 进制随机字符串
    const array = new Uint8Array(16);
    window.crypto.getRandomValues(array);
    const randomKey = 'sk-' + Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    
    apiKeyEl.value = randomKey;
    
    // 使用带回退机制的复制函数
    copyToClipboard(randomKey).then(success => {
        if (success) {
            showToast(t('common.success'), t('config.apiKey.generatedAndCopied') || '已生成并自动复制新的 API 密钥', 'success');
        } else {
            showToast(t('common.success'), t('config.apiKey.generated') || '已生成新的 API 密钥', 'success');
        }
    });
    
    // 触发输入框的 change 事件
    apiKeyEl.dispatchEvent(new Event('input', { bubbles: true }));
    apiKeyEl.dispatchEvent(new Event('change', { bubbles: true }));
    updateConfigHandoffSummary();
}

export {
    loadConfiguration,
    saveConfiguration,
    updateConfigProviderConfigs,
    generateApiKey
};
