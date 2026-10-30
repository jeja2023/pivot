// @ts-check
function isStealthTarget(requestUrl, targetUrl) {
    try {
        const target = new URL(targetUrl);
        return ['http:', 'https:'].includes(target.protocol) && new URL(requestUrl).origin === target.origin;
    } catch (_) {
        return false;
    }
}

function publicDesktopConfig(config) {
    if (!config) return config;
    const { stealthSecret: _stealthSecret, ...publicConfig } = config;
    return publicConfig;
}

function stripStealthHeaders(headers) {
    for (const name of Object.keys(headers || {})) {
        if (['x-pivot-stealth-time', 'x-pivot-stealth-token', 'x-pivot-stealth-token-v2', 'x-pivot-stealth-version'].includes(name.toLowerCase())) delete headers[name];
    }
    return headers;
}

function createStealthHeaders(secret, targetUrl, now = Date.now()) {
    const host = new URL(targetUrl).host.toLowerCase();
    const timestamp = String(now);
    return {
        'X-Pivot-Stealth-Time': timestamp,
        'X-Pivot-Stealth-Version': '2',
        'X-Pivot-Stealth-Token': crypto.createHmac('sha256', secret).update(timestamp).digest('hex'),
        'X-Pivot-Stealth-Token-V2': crypto.createHmac('sha256', secret).update(`${timestamp}:${host}`).digest('hex')
    };
}

module.exports = { createStealthHeaders, isStealthTarget, publicDesktopConfig, stripStealthHeaders };
const crypto = require('node:crypto');

