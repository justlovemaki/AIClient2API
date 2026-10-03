// Playground 管理模块

import { getAuthHeaders } from './auth.js';
import { markOnce, getProviderConfigs } from './utils.js';
import { t } from './i18n.js';

let providerModels = {};   // { providerType: [model1, model2, ...] }
let apiKey = '';           // REQUIRED_API_KEY, used for /v1/chat/completions auth
let messages = [];         // current conversation history
let pendingFiles = [];     // { name, type, dataUrl }
let isStreaming = false;
let currentAbortController = null;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el(id) {
    return document.getElementById(id);
}

function getProviderSelect() { return el('pg-provider-select'); }
function getModelSelect()    { return el('pg-model-select'); }
function getCopilotAutoTierSelect() { return el('pg-copilot-auto-tier'); }
function getInterfaceSelect(){ return el('pg-interface-select'); }
function getInput()          { return el('pg-input'); }
function getSendBtn()        { return el('pg-send-btn'); }
function getStopBtn()        { return el('pg-stop-btn'); }
function getMessages()       { return el('pg-messages'); }
function getEmpty()          { return el('pg-empty'); }
function getAttachPreview()  { return el('pg-attachments-preview'); }
function getSystemInput()    { return el('pg-system-input'); }
function getTempSlider()     { return el('pg-temp-slider'); }
function getTempVal()        { return el('pg-temp-val'); }
function getMaxTokens()      { return el('pg-max-tokens'); }
function getStreamCheckbox() { return el('pg-stream-checkbox'); }

// ── Initialisation ───────────────────────────────────────────────────────────

export function initPlaygroundManager() {
    bindEvents();
}

export async function loadPlaygroundData() {
    return loadProviderData();
}

async function loadProviderData() {
    try {
        const headers = getAuthHeaders();

        const [accessRes, modelsRes] = await Promise.all([
            fetch('/api/access-info', { headers }),
            fetch('/api/provider-models', { headers })
        ]);

        if (accessRes.ok) {
            const data = await accessRes.json();
            apiKey = data.apiKey || '';
            renderProviderOptions(data.providers || []);
        }

        if (modelsRes.ok) {
            providerModels = await modelsRes.json();
        }

        // 尝试恢复上次选择的提供商和模型
        restoreSelections();
    } catch (e) {
        console.error('[Playground] Failed to load provider data:', e);
    } finally {
        updateInputState();
    }
}

function restoreSelections() {
    const savedProvider = localStorage.getItem('pg_selected_provider');
    const savedModel = localStorage.getItem('pg_selected_model');

    if (savedProvider) {
        const providerSel = getProviderSelect();
        if (providerSel) {
            providerSel.value = savedProvider;
            // 触发模型列表更新
            onProviderChange(savedProvider);
            
            if (savedModel) {
                const modelSel = getModelSelect();
                if (modelSel) {
                    // 检查模型是否存在于当前提供商
                    const models = providerModels[savedProvider] || [];
                    if (models.includes(savedModel)) {
                        modelSel.value = savedModel;
                    }
                }
            }
        }
    }
}

function renderProviderOptions(providers) {
    const sel = getProviderSelect();
    if (!sel) return;

    sel.innerHTML = `<option value="">${t('playground.selectProvider')}</option>`;

    // 使用与凭据管理一致的排序逻辑
    const supportedIds = providers.map(p => p.id);
    const orderedConfigs = getProviderConfigs(supportedIds);
    
    // 创建快速查找表
    const providerMap = new Map(providers.map(p => [p.id, p]));

    orderedConfigs
        .filter(config => {
            const p = providerMap.get(config.id);
            return p && (p.usableNodes || 0) > 0;
        })
        .forEach(config => {
            const p = providerMap.get(config.id);
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `● ${config.name} (${p.usableNodes}/${p.totalNodes})`;
            sel.appendChild(opt);
        });
}

// ── Events ───────────────────────────────────────────────────────────────────

