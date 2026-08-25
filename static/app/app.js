// 主应用入口文件 - 模块化版本

// 导入所有模块
import {
    providerStats,
    REFRESH_INTERVALS
} from './constants.js';

import {
    showToast,
    getProviderStats
} from './utils.js';

import { t, updatePageLanguage } from './i18n.js';

import {
    initFileUpload,
    fileUploadHandler
} from './file-upload.js';

import { 
    initNavigation,
    setSectionLoaders
} from './navigation.js';

import {
    initEventListeners,
    setDataLoaders,
    setReloadConfig
} from './event-handlers.js';

import {
    initEventStream,
    setProviderLoaders,
    setConfigLoaders
} from './event-stream.js';

import {
    loadSystemInfo,
    updateTimeDisplay,
    loadProviders,
    loadProvidersPageData,
    openProviderManager,
    showAuthModal,
    executeGenerateAuthUrl,
    handleGenerateAuthUrl,
    showAddProviderGroupModal
} from './provider-manager.js';

import {
    loadConfiguration,
    saveConfiguration,
    generateApiKey
} from './config-manager.js';

import {
    showProviderManagerModal,
    refreshProviderConfig
} from './modal.js';

import {
    initRoutingExamples
} from './routing-examples.js';

import {
    initAccessManager,
    loadAccessInfo
} from './access-manager.js';

import {
    initUploadConfigManager,
    loadConfigList,
    viewConfig,
    deleteConfig,
    closeConfigModal,
    copyConfigContent,
    reloadConfig
} from './upload-config-manager.js';

import {
    initUsageManager,
    loadUsagePageData,
    refreshUsage
} from './usage-manager.js';

import {
    initImageZoom
} from './image-zoom.js';

import {
    initPluginManager,
    loadPlugins,
    togglePlugin
} from './plugin-manager.js';

import {
    initTutorialManager
} from './tutorial-manager.js';

import {
    CustomModelsManager
} from './custom-models-manager.js';

import {
    initPlaygroundManager,
    loadPlaygroundData
} from './playground-manager.js';

let isAppInitialized = false;

/**
 * 加载初始数据
 */
async function loadInitialData() {
    await Promise.all([
        loadSystemInfo(),
        loadProviders()
    ]);
}

/**
 * 初始化应用
 */
async function initApp() {
    if (isAppInitialized) {
        return;
    }
    isAppInitialized = true;

    // 设置数据加载器
    setDataLoaders(loadInitialData, saveConfiguration);
    
    // 设置reloadConfig函数
    setReloadConfig(reloadConfig);
    
    // 设置提供商加载器
    setProviderLoaders(loadProviders, refreshProviderConfig);
    
    // 设置配置加载器
    setConfigLoaders(loadConfigList);

    setSectionLoaders({
        access: loadAccessInfo,
        config: loadConfiguration,
        providers: loadProvidersPageData,
        'custom-models': () => window.customModelsManager?.load(),
        'upload-config': loadConfigList,
        usage: loadUsagePageData,
        plugins: loadPlugins,
        playground: loadPlaygroundData
    });
    
    // 导出全局函数供其他模块使用
    window.loadProviders = loadProviders;
    window.openProviderManager = openProviderManager;
    window.showProviderManagerModal = showProviderManagerModal;
    window.refreshProviderConfig = refreshProviderConfig;
    window.fileUploadHandler = fileUploadHandler;
    window.showAuthModal = showAuthModal;
    window.executeGenerateAuthUrl = executeGenerateAuthUrl;
    window.handleGenerateAuthUrl = handleGenerateAuthUrl;
    window.showAddProviderGroupModal = showAddProviderGroupModal;

    // 配置管理相关全局函数
    window.viewConfig = viewConfig;
    window.deleteConfig = deleteConfig;
    window.loadConfigList = loadConfigList;
    window.closeConfigModal = closeConfigModal;
    window.copyConfigContent = copyConfigContent;
    window.reloadConfig = reloadConfig;
    window.generateApiKey = generateApiKey;
    window.loadAccessInfo = loadAccessInfo;

    // 用量管理相关全局函数
    window.refreshUsage = refreshUsage;

    // 插件管理相关全局函数
    window.togglePlugin = togglePlugin;

    // 初始化自定义模型管理
    window.customModelsManager = new CustomModelsManager();

    // 初始化各个模块
    initEventListeners();
    initEventStream();
    initFileUpload(); // 初始化文件上传功能
    initAccessManager(); // 初始化快速接入页面
    initUploadConfigManager(); // 初始化配置管理功能
    initUsageManager(); // 初始化用量管理功能
    initImageZoom(); // 初始化图片放大功能
    initPluginManager(); // 初始化插件管理功能
    initTutorialManager(); // 初始化教程管理功能
    initPlaygroundManager(); // 初始化 Playground
    initMobileMenu(); // 初始化移动端菜单
    
    // 加载初始数据 (确保在导航初始化前加载，因为导航可能触发页面数据加载)
    await loadInitialData();
    
    // 初始化导航功能，触发初始页面的激活
    initNavigation();
    updatePageLanguage();
    
    // 显示欢迎消息
    showToast(t('common.success'), t('common.welcome'), 'success');
    
    // 每5秒更新服务器时间和运行时间显示
    setInterval(() => {
        updateTimeDisplay();
    }, 5000);
    
    // 定期刷新系统信息
    setInterval(() => {
        loadProviders();

        if (providerStats.activeProviders > 0) {
            const stats = getProviderStats(providerStats);
            console.log('=== 提供商统计报告 ===');
            console.log(`活跃提供商: ${stats.activeProviders}`);
            console.log(`健康提供商: ${stats.healthyProviders} (${stats.healthRatio})`);
            console.log(`总账户数: ${stats.totalAccounts}`);
            console.log(`总请求数: ${stats.totalRequests}`);
            console.log(`总错误数: ${stats.totalErrors}`);
            console.log(`成功率: ${stats.successRate}`);
            console.log(`平均每提供商请求数: ${stats.avgUsagePerProvider}`);
            console.log('========================');
        }
    }, REFRESH_INTERVALS.SYSTEM_INFO);

}

