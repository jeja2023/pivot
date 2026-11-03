'use strict';

const { queryOne } = require('../db/client');

async function getActiveAttachmentById(id) {
    const safeId = Number(id);
    if (!Number.isSafeInteger(safeId) || safeId <= 0) return null;
    return await queryOne('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL', [safeId]);
}

async function getActiveAttachmentByFilePath(filePath) {
    const safePath = String(filePath || '').trim();
    if (!safePath) return null;
    return await queryOne('SELECT * FROM attachments WHERE file_path = ? AND deleted_at IS NULL', [safePath]);
}

module.exports = {
    getActiveAttachmentById,
    getActiveAttachmentByFilePath
};
