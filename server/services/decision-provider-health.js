'use strict';

const { readTypedEnv } = require('../config/env-registry');

function getLayaDecisionHealthConfig(env = process.env) {
    return {
        enabled: readTypedEnv('PIVOT_LAYA_DECISION_ENABLED', env),
        url: readTypedEnv('PIVOT_LAYA_DECISION_URL', env),
        healthUrl: readTypedEnv('PIVOT_LAYA_DECISION_HEALTH_URL', env),
        timeoutMs: readTypedEnv('PIVOT_LAYA_DECISION_HEALTH_TIMEOUT_MS', env),
        version: readTypedEnv('PIVOT_LAYA_DECISION_VERSION', env)
    };
}

async function checkLayaDecisionHealth({ env = process.env, fetchFn = globalThis.fetch } = {}) {
    const config = getLayaDecisionHealthConfig(env);
    if (!config.enabled) return { status: 'ok', enabled: false, message: 'Laya 决策服务未启用' };
    if (!config.url) return { status: 'error', enabled: true, message: 'Laya 决策服务已启用但未配置地址' };
    if (!config.healthUrl) return { status: 'degraded', enabled: true, message: 'Laya 决策服务未配置健康检查地址' };
    if (!config.version) return { status: 'error', enabled: true, message: 'Laya 决策服务已启用但未配置已审核模型版本' };
    if (typeof fetchFn !== 'function') return { status: 'error', enabled: true, message: '当前运行时不支持健康检查请求' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const response = await fetchFn(config.healthUrl, { method: 'GET', signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) return { status: 'error', enabled: true, message: 'Laya 健康检查返回 HTTP ' + response.status };
        let body = {};
        try { body = await response.json(); } catch (_) {}
        const reportedVersion = String(body?.modelVersion || body?.version || '').trim();
        if (config.version && reportedVersion && config.version !== reportedVersion) {
            return { status: 'degraded', enabled: true, modelVersion: reportedVersion, message: 'Laya 健康检查版本与已审核版本不一致' };
        }
        return { status: 'ok', enabled: true, modelVersion: reportedVersion || config.version, message: 'Laya 决策服务健康' };
    } catch (error) {
        const timeout = error?.name === 'AbortError';
        return { status: 'error', enabled: true, message: timeout ? 'Laya 健康检查超时' : String(error?.message || 'Laya 健康检查失败').slice(0, 240) };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    checkLayaDecisionHealth,
    getLayaDecisionHealthConfig
};