/**
 * 初始化移动端菜单
 */
function initMobileMenu() {
    const mobileMenuToggle = document.getElementById('mobileMenuToggle');
    const headerControls = document.getElementById('headerControls');
    
    if (!mobileMenuToggle || !headerControls) {
        console.log('Mobile menu elements not found');
        return;
    }
    
    // 默认隐藏header-controls
    headerControls.style.display = 'none';
    
    let isMenuOpen = false;
    
    mobileMenuToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        console.log('Mobile menu toggle clicked, current state:', isMenuOpen);
        
        isMenuOpen = !isMenuOpen;
        
        if (isMenuOpen) {
            headerControls.style.display = 'flex';
            mobileMenuToggle.innerHTML = '<i class="fas fa-times"></i>';
            console.log('Menu opened');
        } else {
            headerControls.style.display = 'none';
            mobileMenuToggle.innerHTML = '<i class="fas fa-bars"></i>';
            console.log('Menu closed');
        }
    });
    
    // 点击页面其他地方关闭菜单
    document.addEventListener('click', (e) => {
        if (isMenuOpen && !mobileMenuToggle.contains(e.target) && !headerControls.contains(e.target)) {
            isMenuOpen = false;
            headerControls.style.display = 'none';
            mobileMenuToggle.innerHTML = '<i class="fas fa-bars"></i>';
            console.log('Menu closed by clicking outside');
        }
    });
}

// 等待组件加载完成后初始化应用
// 组件加载器会在所有组件加载完成后触发 'componentsLoaded' 事件
window.addEventListener('componentsLoaded', initApp);

// 如果组件已经加载完成（例如页面刷新后），也需要初始化
// 检查是否有组件已经存在
document.addEventListener('DOMContentLoaded', () => {
    // 如果 sidebar 和 content 已经有内容，说明组件已加载
    const sidebarContainer = document.getElementById('sidebar-container');
    const contentContainer = document.getElementById('content-container');
    
    // 如果容器不存在或为空，说明使用的是组件加载方式，等待 componentsLoaded 事件
    // 如果容器已有内容，说明是静态 HTML，直接初始化
    if (sidebarContainer && contentContainer) {
        const hasContent = sidebarContainer.children.length > 0 || contentContainer.children.length > 0;
        if (hasContent) {
            // 静态 HTML 方式，直接初始化
            initApp();
        }
        // 否则等待 componentsLoaded 事件
    }
});

// 导出调试函数
window.getProviderStats = () => getProviderStats(providerStats);

console.log('AIClient2API 管理控制台已加载 - 模块化版本');
