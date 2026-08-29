import { getProviderConfigs, copyToClipboard, showToast, escapeHtml } from './utils.js';
import { getAvailableRoutes, copyCurlExample } from './routing-examples.js';
import { t } from './i18n.js';

let latestAccessData = null;
let latestSnippetFormat = 'markdown';

const recommendedModelMap = {
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

function getElement(id) {
    return document.getElementById(id);
}

function normalizeSnippetFormat(format) {
    return ['markdown', 'env', 'json'].includes(format) ? format : 'markdown';
}

function getSelectedSnippetFormat() {
    const activeButton = document.querySelector('.access-format-btn.active');
    return normalizeSnippetFormat(activeButton?.dataset.format || latestSnippetFormat);
}

function setSelectedSnippetFormat(format) {
    latestSnippetFormat = normalizeSnippetFormat(format);
    document.querySelectorAll('.access-format-btn').forEach(button => {
        button.classList.toggle('active', button.dataset.format === latestSnippetFormat);
    });
}

function buildProviderConfigMap(supportedProviders) {
    return new Map(getProviderConfigs(supportedProviders).map(config => [config.id, config]));
}

function resolveRouteInfo(providerId, providerName) {
    const routes = getAvailableRoutes();
    let route = routes.find(item => item.provider === providerId);

    if (!route) {
        const baseRoute = routes.find(item => providerId.startsWith(item.provider + '-'));
        route = {
            provider: providerId,
            name: providerName,
            paths: {
                openai: `/${providerId}/v1/chat/completions`,
                claude: `/${providerId}/v1/messages`
            },
            badge: baseRoute?.badge || '',
            badgeClass: baseRoute?.badgeClass || ''
        };
    }

    return route;
}

function getOriginBaseUrl() {
    return window.location.origin;
}

function getFullEndpoint(path) {
    return `${getOriginBaseUrl()}${path}`;
}

function getClientBaseUrl(path) {
    if (!path) {
        return getOriginBaseUrl();
    }

    const normalizedPath = path
        .replace(/\/v1\/chat\/completions$/, '/v1')
        .replace(/\/v1\/messages$/, '/v1')
        .replace(/\/v1\/responses$/, '/v1');

    return `${getOriginBaseUrl()}${normalizedPath}`;
}

function getConfiguredProviders(providers) {
    return providers.filter(provider => provider.totalNodes > 0);
}

function getVisibleProviders(providers) {
    const configuredOnly = getElement('accessConfiguredOnly')?.checked !== false;
    if (!configuredOnly) {
        return providers;
    }
    return getConfiguredProviders(providers);
}

function getRecommendedModel(providerId) {
    if (recommendedModelMap[providerId]) {
        return recommendedModelMap[providerId];
    }

    const matchedBaseId = Object.keys(recommendedModelMap).find(baseId => providerId.startsWith(baseId + '-'));
    if (matchedBaseId) {
        return recommendedModelMap[matchedBaseId];
    }

    return 'gpt-5.5';
}

function toPrettyJson(value) {
    return JSON.stringify(value, null, 2);
}

function buildMarkdownSnippet(title, entries) {
    return [
        `# ${t(title)}`,
        ...entries.map(([label, value]) => `- ${t(label)}: ${t(value)}`)
    ].join('\n');
}

function buildEnvSnippet(entries) {
    return entries.map(([key, value]) => `${key}=${value}`).join('\n');
}

function renderDefaultProviders(defaultProviders, configMap) {
    const container = getElement('accessDefaultProviders');
    if (!container) {
        return;
    }

    if (!defaultProviders.length) {
        container.innerHTML = `<div class="access-empty">${escapeHtml(t('access.empty.defaultProviders'))}</div>`;
        return;
    }

    container.innerHTML = defaultProviders.map(providerId => {
        const config = configMap.get(providerId);
        const name = config?.name || providerId;
        const icon = config?.icon || 'fa-server';
        return `
            <span class="access-chip">
                <i class="fas ${escapeHtml(icon)}"></i>
                <span>${escapeHtml(name)}</span>
            </span>
        `;
    }).join('');
}

function renderProviderCards(providers, defaultProviders, configMap) {
    const container = getElement('accessProvidersTable');
    if (!container) {
        return;
    }

    if (!providers.length) {
        const configuredOnly = getElement('accessConfiguredOnly')?.checked !== false;
        const emptyText = configuredOnly
            ? t('access.empty.providersConfiguredOnly')
            : t('access.empty.providers');
        container.innerHTML = `<div class="access-empty">${escapeHtml(emptyText)}</div>`;
        return;
    }

    container.innerHTML = providers.map(provider => {
        const config = configMap.get(provider.id);
        const name = config?.name || provider.id;
        const icon = config?.icon || 'fa-server';
        const route = resolveRouteInfo(provider.id, name);
        const openaiPath = `/${provider.id}/v1/chat/completions`;
        const responsesPath = `/${provider.id}/v1/responses`;
        const claudePath = `/${provider.id}/v1/messages`;
        const isDefault = defaultProviders.includes(provider.id);
        const emptyClass = provider.totalNodes === 0 ? 'empty' : '';
        const emptyBadge = provider.totalNodes === 0
            ? `<span class="access-badge empty"><i class="fas fa-circle-exclamation"></i>${escapeHtml(t('access.badges.empty'))}</span>`
            : '';
        const defaultBadge = isDefault
            ? `<span class="access-badge default"><i class="fas fa-thumbtack"></i>${escapeHtml(t('access.badges.default'))}</span>`
            : '';
        const routeBadge = route.badge 
            ? `<span class="access-badge ${route.badgeClass}">${escapeHtml(t(route.badge))}</span>` 
            : '';

        return `
            <article class="access-provider-card ${emptyClass}">
                <div class="access-provider-head">
                    <div class="access-provider-name">
                        <i class="fas ${escapeHtml(icon)}"></i>
                        <div>
                            <h4>${escapeHtml(name)}</h4>
                            <div class="access-provider-id">${escapeHtml(provider.id)}</div>
                        </div>
                    </div>
                    <div class="access-provider-badges">
                        ${routeBadge}
                        ${defaultBadge}
                        ${emptyBadge}
                    </div>
                </div>
                <div class="access-provider-stats">
                    <div class="access-provider-stat">
                        <span>${escapeHtml(t('access.providers.totalNodes'))}</span>
                        <strong>${provider.totalNodes}</strong>
                    </div>
                    <div class="access-provider-stat">
                        <span>${escapeHtml(t('access.providers.healthyNodes'))}</span>
                        <strong>${provider.healthyNodes}</strong>
                    </div>
                    <div class="access-provider-stat">
                        <span>${escapeHtml(t('access.providers.disabledNodes'))}</span>
                        <strong>${provider.disabledNodes}</strong>
                    </div>
                </div>
                <div class="access-endpoints">
                    <div class="access-endpoint-row">
                        <strong>${escapeHtml(t('access.providers.openaiEndpoint'))}</strong>
                        <code>${escapeHtml(openaiPath ? getFullEndpoint(openaiPath) : t('access.empty.endpoint'))}</code>
                        <div class="access-endpoint-actions">
                            <button type="button" class="btn btn-secondary btn-sm access-copy-btn" 
                                    data-i18n-title="access.actions.copyEndpoint"
                                    title="${escapeHtml(t('access.actions.copyEndpoint'))}"
                                    data-copy="${escapeHtml(openaiPath ? getFullEndpoint(openaiPath) : '')}">
                                <i class="fas fa-copy"></i>
                            </button>
                            <button type="button" class="btn btn-outline btn-sm access-curl-btn" 
                                    data-i18n-title="access.actions.copyCurl"
                                    title="${escapeHtml(t('access.actions.copyCurl'))}"
                                    data-provider="${provider.id}"
                                    data-protocol="openai">
                                <i class="fas fa-terminal"></i>
                            </button>
                        </div>
                    </div>
                    <div class="access-endpoint-row">
                        <strong>${escapeHtml(t('access.providers.responsesEndpoint'))}</strong>
                        <code>${escapeHtml(getFullEndpoint(responsesPath))}</code>
                        <div class="access-endpoint-actions">
                            <button type="button" class="btn btn-secondary btn-sm access-copy-btn"
                                    data-i18n-title="access.actions.copyEndpoint"
                                    title="${escapeHtml(t('access.actions.copyEndpoint'))}"
                                    data-copy="${escapeHtml(getFullEndpoint(responsesPath))}">
                                <i class="fas fa-copy"></i>
                            </button>
                            <button type="button" class="btn btn-outline btn-sm access-curl-btn"
                                    data-i18n-title="access.actions.copyCurl"
                                    title="${escapeHtml(t('access.actions.copyCurl'))}"
                                    data-provider="${provider.id}"
                                    data-protocol="responses">
                                <i class="fas fa-terminal"></i>
                            </button>
                        </div>
                    </div>
                    <div class="access-endpoint-row">
                        <strong>${escapeHtml(t('access.providers.claudeEndpoint'))}</strong>
                        <code>${escapeHtml(claudePath ? getFullEndpoint(claudePath) : t('access.empty.endpoint'))}</code>
                        <div class="access-endpoint-actions">
                            <button type="button" class="btn btn-secondary btn-sm access-copy-btn" 
                                    data-i18n-title="access.actions.copyEndpoint"
                                    title="${escapeHtml(t('access.actions.copyEndpoint'))}"
                                    data-copy="${escapeHtml(claudePath ? getFullEndpoint(claudePath) : '')}">
                                <i class="fas fa-copy"></i>
                            </button>
                            <button type="button" class="btn btn-outline btn-sm access-curl-btn" 
                                    data-i18n-title="access.actions.copyCurl"
                                    title="${escapeHtml(t('access.actions.copyCurl'))}"
                                    data-provider="${provider.id}"
                                    data-protocol="claude">
                                <i class="fas fa-terminal"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </article>
        `;
    }).join('');
}

function updateStats(data) {
    const providerGroupsCount = data.providers.length;
    const totalNodesCount = data.providers.reduce((sum, provider) => sum + provider.totalNodes, 0);

    const keyStatus = data.hasApiKey
        ? t('access.stats.keyReady')
        : t('access.stats.keyMissing');

    if (getElement('accessApiKeyStatus')) getElement('accessApiKeyStatus').textContent = keyStatus;
    if (getElement('accessDefaultProvidersCount')) getElement('accessDefaultProvidersCount').textContent = data.defaultProviders.length;
    if (getElement('accessProviderGroupsCount')) getElement('accessProviderGroupsCount').textContent = providerGroupsCount;
    if (getElement('accessTotalNodesCount')) getElement('accessTotalNodesCount').textContent = totalNodesCount;
}

function updateFields(data) {
    const apiKeyField = getElement('accessApiKeyField');
    const baseUrlField = getElement('accessBaseUrlField');

    if (apiKeyField) {
        apiKeyField.value = data.apiKey || '';
        apiKeyField.placeholder = t('access.empty.key');
    }

    if (baseUrlField) {
        baseUrlField.value = getOriginBaseUrl();
    }
}

function renderSnippetProviderOptions(data, configMap) {
    const select = getElement('accessSnippetProvider');
    if (!select) {
        return;
    }

    const preferredProviders = getConfiguredProviders(data.providers);
    const fallbackProviders = data.providers;
    const optionsSource = preferredProviders.length > 0 ? preferredProviders : fallbackProviders;
    const currentValue = select.value;
    const preferredSelected = optionsSource.find(provider => provider.id === currentValue)
        ? currentValue
        : (data.defaultProviders.find(id => optionsSource.some(provider => provider.id === id)) || optionsSource[0]?.id || '');

    select.innerHTML = optionsSource.map(provider => {
        const config = configMap.get(provider.id);
        const name = config?.name || provider.id;
        return `<option value="${escapeHtml(provider.id)}">${escapeHtml(name)} (${escapeHtml(provider.id)})</option>`;
    }).join('');

    if (preferredSelected) {
        select.value = preferredSelected;
    }
}

function buildCherryStudioSnippet(providerName, baseUrl, apiKey, model, format) {
    const resolvedApiKey = apiKey || 'YOUR_API_KEY';

    if (format === 'json') {
        return toPrettyJson({
            client: 'Cherry Studio',
            providerType: 'OpenAI Compatible',
            name: `AIClient2API (${providerName})`,
            baseUrl,
            apiKey: resolvedApiKey,
            model
        });
    }

    if (format === 'env') {
        return buildEnvSnippet([
            ['CHERRY_STUDIO_PROVIDER_TYPE', 'OpenAI Compatible'],
            ['CHERRY_STUDIO_NAME', `AIClient2API (${providerName})`],
            ['CHERRY_STUDIO_BASE_URL', baseUrl],
            ['CHERRY_STUDIO_API_KEY', resolvedApiKey],
            ['CHERRY_STUDIO_MODEL', model]
        ]);
    }

    return buildMarkdownSnippet('Cherry Studio', [
        ['access.snippets.field.provider', 'access.snippets.field.protocol'],
        ['access.snippets.field.name', `AIClient2API (${providerName})`],
        ['access.snippets.field.baseUrl', baseUrl],
        ['access.snippets.field.apiKey', resolvedApiKey],
        ['access.snippets.field.model', model]
    ]);
}

function buildNextChatSnippet(baseUrl, apiKey, model, format) {
    const resolvedApiKey = apiKey || 'YOUR_API_KEY';

    if (format === 'json') {
        return toPrettyJson({
            client: 'NextChat',
            openAIApiKey: resolvedApiKey,
            openAIBaseUrl: baseUrl,
            customModels: model,
            defaultModel: model
        });
    }

    if (format === 'env') {
        return buildEnvSnippet([
            ['NEXTCHAT_OPENAI_API_KEY', resolvedApiKey],
            ['NEXTCHAT_OPENAI_BASE_URL', baseUrl],
            ['NEXTCHAT_CUSTOM_MODELS', model],
            ['NEXTCHAT_DEFAULT_MODEL', model]
        ]);
    }

    return buildMarkdownSnippet('NextChat', [
        ['access.snippets.field.apiKey', resolvedApiKey],
        ['access.snippets.field.baseUrl', baseUrl],
        ['access.snippets.field.customModels', model],
        ['access.snippets.field.defaultModel', model]
    ]);
}

function buildClineSnippet(providerName, baseUrl, apiKey, model, format) {
    const resolvedApiKey = apiKey || 'YOUR_API_KEY';

    if (format === 'json') {
        return toPrettyJson({
            client: 'Cline',
            apiProvider: 'OpenAI Compatible',
            profileName: `AIClient2API (${providerName})`,
            baseUrl,
            apiKey: resolvedApiKey,
            modelId: model
        });
    }

    if (format === 'env') {
        return buildEnvSnippet([
            ['CLINE_API_PROVIDER', 'OpenAI Compatible'],
            ['CLINE_PROFILE_NAME', `AIClient2API (${providerName})`],
            ['CLINE_BASE_URL', baseUrl],
            ['CLINE_API_KEY', resolvedApiKey],
            ['CLINE_MODEL_ID', model]
        ]);
    }

    return buildMarkdownSnippet('Cline', [
        ['access.snippets.field.provider', 'access.snippets.field.protocol'],
        ['access.snippets.field.profileName', `AIClient2API (${providerName})`],
        ['access.snippets.field.baseUrl', baseUrl],
        ['access.snippets.field.apiKey', resolvedApiKey],
        ['access.snippets.field.modelId', model]
    ]);
}

function renderClientSnippets(data, configMap) {
    const select = getElement('accessSnippetProvider');
    const cherryNode = getElement('accessCherrySnippet');
    const nextChatNode = getElement('accessNextChatSnippet');
    const clineNode = getElement('accessClineSnippet');

    if (!select || !cherryNode || !nextChatNode || !clineNode) {
        return;
    }

    const providerId = select.value;
    const format = getSelectedSnippetFormat();
    const provider = data.providers.find(item => item.id === providerId) || data.providers[0];
    if (!provider) {
        cherryNode.textContent = t('access.empty.providers');
        nextChatNode.textContent = t('access.empty.providers');
        clineNode.textContent = t('access.empty.providers');
        return;
    }

    const config = configMap.get(provider.id);
    const providerName = config?.name || provider.id;
    const route = resolveRouteInfo(provider.id, providerName);
    const baseUrl = getClientBaseUrl(route.paths?.openai || route.paths?.claude);
    const model = getRecommendedModel(provider.id);
    const apiKey = data.apiKey || '';

    cherryNode.textContent = buildCherryStudioSnippet(providerName, baseUrl, apiKey, model, format);
    nextChatNode.textContent = buildNextChatSnippet(baseUrl, apiKey, model, format);
    clineNode.textContent = buildClineSnippet(providerName, baseUrl, apiKey, model, format);
}

async function copyFromButton(button) {
    const value = button.getAttribute('data-copy') || '';
    if (!value) {
        showToast(t('common.error'), t('access.copy.missing'), 'error');
        return;
    }

    const copied = await copyToClipboard(value);
    if (copied) {
        showToast(t('common.success'), t('common.copy.success'), 'success');
    } else {
        showToast(t('common.error'), t('common.copy.failed'), 'error');
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

function renderAccessPage(data) {
    // 按照 getProviderConfigs 的预设顺序对 providers 进行排序，以保持与系统其他地方（如提供商列表、模型测试）的展示顺序一致
    if (data.providers && data.supportedProviders) {
        const presetConfigs = getProviderConfigs(data.supportedProviders);
        const presetOrder = presetConfigs.map(config => config.id);
        data.providers.sort((a, b) => {
            const indexA = presetOrder.indexOf(a.id);
            const indexB = presetOrder.indexOf(b.id);
            const valA = indexA === -1 ? 999 : indexA;
            const valB = indexB === -1 ? 999 : indexB;
            return valA - valB;
        });
    }

    const configMap = buildProviderConfigMap(data.supportedProviders || []);
    const visibleProviders = getVisibleProviders(data.providers || []);

    setSelectedSnippetFormat(getSelectedSnippetFormat());
    updateStats(data);
    updateFields(data);
    renderDefaultProviders(data.defaultProviders || [], configMap);
    renderSnippetProviderOptions(data, configMap);
    renderClientSnippets(data, configMap);
    renderProviderCards(visibleProviders, data.defaultProviders || [], configMap);
}

export async function loadAccessInfo() {
    const container = getElement('accessProvidersTable');
    if (container) {
        container.innerHTML = `
            <div class="status-loading">
                <i class="fas fa-spinner fa-spin"></i>
                <span>${escapeHtml(t('common.loading'))}</span>
            </div>
        `;
    }

    try {
        latestAccessData = await window.apiClient.get('/access-info');
        renderAccessPage(latestAccessData);
    } catch (error) {
        console.error('Failed to load access info:', error);
        if (container) {
            container.innerHTML = `<div class="access-empty">${escapeHtml(error.message || t('common.error'))}</div>`;
        }
        showToast(t('common.error'), t('access.load.failed', { error: error.message }), 'error');
    }
}

export function initAccessManager() {
    const refreshButton = getElement('refreshAccessInfo');
    if (refreshButton && !refreshButton.dataset.bound) {
        refreshButton.addEventListener('click', () => loadAccessInfo());
        refreshButton.dataset.bound = 'true';
    }

    const toggleButton = getElement('toggleAccessApiKey');
    const apiKeyField = getElement('accessApiKeyField');
    if (toggleButton && apiKeyField && !toggleButton.dataset.bound) {
        toggleButton.addEventListener('click', () => {
            const icon = toggleButton.querySelector('i');
            const isPassword = apiKeyField.type === 'password';
            apiKeyField.type = isPassword ? 'text' : 'password';
            if (icon) {
                icon.className = isPassword ? 'fas fa-eye-slash' : 'fas fa-eye';
            }
        });
        toggleButton.dataset.bound = 'true';
    }

    const copyApiKeyButton = getElement('copyAccessApiKey');
    if (copyApiKeyButton && !copyApiKeyButton.dataset.bound) {
        copyApiKeyButton.addEventListener('click', async () => {
            const value = getElement('accessApiKeyField')?.value || '';
            if (!value) {
                showToast(t('common.error'), t('access.copy.missing'), 'error');
                return;
            }

            const copied = await copyToClipboard(value);
            if (copied) {
                showToast(t('common.success'), t('common.copy.success'), 'success');
            } else {
                showToast(t('common.error'), t('common.copy.failed'), 'error');
            }
        });
        copyApiKeyButton.dataset.bound = 'true';
    }

    const copyBaseUrlButton = getElement('copyAccessBaseUrl');
    if (copyBaseUrlButton && !copyBaseUrlButton.dataset.bound) {
        copyBaseUrlButton.addEventListener('click', async () => {
            const value = getElement('accessBaseUrlField')?.value || '';
            const copied = await copyToClipboard(value);
            if (copied) {
                showToast(t('common.success'), t('common.copy.success'), 'success');
            } else {
                showToast(t('common.error'), t('common.copy.failed'), 'error');
            }
        });
        copyBaseUrlButton.dataset.bound = 'true';
    }

    const configuredOnlyToggle = getElement('accessConfiguredOnly');
    if (configuredOnlyToggle && !configuredOnlyToggle.dataset.bound) {
        configuredOnlyToggle.addEventListener('change', () => {
            if (latestAccessData) {
                renderAccessPage(latestAccessData);
            }
        });
        configuredOnlyToggle.dataset.bound = 'true';
    }

    const snippetProviderSelect = getElement('accessSnippetProvider');
    if (snippetProviderSelect && !snippetProviderSelect.dataset.bound) {
        snippetProviderSelect.addEventListener('change', () => {
            if (latestAccessData) {
                const configMap = buildProviderConfigMap(latestAccessData.supportedProviders || []);
                renderClientSnippets(latestAccessData, configMap);
            }
        });
        snippetProviderSelect.dataset.bound = 'true';
    }

    if (!document.body.dataset.accessCopyBound) {
        document.body.addEventListener('click', async event => {
            const jumpButton = event.target.closest('.access-jump-btn');
            if (jumpButton) {
                navigateToSection(jumpButton.dataset.section);
                return;
            }

            const formatButton = event.target.closest('.access-format-btn');
            if (formatButton) {
                setSelectedSnippetFormat(formatButton.dataset.format);
                if (latestAccessData) {
                    const configMap = buildProviderConfigMap(latestAccessData.supportedProviders || []);
                    renderClientSnippets(latestAccessData, configMap);
                }
                return;
            }

            const endpointButton = event.target.closest('.access-copy-btn');
            if (endpointButton) {
                await copyFromButton(endpointButton);
                return;
            }

            const curlButton = event.target.closest('.access-curl-btn');
            if (curlButton) {
                const provider = curlButton.dataset.provider;
                const protocol = curlButton.dataset.protocol;
                const model = getRecommendedModel(provider);
                await copyCurlExample(provider, { protocol, model });
                return;
            }

            const snippetButton = event.target.closest('.access-snippet-copy-btn');
            if (snippetButton) {
                const targetId = snippetButton.getAttribute('data-target');
                const text = getElement(targetId)?.textContent || '';
                if (!text) {
                    showToast(t('common.error'), t('access.copy.missing'), 'error');
                    return;
                }
                const copied = await copyToClipboard(text);
                if (copied) {
                    showToast(t('common.success'), t('common.copy.success'), 'success');
                } else {
                    showToast(t('common.error'), t('common.copy.failed'), 'error');
                }
            }
        });
        document.body.dataset.accessCopyBound = 'true';
    }
}
