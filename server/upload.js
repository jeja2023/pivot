/* 文件上传逻辑模块 File Upload Logic */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadRoot = path.resolve(__dirname, '../uploads');
const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.pdf', '.csv']);
const allowTypes = /^(image\/(png|jpeg|gif|webp)|text\/|application\/pdf|text\/markdown|text\/csv)$/;

function removeUploadedFile(file) {
    if (!file?.path) return;
    const target = path.resolve(file.path);
    if (!target.startsWith(uploadRoot + path.sep)) return;
    fs.promises.unlink(target).catch(() => {});
}

function verifyUploadedMagic(file) {
    if (!file?.path) return true;
    
    let buffer = Buffer.alloc(1024); // 仅读取前 1KB
    let fd;
    try {
        fd = fs.openSync(file.path, 'r');
        fs.readSync(fd, buffer, 0, 1024, 0);
    } catch (e) {
        return false;
    } finally {
        if (fd) fs.closeSync(fd);
    }

    const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
    if (ext === '.png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (ext === '.jpg' || ext === '.jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    if (ext === '.gif') return buffer.subarray(0, 3).toString('ascii') === 'GIF';
    if (ext === '.webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    if (ext === '.pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    
    // 对于文本类文件，检查是否包含空字符（简单判断是否为二进制）
    return !buffer.subarray(0, 512).includes(0);
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
        destination: (req, file, cb) => cb(null, 'uploads/'),
        filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomUUID() + path.extname(file.originalname || ''))
    });

    return multer({
        storage,
        limits: { fileSize: 20 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase();
            if (allowedExtensions.has(ext) && allowTypes.test(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('不支持该文件类型'));
            }
        }
    });
}

module.exports = { createUploadMiddleware, uploadSecurityMiddleware };
