const { assertSafeOutboundHost, normalizeHostForPolicy, isPrivateHost, isLoopbackHost } = require('../security');

const DEFAULT_NETWORK_POLICY = Object.freeze({
    allowed_origins: [],
    allowed_ports: [80, 443, 8080],
    allow_redirect: false,
    allowed_redirect_origins: [],
    block_private_ranges: true,
    block_loopback: true,
    block_link_local: true,
    max_download_size_bytes: 52428800
});

function normalizeNetworkPolicy(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        ...DEFAULT_NETWORK_POLICY,
        ...source,
        allowed_origins: Array.isArray(source.allowed_origins || source.allowedOrigins) ? (source.allowed_origins || source.allowedOrigins).map(String) : [],
        allowed_redirect_origins: Array.isArray(source.allowed_redirect_origins || source.allowedRedirectOrigins) ? (source.allowed_redirect_origins || source.allowedRedirectOrigins).map(String) : [],
        allowed_ports: Array.isArray(source.allowed_ports || source.allowedPorts) ? (source.allowed_ports || source.allowedPorts).map(Number).filter(Number.isInteger) : [...DEFAULT_NETWORK_POLICY.allowed_ports]
    };
}

function originOf(rawUrl) {
    const parsed = new URL(String(rawUrl || ''));
    return { parsed, origin: parsed.origin.toLowerCase() };
}

function originAllowed(origin, allowed = []) {
    if (!allowed.length) return true;
    return allowed.some(item => {
        try {
            const candidate = new URL(item).origin.toLowerCase();
            return candidate === origin;
        } catch (_) { return false; }
    });
}

function validateNetworkPolicyUrl(rawUrl, policy = {}, options = {}) {
    const normalized = normalizeNetworkPolicy(policy);
    const { parsed, origin } = originOf(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('网络策略仅允许 HTTP/HTTPS。');
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!normalized.allowed_ports.includes(port)) throw new Error(`网络端口不在白名单中：${port}`);
    if (options.requireAllowlist === true && normalized.allowed_origins.length === 0) throw new Error('自主 Agent 网络策略必须显式配置 Origin 白名单。');
    if (!originAllowed(origin, normalized.allowed_origins) && !options.isRedirect) throw new Error('网络目标 Origin 不在白名单中。');
    const host = normalizeHostForPolicy(parsed.hostname);
    if (normalized.block_loopback && isLoopbackHost(host)) throw new Error('网络策略禁止访问 loopback。');
    if (normalized.block_private_ranges && isPrivateHost(host)) throw new Error('网络策略禁止访问非白名单私有地址。');
    if (normalized.block_link_local && (host.startsWith('169.254.') || host.startsWith('fe80:'))) throw new Error('网络策略禁止访问 link-local 地址。');
    return parsed;
}

async function assertNetworkPolicyUrl(rawUrl, policy = {}, options = {}) {
    const parsed = validateNetworkPolicyUrl(rawUrl, policy, options);
    await assertSafeOutboundHost(parsed.hostname, {
        blockPrivate: normalizeNetworkPolicy(policy).block_private_ranges,
        allowExplicitLoopback: false
    });
    return parsed;
}

function assertRedirectAllowed(fromUrl, toUrl, policy = {}) {
    const normalized = normalizeNetworkPolicy(policy);
    const from = originOf(fromUrl).origin;
    const target = originOf(toUrl).origin;
    if (from === target) return true;
    if (!normalized.allow_redirect) throw new Error('网络策略禁止跨 Origin 重定向。');
    if (!originAllowed(target, normalized.allowed_redirect_origins)) throw new Error('重定向目标不在白名单中。');
    return true;
}

module.exports = {
    DEFAULT_NETWORK_POLICY,
    assertNetworkPolicyUrl,
    assertRedirectAllowed,
    normalizeNetworkPolicy,
    validateNetworkPolicyUrl
};
