const crypto = require('crypto');
const http = require('http');
const https = require('https');

const UPDATER_LOG_TIME_ZONE = process.env.PIVOT_LOG_TIME_ZONE || 'Asia/Shanghai';
const UPDATER_LOG_TIME_OFFSET = '+08:00';
const updaterLogTimeFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: UPDATER_LOG_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
});

function formatUpdaterTimestamp(value) {
    if (!value) return value;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const parts = Object.fromEntries(updaterLogTimeFormatter.formatToParts(date).map(part => [part.type, part.value]));
    const millis = String(date.getMilliseconds()).padStart(3, '0');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${millis}${UPDATER_LOG_TIME_OFFSET}`;
}

function normalizeUpdaterLogLine(line) {
    return String(line || '').replace(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+Z)\]/, (_match, timestamp) => {
        return `[${formatUpdaterTimestamp(timestamp)}]`;
    });
}

function normalizeUpdaterStateTimestamps(state) {
    if (!state || typeof state !== 'object') return state;
    const next = { ...state };
    ['updatedAt', 'startedAt', 'finishedAt'].forEach(key => {
        if (next[key]) next[key] = formatUpdaterTimestamp(next[key]);
    });
    if (Array.isArray(next.logs)) {
        next.logs = next.logs.map(normalizeUpdaterLogLine);
    }
    return next;
}

function normalizeUpdaterResponse(data) {
    if (!data || typeof data !== 'object') return data;
    const next = { ...data };
    if (next.state) next.state = normalizeUpdaterStateTimestamps(next.state);
    return next;
}

function normalizeUpdaterError(error) {
    const message = error?.message || String(error || '');
    if (/ENOTFOUND\s+pivot-updater/i.test(message) || /getaddrinfo\s+ENOTFOUND/i.test(message)) {
        return 'Updater sidecar 未连接：请确认已执行 docker compose --profile online-update up -d --build pivot-updater，且主应用与 pivot-updater 在同一 compose 网络中。';
    }
    if (/ECONNREFUSED/i.test(message)) {
        return 'Updater sidecar 拒绝连接：请确认 pivot-updater 容器正在运行，并检查 PIVOT_UPDATER_URL 端口是否正确。';
    }
    if (/timed out|timeout/i.test(message)) {
        return 'Updater sidecar 请求超时：请检查容器网络、Docker socket 权限和服务器负载。';
    }
    return message;
}

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
        err.code = cfg.switchEnabled ? 'UPDATER_NOT_CONFIGURED' : 'UPDATER_DISABLED';
        err.statusCode = 503;
        throw err;
    }

    const url = new URL(`${cfg.baseUrl}${pathname}`);
    const payload = body === undefined ? '' : JSON.stringify(body);
    let response;
    try {
        response = await new Promise((resolve, reject) => {
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
    } catch (e) {
        const err = new Error(normalizeUpdaterError(e));
        err.cause = e;
        throw err;
    }
    const { statusCode, text } = response;
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
    return normalizeUpdaterResponse(data);
}

function createUpdateRunId() {
    return `upd-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = {
    createUpdateRunId,
    formatUpdaterTimestamp,
    getUpdaterConfig,
    getUpdaterPublicConfig,
    normalizeUpdaterError,
    normalizeUpdaterLogLine,
    normalizeUpdaterResponse,
    normalizeUpdaterStateTimestamps,
    requestUpdater
};
