'use strict';

// 知识内容产品层：在不破坏既有 knowledge_docs / knowledge_chunks 的前提下，
// 为上传型 RAG 建立稳定文档、版本、块与引用投影。旧表继续服务现有聊天和
// 管理接口，新表为审核、来源、精确引用和后续局域网连接器提供统一模型。
const crypto = require('crypto');
const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { isAdmin } = require('../permissions');
const { canReadKnowledgeResource } = require('./knowledge-access');
const { buildRagSearchContent } = require('./rag-tokenizer');
const { hydrateManualKnowledgeArticleEmbeddings } = require('./knowledge-manual-embeddings');

const DOCUMENT_STATUSES = new Set(['draft', 'review', 'published', 'expired', 'archived']);
const PERMISSIONS = new Set(['owner', 'manager', 'editor', 'commenter', 'viewer']);
const VERIFIED_STATUSES = new Set(['verified', 'unverified', 'expired']);
const FRESHNESS_POLICIES = new Set(['manual', '30d', '90d', '180d', '365d']);
const COMMENT_KINDS = new Set(['comment', 'correction']);
const COMMENT_STATUSES = new Set(['open', 'resolved']);

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeText(value, max = 500) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeStatus(value, allowed, fallback) {
    const status = String(value || '').trim().toLowerCase();
    return allowed.has(status) ? status : fallback;
}

function normalizeJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizeDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : getBeijingTimestamp(date);
}

function dueAtForPolicy(policy, now = new Date()) {
    const normalized = FRESHNESS_POLICIES.has(policy) ? policy : 'manual';
    const days = Number.parseInt(normalized, 10);
    if (!Number.isFinite(days) || days <= 0) return null;
    return getBeijingTimestamp(new Date(now.getTime() + days * 24 * 60 * 60 * 1000));
}

function diffText(previous = '', next = '') {
    const before = String(previous || '').split(/\r?\n/);
    const after = String(next || '').split(/\r?\n/);
    const max = Math.max(before.length, after.length);
    const changes = [];
    for (let index = 0; index < max; index += 1) {
        if (before[index] === after[index]) continue;
        if (before[index] !== undefined) changes.push({ type: 'removed', line: index + 1, text: before[index] });
        if (after[index] !== undefined) changes.push({ type: 'added', line: index + 1, text: after[index] });
        if (changes.length >= 400) break;
    }
    return { changed: changes.length, truncated: changes.length >= 400, changes };
}

function citationKeyFor({ documentId, versionId, chunkId }) {
    return `kb:${normalizeId(documentId) || 0}:v${normalizeId(versionId) || 0}:c${normalizeId(chunkId) || 0}`;
}

function blockCitationKeyFor({ documentId, versionId, blockId }) {
    return `kb:${normalizeId(documentId) || 0}:v${normalizeId(versionId) || 0}:b${normalizeId(blockId) || 0}`;
}

async function getOrCreateManualSource(userId, collectionId = null) {
    const safeUserId = normalizeId(userId);
    const safeCollectionId = normalizeId(collectionId);
    const existing = await queryOne(`
        SELECT * FROM knowledge_sources
        WHERE user_id = ? AND kind = 'manual' AND deleted_at IS NULL
          AND collection_id IS NOT DISTINCT FROM ?
        ORDER BY id ASC LIMIT 1
    `, [safeUserId, safeCollectionId]);
    if (existing) return existing;
    const timestamp = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO knowledge_sources (user_id, collection_id, name, kind, config_json, sync_mode, status, created_at, updated_at)
        VALUES (?, ?, '人工知识文章', 'manual', '{}', 'manual', 'active', ?, ?) RETURNING *
    `, [safeUserId, safeCollectionId, timestamp, timestamp]);
}

async function createKnowledgeArticle({ user, title, content, collectionId = null, summary = '' }) {
    const ownerUserId = normalizeId(user?.id);
    const safeTitle = normalizeText(title, 255);
    const safeContent = String(content || '').trim().slice(0, 2_000_000);
    if (!ownerUserId || !safeTitle || !safeContent) return null;
    const safeCollectionId = normalizeId(collectionId);
    const source = await getOrCreateManualSource(ownerUserId, safeCollectionId);
    const timestamp = getBeijingTimestamp();
    return await transaction(async trx => {
        const document = await trx.queryOne(`
            INSERT INTO knowledge_documents (
                source_id, collection_id, owner_user_id, title, canonical_uri, mime_type,
                visibility_status, lifecycle_status, content_owner_user_id, verified_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, '', 'text/markdown', 'personal', 'draft', ?, 'unverified', ?, ?) RETURNING *
        `, [source.id, safeCollectionId, ownerUserId, safeTitle, ownerUserId, timestamp, timestamp]);
        const version = await trx.queryOne(`
            INSERT INTO knowledge_document_versions (
                document_id, version_no, source_hash, source_size, parser_version, chunker_version,
                embedding_profile, status, content_path, change_summary, created_at, updated_at
            ) VALUES (?, 1, ?, ?, 'manual-v1', 'manual-block-v1', '', 'draft', '', ?, ?, ?) RETURNING *
        `, [document.id, crypto.createHash('sha256').update(safeContent).digest('hex'), Buffer.byteLength(safeContent), normalizeText(summary, 1000), timestamp, timestamp]);
        const block = await trx.queryOne(`
            INSERT INTO knowledge_blocks (
                version_id, block_type, block_order, heading_path, content, char_start, char_end,
                source_locator_json, created_at, updated_at
            ) VALUES (?, 'article', 0, ?, ?, 0, ?, ?, ?, ?) RETURNING *
        `, [version.id, safeTitle, safeContent, safeContent.length, JSON.stringify({ headingPath: safeTitle, charStart: 0, charEnd: safeContent.length }), timestamp, timestamp]);
        await trx.execute(`
            INSERT INTO knowledge_permissions (resource_type, resource_id, principal_type, principal_id, permission, inherited, created_by, created_at, updated_at)
            VALUES ('document', ?, 'user', ?, 'owner', 0, ?, ?, ?)
        `, [document.id, String(ownerUserId), ownerUserId, timestamp, timestamp]);
        const citationKey = blockCitationKeyFor({ documentId: document.id, versionId: version.id, blockId: block.id });
        await trx.execute(`
            INSERT INTO knowledge_citations (
                citation_key, document_id, version_id, block_id, title_snapshot, locator_json, quoted_text, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [citationKey, document.id, version.id, block.id, safeTitle, JSON.stringify({ headingPath: safeTitle, charStart: 0, charEnd: safeContent.length }), safeContent.slice(0, 2000), timestamp]);
        const legacy = await trx.queryOne(`
            INSERT INTO knowledge_docs (
                user_id, collection_id, name, status, is_enabled, chunk_count, indexed_chunks, progress,
                error_message, source_path, source_size, source_hash, product_document_id, lifecycle_status,
                created_at, updated_at, processed_at
            ) VALUES (?, ?, ?, 'draft', 0, 1, 1, 100, '', '', ?, ?, ?, 'draft', ?, ?, ?)
            RETURNING *
        `, [ownerUserId, safeCollectionId, safeTitle, Buffer.byteLength(safeContent), crypto.createHash('sha256').update(safeContent).digest('hex'), document.id, timestamp, timestamp, timestamp]);
        const chunk = await trx.queryOne(`
            INSERT INTO knowledge_chunks (
                doc_id, content, search_content, heading_path, chunk_index, char_start, char_end, embedding,
                embedding_profile, embedding_dimensions, block_id
            ) VALUES (?, ?, ?, ?, 0, 0, ?, NULL, '', 0, ?) RETURNING *
        `, [legacy.id, safeContent, buildRagSearchContent(`${safeTitle}\n${safeContent}`), safeTitle, safeContent.length, block.id]);
        await trx.execute(`
            UPDATE knowledge_citations
            SET legacy_chunk_id = ? WHERE citation_key = ?
        `, [chunk.id, citationKey]);
        await trx.execute('UPDATE knowledge_document_versions SET legacy_doc_id = ? WHERE id = ?', [legacy.id, version.id]);
        await trx.execute('UPDATE knowledge_documents SET current_version_id = ?, legacy_doc_id = ? WHERE id = ?', [version.id, legacy.id, document.id]);
        return { document: { ...document, legacy_doc_id: legacy.id }, version, block, chunk, citationKey };
    });
}

