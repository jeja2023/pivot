'use strict';

const fs = require('fs');
const path = require('path');

function normalizePublisherName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

async function verifyWindowsUpdateArtifact(filePath, publisherName, options = {}) {
    const artifactPath = path.resolve(String(filePath || ''));
    const publisher = normalizePublisherName(publisherName);
    if (!artifactPath || !fs.existsSync(artifactPath)) throw new Error(`Windows 更新签名验收找不到文件：${artifactPath || '<empty>'}`);
    if (!publisher) throw new Error('Windows 更新签名验收缺少预期发布者名称。');

    const verifySignature = options.verifySignature || require('electron-updater/out/windowsExecutableCodeSignatureVerifier').verifySignature;
    const logger = options.logger || { info() {}, warn() {}, error() {} };
    const verificationError = await verifySignature([publisher], artifactPath, logger);
    if (verificationError) {
        throw new Error(`Windows 更新签名验收失败：${path.basename(artifactPath)}\n${verificationError}`);
    }
    return true;
}

async function verifyWindowsUpdateArtifacts(paths, publisherName, options = {}) {
    const artifacts = Array.isArray(paths) ? paths : [paths];
    if (!artifacts.length) throw new Error('Windows 更新签名验收缺少安装产物。');
    for (const artifactPath of artifacts) {
        await verifyWindowsUpdateArtifact(artifactPath, publisherName, options);
    }
    return true;
}

async function main() {
    const [installerPath, appPath, publisherName] = process.argv.slice(2);
    await verifyWindowsUpdateArtifacts([installerPath, appPath], publisherName, { logger: console });
    console.log(`Windows 更新签名验收通过：${path.basename(installerPath)}、${path.basename(appPath)}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    });
}

module.exports = {
    normalizePublisherName,
    verifyWindowsUpdateArtifact,
    verifyWindowsUpdateArtifacts
};
