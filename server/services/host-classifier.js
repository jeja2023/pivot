const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const os = require('os');

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
    return normalized.includes('.');
}

async function addResolvedHostAliases(names) {
    const hosts = Array.from(names).filter(shouldResolveHostAlias);
    const results = await Promise.allSettled(hosts.map(host => dns.lookup(host, { all: true, verbatim: true })));
    results.forEach(result => {
        if (result.status !== 'fulfilled') return;
        (result.value || []).forEach(record => {
            if (record?.address) names.add(String(record.address).toLowerCase());
        });
    });
    return names;
}

async function isLocalModelHostAsync(host, localNames) {
    if (isLocalModelHost(host, localNames)) return true;
    const normalized = normalizeHostAlias(host);
    if (!shouldResolveHostAlias(normalized)) return false;
    try {
        const records = await dns.lookup(normalized, { all: true, verbatim: true });
        return records.some(record => localNames.has(String(record.address || '').toLowerCase()));
    } catch (_err) {
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
        // Conservative defaults above are enough when OS inspection is unavailable.
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
    normalizeHostAlias,
    shouldResolveHostAlias
};