async function getVersionForUser(versionId, user) {
    const id = normalizeId(versionId);
    if (!id) return null;
    const row = await queryOne(`
        SELECT version_id, document_id FROM (
            SELECT kv.id AS version_id, kv.document_id FROM knowledge_document_versions kv WHERE kv.id = ?
        ) version_ref
    `, [id]);
    if (!row) return null;
    const document = await getProductDocumentForUser(row.document_id, user);
    if (!document) return null;
    const version = await queryOne('SELECT * FROM knowledge_document_versions WHERE id = ?', [id]);
    return { document, version };
}

function canEditDocument(document, user) {
    return Boolean(document && user && (isAdmin(user)
        || Number(document.owner_user_id) === Number(user.id)
        || Number(document.content_owner_user_id) === Number(user.id)));
}

async function submitDocumentVersionForReview({ versionId, actor, reviewerUserId, note = '' }) {
    const detail = await getVersionForUser(versionId, actor);
    const reviewer = normalizeId(reviewerUserId);
    if (!detail || !reviewer || !canEditDocument(detail.document, actor) || detail.version.status !== 'draft') return null;
    const timestamp = getBeijingTimestamp();
    await transaction(async trx => {
        await trx.execute(`
            UPDATE knowledge_document_versions SET status = 'review', submitted_at = ?, updated_at = ? WHERE id = ?
        `, [timestamp, timestamp, detail.version.id]);
        await trx.execute(`
            INSERT INTO knowledge_reviews (version_id, reviewer_user_id, status, note, created_at, updated_at)
            VALUES (?, ?, 'pending', ?, ?, ?)
        `, [detail.version.id, reviewer, normalizeText(note, 2000), timestamp, timestamp]);
    });
    return { versionId: Number(detail.version.id), status: 'review', reviewerUserId: reviewer };
}

async function reviewDocumentVersion({ versionId, actor, approved, note = '' }) {
    const safeVersionId = normalizeId(versionId);
    if (!safeVersionId || !actor?.id) return null;
    // 审核人不必拥有阅读整篇私有文档的普通 viewer 权限；其可操作范围仅限
    // 被显式分配的 pending review。不能先走 getVersionForUser，否则审核人会
    // 因尚未获得阅读权限而无法完成审核。
    const version = await queryOne('SELECT * FROM knowledge_document_versions WHERE id = ?', [safeVersionId]);
    if (!version || version.status !== 'review') return null;
    const review = await queryOne(`
        SELECT * FROM knowledge_reviews
        WHERE version_id = ? AND reviewer_user_id = ? AND status = 'pending'
        ORDER BY id DESC LIMIT 1
    `, [version.id, actor.id]);
    if (!review && !isAdmin(actor)) return null;
    const document = await queryOne('SELECT * FROM knowledge_documents WHERE id = ? AND deleted_at IS NULL', [version.document_id]);
    if (!document) return null;
    const timestamp = getBeijingTimestamp();
    const nextStatus = approved === true ? 'draft' : 'draft';
    await transaction(async trx => {
        if (review) {
            await trx.execute(`
                UPDATE knowledge_reviews SET status = ?, note = ?, updated_at = ? WHERE id = ?
            `, [approved === true ? 'approved' : 'rejected', normalizeText(note, 2000), timestamp, review.id]);
        }
        await trx.execute(`
            UPDATE knowledge_document_versions SET status = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?
        `, [nextStatus, timestamp, actor.id, timestamp, version.id]);
    });
    return { documentId: Number(document.id), versionId: Number(version.id), status: nextStatus, approved: approved === true };
}

