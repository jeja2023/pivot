const fs = require('fs');
const path = require('path');
const { extractDocumentTextWithOcrFallback, truncateExtractedText } = require('./document-processing/text-extraction');
const { getKnowledgeLimits } = require('./resource-limits');
const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { clearRagCacheForUser } = require('./rag-cache');
const { indexDocumentChunks } = require('./rag-index');
const { getRagConfig } = require('./rag-config');
const { clearKnowledgeGraphForDocument, getGraphSummary } = require('./knowledge-graph');
const { getBackgroundRuntimeConfig } = require('./runtime-settings');
const { clearDirSizeCache } = require('./dir-size-cache');
const knowledgeRepository = require('../repositories/knowledge');
const {
    buildDocumentAccessFilter,
    normalizeKnowledgeUser
} = require('./knowledge-access');
const {
    normalizeShareSettings
} = require('./unit-visibility');
const { isAdmin } = require('../permissions');
const { filterExistingShareUserIds, listShareTargets } = require('./share-targets');

const projectRoot = path.resolve(__dirname, '../..');
const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
    ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
    : path.join(projectRoot, 'uploads');
const knowledgeSourceRoot = path.join(uploadRoot, 'knowledge_docs');
const allowedExtensions = new Set([
    '.txt', '.md', '.pdf',
    '.doc', '.docx',
    '.xls', '.xlsx',
    '.csv', '.json',
    '.html', '.htm'
]);
const activeIndexes = new Set();
const pendingIndexes = new Map();
let runningIndexCount = 0;

function getMaxConcurrentIndexes() {
    return getBackgroundRuntimeConfig().ragIndexMaxConcurrent;
}

function ensureKnowledgeSourceRoot() {
    fs.mkdirSync(knowledgeSourceRoot, { recursive: true });
}

function normalizeKnowledgeDocId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeKnowledgeCollectionName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function normalizeKnowledgeCollectionDescription(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 300);
}

