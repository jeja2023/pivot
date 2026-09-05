const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { queryOne, execute } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { normalizeUploadedOriginalName } = require('../../upload');
const { isImageExtension, isPdfExtension } = require('./constants');
const {
    buildManagedPath,
    originalsRoot,
    resolveStoredDocumentPath,
    toProjectRelativePath
} = require('./paths');

const SAFE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
    '.txt', '.md', '.pdf', '.csv', '.json', '.html', '.htm',
    '.doc', '.docx', '.xls', '.xlsx'
]);

function normalizeJson(value, fallback = {}) {
    try {
        return JSON.stringify(value && typeof value === 'object' ? value : fallback);
    } catch (_err) {
        return JSON.stringify(fallback);
    }
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (_err) {
        return fallback;
    }
}

function safeExtension(fileName) {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    return SAFE_EXTENSIONS.has(ext) ? ext : '.bin';
}

function normalizeOriginalName(value) {
    return normalizeUploadedOriginalName(value || '未命名文件').slice(0, 255) || '未命名文件';
}

function detectDocumentKind({ ext, mimeType = '' }) {
    const mime = String(mimeType || '').toLowerCase();
    if (isPdfExtension(ext) || mime === 'application/pdf') return 'pdf';
    if (isImageExtension(ext) || mime.startsWith('image/')) return 'image';
    return 'document';
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

async function moveUploadedFile(sourcePath, targetPath) {
    try {
        await fs.promises.rename(sourcePath, targetPath);
    } catch (err) {
        if (!['EXDEV', 'EPERM', 'EACCES'].includes(err?.code)) throw err;
        await fs.promises.copyFile(sourcePath, targetPath);
        await fs.promises.rm(sourcePath, { force: true, maxRetries: 4, retryDelay: 80 });
    }
}

async function readImageMetadata(filePath) {
    try {
        const metadata = await sharp(filePath).metadata();
        return {
            width: Number(metadata.width || 0),
            height: Number(metadata.height || 0),
            format: metadata.format || ''
        };
    } catch (_err) {
        return { width: 0, height: 0, format: '' };
    }
}

function serializeFile(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        originalName: row.original_name,
        fileType: row.file_type,
        fileExt: row.file_ext,
        fileSize: Number(row.file_size || 0),
        pageCount: Number(row.page_count || 0),
        sourceModule: row.source_module || '',
        sourceRef: row.source_ref || '',
        sha256: row.sha256 || '',
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

async function getDocumentFileForUser(fileId, userId) {
    return await queryOne(`
        SELECT *
        FROM document_files
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [fileId, userId]) || null;
}

async function getDocumentFilePathAsync(row) {
    const target = resolveStoredDocumentPath(row?.file_path);
    if (!target) return null;
    try {
        await fs.promises.access(target, fs.constants.R_OK);
        return target;
    } catch (_err) {
        return null;
    }
}

async function updateDocumentFileMetadata({ fileId, userId, pageCount = null, metadata = null }) {
    const existing = await getDocumentFileForUser(fileId, userId);
    if (!existing) return null;
    const mergedMetadata = metadata ? { ...parseJson(existing.metadata_json, {}), ...metadata } : parseJson(existing.metadata_json, {});
    await execute(`
        UPDATE document_files
        SET page_count = COALESCE(?, page_count), metadata_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [
        pageCount === null || pageCount === undefined ? null : Number(pageCount) || 0,
        normalizeJson(mergedMetadata),
        getBeijingTimestamp(),
        fileId,
        userId
    ]);
    return await getDocumentFileForUser(fileId, userId);
}

async function registerUploadedFile({ user, file, sourceModule = 'document_processing', sourceRef = '', metadata = {} }) {
    if (!file?.path) {
        const error = new Error('请上传文件。');
        error.status = 400;
        throw error;
    }

    const userId = user.id;
    const now = getBeijingTimestamp();
    const originalName = normalizeOriginalName(file.originalname || file.filename || 'upload');
    const ext = safeExtension(originalName);
    const kind = detectDocumentKind({ ext, mimeType: file.mimetype });
    const initialSize = Number(file.size || 0) || (await fs.promises.stat(file.path)).size;
    const row = await queryOne(`
        INSERT INTO document_files (
            user_id, original_name, file_type, file_ext, file_size, source_module, source_ref, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
    `, [userId, originalName, kind, ext, initialSize, sourceModule, String(sourceRef || '').slice(0, 120), normalizeJson(metadata), now, now]);

    const fileId = row.id;
    const storedName = `${fileId}-${crypto.randomUUID()}${ext}`;
    const targetPath = await buildManagedPath(originalsRoot, userId, storedName);
    try {
        await moveUploadedFile(file.path, targetPath);
        const stat = await fs.promises.stat(targetPath);
        const digest = await sha256File(targetPath);
        const imageMetadata = kind === 'image' ? await readImageMetadata(targetPath) : {};
        const nextMetadata = { ...metadata, mimeType: file.mimetype || '', ...imageMetadata };
        await execute(`
            UPDATE document_files
            SET stored_name = ?, file_path = ?, file_size = ?, sha256 = ?, metadata_json = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [storedName, toProjectRelativePath(targetPath), stat.size, digest, normalizeJson(nextMetadata), getBeijingTimestamp(), fileId, userId]);
    } catch (err) {
        await execute('UPDATE document_files SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
            [getBeijingTimestamp(), getBeijingTimestamp(), fileId, userId]);
        throw err;
    }

    return await getDocumentFileForUser(fileId, userId);
}

module.exports = {
    detectDocumentKind,
    getDocumentFileForUser,
    getDocumentFilePathAsync,
    parseJson,
    readImageMetadata,
    registerUploadedFile,
    serializeFile,
    updateDocumentFileMetadata
};