async function publishDocumentVersion({ versionId, actor }) {
    const detail = await getVersionForUser(versionId, actor);
    if (!detail || !canEditDocument(detail.document, actor) || !['draft', 'review'].includes(detail.version.status)) return null;
    const latestReview = await queryOne(`
        SELECT status FROM knowledge_reviews WHERE version_id = ? ORDER BY id DESC LIMIT 1
    `, [detail.version.id]);
    // 人工内容的状态机必须完整经过 draft → review → published。导入资料由
    // publishLegacyDocumentProjection 走独立的自动索引发布链路，不能借此绕过
    // 人工知识文章的审核责任。
    if (!latestReview || latestReview.status !== 'approved') return null;
    const nextLegacyDocId = normalizeId(detail.version.legacy_doc_id);
    if (!nextLegacyDocId) return null;
    const timestamp = getBeijingTimestamp();
    await transaction(async trx => {
        const previousLegacyDocId = normalizeId(detail.document.legacy_doc_id);
        if (previousLegacyDocId && previousLegacyDocId !== nextLegacyDocId) {
            await trx.execute(`
                UPDATE knowledge_docs SET is_enabled = 0, lifecycle_status = 'archived', updated_at = ?
                WHERE id = ? AND user_id = ?
            `, [timestamp, previousLegacyDocId, detail.document.owner_user_id]);
        }
        await trx.execute(`
            UPDATE knowledge_document_versions
            SET status = 'published', published_at = ?, published_by = ?, updated_at = ? WHERE id = ?
        `, [timestamp, actor.id, timestamp, detail.version.id]);
        await trx.execute(`
            UPDATE knowledge_documents
            SET current_version_id = ?, legacy_doc_id = ?, lifecycle_status = 'published', updated_at = ? WHERE id = ?
        `, [detail.version.id, nextLegacyDocId, timestamp, detail.document.id]);
        await trx.execute(`
            UPDATE knowledge_docs
            SET product_document_id = ?, status = 'lexical_ready', lifecycle_status = 'published', is_enabled = 1,
                processed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?
        `, [detail.document.id, timestamp, timestamp, nextLegacyDocId, detail.document.owner_user_id]);
    });
    // 发布事务先把文章安全地切到关键词可检索，再异步补齐向量；模型不可用时
    // 不阻塞审核发布，恢复巡检会继续处理。
    void hydrateManualKnowledgeArticleEmbeddings({
        legacyDocId: nextLegacyDocId,
        userId: detail.document.owner_user_id,
        user: actor
    }).catch(() => {});
    return { documentId: Number(detail.document.id), versionId: Number(detail.version.id), status: 'published', indexStatus: 'lexical_ready' };
}

