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
        throw new Error('config.autoUpdate.url must use https unless config.autoUpdate.allowInsecureHttp=true or explicit loopback dev feeds are enabled.');
    }
    if (allowConfiguredHttp && !isLoopbackUpdateUrl(url) && allowedOrigins.length === 0) {
        throw new Error('config.autoUpdate.allowedOrigins is required when config.autoUpdate.allowInsecureHttp=true for non-loopback http feeds.');
    }
}

function normalizeUpdateFeedUrl(value, options = {}) {
    const raw = String(value || '').trim();
    if (!raw) {
        if (options.required) throw new Error('config.autoUpdate.url is required.');
        return '';
    }

    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('config.autoUpdate.url must use http or https.');
    }

    assertHttpUpdatePolicy(url, options);

    if (!isOriginAllowed(url, options.allowedOrigins)) {
        throw new Error('config.autoUpdate.url origin is not in config.autoUpdate.allowedOrigins.');
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