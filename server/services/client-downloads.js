'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const downloadsRoot = path.resolve(__dirname, '../../downloads');

function normalizeHelperManifest(value) {
    if (!value || value.schemaVersion !== 1 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version || '')
        || !['development', 'release'].includes(value.channel) || !Number.isSafeInteger(value.size) || value.size <= 0
        || !/^[a-f0-9]{64}$/i.test(value.sha256 || '')) return null;
    const filename = `PivotLocalHelper-${value.channel === 'development' ? 'Dev-' : ''}Setup-${value.version}.exe`;
    if (value.filename !== filename) return null;
    return { version: value.version, channel: value.channel, filename, size: value.size, sha256: value.sha256.toLowerCase() };
}

async function regularFile(root, filename) {
    const file = path.join(root, filename);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || path.dirname(await fs.realpath(file)) !== await fs.realpath(root)) return null;
    return stat;
}

async function getClientDownloads({ root = downloadsRoot, desktopEnabled = process.env.ENABLE_DESKTOP_DOWNLOAD === 'true' } = {}) {
    const result = { desktop: { available: false }, localHelper: { available: false, platform: 'Windows x64' } };
    if (desktopEnabled) {
        try { if (await regularFile(root, 'Pivot-Setup.exe')) result.desktop = { available: true, url: '/downloads/Pivot-Setup.exe', platform: 'Windows' }; } catch (_) {}
    }
    try {
        const folder = path.join(root, 'local-helper');
        if (path.dirname(await fs.realpath(folder)) !== await fs.realpath(root)) return result;
        const manifestStat = await regularFile(folder, 'latest.json');
        if (!manifestStat || manifestStat.size > 16384) return result;
        const manifest = normalizeHelperManifest(JSON.parse(await fs.readFile(path.join(folder, 'latest.json'), 'utf8')));
        if (!manifest) return result;
        const file = await regularFile(folder, manifest.filename);
        if (file?.size !== manifest.size) return result;
        result.localHelper = { available: true, platform: 'Windows x64', ...manifest, url: '/downloads/local-helper/' + encodeURIComponent(manifest.filename) };
    } catch (_) { /* 尚未发布或文件不完整时不暴露无效下载地址。 */ }
    return result;
}

module.exports = { getClientDownloads, normalizeHelperManifest };
