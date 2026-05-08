const fs = require('fs');
const path = require('path');

function extractAppVersionFromChangelog(text) {
    const match = String(text || '').match(/^##\s*\[?(.+?)\]?\s*-/m);
    if (!match) return 'v0.0.0';
    const version = String(match[1] || '').trim();
    if (!version) return 'v0.0.0';
    return version.startsWith('v') ? version : `v${version}`;
}

function getAppVersion() {
    // 优先从 CHANGELOG.md 获取，以实现版本号单一来源管理
    try {
        const changelogPath = path.resolve(__dirname, '..', 'CHANGELOG.md');
        if (fs.existsSync(changelogPath)) {
            const text = fs.readFileSync(changelogPath, 'utf8');
            const version = extractAppVersionFromChangelog(text);
            if (version && version !== 'v0.0.0') return version;
        }
    } catch (e) {
        // 忽略错误，继续尝试 package.json
    }

    try {
        // 回退方案：从 package.json 获取
        const pkgPath = path.resolve(__dirname, '..', 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.version) return pkg.version.startsWith('v') ? pkg.version : `v${pkg.version}`;
        }
    } catch (e) {
        // 忽略错误
    }

    return 'v0.0.0';
}

function applyAppVersionTemplate(text, appVersion = getAppVersion()) {
    return String(text || '').replace(/__APP_VERSION__/g, appVersion);
}

module.exports = {
    applyAppVersionTemplate,
    extractAppVersionFromChangelog,
    getAppVersion
};
