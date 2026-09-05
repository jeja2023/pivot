'use strict';

const MAX_TRUSTED_EXTERNAL_ORIGINS = 32;

function normalizeTrustedExternalOrigins(value) {
    const entries = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    const origins = [];
    for (const entry of entries) {
        const raw = String(entry || '').trim();
        if (!raw) continue;
        let parsed;
        try {
            parsed = new URL(raw);
        } catch (_) {
            throw new Error(`外部站点白名单包含无效 URL：${raw}`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw new Error('外部站点白名单只允许不含账号信息的 HTTP/HTTPS Origin。');
        }
        if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
            throw new Error('外部站点白名单必须填写 Origin，不能包含路径、查询参数或片段。');
        }
        const origin = parsed.origin.toLowerCase();
        if (!origins.includes(origin)) origins.push(origin);
        if (origins.length >= MAX_TRUSTED_EXTERNAL_ORIGINS) break;
    }
    return origins;
}

function isTrustedExternalNavigation(targetUrl, currentTargetUrl, options = {}) {
    if (options.allowExternalOpen !== true) return false;
    let target;
    try {
        target = new URL(String(targetUrl || ''));
    } catch (_) {
        return false;
    }
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    try {
        if (currentTargetUrl && new URL(currentTargetUrl).origin === target.origin) return false;
    } catch (_) {}
    try {
        return normalizeTrustedExternalOrigins(options.allowedExternalOrigins).includes(target.origin.toLowerCase());
    } catch (_) {
        return false;
    }
}

module.exports = {
    MAX_TRUSTED_EXTERNAL_ORIGINS,
    isTrustedExternalNavigation,
    normalizeTrustedExternalOrigins
};
