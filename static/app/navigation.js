import { updatePageLanguage } from './i18n.js';
// 导航功能模块

import { elements } from './constants.js';

let sectionLoaders = {};

function setSectionLoaders(loaders = {}) {
    sectionLoaders = loaders;
}

function isSectionActive(sectionId) {
    return document.getElementById(sectionId)?.classList.contains('active') === true;
}

function loadSection(sectionId) {
    if (typeof sectionLoaders[sectionId] !== 'function') {
        return Promise.resolve(false);
    }

    return Promise.resolve(sectionLoaders[sectionId]()).then(() => true);
}

function loadSectionIfActive(sectionId) {
    if (!isSectionActive(sectionId)) {
        return Promise.resolve(false);
    }

    return loadSection(sectionId);
        updatePageLanguage();
}

/**
 * 初始化导航功能
 */
function initNavigation() {
    if (!elements.navItems || !elements.sections) {
        console.warn('导航元素未找到');
        return;
    }

    elements.navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            activateSection(item.dataset.section, { updateHash: true });
        });
    });

    window.addEventListener('hashchange', () => {
        const sectionId = window.location.hash.slice(1) || 'dashboard';
        activateSection(sectionId, { updateHash: false });
    });

    const initialSectionId = window.location.hash.slice(1) || 'dashboard';
    activateSection(initialSectionId, { updateHash: false });
}

/**
 * 激活指定章节
 * @param {string} sectionId - 章节ID
 * @param {Object} options - 额外选项
 */
function activateSection(sectionId, options = {}) {
    const { updateHash = false } = options;
    const hasMatchingSection = Array.from(elements.sections).some(section => section.id === sectionId);

    if (!hasMatchingSection) {
        return;
    }

    // 更新导航状态
    elements.navItems.forEach(nav => {
        nav.classList.remove('active');
        if (nav.dataset.section === sectionId) {
            nav.classList.add('active');
        }
    });

    // 显示对应章节
    elements.sections.forEach(section => {
        section.classList.remove('active');
        if (section.id === sectionId) {
            section.classList.add('active');
            
            // 如果是日志页面，默认滚动到底部
            if (sectionId === 'logs') {
                setTimeout(() => {
                    const logsContainer = document.getElementById('logsContainer');
                    if (logsContainer) {
                        logsContainer.scrollTop = logsContainer.scrollHeight;
                    }
                }, 100);
            }
        }
    });

    // 滚动到顶部
    scrollToTop();

    const hashWillChange = updateHash && window.location.hash !== `#${sectionId}`;
    if (hashWillChange) {
        window.location.hash = sectionId;
    }

    // Hash changes will re-enter activateSection through hashchange, so load only when
    // the current activation is final.
    if (!hashWillChange) {
        loadSection(sectionId);
        updatePageLanguage();
    }
}

/**
 * 切换到指定章节
 * @param {string} sectionId - 章节ID
 */
function switchToSection(sectionId) {
    activateSection(sectionId, { updateHash: true });
}

function switchSectionIfActive(currentSectionId, targetSectionId) {
    if (isSectionActive(currentSectionId)) {
        switchToSection(targetSectionId);
        return true;
    }

    return false;
}

/**
 * 滚动到页面顶部
 */
function scrollToTop() {
    // 尝试滚动内容区域
    const contentContainer = document.getElementById('content-container');
    if (contentContainer) {
        contentContainer.scrollTop = 0;
    }
    
    // 同时滚动窗口到顶部
    window.scrollTo(0, 0);
}

/**
 * 切换到仪表盘页面
 */
function switchToDashboard() {
    switchToSection('dashboard');
}

/**
 * 切换到提供商页面
 */
function switchToProviders() {
    switchToSection('providers');
}

export {
    initNavigation,
    setSectionLoaders,
    loadSectionIfActive,
    switchSectionIfActive,
    switchToSection,
    switchToDashboard,
    switchToProviders
};
