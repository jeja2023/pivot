const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeBoolean(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function normalizeOriginList(value) {
    const items = Array.isArray(value) ? value : String(value || '').split(',');
    return items
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .map(item => {
            try {
                return new URL(item).origin;
            } catch (_err) {
                return item.toLowerCase();
            }
        });
}

function isLoopbackUpdateUrl(url) {
    const hostname = String(url.hostname || '').toLowerCase();
    return LOOPBACK_HOSTS.has(hostname);
}

function isOriginAllowed(url, allowedOrigins = []) {
    const allowed = normalizeOriginList(allowedOrigins);
    if (allowed.length === 0) return true;
    const origin = url.origin.toLowerCase();
    const host = url.hostname.toLowerCase();
    return allowed.some(item => item === origin || item === host);
}

function assertHttpUpdatePolicy(url, options = {}) {
    if (url.protocol !== 'http:') return;

    const allowedOrigins = normalizeOriginList(options.allowedOrigins);
    const allowConfiguredHttp = options.allowInsecureHttp === true;
    const allowLoopbackDevHttp = normalizeBoolean(options.env?.PIVOT_DESKTOP_ALLOW_INSECURE_UPDATE_FEED)
        && isLoopbackUpdateUrl(url);

    if (!allowConfiguredHttp && !allowLoopbackDevHttp) {
        throw new Error('自动更新 URL 必须使用 HTTPS 协议，除非显式配置 allowInsecureHttp=true 或启用本地回环开发源。');
    }
    if (allowConfiguredHttp && !isLoopbackUpdateUrl(url) && allowedOrigins.length === 0) {
        throw new Error('当对非回环地址启用 allowInsecureHttp=true 时，必须配置 allowedOrigins 来源白名单。');
    }
}

function normalizeUpdateFeedUrl(value, options = {}) {
    const raw = String(value || '').trim();
    if (!raw) {
        if (options.required) throw new Error('自动更新配置缺少必需的 url。');
        return '';
    }

    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('自动更新 url 必须使用 http 或 https 协议。');
    }

    assertHttpUpdatePolicy(url, options);

    if (!isOriginAllowed(url, options.allowedOrigins)) {
        throw new Error('自动更新 url 源地址未在 allowedOrigins 允许列表中。');
    }

    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}

function assertAllowedUpdateFeedUrl(value, options = {}) {
    return normalizeUpdateFeedUrl(value, { ...options, required: true });
}

module.exports = {
    assertAllowedUpdateFeedUrl,
    isLoopbackUpdateUrl,
    isOriginAllowed,
    normalizeOriginList,
    normalizeUpdateFeedUrl
};