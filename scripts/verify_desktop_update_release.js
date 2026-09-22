'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function readYaml(filePath, label) {
    if (!fs.existsSync(filePath)) throw new Error(`更新发布验收缺少 ${label}：${filePath}`);
    try {
        return yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
    } catch (error) {
        throw new Error(`更新发布验收无法解析 ${label}：${error.message}`);
    }
}

function resolveUpdateFeedUrl(config = {}) {
    const autoUpdate = config?.autoUpdate || {};
    const rawUrl = String(autoUpdate.url || '').trim()
        || new URL(String(autoUpdate.path || '/downloads/'), String(config.remoteUrl || '')).toString();
    const url = new URL(rawUrl);
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
}

function sha512Base64(filePath) {
    return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function assertFile(filePath, label) {
    if (!fs.existsSync(filePath)) throw new Error(`更新发布验收缺少 ${label}：${filePath}`);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`更新发布验收发现空的 ${label}：${filePath}`);
    return stat;
}

function normalizePublisherNames(value) {
    return (Array.isArray(value) ? value : [value])
        .map(item => String(item || '').trim())
        .filter(Boolean);
}

function verifyDesktopUpdateRelease({ downloadsDir, resourcesDir, version, publisherName, allowIntranetSelfSigned } = {}) {
    const safeVersion = String(version || '').trim();
    const publisher = String(publisherName || '').trim();
    const allowSelfSigned = allowIntranetSelfSigned === true
        || String(process.env.PIVOT_ALLOW_INTRANET_SELF_SIGNED || '').trim().toLowerCase() === 'true';
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(safeVersion)) throw new Error('更新发布验收缺少有效版本号。');
    if (!publisher || (publisher === 'Pivot Local Dev' && !allowSelfSigned)) throw new Error('更新发布验收要求受信任的 Windows 签名发布者，不能使用 Pivot Local Dev。');

    const updateDir = path.resolve(String(downloadsDir || ''));
    const resources = path.resolve(String(resourcesDir || ''));
    const installerName = `Pivot Setup ${safeVersion}.exe`;
    const installerPath = path.join(updateDir, installerName);
    const blockmapPath = path.join(updateDir, `${installerName}.blockmap`);
    const latestPath = path.join(updateDir, 'latest.yml');
    const installerStat = assertFile(installerPath, 'Windows 安装器');
    assertFile(blockmapPath, 'Windows 安装器 blockmap');

    const latest = readYaml(latestPath, 'latest.yml');
    if (String(latest.version || '') !== safeVersion) throw new Error(`latest.yml 版本不匹配：期望 ${safeVersion}，实际 ${latest.version || '<empty>'}。`);
    const releaseFile = Array.isArray(latest.files)
        ? latest.files.find(file => {
            const url = String(file?.url || '');
            return url === installerName || url === `Pivot-Setup-${safeVersion}.exe`;
        })
        : null;
    if (!releaseFile) throw new Error(`latest.yml 未声明当前安装器：${installerName}。`);
    if (Number(releaseFile.size) !== installerStat.size) throw new Error('latest.yml 安装器大小与实际文件不一致。');
    if (String(releaseFile.sha512 || '') !== sha512Base64(installerPath)) throw new Error('latest.yml 安装器 SHA-512 与实际文件不一致。');

    const config = JSON.parse(fs.readFileSync(path.join(resources, 'config.json'), 'utf8'));
    if (config?.autoUpdate?.enabled !== true) throw new Error('打包后的客户端配置未启用自动更新。');
    const feedUrl = resolveUpdateFeedUrl(config);
    const allowedOrigins = Array.isArray(config.autoUpdate.allowedOrigins) ? config.autoUpdate.allowedOrigins : [];
    if (!allowedOrigins.map(origin => new URL(String(origin)).origin).includes(new URL(feedUrl).origin)) {
        throw new Error('打包后的客户端配置未显式允许更新源 Origin。');
    }
    if (String(config.autoUpdate.publisherName || '') !== publisher) throw new Error('打包后的客户端更新发布者与发布签名发布者不一致。');

    const appUpdate = readYaml(path.join(resources, 'app-update.yml'), 'app-update.yml');
    if (appUpdate.provider !== 'generic' || String(appUpdate.url || '') !== feedUrl) {
        throw new Error('app-update.yml 未绑定到打包配置指定的 generic 更新源。');
    }
    if (!normalizePublisherNames(appUpdate.publisherName).includes(publisher)) {
        throw new Error('app-update.yml 未绑定到预期的 Windows 签名发布者。');
    }
    return { version: safeVersion, installerName, feedUrl, publisherName: publisher };
}

function main() {
    const [downloadsDir, resourcesDir, version, publisherName] = process.argv.slice(2);
    const result = verifyDesktopUpdateRelease({ downloadsDir, resourcesDir, version, publisherName });
    console.log(`桌面自动更新发布验收通过：v${result.version} → ${result.feedUrl}`);
}

if (require.main === module) {
    try { main(); } catch (error) {
        console.error(error?.stack || error?.message || String(error));
        process.exitCode = 1;
    }
}

module.exports = { resolveUpdateFeedUrl, verifyDesktopUpdateRelease };
