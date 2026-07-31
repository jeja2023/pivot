const path = require('path');
const { fileURLToPath } = require('url');

function parseUrl(rawUrl) {
    try {
        return new URL(String(rawUrl || ''));
    } catch (_error) {
        return null;
    }
}

function sameFilePath(left, right) {
    const normalize = (value) => {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}

function isAllowedLocalFile(url, allowedFilePaths = []) {
    if (!url || url.protocol !== 'file:') return false;
    let filePath = '';
    try {
        filePath = fileURLToPath(url);
    } catch (_error) {
        return false;
    }
    return allowedFilePaths.some((allowedPath) => sameFilePath(filePath, allowedPath));
}

function isTrustedRendererUrl(rawUrl, targetUrl, options = {}) {
    const candidate = parseUrl(rawUrl);
    if (!candidate) return false;
    if (isAllowedLocalFile(candidate, options.allowedFilePaths)) return true;

    const target = parseUrl(targetUrl);
    if (!target || !['http:', 'https:'].includes(target.protocol)) return false;
    if (!['http:', 'https:'].includes(candidate.protocol)) return false;
    return candidate.origin === target.origin;
}

module.exports = {
    isTrustedRendererUrl,
    parseUrl
};
