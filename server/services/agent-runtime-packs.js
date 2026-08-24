const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { assertNetworkPolicyUrl, normalizeNetworkPolicy } = require('./agent-network-policy');
const { assertSafeOutboundHost, createSafeHttpAgents, isLoopbackHost } = require('../security');

const PACK_TYPES = new Set(['data', 'browser']);
const MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024;

function safePart(value, fallback = 'pack') {
    const text = String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    return text || fallback;
}

function normalizeRuntimePackManifest(value = {}) {
    const manifest = value && typeof value === 'object' ? value : {};
    const type = String(manifest.type || '').toLowerCase();
    if (!PACK_TYPES.has(type)) throw new Error('运行时资源包类型只能是 data 或 browser。');
    const id = safePart(manifest.id, 'runtime');
    const version = safePart(manifest.version, '0.0.0');
    const digest = String(manifest.sha256 || manifest.digest || '').replace(/^sha256:/i, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('运行时资源包必须提供 SHA256 摘要。');
    return { ...manifest, type, id, version, sha256: digest, size: Math.max(Number(manifest.size) || 0, 0), url: String(manifest.url || '').trim() };
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    let size = 0;
    for await (const chunk of stream) { size += chunk.length; hash.update(chunk); }
    return { sha256: hash.digest('hex'), size };
}

async function verifyRuntimePack(filePath, manifest) {
    const normalized = normalizeRuntimePackManifest(manifest);
    const actual = await sha256File(filePath);
    const errors = [];
    if (actual.size > MAX_PACK_BYTES) errors.push('运行时资源包超过大小限制。');
    if (actual.sha256 !== normalized.sha256) errors.push('运行时资源包 SHA256 校验失败。');
    if (normalized.size && actual.size !== normalized.size) errors.push('运行时资源包大小校验失败。');
    return { valid: errors.length === 0, errors, manifest: normalized, actual };
}

function runtimePackRoot(options = {}) {
    return path.resolve(options.root || process.env.PIVOT_RUNTIME_PACK_ROOT || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-runtime-packs'));
}

async function installRuntimePack(filePath, manifest, options = {}) {
    const verified = await verifyRuntimePack(filePath, manifest);
    if (!verified.valid) {
        const error = new Error(verified.errors.join('；'));
        error.code = 'AGENT_RUNTIME_PACK_INVALID';
        error.details = verified;
        throw error;
    }
    const { type, id, version } = verified.manifest;
    const root = runtimePackRoot(options);
    const targetDir = path.join(root, type, id, version);
    await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });
    const target = path.join(targetDir, 'pack.bundle');
    await fsp.copyFile(filePath, target);
    await fsp.writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify({ ...verified.manifest, installedAt: new Date().toISOString(), file: 'pack.bundle' }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    return { ...verified, targetDir, target };
}

async function syncRuntimePack(manifest, options = {}) {
    const normalized = normalizeRuntimePackManifest(manifest);
    if (!normalized.url) throw new Error('运行时资源包同步需要提供 LAN URL。');
    const policy = normalizeNetworkPolicy(options.networkPolicy || {});
    const parsed = await assertNetworkPolicyUrl(normalized.url, policy, { requireAllowlist: true });
    await assertSafeOutboundHost(parsed.hostname, { blockPrivate: false });
    const response = await axios.get(parsed.toString(), {
        responseType: 'stream',
        timeout: Math.max(1000, Number.parseInt(options.timeoutMs || '120000', 10) || 120000),
        maxContentLength: MAX_PACK_BYTES,
        maxBodyLength: MAX_PACK_BYTES,
        validateStatus: status => status >= 200 && status < 300,
        signal: options.signal,
        proxy: false,
        ...createSafeHttpAgents({
            blockPrivate: false,
            allowExplicitLoopback: policy.block_loopback === false && isLoopbackHost(parsed.hostname)
        })
    });
    const temp = path.join(options.tempRoot || os.tmpdir(), `pivot-pack-${crypto.randomUUID()}.bundle`);
    await fsp.mkdir(path.dirname(temp), { recursive: true });
    const file = await fsp.open(temp, 'w');
    let size = 0;
    try {
        for await (const chunk of response.data) {
            size += chunk.length;
            if (size > MAX_PACK_BYTES) throw new Error('运行时资源包超过下载大小限制。');
            await file.write(chunk);
        }
    } finally { await file.close(); }
    try { return await installRuntimePack(temp, normalized, options); }
    finally { await fsp.rm(temp, { force: true }); }
}

async function listRuntimePacks(options = {}) {
    const root = runtimePackRoot(options);
    const output = [];
    for (const type of PACK_TYPES) {
        const typeRoot = path.join(root, type);
        if (!fs.existsSync(typeRoot)) continue;
        for (const id of await fsp.readdir(typeRoot)) {
            const idRoot = path.join(typeRoot, id);
            for (const version of await fsp.readdir(idRoot)) {
                const manifestPath = path.join(idRoot, version, 'manifest.json');
                if (fs.existsSync(manifestPath)) output.push(JSON.parse(await fsp.readFile(manifestPath, 'utf8')));
            }
        }
    }
    return output;
}

module.exports = { MAX_PACK_BYTES, PACK_TYPES, installRuntimePack, listRuntimePacks, normalizeRuntimePackManifest, sha256File, syncRuntimePack, verifyRuntimePack };
