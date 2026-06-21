/* File upload helpers */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { getUploadLimits } = require('./services/resource-limits');
const { clearDirSizeCache } = require('./services/dir-size-cache');

const projectRoot = path.resolve(__dirname, '..');
const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
    ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
    : path.join(projectRoot, 'uploads');
const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.txt', '.md', '.pdf', '.csv', '.doc', '.docx', '.xls', '.xlsx']);

function scoreFilenameEncoding(value) {
    const text = String(value || '');
    let score = 0;
    for (const char of text) {
        if (/[\u4e00-\u9fff\u3400-\u4dbf]/u.test(char)) score += 3;
        if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(char)) score += 2;
        if (char === '\uFFFD') score -= 12;
        if (/[\u0080-\u009f]/u.test(char)) score -= 8;
    }
    if (/[脙脗][\u0080-\u00bf]/u.test(text)) score -= 5;
    if (/[\u00e4-\u00e9][\u0080-\u00bf]/u.test(text)) score -= 5;
    return score;
}

function shouldPreferLatin1DecodedName(original, decoded) {
    if (!decoded || decoded === original || decoded.includes('\uFFFD')) return false;
    const originalScore = scoreFilenameEncoding(original);
    const decodedScore = scoreFilenameEncoding(decoded);
    const hasMojibakeSignal = /[\u0080-\u009f]/u.test(original)
        || /[脙脗][\u0080-\u00bf]/u.test(original)
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

function removeUploadedFile(file) {
    if (!file?.path) return;
    const target = path.resolve(file.path);
    if (!target.startsWith(uploadRoot + path.sep)) return;
    fs.promises.unlink(target).then(() => clearDirSizeCache()).catch(() => {});
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
    const files = [
        ...(req.file ? [req.file] : []),
        ...Object.values(req.files || {}).flat()
    ];
    for (const file of files) {
        if (!verifyUploadedMagic(file)) {
            files.forEach(removeUploadedFile);
            return res.status(400).json({ error: '文件内容与扩展名不匹配，已拒绝上传' });
        }
    }
    next();
}

function createUploadMiddleware() {
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            fs.mkdirSync(uploadRoot, { recursive: true });
            cb(null, uploadRoot);
        },
        filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomUUID() + path.extname(normalizeUploadedOriginalName(file.originalname)))
    });

    const fileFilter = (req, file, cb) => {
        file.originalname = normalizeUploadedOriginalName(file.originalname);
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!allowedExtensions.has(ext)) {
            return cb(new Error(`不支持该文件类型 (${file.originalname}, 扩展名 ${ext})`));
        }
        cb(null, true);
    };

    const createInstance = () => multer({
        storage,
        limits: { fileSize: getUploadLimits().attachmentMaxBytes },
        fileFilter
    });

    return {
        single(field) {
            return (req, res, next) => createInstance().single(field)(req, res, next);
        },
        array(field, maxCount) {
            return (req, res, next) => createInstance().array(field, maxCount)(req, res, next);
        }
    };
}

module.exports = { createUploadMiddleware, normalizeUploadedOriginalName, uploadSecurityMiddleware };
