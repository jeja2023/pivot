/* 文件上传辅助函数 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { getKnowledgeLimits, getUploadLimits } = require('./services/resource-limits');
const { clearDirSizeCache } = require('./services/dir-size-cache');

const projectRoot = path.resolve(__dirname, '..');
const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
    ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
    : path.join(projectRoot, 'uploads');
const knowledgeUploadRoot = path.join(uploadRoot, 'docs');
const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.txt', '.md', '.pdf', '.csv', '.json', '.html', '.htm', '.doc', '.docx', '.xls', '.xlsx']);
const knowledgeExtensions = new Set(['.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.json', '.html', '.htm']);

const DEFAULT_MULTIPART_LIMITS = Object.freeze({
    fieldNameSize: 80,
    fieldSize: 256 * 1024,
    fields: 20,
    parts: 50,
    headerPairs: 100
});
const MAX_MULTIPART_FIELD_DEPTH = 8;

function scoreFilenameEncoding(value) {
    const text = String(value || '');
    let score = 0;
    for (const char of text) {
        if (/[\u4e00-\u9fff\u3400-\u4dbf]/u.test(char)) score += 3;
        if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(char)) score += 2;
        if (char === '\uFFFD') score -= 12;
        if (/[\u0080-\u009f]/u.test(char)) score -= 8;
    }
    if (/[鑴欒剹][\u0080-\u00bf]/u.test(text)) score -= 5;
    if (/[\u00e4-\u00e9][\u0080-\u00bf]/u.test(text)) score -= 5;
    return score;
}

function shouldPreferLatin1DecodedName(original, decoded) {
    if (!decoded || decoded === original || decoded.includes('\uFFFD')) return false;
    const originalScore = scoreFilenameEncoding(original);
    const decodedScore = scoreFilenameEncoding(decoded);
    const hasMojibakeSignal = /[\u0080-\u009f]/u.test(original)
        || /[鑴欒剹][\u0080-\u00bf]/u.test(original)
        || /[\u00e4-\u00e9][\u0080-\u00bf]/u.test(original);
    return hasMojibakeSignal && decodedScore > originalScore;
}

function normalizeUploadedOriginalName(value) {
    const fallback = 'upload';
    const raw = String(value || '').replace(/\0/g, '').replace(/\\/g, '/');
    const original = path.basename(raw).normalize('NFC') || fallback;
    const decoded = path.basename(Buffer.from(original, 'latin1').toString('utf8').replace(/\\/g, '/')).normalize('NFC');
    return shouldPreferLatin1DecodedName(original, decoded) ? decoded : original;
}

function isPathInside(root, target) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    const relative = path.relative(resolvedRoot, resolvedTarget);
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createUploadError(message, code = 'UPLOAD_REJECTED') {
    const err = new Error(message);
    err.status = 400;
    err.expose = true;
    err.code = code;
    return err;
}

function normalizeMulterError(error) {
    if (!error) return null;
    if (error instanceof multer.MulterError) {
        error.status = 400;
        error.expose = true;
        return error;
    }
    if (!error.status) error.status = 400;
    error.expose = true;
    return error;
}

function trackUploadedPath(req, filePath) {
    if (!req || !filePath) return;
    if (!req._pivotUploadPaths) req._pivotUploadPaths = new Set();
    req._pivotUploadPaths.add(path.resolve(filePath));
}

function removeUploadedPath(filePath, root = uploadRoot) {
    if (!filePath) return;
    const target = path.resolve(filePath);
    if (!isPathInside(root, target)) return;
    fs.promises.unlink(target).then(() => clearDirSizeCache()).catch(() => {});
}

function removeUploadedFile(file, root = uploadRoot) {
    if (!file?.path) return;
    removeUploadedPath(file.path, root);
}

function collectRequestFiles(req) {
    return [
        ...(req.file ? [req.file] : []),
        ...Object.values(req.files || {}).flat()
    ];
}

function cleanupRequestUploads(req, root = uploadRoot) {
    collectRequestFiles(req).forEach(file => removeUploadedFile(file, root));
    Array.from(req._pivotUploadPaths || []).forEach(filePath => removeUploadedPath(filePath, root));
}

function verifyUploadedMagic(file) {
    if (!file?.path) return true;

    const buffer = Buffer.alloc(1024);
    let bytesRead = 0;
    let fd;
    try {
        fd = fs.openSync(file.path, 'r');
        bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
    } catch (e) {
        return false;
    } finally {
        if (fd) fs.closeSync(fd);
    }

    const actualData = buffer.subarray(0, bytesRead);
    const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
    if (ext === '.png') return actualData.length >= 8 && actualData.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (ext === '.jpg' || ext === '.jpeg') return actualData.length >= 3 && actualData[0] === 0xff && actualData[1] === 0xd8 && actualData[2] === 0xff;
    if (ext === '.gif') return actualData.length >= 3 && actualData.subarray(0, 3).toString('ascii') === 'GIF';
    if (ext === '.webp') return actualData.length >= 12 && actualData.subarray(0, 4).toString('ascii') === 'RIFF' && actualData.subarray(8, 12).toString('ascii') === 'WEBP';
    if (ext === '.bmp') return actualData.length >= 2 && actualData[0] === 0x42 && actualData[1] === 0x4d;
    if (ext === '.pdf') return actualData.length >= 5 && actualData.subarray(0, 5).toString('ascii') === '%PDF-';
    if (ext === '.docx' || ext === '.xlsx') return actualData.length >= 4 && actualData[0] === 0x50 && actualData[1] === 0x4b && actualData[2] === 0x03 && actualData[3] === 0x04;
    if (ext === '.doc' || ext === '.xls') return actualData.length >= 4 && actualData[0] === 0xd0 && actualData[1] === 0xcf && actualData[2] === 0x11 && actualData[3] === 0xe0;

    const checkLen = Math.min(bytesRead, 512);
    return checkLen === 0 || !actualData.subarray(0, checkLen).includes(0);
}

function uploadSecurityMiddleware(req, res, next) {
    const root = req._pivotUploadRoot || uploadRoot;
    const files = collectRequestFiles(req);
    for (const file of files) {
        if (!verifyUploadedMagic(file)) {
            cleanupRequestUploads(req, root);
            return res.status(400).json({ error: '文件内容与扩展名不匹配，已拒绝上传' });
        }
    }
    next();
}

function countObjectDepth(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object') return depth;
    if (seen.has(value)) return depth;
    seen.add(value);
    return Object.values(value).reduce((maxDepth, child) => Math.max(maxDepth, countObjectDepth(child, depth + 1, seen)), depth);
}

function validateMultipartBody(req) {
    const body = req.body || {};
    for (const key of Object.keys(body)) {
        if (String(key).length > DEFAULT_MULTIPART_LIMITS.fieldNameSize) {
            return createUploadError('上传表单字段名过长', 'LIMIT_FIELD_KEY');
        }
    }
    if (countObjectDepth(body) > MAX_MULTIPART_FIELD_DEPTH) {
        return createUploadError('上传表单字段嵌套过深', 'LIMIT_FIELD_DEPTH');
    }
    return null;
}

function createStorage(root) {
    return multer.diskStorage({
        destination: (req, file, cb) => {
            fs.mkdirSync(root, { recursive: true });
            req._pivotUploadRoot = root;
            cb(null, root);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(normalizeUploadedOriginalName(file.originalname));
            const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
            trackUploadedPath(req, path.join(root, filename));
            cb(null, filename);
        }
    });
}

function createFileFilter(extensions, errorMessage) {
    return (req, file, cb) => {
        file.originalname = normalizeUploadedOriginalName(file.originalname);
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!extensions.has(ext)) {
            return cb(createUploadError(errorMessage || `不支持该文件类型 (${file.originalname}, 扩展名 ${ext})`, 'LIMIT_FILE_TYPE'));
        }
        cb(null, true);
    };
}

function resolvePositiveInt(value, fallback) {
    const parsed = typeof value === 'function' ? Number.parseInt(value(), 10) : Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createUploadInstance(options = {}) {
    const maxFiles = resolvePositiveInt(options.maxFiles, 1);
    const maxFields = resolvePositiveInt(options.maxFields, DEFAULT_MULTIPART_LIMITS.fields);
    const fileSize = resolvePositiveInt(options.fileSize, getUploadLimits().attachmentMaxBytes);
    return multer({
        storage: createStorage(options.root || uploadRoot),
        limits: {
            ...DEFAULT_MULTIPART_LIMITS,
            fileSize,
            files: maxFiles,
            fields: maxFields,
            parts: resolvePositiveInt(options.maxParts, maxFiles + maxFields + 4)
        },
        fileFilter: createFileFilter(options.extensions || allowedExtensions, options.errorMessage)
    });
}

function withUploadGuards(middleware, options = {}) {
    return (req, res, next) => {
        const root = options.root || uploadRoot;
        req._pivotUploadRoot = root;
        const cleanup = () => cleanupRequestUploads(req, root);
        const onAborted = () => cleanup();
        req.once('aborted', onAborted);
        middleware(req, res, (err) => {
            req.off?.('aborted', onAborted);
            if (err) {
                cleanup();
                return next(normalizeMulterError(err));
            }
            const fieldError = validateMultipartBody(req);
            if (fieldError) {
                cleanup();
                return next(fieldError);
            }
            return next();
        });
    };
}

function createSafeUpload(options = {}) {
    const root = options.root || uploadRoot;
    return {
        single(field) {
            return (req, res, next) => withUploadGuards(
                createUploadInstance({ ...options, root, maxFiles: 1 }).single(field),
                { root }
            )(req, res, next);
        },
        array(field, maxCount) {
            const maxFiles = resolvePositiveInt(maxCount, options.maxFiles || 1);
            return (req, res, next) => withUploadGuards(
                createUploadInstance({ ...options, root, maxFiles }).array(field, maxFiles),
                { root }
            )(req, res, next);
        }
    };
}

function createUploadMiddleware() {
    return createSafeUpload({
        root: uploadRoot,
        extensions: allowedExtensions,
        fileSize: () => getUploadLimits().attachmentMaxBytes,
        maxFields: 20
    });
}

function createKnowledgeUploadMiddleware() {
    return createSafeUpload({
        root: knowledgeUploadRoot,
        extensions: knowledgeExtensions,
        fileSize: () => getKnowledgeLimits().uploadMaxBytes,
        maxFields: 6,
        maxParts: 10,
        errorMessage: '仅支持 txt、md、pdf、doc、docx、xls、xlsx、csv、json、html 文档'
    });
}

module.exports = {
    createKnowledgeUploadMiddleware,
    createSafeUpload,
    createUploadMiddleware,
    normalizeUploadedOriginalName,
    uploadSecurityMiddleware
};