function bindEvents() {
    if (!markOnce(document.body, 'playgroundEvents')) {
        return;
    }

    document.addEventListener('change', (e) => {
        if (e.target.id === 'pg-provider-select') {
            onProviderChange(e.target.value);
            localStorage.setItem('pg_selected_provider', e.target.value);
            // 切换提供商时清除旧模型缓存，强制重新选择或匹配
            localStorage.removeItem('pg_selected_model');
        }
    });

    document.addEventListener('change', (e) => {
        if (e.target.id === 'pg-model-select') {
            updateInputState();
            localStorage.setItem('pg_selected_model', e.target.value);
        }
    });

    document.addEventListener('change', (e) => {
        if (e.target.id === 'pg-copilot-auto-tier') {
            localStorage.setItem('pg_copilot_auto_tier', e.target.value);
        }
    });

    document.addEventListener('change', (e) => {
        if (e.target.id === 'pg-interface-select') {
            const isChat = e.target.value === 'chat';
            const streamBox = getStreamCheckbox();
            if (streamBox) {
                streamBox.disabled = !isChat;
                const wrap = streamBox.closest('.pg-stream-toggle-wrap');
                if (wrap) wrap.style.opacity = isChat ? '1' : '0.5';
            }
        }
    });

    document.addEventListener('input', (e) => {
        if (e.target.id === 'pg-temp-slider') {
            const val = getTempVal();
            if (val) val.textContent = e.target.value;
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.target.id === 'pg-input' && e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    document.addEventListener('input', (e) => {
        if (e.target.id === 'pg-input') {
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 240) + 'px';
        }
    });

    document.addEventListener('click', (e) => {
        if (e.target.closest('#pg-send-btn')) handleSend();
        if (e.target.closest('#pg-stop-btn')) handleStop();
        if (e.target.closest('#pg-clear-btn')) clearChat();
        if (e.target.closest('#pg-attach-btn')) el('pg-file-input')?.click();

        // 移动端响应式选项卡切换
        const tabBtn = e.target.closest('.pg-tab-btn');
        if (tabBtn) {
            const targetTab = tabBtn.getAttribute('data-tab');
            switchPlaygroundTab(targetTab);
        }

        // 移动端一键进入对话按钮切换
        const startChatBtn = e.target.closest('[data-tab-switch]');
        if (startChatBtn) {
            const targetTab = startChatBtn.getAttribute('data-tab-switch');
            switchPlaygroundTab(targetTab);
        }
    });

    document.addEventListener('change', (e) => {
        if (e.target.id === 'pg-file-input') handleFiles(e.target.files);
    });
}

function onProviderChange(providerType) {
    const modelSel = getModelSelect();
    if (!modelSel) return;
    const autoTierSection = el('pg-copilot-auto-tier-section');
    const autoTierSelect = getCopilotAutoTierSelect();
    if (autoTierSection) {
        autoTierSection.style.display = providerType === 'github-copilot' ? '' : 'none';
    }
    if (autoTierSelect) {
        const savedTier = localStorage.getItem('pg_copilot_auto_tier');
        autoTierSelect.value = ['efficiency', 'balance', 'intelligence'].includes(savedTier) ? savedTier : 'balance';
    }

    if (!providerType) {
        modelSel.innerHTML = `<option value="">${t('playground.providerFirst')}</option>`;
        modelSel.disabled = true;
        updateInputState();
        return;
    }

    const models = providerModels[providerType] || [];
    modelSel.innerHTML = `<option value="">${t('playground.selectModel')}</option>`;
    models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSel.appendChild(opt);
    });
    modelSel.disabled = false;
    updateInputState();
}

function updateInputState() {
    const provider = getProviderSelect()?.value;
    const model = getModelSelect()?.value;
    const hasSelection = !!(provider && model);
    const ready = !!(hasSelection && !isStreaming);

    const input = getInput();
    const sendBtn = getSendBtn();
    const stopBtn = getStopBtn();

    if (input) {
        input.disabled = !hasSelection || isStreaming;
    }

    if (sendBtn) {
        sendBtn.style.display = isStreaming ? 'none' : 'flex';
        sendBtn.disabled = !ready;
    }

    if (stopBtn) {
        stopBtn.style.display = isStreaming ? 'flex' : 'none';
        stopBtn.disabled = !isStreaming;
    }

    // Update status indicator
    const indicator = el('pg-active-indicator');
    const statusText = el('pg-status-text');
    if (indicator && statusText) {
        if (ready) {
            indicator.className = 'pg-indicator active';
            statusText.textContent = t('playground.status.ready');
        } else {
            indicator.className = 'pg-indicator inactive';
            statusText.textContent = isStreaming ? t('playground.generating') : t('playground.status.unready');
        }
    }
}

