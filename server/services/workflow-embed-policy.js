'use strict';

const EMBED_ORIGIN_ENV = 'PIVOT_EMBED_ALLOWED_ORIGINS';

function getWorkflowEmbedAllowedOrigins(env = process.env) {
    return [...new Set(String(env[EMBED_ORIGIN_ENV] || '')
        .split(',')
        .map(value => String(value || '').trim())
        .map(value => {
            try {
                const parsed = new URL(value);
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
                return parsed.origin;
            } catch (_) {
                return '';
            }
        })
        .filter(Boolean))];
}

function normalizeWorkflowEmbedUrl(value, { allowExternal = false, env = process.env } = {}) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('呈现节点需要提供资源地址。');
    if (/^\/(?!\/)/.test(raw)) return raw;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_) {
        throw new Error('资源地址必须是同源路径或合法的 HTTP/HTTPS 地址。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('资源地址只允许 HTTP/HTTPS 地址。');
    if (parsed.username || parsed.password) throw new Error('资源地址不能包含账号或密码。');
    if (!allowExternal && !getWorkflowEmbedAllowedOrigins(env).includes(parsed.origin)) {
        throw new Error('外部嵌入来源未获管理员批准，请改用同源路径或配置 PIVOT_EMBED_ALLOWED_ORIGINS。');
    }
    return parsed.toString();
}

module.exports = { getWorkflowEmbedAllowedOrigins, normalizeWorkflowEmbedUrl };
