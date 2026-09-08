const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const policyPath = path.join(__dirname, 'license_policy.json');
const noticesPath = path.join(root, 'docs', 'licenses', 'THIRD_PARTY_NOTICES.md');
const lgplPath = path.join(root, 'docs', 'licenses', 'LGPL-3.0.txt');

function packageNameFromLockPath(lockPath) {
    return String(lockPath || '').replace(/^node_modules\//, '');
}

function readInstalledLicense(name) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
        if (pkg.license) return String(pkg.license);
        if (Array.isArray(pkg.licenses)) return pkg.licenses.map(item => item?.type).filter(Boolean).join(' OR ');
    } catch (_) {}
    return '';
}

function matchException(name, exceptions = {}) {
    return Object.entries(exceptions).find(([pattern]) => {
        const expression = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`);
        return expression.test(name);
    })?.[1] || null;
}

function validateLicenses(lock, policy, now = Date.now()) {
    const failures = [];
    const allowed = new Set(policy.allowed || []);
    for (const [lockPath, metadata] of Object.entries(lock.packages || {})) {
        if (!lockPath || metadata.dev) continue;
        const name = packageNameFromLockPath(lockPath);
        const license = String(metadata.license || readInstalledLicense(name) || '').trim();
        if (allowed.has(license)) continue;
        const exception = matchException(name, policy.exceptions || {});
        if (!exception?.selectedLicense || !exception?.reason || !exception?.expiresOn) {
            failures.push(`${name} 使用未治理许可：${license || '缺失'}`);
            continue;
        }
        const expiresAt = Date.parse(`${exception.expiresOn}T23:59:59Z`);
        if (!Number.isFinite(expiresAt) || now > expiresAt) failures.push(`${name} 的许可例外已过期或日期无效：${exception.expiresOn}`);
    }
    return failures;
}

function main() {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const failures = validateLicenses(lock, policy);
    if (!fs.existsSync(noticesPath) || !fs.readFileSync(noticesPath, 'utf8').includes('libvips')) failures.push('缺少 libvips 第三方许可声明');
    if (!fs.existsSync(lgplPath) || fs.statSync(lgplPath).size < 5000) failures.push('缺少完整 LGPL-3.0 许可文本');
    if (failures.length) {
        console.error('第三方许可检查失败：');
        failures.forEach(item => console.error(` - ${item}`));
        process.exit(1);
    }
    console.log('第三方许可检查通过：生产依赖许可均已治理，LGPL 文本与声明齐全。');
}

if (require.main === module) main();

module.exports = { matchException, validateLicenses };
