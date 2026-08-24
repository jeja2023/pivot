const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const os = require('os');

const DEFAULT_DNS_LOOKUP_TIMEOUT_MS = 2000;

function getDnsLookupTimeoutMs() {
    const configured = Number.parseInt(process.env.PIVOT_DNS_LOOKUP_TIMEOUT_MS || '', 10);
    if (!Number.isFinite(configured)) return DEFAULT_DNS_LOOKUP_TIMEOUT_MS;
    return Math.min(Math.max(configured, 250), 10000);
}

async function lookupWithTimeout(host, options = {}) {
    const timeoutMs = getDnsLookupTimeoutMs();
    let timer = null;
    const lookup = dns.lookup(host, options);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`DNS lookup timeout for ${host}`);
            error.code = 'DNS_LOOKUP_TIMEOUT';
            reject(error);
        }, timeoutMs);
    });
    return Promise.race([lookup, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function normalizeHostAlias(value) {
    let host = String(value || '').trim();
    if (!host) return '';
    if (host.includes(',')) host = host.split(',')[0].trim();
    if (!host) return '';

    try {
        host = new URL(host.includes('://') ? host : `http://${host}`).hostname;
    } catch (e) {
        host = host.replace(/\/.*$/, '');
        if (host.startsWith('[')) {
            const bracketEnd = host.indexOf(']');
            host = bracketEnd >= 0 ? host.slice(1, bracketEnd) : host.slice(1);
        } else if ((host.match(/:/g) || []).length === 1) {
            host = host.split(':')[0];
        }
    }

    host = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host.includes('%')) host = host.split('%')[0];
    return host;
}

function addHostAlias(names, value) {
    String(value || '')
        .split(',')
        .map(normalizeHostAlias)
        .filter(Boolean)
        .forEach(host => names.add(host));
}

function getRequestHostAliases(req) {
    if (!req) return [];
    return [
        req.hostname,
        req.headers?.host,
        req.headers?.['x-forwarded-host'],
        req.headers?.['x-forwarded-server']
    ].filter(Boolean);
}

function isLikelyContainerRuntime() {
    const trustDockerHosts = String(process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS || '').trim().toLowerCase();
    if (trustDockerHosts === 'true') return true;
    if (trustDockerHosts === 'false') return false;

    const explicitContainer = String(process.env.PIVOT_RUNNING_IN_CONTAINER || '').trim().toLowerCase();
    if (explicitContainer === 'true') return true;
    if (explicitContainer === 'false') return false;
    if (process.env.KUBERNETES_SERVICE_HOST) return false;

    try {
        if (fs.existsSync('/.dockerenv')) return true;
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        return /docker|containerd|kubepods|libpod/i.test(cgroup);
    } catch (_err) {
        return false;
    }
}

const KNOWN_PUBLIC_TLDS = new Set([
    'com', 'net', 'org', 'cn', 'io', 'ai', 'co', 'app', 'dev', 'xyz', 'cc', 'top',
    'me', 'info', 'biz', 'us', 'uk', 'jp', 'hk', 'tw', 'de', 'fr', 'ru', 'in', 'vip',
    'cloud', 'site', 'tech', 'online', 'store', 'space', 'fun', 'pro', 'live', 'icu',
    'link', 'work', 'world', 'agency', 'digital', 'network', 'ltd', 'zone', 'today'
]);

const KNOWN_PUBLIC_MODEL_DOMAINS = new Set([
    'openai.com', 'anthropic.com', 'deepseek.com', 'aliyuncs.com', 'aliyun.com',
    'baidu.com', 'volces.com', 'volcengine.com', 'tencent.com', 'zhipuai.cn',
    'bigmodel.cn', 'moonshot.cn', 'siliconflow.cn', 'groq.com', 'together.xyz',
    'openrouter.ai', 'mistral.ai', 'cohere.com', 'azure.com', 'cloudflare.com',
    'google.com', 'googleapis.com', 'github.com', 'huggingface.co', 'ollama.com'
]);

function isPublicRemoteHostname(host) {
    const normalized = normalizeHostAlias(host);
    if (!normalized || net.isIP(normalized)) return false;
    for (const domain of KNOWN_PUBLIC_MODEL_DOMAINS) {
        if (normalized === domain || normalized.endsWith(`.${domain}`)) return true;
    }
    const parts = normalized.split('.');
    if (parts.length >= 2) {
        const tld = parts[parts.length - 1];
        const sld = parts[parts.length - 2];
        if (KNOWN_PUBLIC_TLDS.has(tld)) {
            if (['com', 'edu', 'gov', 'net', 'org'].includes(sld) && parts.length >= 3) return true;
            return true;
        }
    }
    return false;
}

function isDockerInternalServiceHost(host) {
    const normalized = normalizeHostAlias(host);
    if (!normalized || normalized.includes('.') || net.isIP(normalized)) return false;
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(normalized)) return false;
    return isLikelyContainerRuntime();
}