function finalizeRequestUI({ shouldFocusInput = false } = {}) {
    isStreaming = false;
    currentAbortController = null;
    updateInputState();

    const input = getInput();
    if (shouldFocusInput && input && !input.disabled) {
        input.focus();
    }

    scrollToBottom();
}

// ── Chat logic ────────────────────────────────────────────────────────────────

async function handleSend() {
    if (isStreaming) return;

    const provider = getProviderSelect()?.value;
    const model = getModelSelect()?.value;
    const interfaceType = getInterfaceSelect()?.value || 'chat';
    const input = getInput();
    const text = input?.value.trim();

    if (!provider || !model || (!text && pendingFiles.length === 0)) return;
    if (!apiKey) return;

    const sysPrompt = getSystemInput()?.value.trim();
    const temp = parseFloat(getTempSlider()?.value || '0.7');
    const maxTokens = parseInt(getMaxTokens()?.value || '4096');
    const useStream = getStreamCheckbox()?.checked ?? true;
    const autoTier = provider === 'github-copilot' ? getCopilotAutoTierSelect()?.value || 'balance' : undefined;

    // Build history for request
    const requestMessages = [];
    if (sysPrompt) requestMessages.push({ role: 'system', content: sysPrompt });
    messages.slice(-20).forEach(m => requestMessages.push(m));

    const filesToSend = [...pendingFiles];
    const userContent = buildUserContent(text, filesToSend);
    requestMessages.push({ role: 'user', content: userContent });

    // UI: User message
    const displayText = [
        text,
        ...filesToSend.map(f => `${t('playground.attachPrefix')}${f.name}]`)
    ].filter(Boolean).join('\n');
    appendMessage('user', displayText);

    // Save to history
    messages.push({ role: 'user', content: userContent });

    if (input) { input.value = ''; input.style.height = 'auto'; }
    pendingFiles = [];
    renderAttachmentPreview();

    const assistantBubble = appendMessage('assistant', '');
    
    if (interfaceType === 'image' || interfaceType === 'image-edit') {
        await imageResponse(provider, model, text, filesToSend, assistantBubble, interfaceType);
    } else if (useStream) {
        await streamResponse(provider, model, assistantBubble, {
            messages: requestMessages,
            temperature: temp,
            max_tokens: maxTokens,
            auto_tier: autoTier
        });
    } else {
        await unaryResponse(provider, model, assistantBubble, {
            messages: requestMessages,
            temperature: temp,
            max_tokens: maxTokens,
            auto_tier: autoTier
        });
    }
}

function handleStop() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
}

function buildUserContent(text, files) {
    if (files.length === 0) return text;
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    files.forEach(f => {
        if (f.type.startsWith('image/')) {
            parts.push({ type: 'image_url', image_url: { url: f.dataUrl } });
        } else {
            parts.push({ type: 'text', text: `[File: ${f.name}]\n${f.dataUrl}` });
        }
    });
    return parts;
}

function dataUrlToBlob(dataUrl) {
    const [meta, data] = dataUrl.split(',');
    const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/png';
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    return new Blob([bytes], {type: mime});
}

