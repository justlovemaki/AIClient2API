/**
 * 用量查询服务
 * 用于处理各个提供商的授权文件用量查询
 */

import { getProviderPoolManager } from './service-manager.js';
import { serviceInstances } from '../providers/adapter.js';
import { MODEL_PROVIDER } from '../utils/common.js';
import { getProviderModels } from '../providers/provider-models.js';

/**
 * 用量查询服务类
 */
export class UsageService {
    constructor() {
        this.providerHandlers = {
            [MODEL_PROVIDER.KIRO_API]: this.getKiroUsage.bind(this),
            [MODEL_PROVIDER.GEMINI_CLI]: this.getGeminiUsage.bind(this),
            [MODEL_PROVIDER.ANTIGRAVITY]: this.getAntigravityUsage.bind(this),
            [MODEL_PROVIDER.CODEX_API]: this.getCodexUsage.bind(this),
            [MODEL_PROVIDER.GROK_CLI]: this.getGrokCliUsage.bind(this),
        };

        // 映射提供商到对应的格式化函数
        this.formatters = {
            [MODEL_PROVIDER.KIRO_API]: formatKiroUsage,
            [MODEL_PROVIDER.GEMINI_CLI]: formatGeminiUsage,
            [MODEL_PROVIDER.ANTIGRAVITY]: formatAntigravityUsage,
            [MODEL_PROVIDER.CODEX_API]: formatCodexUsage,
            [MODEL_PROVIDER.GROK_CLI]: formatGrokCliUsage,
        };
    }

    /**
     * 获取指定提供商的用量信息（原始数据）
     * @param {string} providerType - 提供商类型
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} 原始用量数据
     */
    async getUsage(providerType, uuid = null) {
        const handler = this.providerHandlers[providerType];
        if (!handler) {
            throw new Error(`不支持的提供商类型: ${providerType}`);
        }
        return handler(uuid);
    }

    /**
     * 格式化指定的原始用量数据
     * @param {string} providerType - 提供商类型
     * @param {Object} rawUsage - 原始用量数据
     * @returns {Object} 格式化后的用量信息
     */
    formatUsage(providerType, rawUsage) {
        if (!rawUsage) return null;
        const formatter = this.formatters[providerType];
        if (typeof formatter === 'function') {
            return formatter(rawUsage);
        }
        return rawUsage;
    }

    /**
     * 获取指定提供商的用量信息并格式化
     * @param {string} providerType - 提供商类型
     * @param {string} [uuid] - 可选的提供商实例 UUID
     * @returns {Promise<Object>} 格式化后的用量信息
     */
    async getFormattedUsage(providerType, uuid = null) {
        const rawUsage = await this.getUsage(providerType, uuid);
        return this.formatUsage(providerType, rawUsage);
    }

    /**
     * 获取所有提供商的用量信息
     * @returns {Promise<Object>} 所有提供商的用量信息
     */
    async getAllUsage() {
        const results = {};
        const poolManager = getProviderPoolManager();
        
        for (const providerType of Object.keys(this.providerHandlers)) {
            try {
                // 检查是否有号池配置
                if (poolManager) {
                    const pools = poolManager.getProviderPools(providerType);
                    if (pools && pools.length > 0) {
                        results[providerType] = [];
                        for (const pool of pools) {
                            try {
                                const usage = await this.getFormattedUsage(providerType, pool.uuid);
                                results[providerType].push({
                                    uuid: pool.uuid,
                                    usage
                                });
                            } catch (error) {
                                results[providerType].push({
                                    uuid: pool.uuid,
                                    error: error.message
                                });
                            }
                        }
                    }
                }
                
                // 如果没有号池配置，尝试获取单个实例的用量
                if (!results[providerType] || results[providerType].length === 0) {
                    const usage = await this.getFormattedUsage(providerType, null);
                    results[providerType] = [{ uuid: 'default', usage }];
                }
            } catch (error) {
                results[providerType] = [{ uuid: 'default', error: error.message }];
            }
        }
        
        return results;
    }

