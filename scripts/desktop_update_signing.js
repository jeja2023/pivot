'use strict';

const fs = require('fs');
const path = require('path');

function normalizeWindowsUpdatePublisher(value) {
    const publisher = String(value || '').trim().replace(/\s+/g, ' ');
    if (!publisher || publisher.length > 256) return '';
    return publisher;
}

function hasWindowsSigningCredential(env = process.env) {
    return ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_NAME', 'WIN_CSC_NAME']
        .some(key => String(env[key] || '').trim().length > 0);
}

function prepareWindowsUpdateSigningProfile(rootDir, options = {}) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    const packagePath = path.join(root, 'package.json');
    const original = fs.readFileSync(packagePath, 'utf8');
    const required = options.required === true;
    const publisherName = normalizeWindowsUpdatePublisher(options.publisherName || options.env?.PIVOT_WINDOWS_UPDATE_PUBLISHER);
    const signed = hasWindowsSigningCredential(options.env || process.env);
    if (required && !publisherName) {
        throw new Error('Windows 正式更新包必须提供 PIVOT_WINDOWS_UPDATE_PUBLISHER，用于校验后续安装器签名。');
    }
    if (required && !signed) {
        throw new Error('Windows 正式更新包必须配置 CSC_LINK、WIN_CSC_LINK、CSC_NAME 或 WIN_CSC_NAME 代码签名凭据。');
    }
    if (!publisherName) return { publisherName: '', restore() {} };

    const pkg = JSON.parse(original);
    pkg.build = { ...pkg.build, win: { ...pkg.build?.win, publisherName, verifyUpdateCodeSignature: true } };
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    let restored = false;
    return {
        publisherName,
        restore() {
            if (restored) return;
            restored = true;
            fs.writeFileSync(packagePath, original, 'utf8');
        }
    };
}

module.exports = {
    hasWindowsSigningCredential,
    normalizeWindowsUpdatePublisher,
    prepareWindowsUpdateSigningProfile
};
