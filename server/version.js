const fs = require('fs');
const path = require('path');

function extractAppVersionFromChangelog(text) {
    const match = String(text || '').match(/^##\s*\[(.+?)\]/m);
    if (!match) return 'v0.0.0';
    const version = String(match[1] || '').trim();
    if (!version) return 'v0.0.0';
    return version.startsWith('v') ? version : `v${version}`;
}

function getAppVersion() {
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
