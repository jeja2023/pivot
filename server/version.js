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
    try {
        // 优先从 package.json 获取
        const pkgPath = path.resolve(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.version) return pkg.version.startsWith('v') ? pkg.version : `v${pkg.version}`;
    } catch (e) {
        // 忽略错误，尝试从 CHANGELOG 获取
    }

    try {
        const changelogPath = path.resolve(__dirname, '..', 'CHANGELOG.md');
        const text = fs.readFileSync(changelogPath, 'utf8');
        return extractAppVersionFromChangelog(text);
    } catch (e) {
        return 'v0.0.0';
    }
}

function applyAppVersionTemplate(text, appVersion = getAppVersion()) {
    return String(text || '').replace(/__APP_VERSION__/g, appVersion);
}

module.exports = {
    applyAppVersionTemplate,
    extractAppVersionFromChangelog,
    getAppVersion
};
