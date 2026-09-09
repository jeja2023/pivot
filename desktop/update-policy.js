const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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

function assertHttpUpdatePolicy(url, _options = {}) {
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('自动更新 URL 必须使用 HTTP 或 HTTPS 协议。');
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