function isLocalModelHost(host, localNames) {
    const normalized = normalizeHostAlias(host);
    return localNames.has(normalized) || isDockerInternalServiceHost(normalized);
}

function shouldResolveHostAlias(host) {
    const normalized = normalizeHostAlias(host);
    if (!normalized || net.isIP(normalized)) return false;
    if (['localhost', 'loopback', 'host.docker.internal'].includes(normalized)) return false;
    if (isPublicRemoteHostname(normalized)) return false;
    const disableDns = String(process.env.PIVOT_DISABLE_DNS_LOOKUP || '').trim().toLowerCase();
    if (disableDns === 'true' || disableDns === '1') return false;
    return normalized.includes('.');
}

async function addResolvedHostAliases(names) {
    const hosts = Array.from(names).filter(shouldResolveHostAlias);
    const results = await Promise.allSettled(hosts.map(host => lookupWithTimeout(host, { all: true, verbatim: true })));
    results.forEach(result => {
        if (result.status !== 'fulfilled') return;
        (result.value || []).forEach(record => {
            if (record?.address) names.add(String(record.address).toLowerCase());
        });
    });
    return names;
}

const HOST_RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;
const hostResolutionCache = new Map();

async function isLocalModelHostAsync(host, localNames) {
    if (isLocalModelHost(host, localNames)) return true;
    const normalized = normalizeHostAlias(host);
    if (!shouldResolveHostAlias(normalized)) return false;
    const now = Date.now();
    const cached = hostResolutionCache.get(normalized);
    if (cached && cached.expires > now) {
        return cached.value;
    }
    try {
        const records = await lookupWithTimeout(normalized, { all: true, verbatim: true });
        const result = records.some(record => localNames.has(String(record.address || '').toLowerCase()));
        hostResolutionCache.set(normalized, { value: result, expires: now + HOST_RESOLUTION_CACHE_TTL_MS });
        return result;
    } catch (_err) {
        hostResolutionCache.set(normalized, { value: false, expires: now + HOST_RESOLUTION_CACHE_TTL_MS });
        return false;
    }
}

function getLocalHostnames({ requestHosts = [], publicUrl = process.env.PUBLIC_URL || '' } = {}) {
    const names = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal', 'loopback']);
    try {
        const hostname = os.hostname().toLowerCase();
        names.add(hostname);
        if (hostname.includes('.')) {
            names.add(hostname.split('.')[0]);
        }

        const interfaces = os.networkInterfaces();
        Object.values(interfaces).flat().filter(Boolean).forEach(item => {
            if (item.address) {
                names.add(String(item.address).toLowerCase());
                if (item.address.includes('%')) {
                    names.add(item.address.split('%')[0].toLowerCase());
                }
            }
        });
    } catch (e) {
        // 当无法直接检查操作系统时，采用上述保守默认值
    }
    addHostAlias(names, publicUrl);
    addHostAlias(names, process.env.PUBLIC_URL || '');
    addHostAlias(names, process.env.CORS_ORIGIN || '');
    addHostAlias(names, process.env.PIVOT_HOST || '');
    addHostAlias(names, process.env.PIVOT_ADVERTISE_HOSTS || '');
    addHostAlias(names, process.env.PIVOT_LOCAL_MODEL_HOSTS || '');
    requestHosts.forEach(host => addHostAlias(names, host));
    return names;
}

const RESOLVED_HOSTNAMES_TTL_MS = 60 * 1000;
const resolvedHostnamesCache = new Map();

async function getResolvedLocalHostnames(options = {}) {
    const { requestHosts = [], publicUrl = '' } = options;
    const cacheKey = `${publicUrl}|${Array.isArray(requestHosts) ? requestHosts.slice().sort().join(',') : ''}`;
    const now = Date.now();
    const cached = resolvedHostnamesCache.get(cacheKey);
    if (cached && cached.expires > now) {
        return cached.value;
    }
    const names = getLocalHostnames(options);
    const resolved = await addResolvedHostAliases(names);
    resolvedHostnamesCache.set(cacheKey, { value: resolved, expires: now + RESOLVED_HOSTNAMES_TTL_MS });
    return resolved;
}

module.exports = {
    addHostAlias,
    addResolvedHostAliases,
    getLocalHostnames,
    getRequestHostAliases,
    getResolvedLocalHostnames,
    isDockerInternalServiceHost,
    isLikelyContainerRuntime,
    isLocalModelHost,
    isLocalModelHostAsync,
    isPublicRemoteHostname,
    normalizeHostAlias,
    shouldResolveHostAlias
};