async function imageResponse(provider, model, prompt, files, bubble, interfaceType) {
    isStreaming = true;
    updateInputState();
    
    currentAbortController = new AbortController();

    const msgWrapper = bubble.closest('.pg-message');
    if (msgWrapper) msgWrapper.style.display = 'flex'; // Image response doesn't need to hide

    let errorMsg = '';
    try {
        const imageFiles = files.filter(f => f.type.startsWith('image/'));
        let response;
        
        // 如果显式选择了 image-edit，或者选了 image 且带了图片附件，则走 edits 接口
        const isEdit = interfaceType === 'image-edit' || (interfaceType === 'image' && imageFiles.length > 0);
        
        if (isEdit) {
            if (imageFiles.length === 0) throw new Error(t('playground.imageEditRequired'));
            
            const formData = new FormData();
            formData.append('model', model);
            formData.append('prompt', prompt || '');
            formData.append('response_format', 'b64_json');
            imageFiles.forEach(f => formData.append('image', dataUrlToBlob(f.dataUrl), f.name));

            response = await fetch('/v1/images/edits', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'model-provider': provider },
                body: formData,
                signal: currentAbortController.signal
            });
        } else {
            response = await fetch('/v1/images/generations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'model-provider': provider },
                body: JSON.stringify({model, prompt, response_format: 'b64_json'}),
                signal: currentAbortController.signal
            });
        }

        if (!response.ok) {
            errorMsg = await parseResponseError(response);
            throw new Error(errorMsg);
        }
        
        const json = await response.json();
        const images = json.data || [];
        if (images.length === 0) throw new Error(t('playground.reqFailed'));

        bubble.innerHTML = images.map((img, i) => {
            const src = img.b64_json ? `data:image/png;base64,${img.b64_json}` : img.url;
            return `<img src="${src}" alt="generated" style="max-width:100%;border-radius:12px;margin:0.5rem 0;display:block">`;
        }).join('');

    } catch (e) {
        if (e.name === 'AbortError') {
            errorMsg = t('playground.aborted');
        } else {
            errorMsg = e.message || t('playground.reqFailed');
        }
    } finally {
        if (errorMsg) {
            bubble.textContent = errorMsg;
            bubble.closest('.pg-message')?.classList.add('error');
        }
        finalizeRequestUI({ shouldFocusInput: true });
    }
}

async function unaryResponse(provider, model, bubble, params) {
    isStreaming = true;
    updateInputState();
    
    currentAbortController = new AbortController();

    let errorMsg = '';
    try {
        const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'model-provider': provider
            },
            body: JSON.stringify({
                model,
                messages: params.messages,
                temperature: params.temperature,
                max_tokens: params.max_tokens,
                auto_tier: params.auto_tier,
                stream: false
            }),
            signal: currentAbortController.signal
        });

        if (!response.ok) {
            errorMsg = await parseResponseError(response);
            throw new Error(errorMsg);
        }

        const json = await response.json();
        const content = json.choices?.[0]?.message?.content || '';
        const reasoning = json.choices?.[0]?.message?.reasoning_content || json.choices?.[0]?.message?.thinking || '';

        bubble.innerHTML = '';
        const msgWrapper = bubble.closest('.pg-message');
        if (msgWrapper) msgWrapper.style.display = 'flex';

        if (reasoning) {
            const resDiv = createReasoningBlock(reasoning);
            bubble.appendChild(resDiv);
        }

        if (content) {
            const contentDiv = document.createElement('div');
            contentDiv.innerHTML = renderMarkdown(content);
            while (contentDiv.firstChild) bubble.appendChild(contentDiv.firstChild);
            
            const historyContent = content.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, t('playground.imagePlaceholder'));
            messages.push({role: 'assistant', content: historyContent});
        }

    } catch (e) {
        if (e.name === 'AbortError') {
            errorMsg = t('playground.aborted');
        } else {
            console.error('[Playground] Unary error:', e.message);
            errorMsg = e.message || t('playground.reqFailed');
        }
    } finally {
        if (errorMsg) {
            bubble.textContent = errorMsg;
            bubble.closest('.pg-message')?.classList.add('error');
            const msgWrapper = bubble.closest('.pg-message');
            if (msgWrapper) msgWrapper.style.display = 'flex';
        }
        finalizeRequestUI({ shouldFocusInput: true });
    }
}

