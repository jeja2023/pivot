const crypto = require('crypto');
const http = require('http');
const https = require('https');

function isOnlineUpdateSwitchEnabled() {
    return String(process.env.PIVOT_ONLINE_UPDATE_ENABLED || '').trim().toLowerCase() === 'true';
}

function getUpdaterConfig() {
    const baseUrl = String(process.env.PIVOT_UPDATER_URL || '').trim().replace(/\/+$/, '');
    const token = String(process.env.PIVOT_UPDATER_TOKEN || '').trim();
    const switchEnabled = isOnlineUpdateSwitchEnabled();
    const configured = !!(baseUrl && token);
    return {
        enabled: switchEnabled && configured,
        switchEnabled,
        configured,
        baseUrl,
        token
    };
}

function getUpdaterPublicConfig() {
    const cfg = getUpdaterConfig();
    return {
        enabled: cfg.enabled,
        switchEnabled: cfg.switchEnabled,
        configured: cfg.configured,
        mode: process.env.PIVOT_UPDATER_MODE || 'git-build',
        repository: process.env.PIVOT_UPDATE_REPO || '',
        branch: process.env.PIVOT_UPDATE_BRANCH || ''
    };
}

async function requestUpdater(pathname, { method = 'GET', body } = {}) {
    const cfg = getUpdaterConfig();
    if (!cfg.enabled) {
        const err = new Error(cfg.switchEnabled
            ? 'Online update is not fully configured. Set PIVOT_UPDATER_URL and PIVOT_UPDATER_TOKEN.'
            : 'Online update is disabled. Set PIVOT_ONLINE_UPDATE_ENABLED=true to enable it.');
        err.statusCode = 503;
        throw err;
    }

    const url = new URL(`${cfg.baseUrl}${pathname}`);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const { statusCode, text } = await new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.token}`,
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            },
            timeout: 30000
        }, res => {
            let responseText = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { responseText += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode || 0, text: responseText }));
        });
        req.on('timeout', () => {
            req.destroy(new Error('Updater request timed out'));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch (e) {
        data = { error: text || 'Updater returned a non-JSON response' };
    }
    if (statusCode < 200 || statusCode >= 300) {
        const err = new Error(data.error || `Updater request failed (${statusCode})`);
        err.statusCode = statusCode;
        err.details = data;
        throw err;
    }
    return data;
}

function createUpdateRunId() {
    return `upd-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
    createUpdateRunId,
    getUpdaterConfig,
    getUpdaterPublicConfig,
    requestUpdater
};
