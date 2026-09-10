'use strict';

const fs = require('fs');
const path = require('path');

function normalizeWindowsUpdatePublisher(value) {
    const publisher = String(value || '').trim().replace(/\s+/g, ' ');
    if (!publisher || publisher.length > 256) return '';
    return publisher;
}

function normalizeWindowsCertificateSha1(value) {
    const thumbprint = String(value || '').trim().replace(/[^a-f0-9]/gi, '').toUpperCase();
    return /^[A-F0-9]{40}$/.test(thumbprint) ? thumbprint : '';
}

function normalizeWindowsCertificateSubject(value) {
    const subject = String(value || '').trim().replace(/\s+/g, ' ');
    return subject && subject.length <= 512 ? subject : '';
}

function resolveWindowsSigningCredential(env = process.env) {
    const certificateLink = String(env.WIN_CSC_LINK || env.CSC_LINK || '').trim();
    if (certificateLink) return { type: 'file', source: env.WIN_CSC_LINK ? 'WIN_CSC_LINK' : 'CSC_LINK' };

    const certificateSha1 = normalizeWindowsCertificateSha1(env.PIVOT_WINDOWS_CERTIFICATE_SHA1);
    if (certificateSha1) return { type: 'store', certificateSha1 };

    const certificateSubjectName = normalizeWindowsCertificateSubject(env.PIVOT_WINDOWS_CERTIFICATE_SUBJECT);
    if (certificateSubjectName) return { type: 'store', certificateSubjectName };

    return null;
}

function hasWindowsSigningCredential(env = process.env) {
    return resolveWindowsSigningCredential(env) !== null;
}

function applyWindowsUpdateSigningProfile(pkg, options = {}) {
    if (!pkg || typeof pkg !== 'object') throw new Error('Windows 更新签名配置缺少 package.json 对象。');
    const required = options.required === true;
    const publisherName = normalizeWindowsUpdatePublisher(options.publisherName || options.env?.PIVOT_WINDOWS_UPDATE_PUBLISHER);
    const credential = resolveWindowsSigningCredential(options.env || process.env);
    const signed = credential !== null;
    if (required && !publisherName) {
        throw new Error('Windows 正式更新包必须提供 PIVOT_WINDOWS_UPDATE_PUBLISHER，用于校验后续安装器签名。');
    }
    if (required && !signed) {
        throw new Error('Windows 正式更新包必须配置 CSC_LINK、WIN_CSC_LINK、PIVOT_WINDOWS_CERTIFICATE_SHA1 或 PIVOT_WINDOWS_CERTIFICATE_SUBJECT 代码签名凭据。');
    }
    if (!publisherName) return { publisherName: '', signed };
    const signtoolOptions = {
        ...pkg.build?.win?.signtoolOptions,
        publisherName
    };
    if (credential?.certificateSha1) signtoolOptions.certificateSha1 = credential.certificateSha1;
    if (credential?.certificateSubjectName) signtoolOptions.certificateSubjectName = credential.certificateSubjectName;
    pkg.build = {
        ...pkg.build,
        win: {
            ...pkg.build?.win,
            signtoolOptions,
            verifyUpdateCodeSignature: true,
            // electron-builder 默认只记录签名失败的告警，仍会产出未签名安装器。
            // 发布更新时必须失败，避免客户端在下载阶段才被签名校验拒绝。
            forceCodeSigning: required || pkg.build?.win?.forceCodeSigning === true
        }
    };
    return { publisherName, signed, credential };
}

function prepareWindowsUpdateSigningProfile(rootDir, options = {}) {
    const root = path.resolve(rootDir || path.resolve(__dirname, '..'));
    const packagePath = path.join(root, 'package.json');
    const original = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(original);
    const profile = applyWindowsUpdateSigningProfile(pkg, options);
    if (!profile.publisherName) return { ...profile, restore() {} };
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    let restored = false;
    return {
        ...profile,
        restore() {
            if (restored) return;
            restored = true;
            fs.writeFileSync(packagePath, original, 'utf8');
        }
    };
}

module.exports = {
    applyWindowsUpdateSigningProfile,
    hasWindowsSigningCredential,
    normalizeWindowsUpdatePublisher,
    normalizeWindowsCertificateSha1,
    normalizeWindowsCertificateSubject,
    prepareWindowsUpdateSigningProfile,
    resolveWindowsSigningCredential
};