async function streamResponse(provider, model, bubble, params) {
    isStreaming = true;
    updateInputState();

    const cursor = document.createElement('span');
    cursor.className = 'pg-cursor';
    
    currentAbortController = new AbortController();
    let accumulated = '';
    let accumulatedReasoning = '';
    let errorMsg = '';

    try {
        const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'model-provider': provider
            },
            body: JSON.stringify({
                model,
                messages: params.messages,
                temperature: params.temperature,
                max_tokens: params.max_tokens,
                auto_tier: params.auto_tier,
                stream: true
            }),
            signal: currentAbortController.signal
        });
 
        if (!response.ok) {
            errorMsg = await parseResponseError(response);
            throw new Error(errorMsg);
        }
 
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        outer: while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, {stream: true});
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break outer;

                try {
                    const json = JSON.parse(data);
                    if (json.error) throw new Error(json.error.message || t('playground.reqFailed'));
                    
                    const delta = json.choices?.[0]?.delta;
                    const content = delta?.content || '';
                    const reasoning = delta?.reasoning_content || delta?.thinking || '';
                    
                    if (content || reasoning) {
                        if (!accumulated && !accumulatedReasoning) {
                            const msgWrapper = bubble.closest('.pg-message');
                            if (msgWrapper) msgWrapper.style.display = 'flex';
                        }
                        
                        if (reasoning) accumulatedReasoning += reasoning;
                        if (content) accumulated += content;
                        
                        let html = '';
                        if (accumulatedReasoning) {
                            html += `<div class="pg-reasoning">
                                <div class="pg-reasoning-title"><i class="fas fa-brain"></i>${t('playground.thinking')}</div>
                                <div class="pg-reasoning-content"></div>
                            </div>`;
                        }
                        
                        bubble.innerHTML = html;
                        if (accumulatedReasoning) {
                            const resContent = bubble.querySelector('.pg-reasoning-content');
                            resContent.textContent = accumulatedReasoning;
                            if (!accumulated) {
                                resContent.appendChild(cursor);
                            }
                        }
                        
                        if (accumulated || !accumulatedReasoning) {
                            const contentSpan = document.createElement('span');
                            contentSpan.textContent = accumulated;
                            bubble.appendChild(contentSpan);
                            bubble.appendChild(cursor);
                        }
                        scrollToBottom();
                    }
                } catch (e) {
                    if (e.message && !e.message.startsWith('Unexpected')) throw e;
                }
            }
        }

        const historyContent = accumulated.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, t('playground.imagePlaceholder'));
        messages.push({role: 'assistant', content: historyContent});

    } catch (e) {
        if (e.name === 'AbortError') {
            accumulated = accumulated || t('playground.aborted');
        } else {
            console.error('[Playground] Stream error:', e.message);
            errorMsg = e.message || t('playground.reqFailed');
        }
    } finally {
        cursor.remove();
        const msgWrapper = bubble.closest('.pg-message');
        if (msgWrapper) msgWrapper.style.display = 'flex';

        if (errorMsg) {
            bubble.textContent = errorMsg;
            bubble.closest('.pg-message')?.classList.add('error');
        } else {
            bubble.innerHTML = '';
            if (accumulatedReasoning) {
                const resDiv = createReasoningBlock(accumulatedReasoning);
                bubble.appendChild(resDiv);
            }
            if (accumulated) {
                const contentDiv = document.createElement('div');
                contentDiv.innerHTML = renderMarkdown(accumulated);
                while (contentDiv.firstChild) bubble.appendChild(contentDiv.firstChild);
            }
        }
        finalizeRequestUI({ shouldFocusInput: true });
    }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

async function parseResponseError(response) {
    const status = response.status;
    const defaultMsg = `${t('playground.reqFailed')} (${status})`;
    try {
        const text = await response.text();
        try {
            const json = JSON.parse(text);
            return json.error?.message || json.message || text || defaultMsg;
        } catch (e) {
            return text || defaultMsg;
        }
    } catch (e) {
        return defaultMsg;
    }
}

function appendMessage(role, text) {
    const empty = getEmpty();
    if (empty) empty.style.display = 'none';

    const container = getMessages();
    if (!container) return document.createElement('span');

    const wrapper = document.createElement('div');
    wrapper.className = `pg-message ${role}`;

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'pg-avatar';
    avatar.innerHTML = role === 'user' ? '<i class="fas fa-user"></i>' : '<i class="fas fa-microchip"></i>';
    wrapper.appendChild(avatar);

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'pg-message-content';

    const bubble = document.createElement('div');
    bubble.className = 'pg-message-bubble';
    
    if (role === 'assistant' && !text) {
        bubble.innerHTML = '<div class="pg-thinking"><span></span><span></span><span></span></div>';
    } else {
        bubble.textContent = text;
    }
    
    contentWrapper.appendChild(bubble);

    if (role === 'assistant') {
        const actions = document.createElement('div');
        actions.className = 'pg-message-actions';
        actions.innerHTML = `
            <div class="pg-action-link btn-copy-msg" title="${t('playground.copyText')}" data-i18n-title="playground.copyText">
                <i class="fas fa-copy"></i>
            </div>
        `;
        actions.querySelector('.btn-copy-msg').addEventListener('click', async () => {
            const rawText = bubble.innerText;
            const success = await copyToClipboard(rawText);
            if (success) {
                const icon = actions.querySelector('.fa-copy');
                const oldClass = icon.className;
                icon.className = 'fas fa-check';
                setTimeout(() => icon.className = oldClass, 2000);
            }
        });
        contentWrapper.appendChild(actions);
    } else if (role === 'user') {
        const actions = document.createElement('div');
        actions.className = 'pg-message-actions';
        actions.innerHTML = `
            <div class="pg-action-link btn-retry-msg" title="${t('playground.retryConversation')}" data-i18n-title="playground.retryConversation">
                <i class="fas fa-sync-alt"></i>
            </div>
        `;
        actions.querySelector('.btn-retry-msg').addEventListener('click', () => {
            retryMessage(wrapper, text);
        });
        contentWrapper.appendChild(actions);
    }

    wrapper.appendChild(contentWrapper);
    container.appendChild(wrapper);
    scrollToBottom();
    return bubble;
}

