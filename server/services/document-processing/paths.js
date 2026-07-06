const fs = require('fs');
const path = require('path');

const { dataDir } = require('../../db');

const projectRoot = path.resolve(__dirname, '../../..');
const documentRoot = process.env.PIVOT_DOCUMENT_PROCESSING_DIR
    ? path.resolve(process.env.PIVOT_DOCUMENT_PROCESSING_DIR)
    : path.join(dataDir, 'document-processing');
const originalsRoot = path.join(documentRoot, 'originals');
const pagesRoot = path.join(documentRoot, 'pages');
const outputsRoot = path.join(documentRoot, 'outputs');
const tempRoot = path.join(documentRoot, 'tmp');

function ensureDocumentProcessingDirs() {
    [documentRoot, originalsRoot, pagesRoot, outputsRoot, tempRoot].forEach(dir => {
        fs.mkdirSync(dir, { recursive: true });
    });
}

function isPathInside(parent, target) {
    const relative = path.relative(path.resolve(parent), path.resolve(target));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveInside(parent, ...parts) {
    const target = path.resolve(parent, ...parts);
    if (!isPathInside(parent, target)) {
        const error = new Error('文件路径不在受控目录内。');
        error.status = 400;
        throw error;
    }
    return target;
}

function toProjectRelativePath(targetPath) {
    const target = path.resolve(targetPath);
    if (isPathInside(documentRoot, target)) {
        const relative = path.relative(documentRoot, target).replace(/\\/g, '/');
        return relative ? `document-processing/${relative}` : 'document-processing';
    }
    const relative = path.relative(projectRoot, target).replace(/\\/g, '/');
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
    return relative;
}

function resolveProjectRelativePath(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.includes('\0')) return null;
    if (normalized === 'document-processing' || normalized.startsWith('document-processing/')) {
        const target = resolveInside(documentRoot, normalized.slice('document-processing'.length).replace(/^\/+/, ''));
        return isPathInside(documentRoot, target) ? target : null;
    }
    const target = path.resolve(projectRoot, normalized);
    if (!isPathInside(documentRoot, target)) return null;
    return target;
}

function resolveStoredDocumentPath(relativePath) {
    const target = resolveProjectRelativePath(relativePath);
    if (!target || !isPathInside(documentRoot, target)) return null;
    return target;
}

function buildManagedPath(root, userId, name) {
    ensureDocumentProcessingDirs();
    const safeUserId = String(Number.parseInt(userId, 10) || 'unknown');
    const safeName = String(name || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180) || `${Date.now()}`;
    const dir = resolveInside(root, safeUserId);
    fs.mkdirSync(dir, { recursive: true });
    return resolveInside(dir, safeName);
}

function fileExists(filePath) {
    try {
        return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_err) {
        return false;
    }
}

function safeUnlinkManaged(relativePath) {
    const target = resolveStoredDocumentPath(relativePath);
    if (!target || !fileExists(target)) return false;
    try {
        fs.rmSync(target, { force: true, maxRetries: 4, retryDelay: 80 });
        return true;
    } catch (_err) {
        return false;
    }
}

module.exports = {
    buildManagedPath,
    documentRoot,
    ensureDocumentProcessingDirs,
    fileExists,
    isPathInside,
    originalsRoot,
    outputsRoot,
    pagesRoot,
    projectRoot,
    resolveInside,
    resolveStoredDocumentPath,
    safeUnlinkManaged,
    tempRoot,
    toProjectRelativePath
};