function normalizeKnowledgeTag(value) {
    return String(value || '')
        .trim()
        .replace(/^#+/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 40);
}

function parseKnowledgeTags(value) {
    const values = Array.isArray(value)
        ? value
        : String(value || '').split(/[,，;；\s\n]+/);
    return [...new Set(values.map(normalizeKnowledgeTag).filter(Boolean))].slice(0, 20);
}

async function upsertKnowledgeTags(userId, tags, now = getBeijingTimestamp()) {
    const safeTags = parseKnowledgeTags(tags);
    if (!safeTags.length) return [];
    return await knowledgeRepository.upsertTags(userId, safeTags, now);
}

function normalizeKnowledgeCollectionId(value) {
    return normalizeKnowledgeDocId(value);
}

async function getKnowledgeCollectionForUser(collectionId, user) {
    const normalizedId = normalizeKnowledgeCollectionId(collectionId);
    if (!normalizedId) return null;
    return await knowledgeRepository.getCollectionForUser(normalizedId, user);
}

async function resolveKnowledgeCollectionId({ userId, user = null, collectionId = null } = {}) {
    const normalizedId = normalizeKnowledgeCollectionId(collectionId);
    if (normalizedId) {
        const collection = await getKnowledgeCollectionForUser(normalizedId, user || userId);
        return collection ? collection.id : null;
    }
    return null;
}

async function listKnowledgeCollections(user) {
    const normalizedUser = normalizeKnowledgeUser(user);
    const rows = await knowledgeRepository.listCollections(normalizedUser);
    return (rows || []).map(row => ({
        ...row,
        doc_count: Number(row.doc_count || 0),
        ready_count: Number(row.ready_count || 0),
        chunk_count: Number(row.chunk_count || 0),
        is_owner: Number(row.user_id) === normalizedUser.id,
        can_edit: Number(row.user_id) === normalizedUser.id,
        read_only: Number(row.user_id) !== normalizedUser.id
    }));
}

async function createKnowledgeCollection({ userId, name, description = '' }) {
    const normalizedName = normalizeKnowledgeCollectionName(name);
    if (!normalizedName) return null;
    const existing = await knowledgeRepository.findCollectionByName(userId, normalizedName);
    if (existing) return existing;

    const now = getBeijingTimestamp();
    const info = db.prepare(`
        INSERT INTO knowledge_collections (user_id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(userId, normalizedName, normalizeKnowledgeCollectionDescription(description), now, now);
    return await getKnowledgeCollectionForUser(info.lastInsertRowid, userId);
}

async function getKnowledgeCollectionShareOptions({ collectionId, user }) {
    const collection = await getKnowledgeCollectionForUser(collectionId, user);
    if (!collection) return null;
    const normalizedUser = normalizeKnowledgeUser(user);
    if (Number(collection.user_id) !== normalizedUser.id && !isAdmin(user)) return null;
    return {
        collection: {
            id: collection.id,
            name: collection.name,
            scope: collection.scope || 'personal',
            allowed_units: collection.allowed_units || '',
            allowed_user_ids: collection.allowed_user_ids || ''
        },
        ...listShareTargets(user, { excludeUserId: collection.user_id })
    };
}

function updateKnowledgeCollectionSharing({ collectionId, user, body = {} }) {
    const normalizedId = normalizeKnowledgeCollectionId(collectionId);
    if (!normalizedId) return null;
    const current = db.prepare(`
        SELECT * FROM knowledge_collections
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).get(normalizedId, normalizeKnowledgeUser(user).id);
    if (!current) return null;
    const settings = normalizeShareSettings(body, user, current);
    settings.allowedUserIds = filterExistingShareUserIds(settings.allowedUserIds, { excludeUserId: current.user_id });
    db.prepare(`
        UPDATE knowledge_collections
        SET scope = ?, allowed_units = ?, allowed_user_ids = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(settings.scope, settings.allowedUnits, settings.allowedUserIds, getBeijingTimestamp(), normalizedId, normalizeKnowledgeUser(user).id);
    clearRagCacheForUser(normalizeKnowledgeUser(user).id);
    return getKnowledgeCollectionForUser(normalizedId, user);
}

async function createKnowledgeTag({ userId, tag }) {
    const safeTags = await upsertKnowledgeTags(userId, [tag]);
    if (!safeTags.length) return null;
    return listKnowledgeTags(userId).find(item => item.tag === safeTags[0]) || { tag: safeTags[0], doc_count: 0 };
}

function filterExistingKnowledgeTags(userId, tags = []) {
    const safeTags = parseKnowledgeTags(tags);
    if (!safeTags.length) return [];
    const rows = db.prepare(`
        SELECT tag
        FROM knowledge_tags
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND tag IN (${safeTags.map(() => '?').join(',')})
    `).all(userId, ...safeTags);
    const existing = new Set(rows.map(row => row.tag));
    return safeTags.filter(tag => existing.has(tag));
}

function setKnowledgeDocumentTags({ docId, userId, tags = [] }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return null;
    const doc = getKnowledgeDocumentForUser(normalizedDocId, userId);
    if (!doc) return null;
    const safeTags = filterExistingKnowledgeTags(userId, tags);
    const now = getBeijingTimestamp();
    const transaction = db.transaction(() => {
        db.prepare('DELETE FROM knowledge_doc_tags WHERE doc_id = ? AND user_id = ?').run(normalizedDocId, userId);
        const insert = db.prepare(`
            INSERT OR IGNORE INTO knowledge_doc_tags (user_id, doc_id, tag, created_at)
            VALUES (?, ?, ?, ?)
        `);
        safeTags.forEach(tag => insert.run(userId, normalizedDocId, tag, now));
        db.prepare('UPDATE knowledge_docs SET updated_at = ? WHERE id = ? AND user_id = ?')
            .run(now, normalizedDocId, userId);
    });
    transaction();
    clearRagCacheForUser(userId);
    return safeTags;
}

async function getKnowledgeDocumentTags({ docId, userId }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return [];
    return await knowledgeRepository.listDocumentTags(normalizedDocId, userId);
}

function buildKnowledgeDocumentScopeFilter(scope = {}, docAlias = 'knowledge_docs') {
    const raw = scope && typeof scope === 'object' ? scope : {};
    const collectionId = normalizeKnowledgeCollectionId(raw.collectionId);
    const tagNames = parseKnowledgeTags(raw.tagNames ?? raw.tagName ?? raw.tag);
    const clauses = [];
    const params = [];
    if (collectionId) {
        clauses.push(`${docAlias}.collection_id = ?`);
        params.push(collectionId);
    }
    if (tagNames.length) {
        clauses.push(`EXISTS (
            SELECT 1
            FROM knowledge_doc_tags tag_scope
            WHERE tag_scope.doc_id = ${docAlias}.id
              AND tag_scope.user_id = ${docAlias}.user_id
              AND tag_scope.tag IN (${tagNames.map(() => '?').join(',')})
        )`);
        params.push(...tagNames);
    }
    return {
        sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
        params
    };
}

function listKnowledgeTags(user, { collectionId = null } = {}) {
    const normalizedUser = normalizeKnowledgeUser(user);
    const normalizedCollectionId = normalizeKnowledgeCollectionId(collectionId);
    if (normalizedCollectionId) {
        const collection = getKnowledgeCollectionForUser(normalizedCollectionId, normalizedUser);
        if (!collection) return [];
        const access = buildDocumentAccessFilter(normalizedUser, 'd', 'c');
        return db.prepare(`
            SELECT t.tag, COUNT(DISTINCT t.doc_id) AS doc_count
            FROM knowledge_doc_tags t
            JOIN knowledge_docs d ON d.id = t.doc_id AND d.user_id = t.user_id
            LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
            WHERE d.deleted_at IS NULL AND ${access.sql}
              AND d.collection_id = ?
            GROUP BY t.tag
            ORDER BY doc_count DESC, t.tag COLLATE NOCASE ASC
        `).all(...access.params, normalizedCollectionId).map(row => ({
            tag: row.tag,
            doc_count: Number(row.doc_count || 0)
        }));
    }

    const access = buildDocumentAccessFilter(normalizedUser, 'd', 'c');
    return db.prepare(`
        WITH tag_names AS (
            SELECT tag
            FROM knowledge_tags
            WHERE user_id = ? AND deleted_at IS NULL
            UNION
            SELECT t.tag
            FROM knowledge_doc_tags t
            JOIN knowledge_docs d ON d.id = t.doc_id AND d.user_id = t.user_id
            LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
            WHERE d.deleted_at IS NULL AND ${access.sql}
        ),
        tag_counts AS (
            SELECT t.tag, COUNT(DISTINCT t.doc_id) AS doc_count
            FROM knowledge_doc_tags t
            JOIN knowledge_docs d ON d.id = t.doc_id AND d.user_id = t.user_id
            LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL
            WHERE d.deleted_at IS NULL AND ${access.sql}
            GROUP BY t.tag
        )
        SELECT tag_names.tag, COALESCE(tag_counts.doc_count, 0) AS doc_count
        FROM tag_names
        LEFT JOIN tag_counts ON tag_counts.tag = tag_names.tag
        ORDER BY doc_count DESC, tag_names.tag COLLATE NOCASE ASC
    `).all(normalizedUser.id, ...access.params, ...access.params).map(row => ({
        tag: row.tag,
        doc_count: Number(row.doc_count || 0)
    }));
}

function getSafeKnowledgeExtension(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    return allowedExtensions.has(ext) ? ext : '.txt';
}

function getKnowledgeSourcePath(relativePath) {
    if (!relativePath) return null;
    const normalized = String(relativePath).replace(/\\/g, '/');
    if (normalized.includes('%')) return null;
    if (!normalized.startsWith('uploads/knowledge_docs/') || normalized.includes('\0')) return null;
    const target = path.resolve(uploadRoot, normalized.slice('uploads/'.length));
    if (target !== knowledgeSourceRoot && !target.startsWith(knowledgeSourceRoot + path.sep)) return null;
    return target;
}

function toProjectRelativePath(filePath) {
    const uploadRelative = path.relative(uploadRoot, filePath).replace(/\\/g, '/');
    return uploadRelative ? `uploads/${uploadRelative}` : 'uploads';
}

function persistUploadedKnowledgeFile(file, userId, docId) {
    ensureKnowledgeSourceRoot();
    const safeUserId = String(normalizeKnowledgeDocId(userId) || 'unknown');
    const ext = getSafeKnowledgeExtension(file.originalname);
    const targetDir = path.join(knowledgeSourceRoot, safeUserId);
    const targetPath = path.join(targetDir, `${docId}${ext}`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.renameSync(file.path, targetPath);
    clearDirSizeCache();
    return {
        sourcePath: toProjectRelativePath(targetPath),
        sourceSize: fs.statSync(targetPath).size
    };
}

async function readKnowledgeDocumentFromPath(filePath, originalName = '') {
    const text = await extractDocumentTextWithOcrFallback(filePath, '', originalName || filePath, { maxOcrPages: 10 });
    return truncateExtractedText(text, getKnowledgeLimits().extractMaxChars);
}

async function createKnowledgeDocumentFromUpload({ userId, file, collectionId = null, tags = [] }) {
    const now = getBeijingTimestamp();
    const resolvedCollectionId = await resolveKnowledgeCollectionId({ userId, collectionId });
    const fileInfo = db.prepare(`
        INSERT INTO knowledge_docs (
            user_id, collection_id, name, status, chunk_count, indexed_chunks, progress, error_message, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, resolvedCollectionId, file.originalname, 'processing', 0, 0, 0, '', now, now);
    const docId = fileInfo.lastInsertRowid;
    const safeTags = parseKnowledgeTags(tags);
    const assignedTags = safeTags.length ? setKnowledgeDocumentTags({ docId, userId, tags: safeTags }) : [];

    try {
        const savedFile = persistUploadedKnowledgeFile(file, userId, docId);
        db.prepare(`
            UPDATE knowledge_docs
            SET source_path = ?, source_size = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `).run(savedFile.sourcePath, savedFile.sourceSize, getBeijingTimestamp(), docId, userId);
        clearRagCacheForUser(userId);
        return { docId, collectionId: resolvedCollectionId, tags: assignedTags, ...savedFile };
    } catch (e) {
        markKnowledgeDocumentError({ docId, userId, error: e });
        throw e;
    }
}

async function getKnowledgeDocumentForUser(docId, user, { includeDeleted = false } = {}) {
    return await knowledgeRepository.getDocumentForUser(docId, user, { includeDeleted });
}

function getKnowledgeDocumentAuditList({ limit = 100, offset = 0, includeActive = false } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const deletedFilter = includeActive ? '' : 'WHERE d.deleted_at IS NOT NULL';
    const data = db.prepare(`
        SELECT
            d.id,
            d.user_id,
            COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username,
            u.nickname,
            d.name,
            d.status,
            d.is_enabled,
            d.chunk_count,
            d.indexed_chunks,
            d.progress,
            d.error_message,
            d.source_path,
            d.source_size,
            d.created_at,
            d.updated_at,
            d.processed_at,
            d.deleted_at,
            d.deleted_by_user
        FROM knowledge_docs d
        LEFT JOIN users u ON u.id = d.user_id
        ${deletedFilter}
        ORDER BY COALESCE(d.deleted_at, d.updated_at, d.created_at) DESC
        LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM knowledge_docs d ${deletedFilter}`).get().count;
    return { data, total, limit: safeLimit, offset: safeOffset };
}

function markKnowledgeDocumentProcessing({ docId, userId }) {
    const now = getBeijingTimestamp();
    return db.prepare(`
        UPDATE knowledge_docs
        SET status = ?, chunk_count = 0, indexed_chunks = 0, progress = 0, error_message = '', updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run('processing', now, docId, userId).changes > 0;
}

function markKnowledgeDocumentReady({ docId, userId, chunkCount }) {
    const now = getBeijingTimestamp();
    return db.prepare(`
        UPDATE knowledge_docs
        SET status = ?, chunk_count = ?, indexed_chunks = ?, progress = 100, error_message = '', processed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run('ready', chunkCount, chunkCount, now, now, docId, userId).changes > 0;
}

function markKnowledgeDocumentError({ docId, userId, error }) {
    const now = getBeijingTimestamp();
    return db.prepare(`
        UPDATE knowledge_docs
        SET status = ?, progress = 0, error_message = ?, processed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run('error', String(error?.message || error || '知识库索引失败').slice(0, 1000), now, now, docId, userId).changes > 0;
}

async function processKnowledgeDocument({ docId, userId, user = null }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    const doc = normalizedDocId ? getKnowledgeDocumentForUser(normalizedDocId, userId) : null;
    if (!doc) {
        const error = new Error('Knowledge document not found');
        error.statusCode = 404;
        throw error;
    }

    const sourcePath = getKnowledgeSourcePath(doc.source_path);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
        const error = new Error('原始文件不存在，无法重新索引，请重新上传文档');
        markKnowledgeDocumentError({ docId: normalizedDocId, userId, error });
        throw error;
    }

    markKnowledgeDocumentProcessing({ docId: normalizedDocId, userId });
    clearRagCacheForUser(userId);
    clearKnowledgeGraphForDocument(normalizedDocId);
    db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(normalizedDocId);

    try {
        const text = await readKnowledgeDocumentFromPath(sourcePath, doc.name);
        const chunkCount = await indexDocumentChunks(normalizedDocId, text, {
            userId,
            user,
            onProgress: ({ indexed, total }) => {
                const now = getBeijingTimestamp();
                const progress = total > 0 ? Math.min(Math.floor((indexed / total) * 100), 99) : 0;
                db.prepare(`
                    UPDATE knowledge_docs
                    SET indexed_chunks = ?, chunk_count = ?, progress = ?, updated_at = ?
                    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
                `).run(indexed, total, progress, now, normalizedDocId, userId);
            }
        });
        markKnowledgeDocumentReady({ docId: normalizedDocId, userId, chunkCount });
        clearRagCacheForUser(userId);
        return { docId: normalizedDocId, chunkCount };
    } catch (e) {
        db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(normalizedDocId);
        markKnowledgeDocumentError({ docId: normalizedDocId, userId, error: e });
        clearRagCacheForUser(userId);
        throw e;
    }
}

async function getKnowledgeDocumentDetail({ docId, userId, user = null, limit = 20, offset = 0 }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return null;
    const accessUser = user || userId;
    const doc = await getKnowledgeDocumentForUser(normalizedDocId, accessUser);
    if (!doc) return null;
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const chunks = await knowledgeRepository.listDocumentChunks(normalizedDocId, safeLimit, safeOffset);
    const totalChunks = await knowledgeRepository.countDocumentChunks(normalizedDocId);
    const tags = await getKnowledgeDocumentTags({ docId: normalizedDocId, userId: accessUser });
    return { doc: { ...doc, tags }, chunks: chunks || [], totalChunks: totalChunks || 0, limit: safeLimit, offset: safeOffset };
}

function setKnowledgeDocumentEnabled({ docId, userId, enabled }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return false;
    const changed = db.prepare(`
        UPDATE knowledge_docs
        SET is_enabled = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(enabled ? 1 : 0, getBeijingTimestamp(), normalizedDocId, userId).changes > 0;
    if (changed) clearRagCacheForUser(userId);
    return changed;
}

function normalizeDocIds(docIds) {
    if (!Array.isArray(docIds)) return [];
    return [...new Set(docIds.map(normalizeKnowledgeDocId).filter(Boolean))].slice(0, 100);
}

function batchDeleteKnowledgeDocuments({ userId, docIds }) {
    const ids = normalizeDocIds(docIds);
    let deleted = 0;
    for (const id of ids) {
        if (deleteKnowledgeDocument({ docId: id, userId })) deleted += 1;
    }
    return { requested: ids.length, deleted };
}

function batchReindexKnowledgeDocuments({ userId, docIds, user = null }) {
    const ids = normalizeDocIds(docIds);
    let scheduled = 0;
    let skipped = 0;
    for (const id of ids) {
        const doc = getKnowledgeDocumentForUser(id, userId);
        if (!doc || !doc.source_path) {
            skipped += 1;
            continue;
        }
        const result = scheduleKnowledgeDocumentIndexing({ docId: id, userId, user });
        if (result.started) scheduled += 1;
        else skipped += 1;
    }
    if (scheduled > 0) clearRagCacheForUser(userId);
    return { requested: ids.length, scheduled, skipped };
}

function recordRagFeedback({ userId, query, chunkId, docName, score, helpful, note }) {
    const safeQuery = String(query || '').trim().slice(0, 1000);
    if (!safeQuery) return null;
    const safeChunkId = normalizeKnowledgeDocId(chunkId);
    const info = db.prepare(`
        INSERT INTO rag_feedback (user_id, query, chunk_id, doc_name, score, helpful, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        userId,
        safeQuery,
        safeChunkId,
        String(docName || '').slice(0, 255),
        Number.isFinite(Number(score)) ? Number(score) : null,
        helpful ? 1 : 0,
        String(note || '').slice(0, 1000),
        getBeijingTimestamp()
    );
    return { id: info.lastInsertRowid };
}

function getRagFeedbackSummary(userId) {
    const rows = db.prepare(`
        SELECT doc_name, helpful, COUNT(*) AS count
        FROM rag_feedback
        WHERE user_id = ?
        GROUP BY doc_name, helpful
    `).all(userId);
    const summary = { helpful: 0, unhelpful: 0, byDoc: [] };
    const byDoc = new Map();
    for (const row of rows) {
        const count = Number(row.count || 0);
        if (row.helpful) summary.helpful += count;
        else summary.unhelpful += count;
        const name = row.doc_name || '未知文档';
        const item = byDoc.get(name) || { docName: name, helpful: 0, unhelpful: 0 };
        if (row.helpful) item.helpful += count;
        else item.unhelpful += count;
        byDoc.set(name, item);
    }
    summary.byDoc = Array.from(byDoc.values()).sort((a, b) => b.unhelpful - a.unhelpful).slice(0, 10);
    return summary;
}

async function setKnowledgeDocumentCollection({ docId, userId, collectionId = null }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return null;
    const doc = await getKnowledgeDocumentForUser(normalizedDocId, userId);
    if (!doc) return null;
    const resolvedCollectionId = await resolveKnowledgeCollectionId({ userId, collectionId });
    const now = getBeijingTimestamp();
    const changed = db.prepare(`
        UPDATE knowledge_docs
        SET collection_id = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(resolvedCollectionId, now, normalizedDocId, userId).changes > 0;
    if (!changed) return null;
    if (resolvedCollectionId) {
        db.prepare('UPDATE knowledge_collections SET updated_at = ? WHERE id = ? AND user_id = ?')
            .run(now, resolvedCollectionId, userId);
    }
    clearRagCacheForUser(userId);
    return await getKnowledgeDocumentForUser(normalizedDocId, userId);
}

function clampQualityScore(value) {
    const score = Math.round(Number(value) || 0);
    return Math.max(0, Math.min(score, 100));
}

function buildKnowledgeQualitySignals({ overview, feedback, graph }) {
    const total = Number(overview.total || 0);
    const ready = Number(overview.ready || 0);
    const readyEnabled = Number(overview.readyEnabled || 0);
    const error = Number(overview.error || 0);
    const disabled = Number(overview.disabled || 0);
    const emptyReady = Number(overview.emptyReady || 0);
    const chunks = Number(overview.chunks || 0);
    const staleReady = Number(overview.staleReady || 0);
    const feedbackTotal = Number(feedback.helpful || 0) + Number(feedback.unhelpful || 0);
    const helpfulRate = feedbackTotal > 0 ? Math.round((Number(feedback.helpful || 0) / feedbackTotal) * 100) : null;
    const readinessRate = total > 0 ? Math.round((readyEnabled / total) * 100) : 0;
    const avgChunksPerReadyDoc = ready > 0 ? Math.round((chunks / ready) * 10) / 10 : 0;
    const graphEntities = Number(graph.entities || 0);
    const graphRelations = Number(graph.relations || 0);

    let score = total > 0 ? 55 : 0;
    score += Math.min(readinessRate * 0.25, 25);
    score += avgChunksPerReadyDoc > 0 ? Math.min(avgChunksPerReadyDoc, 10) : 0;
    score += graphEntities > 0 || graphRelations > 0 ? 5 : 0;
    if (helpfulRate !== null) score += helpfulRate >= 70 ? 5 : helpfulRate >= 50 ? 2 : -5;
    score -= Math.min(error * 12, 30);
    score -= Math.min(disabled * 4, 16);
    score -= Math.min(emptyReady * 10, 20);
    score -= Math.min(staleReady * 2, 10);
    const normalizedScore = clampQualityScore(score);

    return {
        score: normalizedScore,
        level: normalizedScore >= 85 ? 'excellent' : normalizedScore >= 70 ? 'good' : normalizedScore >= 50 ? 'attention' : 'risk',
        readinessRate,
        avgChunksPerReadyDoc,
        feedbackTotal,
        helpfulRate,
        staleReady,
        graphEntities,
        graphRelations
    };
}

async function getKnowledgeQualityReport(userId) {
    const normalized = normalizeKnowledgeUser(userId);
    const overview = (await knowledgeRepository.getDocumentQualityOverview(normalized.id)) || {};
    const problemDocs = (await knowledgeRepository.listProblemDocuments(normalized.id)) || [];
    const feedback = getRagFeedbackSummary(normalized.id);
    const graph = getGraphSummary(userId);
    const signals = buildKnowledgeQualitySignals({ overview, feedback, graph });
    const recommendations = [];
    if (Number(overview.total || 0) === 0) recommendations.push('先上传一批高频业务资料，再用召回测试验证真实问题能否命中。');
    if (Number(overview.error || 0) > 0) recommendations.push('存在索引失败文档，建议先使用“重试失败”恢复可用资料。');
    if (Number(overview.disabled || 0) > 0) recommendations.push('存在停用文档，确认是否需要重新启用或移出知识库。');
    if (Number(overview.emptyReady || 0) > 0) recommendations.push('存在已就绪但无分块文档，建议重新上传或重建索引。');
    if (Number(overview.staleReady || 0) > 0) recommendations.push('部分就绪资料超过 180 天未更新，建议确认时效性后重建索引。');
    if (signals.helpfulRate !== null && signals.helpfulRate < 50) recommendations.push('召回反馈的有用率偏低，建议优先检查问题样本、文档命名和分块质量。');
    if (signals.graphEntities === 0 && Number(overview.ready || 0) > 0) recommendations.push('知识图谱尚未形成有效实体，可对关键文档重建图谱以增强关系召回。');
    if (problemDocs.some(doc => Number(doc.unhelpful || 0) > Number(doc.helpful || 0))) {
        recommendations.push('部分文档收到较多负反馈，建议检查内容时效性、命名和切片质量。');
    }
    if (recommendations.length === 0) recommendations.push('知识库质量状态正常，可以通过召回测试持续观察命中效果。');
    return {
        overview: {
            total: Number(overview.total || 0),
            ready: Number(overview.ready || 0),
            processing: Number(overview.processing || 0),
            error: Number(overview.error || 0),
            disabled: Number(overview.disabled || 0),
            emptyReady: Number(overview.emptyReady || 0),
            readyEnabled: Number(overview.readyEnabled || 0),
            staleReady: Number(overview.staleReady || 0),
            chunks: Number(overview.chunks || 0),
            sourceSize: Number(overview.sourceSize || 0)
        },
        signals,
        feedback,
        graph,
        problemDocs,
        recommendations,
        queue: {
            running: runningIndexCount,
            pending: pendingIndexes.size,
            maxConcurrent: getMaxConcurrentIndexes()
        }
    };
}

function drainKnowledgeDocumentIndexQueue() {
    const maxConcurrentIndexes = getMaxConcurrentIndexes();
    while (runningIndexCount < maxConcurrentIndexes && pendingIndexes.size > 0) {
        const [key, job] = pendingIndexes.entries().next().value;
        pendingIndexes.delete(key);
        runningIndexCount += 1;

        setImmediate(async () => {
            try {
                await processKnowledgeDocument(job);
            } catch (e) {
                if (e.statusCode !== 404) {
                    logger.error({ err: e.message, docId: job.docId }, 'RAG 文档索引失败');
                }
            } finally {
                activeIndexes.delete(key);
                runningIndexCount = Math.max(runningIndexCount - 1, 0);
                drainKnowledgeDocumentIndexQueue();
            }
        });
    }
}

function scheduleKnowledgeDocumentIndexing({ docId, userId, user = null }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return { started: false, reason: 'invalid_doc_id' };
    const key = `${userId}:${normalizedDocId}`;
    if (activeIndexes.has(key)) return { started: false, reason: 'already_processing' };

    activeIndexes.add(key);
    pendingIndexes.set(key, { docId: normalizedDocId, userId, user });
    drainKnowledgeDocumentIndexQueue();
    return { started: true };
}

function syncKnowledgeDocumentIndexConcurrency() {
    drainKnowledgeDocumentIndexQueue();
    return getKnowledgeIndexQueueStatus();
}

function getKnowledgeIndexQueueStatus(userId = null) {
    const normalizedUserId = Number.parseInt(userId, 10);
    const hasUserFilter = Number.isSafeInteger(normalizedUserId) && normalizedUserId > 0;
    const pendingJobs = Array.from(pendingIndexes.values());
    const activeKeys = Array.from(activeIndexes.values());
    const userPendingDocs = hasUserFilter
        ? pendingJobs.filter(job => Number(job.userId) === normalizedUserId).map(job => job.docId).slice(0, 20)
        : [];
    const userActive = hasUserFilter
        ? activeKeys.filter(key => String(key).startsWith(String(normalizedUserId) + ':')).length
        : 0;
    return {
        running: runningIndexCount,
        pending: pendingIndexes.size,
        active: activeIndexes.size,
        maxConcurrent: getMaxConcurrentIndexes(),
        saturated: runningIndexCount >= getMaxConcurrentIndexes(),
        userPending: userPendingDocs.length,
        userActive,
        userPendingDocIds: userPendingDocs
    };
}

function getKnowledgeDocumentSummaryForUser(userId, scope = {}) {
    const normalized = normalizeKnowledgeUser(userId);
    const scopeFilter = buildKnowledgeDocumentScopeFilter(scope, 'd');
    const access = buildDocumentAccessFilter(normalized, 'd', 'c');
    const fromSql = 'FROM knowledge_docs d LEFT JOIN knowledge_collections c ON c.id = d.collection_id AND c.deleted_at IS NULL';
    const wherePrefix = `${access.sql} AND d.deleted_at IS NULL`;
    const rows = db.prepare(`
        SELECT
            d.status,
            COUNT(*) AS count,
            COALESCE(SUM(d.chunk_count), 0) AS chunks,
            COALESCE(SUM(d.source_size), 0) AS source_size
        ${fromSql}
        WHERE ${wherePrefix}
          ${scopeFilter.sql}
        GROUP BY d.status
    `).all(...access.params, ...scopeFilter.params);
    const retryableErrors = db.prepare(`
        SELECT COUNT(*) AS count
        ${fromSql}
        WHERE ${wherePrefix}
          AND d.status = 'error'
          AND d.source_path IS NOT NULL
          AND d.source_path != ''
          ${scopeFilter.sql}
    `).get(...access.params, ...scopeFilter.params).count;
    const readyEnabled = db.prepare(`
        SELECT COUNT(*) AS count
        ${fromSql}
        WHERE ${wherePrefix}
          AND d.status = 'ready'
          AND COALESCE(d.is_enabled, 1) = 1
          ${scopeFilter.sql}
    `).get(...access.params, ...scopeFilter.params).count;
    const lastError = db.prepare(`
        SELECT d.id, d.name, d.error_message, d.updated_at
        ${fromSql}
        WHERE ${wherePrefix}
          AND d.status = 'error'
          AND d.error_message IS NOT NULL
          AND d.error_message != ''
          ${scopeFilter.sql}
        ORDER BY COALESCE(d.updated_at, d.processed_at, d.created_at) DESC
        LIMIT 1
    `).get(...access.params, ...scopeFilter.params) || null;

    const summary = {
        total: 0,
        ready: 0,
        readyEnabled,
        processing: 0,
        error: 0,
        chunks: 0,
        sourceSize: 0,
        retryableErrors,
        lastError,
        config: getRagConfig({}, normalized.id),
        queue: {
            running: runningIndexCount,
            pending: pendingIndexes.size,
            maxConcurrent: getMaxConcurrentIndexes()
        }
    };

    for (const row of rows) {
        const count = Number(row.count || 0);
        summary.total += count;
        if (row.status === 'ready') summary.ready = count;
        if (row.status === 'processing') summary.processing = count;
        if (row.status === 'error') summary.error = count;
        summary.chunks += Number(row.chunks || 0);
        summary.sourceSize += Number(row.source_size || 0);
    }
    return summary;
}

function scheduleFailedKnowledgeDocumentsForUser({ userId, limit = 20, user = null }) {
    const rows = db.prepare(`
        SELECT id
        FROM knowledge_docs
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND status = 'error'
          AND source_path IS NOT NULL
          AND source_path != ''
        ORDER BY COALESCE(updated_at, processed_at, created_at) DESC
        LIMIT ?
    `).all(userId, Math.max(Number.parseInt(limit, 10) || 20, 1));

    let scheduled = 0;
    let alreadyProcessing = 0;
    for (const row of rows) {
        const result = scheduleKnowledgeDocumentIndexing({ docId: row.id, userId, user });
        if (result.started) scheduled += 1;
        if (result.reason === 'already_processing') alreadyProcessing += 1;
    }

    return {
        total: rows.length,
        scheduled,
        alreadyProcessing
    };
}

function recoverStaleKnowledgeDocumentIndexes({ limit = 50 } = {}) {
    const rows = db.prepare(`
        SELECT id, user_id, source_path
        FROM knowledge_docs
        WHERE status = 'processing'
          AND deleted_at IS NULL
        ORDER BY COALESCE(updated_at, created_at) ASC
        LIMIT ?
    `).all(Math.max(Number.parseInt(limit, 10) || 50, 1));
    let scheduled = 0;
    let failed = 0;

    for (const row of rows) {
        if (!row.source_path) {
            markKnowledgeDocumentError({
                docId: row.id,
                userId: row.user_id,
                error: new Error('索引任务中断，原始文件缺失，请重新上传文档')
            });
            failed += 1;
            continue;
        }
        const result = scheduleKnowledgeDocumentIndexing({ docId: row.id, userId: row.user_id });
        if (result.started) scheduled += 1;
    }

    if (rows.length > 0) {
        logger.info({ total: rows.length, scheduled, failed }, 'RAG 索引恢复扫描完成');
    }
    return { total: rows.length, scheduled, failed };
}

function deleteKnowledgeDocument({ docId, userId }) {
    const normalizedDocId = normalizeKnowledgeDocId(docId);
    if (!normalizedDocId) return false;
    const doc = getKnowledgeDocumentForUser(normalizedDocId, userId);
    if (!doc) return false;

    const queueKey = `${userId}:${normalizedDocId}`;
    if (pendingIndexes.delete(queueKey)) activeIndexes.delete(queueKey);
    const now = getBeijingTimestamp();
    const changed = db.prepare(`
        UPDATE knowledge_docs
        SET deleted_at = ?, deleted_by_user = ?, is_enabled = 0, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(now, userId, now, normalizedDocId, userId).changes > 0;
    if (changed) clearRagCacheForUser(userId);
    return changed;
}
module.exports = {
    createKnowledgeCollection,
    getKnowledgeCollectionShareOptions,
    updateKnowledgeCollectionSharing,
    createKnowledgeTag,
    createKnowledgeDocumentFromUpload,
    deleteKnowledgeDocument,
    getKnowledgeCollectionForUser,
    getKnowledgeDocumentAuditList,
    getKnowledgeDocumentForUser,
    getKnowledgeDocumentDetail,
    getKnowledgeDocumentTags,
    getKnowledgeSourcePath,
    getKnowledgeDocumentSummaryForUser,
    getKnowledgeIndexQueueStatus,
    getKnowledgeQualityReport,
    getRagFeedbackSummary,
    listKnowledgeCollections,
    listKnowledgeTags,
    markKnowledgeDocumentError,
    markKnowledgeDocumentProcessing,
    markKnowledgeDocumentReady,
    processKnowledgeDocument,
    readKnowledgeDocumentFromPath,
    recoverStaleKnowledgeDocumentIndexes,
    batchDeleteKnowledgeDocuments,
    batchReindexKnowledgeDocuments,
    recordRagFeedback,
    scheduleFailedKnowledgeDocumentsForUser,
    setKnowledgeDocumentCollection,
    setKnowledgeDocumentTags,
    setKnowledgeDocumentEnabled,
    scheduleKnowledgeDocumentIndexing,
    syncKnowledgeDocumentIndexConcurrency
};