    /**
     * 从适配器获取原始用量数据（统一内部方法）
     * @private
     */
    async _getRawUsageFromAdapter(providerType, uuid = null) {
        const providerKey = uuid ? providerType + uuid : providerType;
        const adapter = serviceInstances[providerKey];
        
        if (!adapter) {
            throw new Error(`${providerType} 服务实例未找到: ${providerKey}`);
        }
        
        // 1. 优先尝试适配器直接暴露的 getUsageLimits
        if (typeof adapter.getUsageLimits === 'function') {
            return adapter.getUsageLimits();
        }
        
        // 2. 尝试适配器内部的服务实例
        const apiServiceNames = [
            'kiroApiService', 
            'geminiApiService', 
            'antigravityApiService', 
            'codexApiService',
            'grokApiService',
            'grokCliApiService'
        ];

        for (const serviceName of apiServiceNames) {
            if (adapter[serviceName] && typeof adapter[serviceName].getUsageLimits === 'function') {
                return adapter[serviceName].getUsageLimits();
            }
        }
        
        throw new Error(`${providerType} 服务实例不支持用量查询: ${providerKey}`);
    }

    /**
     * 获取 Kiro 提供商的用量信息
     */
    async getKiroUsage(uuid = null) {
        return this._getRawUsageFromAdapter(MODEL_PROVIDER.KIRO_API, uuid);
    }

    /**
     * 获取 Gemini CLI 提供商的用量信息
     */
    async getGeminiUsage(uuid = null) {
        return this._getRawUsageFromAdapter(MODEL_PROVIDER.GEMINI_CLI, uuid);
    }

    /**
     * 获取 Antigravity 提供商的用量信息
     */
    async getAntigravityUsage(uuid = null) {
        return this._getRawUsageFromAdapter(MODEL_PROVIDER.ANTIGRAVITY, uuid);
    }

    /**
     * 获取 Codex 提供商的用量信息
     */
    async getCodexUsage(uuid = null) {
        return this._getRawUsageFromAdapter(MODEL_PROVIDER.CODEX_API, uuid);
    }

    /**
     * 获取 Grok CLI 提供商的用量信息
     */
    async getGrokCliUsage(uuid = null) {
        return this._getRawUsageFromAdapter(MODEL_PROVIDER.GROK_CLI, uuid);
    }

    /**
     * 获取支持用量查询的提供商列表
     * @returns {Array<string>} 支持的提供商类型列表
     */
    getSupportedProviders() {
        return Object.keys(this.providerHandlers);
    }
}

// 导出单例实例
export const usageService = new UsageService();

/**
 * 获取状态标识
 */
function getStatus(percent) {
    if (percent > 90) return 'danger';
    if (percent > 70) return 'warning';
    return 'normal';
}

/**
 * 转换时间戳
 */
function formatTimestamp(val) {
    if (!val) return null;
    if (typeof val === 'number') {
        // 如果是秒（10位），转为毫秒（13位）
        const timestamp = val < 10000000000 ? val * 1000 : val;
        return new Date(timestamp).toISOString();
    }
    try {
        return new Date(val).toISOString();
    } catch (e) {
        return null;
    }
}

/**
 * 解析 Tier ID 获取计划名称
 */
function parseTierId(tierId) {
    if (!tierId) return 'FREE';
    if (typeof tierId !== 'string') return String(tierId);
    if (tierId.includes('-')) return tierId;
    const parts = tierId.trim().split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 2].toLowerCase() === 'for') {
        const startIndex = Math.max(0, parts.length - 3);
        return parts.slice(startIndex).join(' ');
    }
    return parts[parts.length - 1];
}

/**
 * 获取计划类别样式类名
 */