async function createArticleDraftVersion({ documentId, actor, title, content, summary = '' }) {
    const document = await getProductDocumentForUser(documentId, actor);
    const safeTitle = normalizeText(title, 255);
    const safeContent = String(content || '').trim().slice(0, 2_000_000);
    if (!document || !canEditDocument(document, actor) || !safeTitle || !safeContent) return null;
    const timestamp = getBeijingTimestamp();
    return await transaction(async trx => {
        const max = await trx.queryOne('SELECT COALESCE(MAX(version_no), 0) AS version_no FROM knowledge_document_versions WHERE document_id = ?', [document.id]);
        const hash = crypto.createHash('sha256').update(safeContent).digest('hex');
        const version = await trx.queryOne(`
            INSERT INTO knowledge_document_versions (
                document_id, version_no, source_hash, source_size, parser_version, chunker_version,
                embedding_profile, status, content_path, change_summary, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'manual-v1', 'manual-block-v1', '', 'draft', '', ?, ?, ?) RETURNING *
        `, [document.id, Number(max?.version_no || 0) + 1, hash, Buffer.byteLength(safeContent), normalizeText(summary, 1000), timestamp, timestamp]);
        const block = await trx.queryOne(`
            INSERT INTO knowledge_blocks (
                version_id, block_type, block_order, heading_path, content, char_start, char_end,
                source_locator_json, created_at, updated_at
            ) VALUES (?, 'article', 0, ?, ?, 0, ?, ?, ?, ?) RETURNING *
        `, [version.id, safeTitle, safeContent, safeContent.length, JSON.stringify({ headingPath: safeTitle, charStart: 0, charEnd: safeContent.length }), timestamp, timestamp]);
        const legacy = await trx.queryOne(`
            INSERT INTO knowledge_docs (
                user_id, collection_id, name, status, is_enabled, chunk_count, indexed_chunks, progress,
                error_message, source_path, source_size, source_hash, lifecycle_status,
                created_at, updated_at, processed_at
            ) VALUES (?, ?, ?, 'draft', 0, 1, 1, 100, '', '', ?, ?, 'draft', ?, ?, ?) RETURNING *
        `, [document.owner_user_id, document.collection_id || null, safeTitle, Buffer.byteLength(safeContent), hash, timestamp, timestamp, timestamp]);
        const chunk = await trx.queryOne(`
            INSERT INTO knowledge_chunks (
                doc_id, content, search_content, heading_path, chunk_index, char_start, char_end, embedding,
                embedding_profile, embedding_dimensions, block_id
            ) VALUES (?, ?, ?, ?, 0, 0, ?, NULL, '', 0, ?) RETURNING *
        `, [legacy.id, safeContent, buildRagSearchContent(`${safeTitle}\n${safeContent}`), safeTitle, safeContent.length, block.id]);
        const citationKey = blockCitationKeyFor({ documentId: document.id, versionId: version.id, blockId: block.id });
        await trx.execute(`
            INSERT INTO knowledge_citations (
                citation_key, document_id, version_id, block_id, legacy_chunk_id, title_snapshot, locator_json, quoted_text, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [citationKey, document.id, version.id, block.id, chunk.id, safeTitle, JSON.stringify({ headingPath: safeTitle, charStart: 0, charEnd: safeContent.length }), safeContent.slice(0, 2000), timestamp]);
        await trx.execute('UPDATE knowledge_document_versions SET legacy_doc_id = ? WHERE id = ?', [legacy.id, version.id]);
        return { documentId: Number(document.id), version: { ...version, legacy_doc_id: legacy.id }, block, chunk, citationKey };
    });
}

async function archiveDocument({ documentId, actor }) {
    const document = await getProductDocumentForUser(documentId, actor);
    if (!document || !canEditDocument(document, actor)) return null;
    const timestamp = getBeijingTimestamp();
    await execute(`
        UPDATE knowledge_documents SET lifecycle_status = 'archived', updated_at = ? WHERE id = ?
    `, [timestamp, document.id]);
    if (normalizeId(document.legacy_doc_id)) {
        await execute(`
            UPDATE knowledge_docs SET is_enabled = 0, lifecycle_status = 'archived', updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [timestamp, document.legacy_doc_id, document.owner_user_id]);
    }
    return { documentId: Number(document.id), status: 'archived' };
}

async function getOrCreateUploadSource({ userId, collectionId = null }) {
    const safeUserId = normalizeId(userId);
    const safeCollectionId = normalizeId(collectionId);
    if (!safeUserId) throw new Error('知识库来源缺少有效用户');
    const existing = await queryOne(`
        SELECT * FROM knowledge_sources
        WHERE user_id = ? AND kind = 'upload' AND deleted_at IS NULL
          AND collection_id IS NOT DISTINCT FROM ?
        ORDER BY id ASC
        LIMIT 1
    `, [safeUserId, safeCollectionId]);
    if (existing) return existing;
    const timestamp = getBeijingTimestamp();
    return await queryOne(`
        INSERT INTO knowledge_sources (
            user_id, collection_id, name, kind, config_json, sync_mode, status, created_at, updated_at
        ) VALUES (?, ?, '本地上传', 'upload', '{}', 'manual', 'active', ?, ?)
        RETURNING *
    `, [safeUserId, safeCollectionId, timestamp, timestamp]);
}

async function getLegacyDocument(legacyDocId, userId = null) {
    const id = normalizeId(legacyDocId);
    if (!id) return null;
    const ownerClause = normalizeId(userId) ? ' AND user_id = ?' : '';
    const params = normalizeId(userId) ? [id, normalizeId(userId)] : [id];
    return await queryOne(`
        SELECT * FROM knowledge_docs WHERE id = ?${ownerClause} AND deleted_at IS NULL
    `, params);
}

async function getOrCreateProductDocumentForLegacy({ legacyDocId, userId, sourceId = null }) {
    const safeLegacyId = normalizeId(legacyDocId);
    const legacy = await getLegacyDocument(safeLegacyId, userId);
    if (!legacy) return null;
    const existing = await queryOne(`
        SELECT * FROM knowledge_documents WHERE legacy_doc_id = ? AND deleted_at IS NULL
    `, [safeLegacyId]);
    if (existing) return existing;
    if (normalizeId(legacy.product_document_id)) {
        const attached = await queryOne('SELECT * FROM knowledge_documents WHERE id = ? AND deleted_at IS NULL', [legacy.product_document_id]);
        if (attached) return attached;
    }

    const source = normalizeId(sourceId)
        ? await queryOne('SELECT id FROM knowledge_sources WHERE id = ? AND deleted_at IS NULL', [normalizeId(sourceId)])
        : await getOrCreateUploadSource({ userId: legacy.user_id, collectionId: legacy.collection_id });
    const timestamp = getBeijingTimestamp();
    const lifecycle = legacy.status === 'ready' || legacy.status === 'lexical_ready' ? 'published' : 'draft';
    const doc = await queryOne(`
        INSERT INTO knowledge_documents (
            legacy_doc_id, source_id, collection_id, owner_user_id, title, canonical_uri, mime_type,
            visibility_status, lifecycle_status, content_owner_user_id, verified_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '', 'personal', ?, ?, 'unverified', ?, ?)
        RETURNING *
    `, [
        safeLegacyId,
        source?.id || null,
        legacy.collection_id || null,
        legacy.user_id,
        normalizeText(legacy.name, 255) || `知识文档 ${safeLegacyId}`,
        String(legacy.source_path || ''),
        lifecycle,
        legacy.user_id,
        timestamp,
        timestamp
    ]);
    await execute(`
        INSERT INTO knowledge_permissions (
            resource_type, resource_id, principal_type, principal_id, permission, inherited, created_by, created_at, updated_at
        ) VALUES ('document', ?, 'user', ?, 'owner', 0, ?, ?, ?)
        ON CONFLICT(resource_type, resource_id, principal_type, principal_id, permission) DO NOTHING
    `, [doc.id, String(legacy.user_id), legacy.user_id, timestamp, timestamp]);
    await execute(`
        UPDATE knowledge_docs
        SET source_id = ?, product_document_id = ?, lifecycle_status = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
    `, [source?.id || null, doc.id, lifecycle, timestamp, safeLegacyId, legacy.user_id]);
    return doc;
}

async function attachLegacyDocumentToProduct({ legacyDocId, documentId, sourceId, canonicalUri = '' }) {
    const safeLegacyId = normalizeId(legacyDocId);
    const safeDocumentId = normalizeId(documentId);
    const safeSourceId = normalizeId(sourceId);
    if (!safeLegacyId || !safeDocumentId || !safeSourceId) return null;
    const legacy = await getLegacyDocument(safeLegacyId);
    const document = await queryOne('SELECT * FROM knowledge_documents WHERE id = ? AND deleted_at IS NULL', [safeDocumentId]);
    if (!legacy || !document || Number(legacy.user_id) !== Number(document.owner_user_id)) return null;
    const timestamp = getBeijingTimestamp();
    await transaction(async trx => {
        const detachedProductId = normalizeId(legacy.product_document_id);
        await trx.execute(`
            UPDATE knowledge_documents
            SET legacy_doc_id = CASE WHEN legacy_doc_id IS NULL THEN ? ELSE legacy_doc_id END,
                source_id = ?, collection_id = COALESCE(?, collection_id),
                title = ?, canonical_uri = ?, updated_at = ?
            WHERE id = ?
        `, [safeLegacyId, safeSourceId, legacy.collection_id || null, normalizeText(legacy.name, 255), String(canonicalUri || legacy.source_path || ''), timestamp, safeDocumentId]);
        await trx.execute(`
            UPDATE knowledge_docs SET product_document_id = ?, source_id = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [safeDocumentId, safeSourceId, timestamp, safeLegacyId, legacy.user_id]);
        // 上传入口会先为新文件建立兼容产品身份；若该文件随后按 canonical
        // URI 归并到已有文档，则删除没有版本和引用的孤儿身份。
        if (detachedProductId && detachedProductId !== safeDocumentId) {
            const links = await trx.queryOne('SELECT COUNT(*) AS count FROM knowledge_docs WHERE product_document_id = ?', [detachedProductId]);
            const versions = await trx.queryOne('SELECT COUNT(*) AS count FROM knowledge_document_versions WHERE document_id = ?', [detachedProductId]);
            if (Number(links?.count || 0) === 0 && Number(versions?.count || 0) === 0) {
                await trx.execute('DELETE FROM knowledge_permissions WHERE resource_type = ? AND resource_id = ?', ['document', detachedProductId]);
                await trx.execute('DELETE FROM knowledge_documents WHERE id = ?', [detachedProductId]);
            }
        }
    });
    return await queryOne('SELECT * FROM knowledge_documents WHERE id = ?', [safeDocumentId]);
}

async function publishLegacyDocumentProjection({ legacyDocId, userId, indexStatus = 'ready', embeddingProfile = '' }) {
    const legacy = await getLegacyDocument(legacyDocId, userId);
    if (!legacy) return null;
    return await transaction(async trx => {
        let product = await trx.queryOne(`
            SELECT * FROM knowledge_documents WHERE legacy_doc_id = ? AND deleted_at IS NULL FOR UPDATE
        `, [legacy.id]);
        if (!product && normalizeId(legacy.product_document_id)) {
            product = await trx.queryOne(`
                SELECT * FROM knowledge_documents WHERE id = ? AND deleted_at IS NULL FOR UPDATE
            `, [legacy.product_document_id]);
        }
        if (!product) {
            // 事务内补齐历史上传文档。此分支不复用外层 helper，避免在事务外产生竞态。
            let source = await trx.queryOne(`
                SELECT * FROM knowledge_sources
                WHERE user_id = ? AND kind = 'upload' AND deleted_at IS NULL
                  AND collection_id IS NOT DISTINCT FROM ?
                ORDER BY id ASC LIMIT 1
            `, [legacy.user_id, legacy.collection_id || null]);
            const timestamp = getBeijingTimestamp();
            if (!source) {
                source = await trx.queryOne(`
                    INSERT INTO knowledge_sources (user_id, collection_id, name, kind, config_json, sync_mode, status, created_at, updated_at)
                    VALUES (?, ?, '本地上传', 'upload', '{}', 'manual', 'active', ?, ?) RETURNING *
                `, [legacy.user_id, legacy.collection_id || null, timestamp, timestamp]);
            }
            product = await trx.queryOne(`
                INSERT INTO knowledge_documents (
                    legacy_doc_id, source_id, collection_id, owner_user_id, title, canonical_uri,
                    visibility_status, lifecycle_status, content_owner_user_id, verified_status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'personal', 'draft', ?, 'unverified', ?, ?) RETURNING *
            `, [legacy.id, source.id, legacy.collection_id || null, legacy.user_id, normalizeText(legacy.name, 255), String(legacy.source_path || ''), legacy.user_id, timestamp, timestamp]);
            await trx.execute(`
                INSERT INTO knowledge_permissions (resource_type, resource_id, principal_type, principal_id, permission, inherited, created_by, created_at, updated_at)
                VALUES ('document', ?, 'user', ?, 'owner', 0, ?, ?, ?)
                ON CONFLICT(resource_type, resource_id, principal_type, principal_id, permission) DO NOTHING
            `, [product.id, String(legacy.user_id), legacy.user_id, timestamp, timestamp]);
        }

        let version = product.current_version_id
            ? await trx.queryOne('SELECT * FROM knowledge_document_versions WHERE id = ?', [product.current_version_id])
            : null;
        if (!version || String(version.source_hash || '') !== String(legacy.source_hash || '') || version.status === 'archived') {
            const max = await trx.queryOne('SELECT COALESCE(MAX(version_no), 0) AS version_no FROM knowledge_document_versions WHERE document_id = ?', [product.id]);
            const timestamp = getBeijingTimestamp();
            version = await trx.queryOne(`
                INSERT INTO knowledge_document_versions (
                    document_id, legacy_doc_id, version_no, source_hash, source_size, source_updated_at, parser_version,
                    chunker_version, embedding_profile, status, content_path, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'document-text-v1', 'structure-aware-v1', ?, 'draft', ?, ?, ?) RETURNING *
            `, [product.id, legacy.id, Number(max?.version_no || 0) + 1, legacy.source_hash || '', Number(legacy.source_size || 0), legacy.updated_at || null, normalizeText(embeddingProfile, 180), legacy.source_path || '', timestamp, timestamp]);
        }

        await trx.execute('DELETE FROM knowledge_citations WHERE version_id = ?', [version.id]);
        await trx.execute('DELETE FROM knowledge_blocks WHERE version_id = ?', [version.id]);
        const chunks = await trx.query(`
            SELECT id, content, heading_path, chunk_index, char_start, char_end
            FROM knowledge_chunks WHERE doc_id = ? ORDER BY chunk_index ASC, id ASC
        `, [legacy.id]);
        const timestamp = getBeijingTimestamp();
        for (const chunk of chunks) {
            const locator = {
                headingPath: String(chunk.heading_path || ''),
                chunkIndex: Number(chunk.chunk_index || 0),
                charStart: chunk.char_start == null ? null : Number(chunk.char_start),
                charEnd: chunk.char_end == null ? null : Number(chunk.char_end)
            };
            const block = await trx.queryOne(`
                INSERT INTO knowledge_blocks (
                    version_id, block_type, block_order, heading_path, content, char_start, char_end,
                    source_locator_json, created_at, updated_at
                ) VALUES (?, 'chunk', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
            `, [version.id, Number(chunk.chunk_index || 0), locator.headingPath, chunk.content, locator.charStart, locator.charEnd, JSON.stringify(locator), timestamp, timestamp]);
            await trx.execute('UPDATE knowledge_chunks SET block_id = ? WHERE id = ? AND doc_id = ?', [block.id, chunk.id, legacy.id]);
            const citationKey = citationKeyFor({ documentId: product.id, versionId: version.id, chunkId: chunk.id });
            await trx.execute(`
                INSERT INTO knowledge_citations (
                    citation_key, document_id, version_id, block_id, legacy_chunk_id, title_snapshot, locator_json, quoted_text, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(citation_key) DO UPDATE SET
                    block_id = excluded.block_id, locator_json = excluded.locator_json, quoted_text = excluded.quoted_text
            `, [citationKey, product.id, version.id, block.id, chunk.id, product.title, JSON.stringify(locator), String(chunk.content || '').slice(0, 2000), timestamp]);
        }
        const lifecycle = indexStatus === 'lexical_ready' ? 'published' : 'published';
        const currentDocument = await trx.queryOne('SELECT legacy_doc_id FROM knowledge_documents WHERE id = ? FOR UPDATE', [product.id]);
        const previousLegacyDocId = normalizeId(currentDocument?.legacy_doc_id);
        if (previousLegacyDocId && previousLegacyDocId !== Number(legacy.id)) {
            await trx.execute(`
                UPDATE knowledge_docs
                SET is_enabled = 0, lifecycle_status = 'archived', updated_at = ?
                WHERE id = ? AND user_id = ? AND deleted_at IS NULL
            `, [timestamp, previousLegacyDocId, legacy.user_id]);
        }
        await trx.execute(`
            UPDATE knowledge_document_versions
            SET status = 'published', embedding_profile = ?, published_at = COALESCE(published_at, ?),
                published_by = COALESCE(published_by, ?), updated_at = ?
            WHERE id = ?
        `, [normalizeText(embeddingProfile, 180), timestamp, legacy.user_id, timestamp, version.id]);
        await trx.execute(`
            UPDATE knowledge_documents
            SET current_version_id = ?, legacy_doc_id = ?, lifecycle_status = ?, title = ?, canonical_uri = ?, updated_at = ?
            WHERE id = ?
        `, [version.id, legacy.id, lifecycle, normalizeText(legacy.name, 255), String(legacy.source_path || ''), timestamp, product.id]);
        await trx.execute(`
            UPDATE knowledge_docs
            SET product_document_id = ?, lifecycle_status = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [product.id, lifecycle, timestamp, legacy.id, legacy.user_id]);
        return {
            documentId: Number(product.id),
            versionId: Number(version.id),
            citations: chunks.length,
            status: indexStatus
        };
    });
}

async function getProductDocumentForUser(documentId, user) {
    const id = normalizeId(documentId);
    if (!id || !user?.id) return null;
    const row = await queryOne(`
        SELECT kd.*, kc.scope AS collection_scope, kc.allowed_units AS collection_allowed_units,
               kc.allowed_user_ids AS collection_allowed_user_ids
        FROM knowledge_documents kd
        LEFT JOIN knowledge_collections kc ON kc.id = kd.collection_id AND kc.deleted_at IS NULL
        WHERE kd.id = ? AND kd.deleted_at IS NULL
    `, [id]);
    if (!row) return null;
    if (isAdmin(user) || Number(row.owner_user_id) === Number(user.id)
        || Number(row.content_owner_user_id) === Number(user.id)
        || Number(row.verifier_user_id) === Number(user.id)) return row;
    if (canReadKnowledgeResource({
        user_id: row.owner_user_id,
        scope: row.collection_scope,
        allowed_units: row.collection_allowed_units,
        allowed_user_ids: row.collection_allowed_user_ids
    }, user)) return row;
    const permission = await queryOne(`
        SELECT 1 AS allowed
        FROM knowledge_permissions
        WHERE resource_type = 'document' AND resource_id = ?
          AND permission IN ('viewer', 'commenter', 'editor', 'manager', 'owner')
          AND (expires_at IS NULL OR expires_at > ?)
          AND (
            (principal_type = 'user' AND principal_id = ?)
            OR (principal_type = 'unit' AND principal_id = ?)
            OR (principal_type = 'role' AND principal_id = ?)
          )
        LIMIT 1
    `, [id, getBeijingTimestamp(), String(user.id), String(user.unit || ''), String(user.role || 'user')]);
    return permission?.allowed ? row : null;
}

async function getCitationForUser(citationKey, user) {
    const safeKey = String(citationKey || '').trim().slice(0, 180);
    if (!safeKey) return null;
    const citation = await queryOne(`
        SELECT * FROM knowledge_citations WHERE citation_key = ?
    `, [safeKey]);
    if (!citation) return null;
    const document = await getProductDocumentForUser(citation.document_id, user);
    if (!document) return null;
    return {
        id: Number(citation.id),
        citationKey: citation.citation_key,
        document: {
            id: Number(document.id),
            title: document.title,
            versionId: normalizeId(citation.version_id),
            lifecycleStatus: document.lifecycle_status,
            verifiedStatus: document.verified_status
        },
        locator: normalizeJson(citation.locator_json, {}),
        quotedText: citation.quoted_text,
        openUrl: citation.block_id
            ? `/api/knowledge/documents/${document.id}/versions/${citation.version_id}/blocks/${citation.block_id}`
            : null,
        createdAt: citation.created_at
    };
}

async function getKnowledgeBlockForUser({ documentId, versionId, blockId, user }) {
    const document = await getProductDocumentForUser(documentId, user);
    const safeVersionId = normalizeId(versionId);
    const safeBlockId = normalizeId(blockId);
    if (!document || !safeVersionId || !safeBlockId) return null;
    const block = await queryOne(`
        SELECT block.*, version.version_no, version.status AS version_status
        FROM knowledge_blocks block
        JOIN knowledge_document_versions version ON version.id = block.version_id
        WHERE block.id = ? AND block.version_id = ? AND version.document_id = ?
    `, [safeBlockId, safeVersionId, document.id]);
    if (!block) return null;
    return {
        id: Number(block.id),
        documentId: Number(document.id),
        versionId: Number(block.version_id),
        versionNo: Number(block.version_no),
        versionStatus: block.version_status,
        type: block.block_type,
        order: Number(block.block_order || 0),
        headingPath: block.heading_path || '',
        content: block.content || '',
        pageNo: normalizeId(block.page_no),
        sheetName: block.sheet_name || '',
        slideNo: normalizeId(block.slide_no),
        charStart: block.char_start == null ? null : Number(block.char_start),
        charEnd: block.char_end == null ? null : Number(block.char_end),
        locator: normalizeJson(block.source_locator_json, {}),
        sourceUrl: `/api/knowledge/documents/${document.id}/source`
    };
}

async function recordCitationEvent({ citationKey, user, eventType, detail = '' }) {
    const safeKey = String(citationKey || '').trim().slice(0, 180);
    const type = ['open', 'helpful', 'unhelpful', 'incorrect'].includes(String(eventType || '')) ? String(eventType) : '';
    if (!safeKey || !type || !user?.id) return null;
    const citation = await queryOne('SELECT * FROM knowledge_citations WHERE citation_key = ?', [safeKey]);
    if (!citation || !await getProductDocumentForUser(citation.document_id, user)) return null;
    const row = await queryOne(`
        INSERT INTO knowledge_citation_events (citation_id, user_id, event_type, detail, created_at)
        VALUES (?, ?, ?, ?, ?) RETURNING *
    `, [citation.id, user.id, type, String(detail || '').trim().slice(0, 1000), getBeijingTimestamp()]);
    return { id: Number(row.id), citationKey: safeKey, eventType: type, createdAt: row.created_at };
}

async function getKnowledgeCitationSummary(userId = null) {
    const user = normalizeId(userId);
    const rows = await query(`
        SELECT event_type, COUNT(*) AS count
        FROM knowledge_citation_events
        ${user ? 'WHERE user_id = ?' : ''}
        GROUP BY event_type
    `, user ? [user] : []);
    const counts = Object.fromEntries(rows.map(row => [row.event_type, Number(row.count || 0)]));
    const feedbackTotal = Number(counts.helpful || 0) + Number(counts.unhelpful || 0) + Number(counts.incorrect || 0);
    return {
        opens: Number(counts.open || 0),
        helpful: Number(counts.helpful || 0),
        unhelpful: Number(counts.unhelpful || 0),
        incorrect: Number(counts.incorrect || 0),
        feedbackTotal,
        helpfulRate: feedbackTotal ? Number((Number(counts.helpful || 0) / feedbackTotal).toFixed(4)) : null
    };
}

async function getCitationForChunkForUser(chunkId, user) {
    const safeChunkId = normalizeId(chunkId);
    if (!safeChunkId) return null;
    const citation = await queryOne(`
        SELECT citation_key FROM knowledge_citations
        WHERE legacy_chunk_id = ? ORDER BY id DESC LIMIT 1
    `, [safeChunkId]);
    return citation?.citation_key ? await getCitationForUser(citation.citation_key, user) : null;
}

async function listProductDocumentVersions(documentId, user) {
    const document = await getProductDocumentForUser(documentId, user);
    if (!document) return null;
    const rows = await query(`
        SELECT id, version_no, source_hash, source_size, embedding_profile, status, change_summary,
               submitted_at, reviewed_at, reviewed_by, published_at, published_by, created_at, updated_at
        FROM knowledge_document_versions
        WHERE document_id = ? ORDER BY version_no DESC
    `, [document.id]);
    return { document, versions: rows };
}

async function updateDocumentGovernance({ documentId, actor, contentOwnerUserId, verifierUserId, verifiedStatus, reviewDueAt, freshnessPolicy }) {
    const document = await getProductDocumentForUser(documentId, actor);
    if (!document || !canEditDocument(document, actor)) return null;
    const contentOwner = contentOwnerUserId === undefined ? normalizeId(document.content_owner_user_id) : normalizeId(contentOwnerUserId);
    const verifier = verifierUserId === undefined ? normalizeId(document.verifier_user_id) : normalizeId(verifierUserId);
    const policy = freshnessPolicy === undefined
        ? normalizeStatus(document.freshness_policy, FRESHNESS_POLICIES, 'manual')
        : normalizeStatus(freshnessPolicy, FRESHNESS_POLICIES, 'manual');
    const status = verifiedStatus === undefined
        ? normalizeStatus(document.verified_status, VERIFIED_STATUSES, 'unverified')
        : normalizeStatus(verifiedStatus, VERIFIED_STATUSES, 'unverified');
    const timestamp = getBeijingTimestamp();
    const dueAt = reviewDueAt === undefined
        ? (freshnessPolicy === undefined ? document.review_due_at : dueAtForPolicy(policy))
        : normalizeDate(reviewDueAt);
    await execute(`
        UPDATE knowledge_documents
        SET content_owner_user_id = ?, content_owner_unit = ?, verifier_user_id = ?,
            verified_status = ?, verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END,
            review_due_at = ?, freshness_policy = ?, updated_at = ?
        WHERE id = ?
    `, [contentOwner, String(actor.unit || ''), verifier, status, status, timestamp, dueAt, policy, timestamp, document.id]);
    return await getProductDocumentForUser(document.id, actor);
}

async function verifyKnowledgeDocument({ documentId, actor, status = 'verified' }) {
    const id = normalizeId(documentId);
    const document = id ? await queryOne('SELECT * FROM knowledge_documents WHERE id = ? AND deleted_at IS NULL', [id]) : null;
    const nextStatus = normalizeStatus(status, VERIFIED_STATUSES, 'verified');
    if (!document || !actor?.id || (!isAdmin(actor) && Number(document.owner_user_id) !== Number(actor.id) && Number(document.verifier_user_id) !== Number(actor.id))) return null;
    const timestamp = getBeijingTimestamp();
    const legacyDocId = normalizeId(document.legacy_doc_id);
    let indexStatus = 'ready';
    if (legacyDocId) {
        const coverage = await queryOne(`
            SELECT COUNT(*) AS total, SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END) AS missing
            FROM knowledge_chunks WHERE doc_id = ?
        `, [legacyDocId]);
        if (Number(coverage?.total || 0) > 0 && Number(coverage?.missing || 0) > 0) indexStatus = 'lexical_ready';
    }
    await transaction(async trx => {
        await trx.execute(`
            UPDATE knowledge_documents
            SET verified_status = ?, verified_at = ?, lifecycle_status = CASE WHEN ? = 'verified' THEN 'published' ELSE lifecycle_status END,
                updated_at = ? WHERE id = ?
        `, [nextStatus, timestamp, nextStatus, timestamp, document.id]);
        if (legacyDocId && nextStatus === 'verified') {
            await trx.execute(`
                UPDATE knowledge_docs
                SET status = ?, is_enabled = 1, lifecycle_status = 'published', updated_at = ?
                WHERE id = ? AND user_id = ?
            `, [indexStatus, timestamp, legacyDocId, document.owner_user_id]);
        }
    });
    return { documentId: Number(document.id), verifiedStatus: nextStatus, indexStatus, verifiedAt: timestamp };
}

async function refreshKnowledgeFreshness({ limit = 500 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 500, 5000));
    const timestamp = getBeijingTimestamp();
    const rows = await query(`
        SELECT id, legacy_doc_id
        FROM knowledge_documents
        WHERE lifecycle_status = 'published' AND deleted_at IS NULL
          AND review_due_at IS NOT NULL AND review_due_at <= ?
        ORDER BY review_due_at ASC LIMIT ?
    `, [timestamp, safeLimit]);
    let expired = 0;
    for (const row of rows) {
        const changed = await execute(`
            UPDATE knowledge_documents
            SET lifecycle_status = 'expired', verified_status = 'expired', updated_at = ?
            WHERE id = ? AND lifecycle_status = 'published'
        `, [timestamp, row.id]);
        if (Number(changed || 0) > 0) {
            expired += 1;
            if (normalizeId(row.legacy_doc_id)) {
                await execute(`
                    UPDATE knowledge_docs SET is_enabled = 0, lifecycle_status = 'expired', updated_at = ?
                    WHERE id = ?
                `, [timestamp, row.legacy_doc_id]);
            }
        }
    }
    return { scanned: rows.length, expired };
}

async function backfillKnowledgeProductProjections({ limit = 100 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 1000));
    const rows = await query(`
        SELECT d.id, d.user_id, d.status
        FROM knowledge_docs d
        LEFT JOIN knowledge_documents product ON product.id = d.product_document_id AND product.deleted_at IS NULL
        WHERE d.deleted_at IS NULL
          AND d.status IN ('ready', 'lexical_ready')
          AND COALESCE(d.chunk_count, 0) > 0
          AND product.id IS NULL
        ORDER BY d.id ASC
        LIMIT ?
    `, [safeLimit]);
    let projected = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            const result = await publishLegacyDocumentProjection({
                legacyDocId: row.id,
                userId: row.user_id,
                indexStatus: row.status
            });
            if (result) projected += 1;
        } catch (_) {
            failed += 1;
        }
    }
    return { scanned: rows.length, projected, failed };
}