async function copyToClipboard(text) {
    if (!text) return false;
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textArea);
        return ok;
    }
}

function clearChat() {
    messages = [];
    pendingFiles = [];
    renderAttachmentPreview();
    const container = getMessages();
    if (container) {
        container.innerHTML = '';
        container.appendChild(createEmptyState());
    }
    const empty = getEmpty();
    if (empty) empty.style.display = 'flex';
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }
    updateInputState();
}

function createEmptyState() {
    const empty = document.createElement('div');
    empty.className = 'pg-welcome';
    empty.id = 'pg-empty';
    empty.innerHTML = `
        <div class="welcome-card">
            <div class="welcome-icon">
                <i class="fas fa-microchip"></i>
            </div>
            <h3 data-i18n="playground.welcome">${t('playground.welcome')}</h3>
            <p data-i18n="playground.emptyHint">${t('playground.emptyHint')}</p>
        </div>
    `;
    if (window.i18n) window.i18n.translateElement(empty);
    return empty;
}

function scrollToBottom() {
    const container = getMessages();
    if (container) container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function isSafeImageUrl(url) {
    return url.startsWith('data:image/') || /^https?:\/\//.test(url);
}

function isSafeVideoUrl(url) {
    return /^https?:\/\/[^\s"'<>]+$/i.test(url) &&
        /\.(mp4|webm|mov|m4v)(\?[^"'<>]*)?$/i.test(url);
}

function renderVideoPlayer(url, label = 'Play Video') {
    if (!isSafeVideoUrl(url)) return '';
    return `<div class="pg-video-block"><video src="${url}" controls preload="metadata" playsinline></video><a href="${url}" target="_blank" rel="noopener noreferrer">${label || 'Play Video'}</a></div>`;
}

function renderMarkdown(text) {
    const blocks = [];
    // Protect code blocks
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const escaped = escapeHtml(code.trimEnd());
        const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        blocks.push(`<pre style="background:var(--bg-tertiary);padding:1rem;border-radius:8px;overflow-x:auto;margin:0.5rem 0"><code${langAttr}>${escaped}</code></pre>`);
        return `\x00BLOCK${blocks.length - 1}\x00`;
    });

    text = escapeHtml(text);

    // Inline code
    text = text.replace(/`([^`]+)`/g, '<code style="background:var(--bg-tertiary);padding:0.1em 0.3em;border-radius:4px">$1</code>');

    // Bold/Italic
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Linked video thumbnails: [![video](thumb)](video.mp4)
    const renderedVideos = new Set();
    text = text.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\((https?:\/\/[^)]+)\)/g, (match, alt, thumbUrl, videoUrl) => {
        if (!isSafeVideoUrl(videoUrl)) return match;
        renderedVideos.add(videoUrl);
        return renderVideoPlayer(videoUrl, alt || 'Play Video');
    });

    // Video links
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, label, url) => {
        if (!isSafeVideoUrl(url)) return match;
        if (renderedVideos.has(url)) return '';
        renderedVideos.add(url);
        return renderVideoPlayer(url, label);
    });

    // Basic images/links
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        if (!isSafeImageUrl(url)) return match;
        return `<img src="${url}" alt="${alt}" style="max-width:100%;border-radius:8px;margin:0.5rem 0;display:block">`;
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Newlines
    text = text.replace(/\n/g, '<br>');

    // Restore code blocks
    text = text.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[+i]);

    return text;
}

// ── File handling ─────────────────────────────────────────────────────────────

function retryMessage(messageWrapper, originalDisplayText) {
    if (isStreaming) return;

    const container = getMessages();
    const allWrappers = Array.from(container.querySelectorAll('.pg-message'));
    const index = allWrappers.indexOf(messageWrapper);

    if (index === -1) return;

    // Extract original text from history if possible (to avoid [Attachment: ...] markers)
    let retryText = originalDisplayText;
    const historyMsg = messages[index];
    if (historyMsg && historyMsg.role === 'user') {
        if (typeof historyMsg.content === 'string') {
            retryText = historyMsg.content;
        } else if (Array.isArray(historyMsg.content)) {
            const textPart = historyMsg.content.find(p => p.type === 'text');
            if (textPart) retryText = textPart.text;
        }
    }

    // 1. Remove all subsequent messages from DOM
    for (let i = allWrappers.length - 1; i >= index; i--) {
        allWrappers[i].remove();
    }

    // 2. Remove from messages array
    messages.splice(index);

    // 3. Put text back to input and trigger send
    const input = getInput();
    if (input) {
        input.value = retryText;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 240) + 'px';
        input.disabled = false;
        input.focus();
        
        // Show empty state if no messages left
        if (messages.length === 0) {
            const empty = getEmpty();
            if (empty) empty.style.display = 'flex';
        }
        
        handleSend();
    }
}

function createReasoningBlock(content, collapsed = true) {
    const resDiv = document.createElement('div');
    resDiv.className = 'pg-reasoning' + (collapsed ? ' collapsed' : '');
    resDiv.innerHTML = `<div class="pg-reasoning-title"><i class="fas fa-brain"></i>${t('playground.thinking')}</div><div class="pg-reasoning-content"></div>`;
    resDiv.querySelector('.pg-reasoning-content').textContent = content;
    resDiv.addEventListener('click', (e) => {
        e.stopPropagation();
        resDiv.classList.toggle('collapsed');
    });
    return resDiv;
}

async function handleFiles(fileList) {
    if (!fileList?.length) return;
    for (const file of fileList) {
        const dataUrl = await readFileAsDataUrl(file);
        pendingFiles.push({ name: file.name, type: file.type, dataUrl });
    }
    const fileInput = el('pg-file-input');
    if (fileInput) fileInput.value = '';
    renderAttachmentPreview();
}

function readFileAsDataUrl(file) {
    return new Promise((r, j) => {
        const reader = new FileReader();
        reader.onload = e => r(e.target.result);
        reader.onerror = j;
        reader.readAsDataURL(file);
    });
}

function renderAttachmentPreview() {
    const preview = getAttachPreview();
    if (!preview) return;
    preview.innerHTML = '';
    pendingFiles.forEach((f, i) => {
        const tag = document.createElement('div');
        tag.className = 'pg-attachment-tag';
        tag.style = "display:inline-flex;align-items:center;background:var(--bg-tertiary);padding:4px 10px;border-radius:8px;margin-right:8px;font-size:0.8rem;border:1px solid var(--border-color);";
        tag.innerHTML = `<i class="fas fa-file" style="margin-right:6px"></i><span>${f.name}</span><button style="border:none;background:none;margin-left:6px;cursor:pointer;color:var(--text-tertiary)">×</button>`;
        tag.querySelector('button').onclick = () => {
            pendingFiles.splice(i, 1);
            renderAttachmentPreview();
        };
        preview.appendChild(tag);
    });
}

function switchPlaygroundTab(tabName) {
    const pg = el('playground');
    if (!pg) return;

    pg.classList.remove('active-tab-chat', 'active-tab-settings', 'active-tab-parameters');
    pg.classList.add(`active-tab-${tabName}`);

    const tabs = pg.querySelectorAll('.pg-tab-btn');
    tabs.forEach(btn => {
        if (btn.getAttribute('data-tab') === tabName) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    if (tabName === 'chat') {
        setTimeout(() => {
            const input = getInput();
            if (input && !input.disabled) {
                input.focus();
            }
        }, 100);
    }
}