function getPlanClass(plan) {
    if (!plan) return 'plan-default';
    const p = plan.toLowerCase();
    if (p.includes('ultra')) return 'plan-ultra';
    if (p.includes('team') || p.includes('ent')) return 'plan-team';
    if (p.includes('pro+') || p.includes('pro +')) return 'plan-pro-plus'; // 独立识别 pro+
    if (p.includes('pro')) return 'plan-pro';
    if (p.includes('plus') || p.includes('+')) return 'plan-plus';
    if (p.includes('free')) return 'plan-free';
    if (p.includes('basic')) return 'plan-basic';
    if (p.includes('super')) return 'plan-super';
    if (p.includes('heavy')) return 'plan-heavy';
    if (p.includes('standard')) return 'plan-standard';
    return 'plan-default';
}

/**
 * 格式化 Kiro 用量
 */
export function formatKiroUsage(usageData) {
    if (!usageData) return null;

    // 兼容多种命名格式 (usageBreakdownList 是 API 原生, usageBreakdown 是某些版本的处理结果)
    const breakdownList = usageData.usageBreakdownList || usageData.usageBreakdown || [];
    const items = [];
    const now = Date.now();
    const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000; // 约3个月
    
    // 检查时间戳是否在当前时间前后3个月内
    const isWithinWindow = (ts) => {
        if (!ts) return true;
        const val = ts < 10000000000 ? ts * 1000 : ts;
        return Math.abs(val - now) <= THREE_MONTHS_MS;
    };
    
    breakdownList.forEach(breakdown => {
        // 1. 基本资源信息
        if (isWithinWindow(breakdown.nextDateReset)) {
            const used = breakdown.currentUsageWithPrecision ?? breakdown.currentUsage;
            const limit = breakdown.usageLimitWithPrecision ?? breakdown.usageLimit;
            const percent = limit > 0 ? (used / limit) * 100 : 0;
            
            items.push({
                id: breakdown.resourceType,
                label: breakdown.displayName,
                used,
                limit,
                percent,
                unit: 'tokens',
                status: getStatus(percent),
                resetAt: formatTimestamp(breakdown.nextDateReset),
                isExpired: false
            });
        }

        // 2. 解析奖励信息 (bonuses)
        if (breakdown.bonuses && Array.isArray(breakdown.bonuses)) {
            breakdown.bonuses.forEach(bonus => {
                if (!isWithinWindow(bonus.expiresAt)) return;

                const bUsed = bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0;
                const bLimit = bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0;
                const bPercent = bLimit > 0 ? (bUsed / bLimit) * 100 : 0;
                const isExpired = bonus.status === 'EXPIRED';
                
                items.push({
                    id: `bonus_${bonus.bonusCode || bonus.displayName}`,
                    label: `Bonus: ${bonus.displayName}${isExpired ? ' (Expired)' : ''}`,
                    used: bUsed,
                    limit: bLimit,
                    percent: bPercent,
                    unit: 'tokens',
                    status: isExpired ? 'danger' : getStatus(bPercent),
                    resetAt: formatTimestamp(bonus.expiresAt),
                    isExpired
                });
            });
        }

        // 3. 解析免费试用信息 (freeTrialInfo)
        if (breakdown.freeTrialInfo) {
            const ft = breakdown.freeTrialInfo;
            if (isWithinWindow(ft.freeTrialExpiry)) {
                const ftUsed = ft.currentUsageWithPrecision ?? ft.currentUsage ?? 0;
                const ftLimit = ft.usageLimitWithPrecision ?? ft.usageLimit ?? 0;
                const ftPercent = ftLimit > 0 ? (ftUsed / ftLimit) * 100 : 0;
                const isExpired = ft.freeTrialStatus === 'EXPIRED';
                
                items.push({
                    id: `freetrial_${breakdown.resourceType}`,
                    label: `Free Trial${isExpired ? ' (Expired)' : ''}`,
                    used: ftUsed,
                    limit: ftLimit,
                    percent: ftPercent,
                    unit: 'tokens',
                    status: isExpired ? 'danger' : getStatus(ftPercent),
                    resetAt: formatTimestamp(ft.freeTrialExpiry),
                    isExpired
                });
            }
        }
    });

    // 仅汇总未过期的额度
    const activeItems = items.filter(item => !item.isExpired);
    const totalUsed = activeItems.reduce((sum, item) => sum + item.used, 0);
    const totalLimit = activeItems.reduce((sum, item) => sum + item.limit, 0);
    const usedPercent = totalLimit > 0 ? (totalUsed / totalLimit) * 100 : 0;

    // 兼容多种用户信息和计划信息的路径
    let plan = usageData.subscriptionInfo?.subscriptionTitle || 
               usageData.subscription?.title || 
               'FREE';
               
    // 移除 'KIRO ' 前缀
    plan = plan.replace(/^KIRO\s+/i, '');
                 
    const email = usageData.userInfo?.email;

    return {
        summary: {
            usedPercent,
            status: getStatus(usedPercent),
            resetAt: formatTimestamp(usageData.nextDateReset),
            plan,
            planClass: getPlanClass(plan),
            unit: items.length > 0 ? items[0].unit : 'tokens',
            totalUsed,
            totalLimit
        },
        user: {
            email
        },
        items,
        raw: usageData
    };
}