async function getDocumentVersionDiff({ documentId, fromVersionId, toVersionId, user }) {
    const document = await getProductDocumentForUser(documentId, user);
    const fromId = normalizeId(fromVersionId);
    const toId = normalizeId(toVersionId);
    if (!document || !fromId || !toId) return null;
    const versions = await query(`
        SELECT id, version_no FROM knowledge_document_versions
        WHERE document_id = ? AND id IN (?, ?)
    `, [document.id, fromId, toId]);
    if (versions.length !== 2) return null;
    const blocks = await query(`
        SELECT version_id, content FROM knowledge_blocks
        WHERE version_id IN (?, ?) ORDER BY version_id, block_order, id
    `, [fromId, toId]);
    const contentByVersion = new Map([[fromId, ''], [toId, '']]);
    blocks.forEach(block => contentByVersion.set(Number(block.version_id), `${contentByVersion.get(Number(block.version_id)) || ''}${contentByVersion.get(Number(block.version_id)) ? '\n' : ''}${block.content || ''}`));
    return {
        documentId: Number(document.id),
        fromVersionId: fromId,
        toVersionId: toId,
        ...diffText(contentByVersion.get(fromId), contentByVersion.get(toId))
    };
}

async function createKnowledgeComment({ documentId, versionId = null, blockId = null, user, kind = 'comment', content }) {
    const document = await getProductDocumentForUser(documentId, user);
    const safeContent = String(content || '').trim().slice(0, 4000);
    const safeKind = normalizeStatus(kind, COMMENT_KINDS, 'comment');
    if (!document || !safeContent) return null;
    const timestamp = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO knowledge_comments (
            document_id, version_id, block_id, user_id, kind, status, content, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?) RETURNING *
    `, [document.id, normalizeId(versionId), normalizeId(blockId), user.id, safeKind, safeContent, timestamp, timestamp]);
    return row;
}

async function listKnowledgeComments({ documentId, user, status = '' }) {
    const document = await getProductDocumentForUser(documentId, user);
    if (!document) return null;
    const safeStatus = normalizeStatus(status, COMMENT_STATUSES, '');
    return await query(`
        SELECT kc.*, COALESCE(NULLIF(member.nickname, ''), member.username) AS user_name
        FROM knowledge_comments kc
        JOIN users member ON member.id = kc.user_id
        WHERE kc.document_id = ? ${safeStatus ? 'AND kc.status = ?' : ''}
        ORDER BY kc.created_at DESC, kc.id DESC
    `, safeStatus ? [document.id, safeStatus] : [document.id]);
}

async function resolveKnowledgeComment({ commentId, actor }) {
    const id = normalizeId(commentId);
    const comment = id ? await queryOne('SELECT * FROM knowledge_comments WHERE id = ?', [id]) : null;
    const document = comment ? await getProductDocumentForUser(comment.document_id, actor) : null;
    if (!comment || !document || !canEditDocument(document, actor)) return null;
    const timestamp = getBeijingTimestamp();
    await execute(`
        UPDATE knowledge_comments SET status = 'resolved', resolved_by = ?, resolved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'open'
    `, [actor.id, timestamp, timestamp, id]);
    return { id, status: 'resolved' };
}

async function listProductDocumentsForUser(user, { limit = 100, lifecycleStatus = '' } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 200));
    const status = normalizeStatus(lifecycleStatus, DOCUMENT_STATUSES, '');
    const rows = await query(`
        SELECT id
        FROM knowledge_documents
        WHERE deleted_at IS NULL ${status ? 'AND lifecycle_status = ?' : ''}
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
    `, status ? [status, safeLimit * 3] : [safeLimit * 3]);
    const visible = [];
    for (const row of rows) {
        const document = await getProductDocumentForUser(row.id, user);
        if (!document) continue;
        visible.push(document);
        if (visible.length >= safeLimit) break;
    }
    return visible;
}

async function setProductDocumentPermission({ documentId, actor, principalType, principalId, permission = 'viewer', expiresAt = null }) {
    const document = await getProductDocumentForUser(documentId, actor);
    if (!document || (Number(document.owner_user_id) !== Number(actor?.id) && !isAdmin(actor))) return null;
    const type = ['user', 'unit', 'role', 'group'].includes(String(principalType || '')) ? String(principalType) : '';
    const subject = normalizeText(principalId, 180);
    const level = normalizeStatus(permission, PERMISSIONS, 'viewer');
    if (!type || !subject) return null;
    const timestamp = getBeijingTimestamp();
    await execute(`
        INSERT INTO knowledge_permissions (
            resource_type, resource_id, principal_type, principal_id, permission, inherited, expires_at, created_by, created_at, updated_at
        ) VALUES ('document', ?, ?, ?, ?, 0, ?, ?, ?, ?)
        ON CONFLICT(resource_type, resource_id, principal_type, principal_id, permission)
        DO UPDATE SET expires_at = excluded.expires_at, created_by = excluded.created_by, updated_at = excluded.updated_at
    `, [document.id, type, subject, level, expiresAt || null, actor.id, timestamp, timestamp]);
    return { documentId: Number(document.id), principalType: type, principalId: subject, permission: level, expiresAt: expiresAt || null };
}

module.exports = {
    archiveDocument,
    attachLegacyDocumentToProduct,
    backfillKnowledgeProductProjections,
    createKnowledgeArticle,
    createArticleDraftVersion,
    createKnowledgeComment,
    getCitationForChunkForUser,
    getCitationForUser,
    getKnowledgeCitationSummary,
    getKnowledgeBlockForUser,
    getOrCreateProductDocumentForLegacy,
    getProductDocumentForUser,
    getDocumentVersionDiff,
    listProductDocumentVersions,
    listProductDocumentsForUser,
    listKnowledgeComments,
    publishDocumentVersion,
    publishLegacyDocumentProjection,
    reviewDocumentVersion,
    refreshKnowledgeFreshness,
    recordCitationEvent,
    resolveKnowledgeComment,
    setProductDocumentPermission,
    submitDocumentVersionForReview,
    updateDocumentGovernance,
    verifyKnowledgeDocument
};
