/* 文件上传逻辑模块 File Upload Logic */
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

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
            const allowedExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.pdf', '.csv']);
            const allowTypes = /^(image\/(png|jpeg|gif|webp)|text\/|application\/pdf|text\/markdown|text\/csv)$/;
            if (allowedExtensions.has(ext) && allowTypes.test(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('不支持该文件类型'));
            }
        }
    });
}

module.exports = { createUploadMiddleware };