/**
 * 格式化 Gemini 用量
 */
export function formatGeminiUsage(usageData) {
    if (!usageData) return null;

    // 检查是否为原始 API 响应 (包含 buckets 数组)
    if (usageData.buckets && Array.isArray(usageData.buckets)) {
        const supportedModels = getProviderModels(MODEL_PROVIDER.GEMINI_CLI);
        const items = [];
        let totalPercent = 0;
        let maxResetAt = null;
        
        for (const bucket of usageData.buckets) {
            // 过滤掉不在支持列表中的模型
            if (!supportedModels.includes(bucket.modelId)) continue;

            const remaining = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 0;
            const percent = (1 - remaining) * 100;
            
            totalPercent += percent;
            if (!maxResetAt || bucket.resetTime > maxResetAt) {
                maxResetAt = bucket.resetTime;
            }
            
            items.push({
                id: bucket.modelId,
                label: bucket.modelId,
                used: percent,
                limit: 100,
                percent,
                unit: 'percent',
                status: getStatus(percent),
                resetAt: formatTimestamp(bucket.resetTime)
            });
        }

        // 按名称排序
        items.sort((a, b) => a.id.localeCompare(b.id));

        // 计算平均使用率作为概要 (因为各模型额度独立，用平均值更能反映整体可用性)
        const avgUsedPercent = items.length > 0 ? totalPercent / items.length : 0;
        const plan = parseTierId(usageData.tierId);

        return {
            summary: {
                usedPercent: avgUsedPercent,
                status: getStatus(avgUsedPercent),
                resetAt: formatTimestamp(maxResetAt),
                plan,
                planClass: getPlanClass(plan),
                unit: 'percent'
            },
            user: { 
                email: usageData.account || null
            },
            items,
            raw: usageData
        };
    }
    return null;
}

/**
 * 格式化 Antigravity 用量
 */
export function formatAntigravityUsage(usageData) {
    if (!usageData) return null;

    // 检查是否为原始 API 响应 (包含 models 对象且内部有 quotaInfo)
    if (usageData.models && typeof usageData.models === 'object' && !usageData.summary) {
        const supportedModels = getProviderModels(MODEL_PROVIDER.ANTIGRAVITY);
        const items = [];
        let totalPercent = 0;
        let maxResetAt = null;
        
        for (const [modelId, modelData] of Object.entries(usageData.models)) {
            // 只处理包含配额信息且在支持列表中的模型
            // 对 Claude 模型添加别名显示 (保持与原逻辑一致)
            const aliasName = modelId.startsWith('claude-') ? `gemini-${modelId}` : modelId;
            
            // 过滤：要么在 ANTIGRAVITY_MODELS 列表中，要么是以 claude- 开头（会被映射为 gemini-claude-*）
            if (!supportedModels.includes(aliasName) && !modelId.startsWith('claude-')) continue;
            
            if (modelData && modelData.quotaInfo) {
                const qInfo = modelData.quotaInfo;
                const remaining = typeof qInfo.remainingFraction === 'number' ? qInfo.remainingFraction : (qInfo.remaining || 0);
                const percent = (1 - remaining) * 100;
                
                totalPercent += percent;
                if (!maxResetAt || qInfo.resetTime > maxResetAt) {
                    maxResetAt = qInfo.resetTime;
                }
                
                items.push({
                    id: aliasName,
                    label: aliasName,
                    used: percent,
                    limit: 100,
                    percent,
                    unit: 'percent',
                    status: getStatus(percent),
                    resetAt: formatTimestamp(qInfo.resetTime)
                });
            }
        }

        // 按名称排序
        items.sort((a, b) => a.id.localeCompare(b.id));

        // 计算平均使用率作为概要
        const avgUsedPercent = items.length > 0 ? totalPercent / items.length : 0;
        const plan = parseTierId(usageData.tierId);

        return {
            summary: {
                usedPercent: avgUsedPercent,
                status: getStatus(avgUsedPercent),
                resetAt: formatTimestamp(maxResetAt),
                plan,
                planClass: getPlanClass(plan),
                unit: 'percent'
            },
            user: { 
                email: usageData.account || null
            },
            items,
            raw: usageData
        };
    }
    return null;
}

/**
 * 格式化 Grok 用量
 */
export function formatGrokUsage(usageData) {
    if (!usageData) return null;

    const items = [];
    let maxUsedPercent = 0;

    // 1. 处理查询配额 (Queries)
    if (usageData.totalQueries !== undefined && usageData.totalQueries > 0) {
        const total = usageData.totalQueries;
        const remaining = usageData.remainingQueries ?? total;
        const used = Math.max(0, total - remaining);
        const percent = (used / total) * 100;
        maxUsedPercent = Math.max(maxUsedPercent, percent);
        
        items.push({
            id: 'queries',
            label: 'Queries Quota',
            used,
            limit: total,
            percent,
            unit: 'queries',
            status: getStatus(percent),
            resetAt: null
        });
    }

    // 2. 处理 Token 配额 (Tokens)
    if (usageData.totalTokens !== undefined && usageData.totalTokens > 0) {
        const total = usageData.totalTokens;
        const remaining = usageData.remainingTokens ?? total;
        const used = Math.max(0, total - remaining);
        const percent = (used / total) * 100;
        maxUsedPercent = Math.max(maxUsedPercent, percent);
        
        items.push({
            id: 'tokens',
            label: 'Token Quota',
            used,
            limit: total,
            percent,
            unit: 'tokens',
            status: getStatus(percent),
            resetAt: null
        });
    }

    // 3. 兜底处理仅有剩余 Tokens 的情况
    if (items.length === 0 && usageData.remainingTokens !== undefined) {
        items.push({
            id: 'tokens',
            label: 'Token Quota',
            used: 0,
            limit: usageData.remainingTokens,
            percent: 0,
            unit: 'tokens',
            status: 'healthy',
            resetAt: null
        });
    }

    // 根据 totalQueries 确定计划名称
    let plan = 'BASIC';
    if (usageData.totalQueries !== undefined) {
        if (usageData.totalQueries > 70) plan = 'HEAVY';
        else if (usageData.totalQueries === 70) plan = 'SUPER';
        else if (usageData.totalQueries < 70) plan = 'BASIC';
    }

    const totalUsed = items.reduce((sum, item) => sum + item.used, 0);
    const totalLimit = items.reduce((sum, item) => sum + item.limit, 0);

    return {
        summary: {
            usedPercent: maxUsedPercent,
            status: getStatus(maxUsedPercent),
            resetAt: null,
            plan,
            planClass: getPlanClass(plan),
            unit: items.length > 0 ? items[0].unit : 'tokens',
            totalUsed,
            totalLimit
        },
        user: { label: null },
        items,
        raw: usageData
    };
}

/**
 * 格式化 Grok CLI 用量。
 */
export function formatGrokCliUsage(usageData) {
    if (!usageData) return null;

    const summaryData = usageData.summary || {};
    const config = usageData.config || {};
    const products = Array.isArray(summaryData.products) ? summaryData.products : [];
    const weeklyLimitPercent = summaryData.weeklyLimitPercent ?? config.creditUsagePercent ?? 0;
    const periodEnd = summaryData.periodEnd || config.currentPeriod?.end || config.billingPeriodEnd || usageData.expiresAt || null;
    const plan = summaryData.grokAccountTier || summaryData.subscriptionTier || config.subscription_tier || null;

    const items = products.map(item => {
        const percent = item.usagePercent ?? 0;
        return {
            id: item.product || 'product',
            label: item.product || 'Product Usage',
            used: percent,
            limit: 100,
            percent,
            unit: 'percent',
            status: getStatus(percent),
            resetAt: periodEnd
        };
    });

    if (items.length === 0) {
        items.push({
            id: 'weekly_limit',
            label: 'Weekly Limit',
            used: weeklyLimitPercent,
            limit: 100,
            percent: weeklyLimitPercent,
            unit: 'percent',
            status: getStatus(weeklyLimitPercent),
            resetAt: periodEnd
        });
    }

    return {
        summary: {
            usedPercent: weeklyLimitPercent,
            status: getStatus(weeklyLimitPercent),
            resetAt: periodEnd,
            plan,
            planClass: plan ? getPlanClass(plan) : 'plan-default',
            unit: 'percent'
        },
        user: {
            email: usageData.account || null
        },
        items,
        raw: usageData
    };
}

/**
 * 格式化 Codex 用量
 */
export function formatCodexUsage(usageData) {
    if (!usageData) return null;

    // 兼容蛇形命名（原生 API）和驼峰命名
    const rateLimit = usageData.rate_limit || usageData.rateLimit;
    const primary = rateLimit?.primary_window || rateLimit?.primaryWindow;
    const secondary = rateLimit?.secondary_window || rateLimit?.secondaryWindow;
    const resetCredits = usageData.rate_limit_reset_credits || usageData.rateLimitResetCredits;
    const resetAvailableCount = Number(resetCredits?.available_count ?? resetCredits?.availableCount ?? 0) || 0;
    
    const primaryUsedPercent = primary?.used_percent ?? primary?.usedPercent ?? 0;
    const secondaryUsedPercent = secondary?.used_percent ?? secondary?.usedPercent ?? 0;

    let maxUsedPercent = 0;
    let worstResetAtTimestamp = null;
    const items = [];

    // 1. 处理主窗口（短时间配额）
    if (primary) {
        maxUsedPercent = primaryUsedPercent;
        worstResetAtTimestamp = primary?.reset_at ?? primary?.resetAt;
        
        items.push({
            id: 'primary_window',
            label: 'Request Quota (5h)',
            used: primaryUsedPercent,
            limit: 100,
            percent: primaryUsedPercent,
            unit: 'percent',
            status: getStatus(primaryUsedPercent),
            resetAt: formatTimestamp(worstResetAtTimestamp)
        });
    }

    // 2. 比较并添加从窗口（周配额）
    if (secondary) {
        const secondaryResetAt = secondary?.reset_at ?? secondary?.resetAt;
        if (secondaryUsedPercent > maxUsedPercent) {
            maxUsedPercent = secondaryUsedPercent;
            worstResetAtTimestamp = secondaryResetAt;
        }
        
        items.push({
            id: 'secondary_window',
            label: 'Weekly Limit',
            used: secondaryUsedPercent,
            limit: 100,
            percent: secondaryUsedPercent,
            unit: 'percent',
            status: getStatus(secondaryUsedPercent),
            resetAt: formatTimestamp(secondaryResetAt)
        });
    }

    const plan = usageData.plan_type || usageData.planType || 'FREE';

    return {
        summary: {
            usedPercent: maxUsedPercent,
            status: getStatus(maxUsedPercent),
            resetAt: formatTimestamp(worstResetAtTimestamp),
            plan,
            planClass: getPlanClass(plan),
            unit: 'percent',
            resetAvailableCount
        },
        user: { 
            email: usageData.account || null
        },
        items,
        raw: usageData
    };
}
