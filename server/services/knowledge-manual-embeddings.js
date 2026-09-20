'use strict';

// 人工文章没有原始上传文件，不能复用文件解析 Worker。这里直接对它已经存在
// 的检索块补齐向量；失败时仍保留 lexical_ready，不让审核发布被外部模型阻塞。
const { query, execute } = require('../db/client');
const { getEmbeddingConfig, getEmbeddingProfile } = require('./rag-config');
const { generateEmbeddingsAdaptive } = require('./rag-index/embedding-client');
const { ensureKnowledgeVectorIndex } = require('./knowledge-vector-index');
const { buildRagSearchContent } = require('./rag-tokenizer');
const { logger: defaultLogger } = require('../logger');

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function hydrateManualKnowledgeArticleEmbeddings({ legacyDocId, userId, user = null, logger = defaultLogger } = {}) {
    const docId = normalizeId(legacyDocId);
    const ownerId = normalizeId(userId);
    if (!docId || !ownerId) return { indexed: 0, missing: 0, status: 'skipped', reason: 'invalid_document' };
    const chunks = await query(`
        SELECT id, content, heading_path
        FROM knowledge_chunks WHERE doc_id = ? ORDER BY chunk_index ASC, id ASC
    `, [docId]);
    if (!chunks.length) return { indexed: 0, missing: 0, status: 'skipped', reason: 'no_chunks' };
    const config = getEmbeddingConfig(ownerId);
    if (!String(config?.http?.url || '').trim()) {
        await execute(`
            UPDATE knowledge_docs SET status = 'lexical_ready', updated_at = now() AT TIME ZONE 'Asia/Shanghai'
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        `, [docId, ownerId]);
        return { indexed: 0, missing: chunks.length, status: 'lexical_ready', reason: 'embedding_unconfigured' };
    }
    const profile = getEmbeddingProfile(config);
    let vectors = [];
    try {
        vectors = await generateEmbeddingsAdaptive(chunks.map(chunk => `${chunk.heading_path || ''}\n${chunk.content || ''}`.trim()), null, null, ownerId, {
            user,
            allowPartial: true,
            source: 'knowledge_manual_article_embedding'
        });
    } catch (error) {
        await execute(`
            UPDATE knowledge_docs SET status = 'lexical_ready', error_message = ?, updated_at = now() AT TIME ZONE 'Asia/Shanghai'
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        `, [`Embedding 补齐失败，当前仅关键词检索：${String(error.message || error).slice(0, 800)}`, docId, ownerId]);
        return { indexed: 0, missing: chunks.length, status: 'lexical_ready', reason: 'embedding_failed' };
    }
    let indexed = 0;
    let missing = 0;
    const dimensions = new Set();
    for (let index = 0; index < chunks.length; index += 1) {
        const vector = Array.isArray(vectors[index]) && vectors[index].length ? vectors[index] : null;
        if (!vector) {
            missing += 1;
            continue;
        }
        await execute(`
            UPDATE knowledge_chunks
            SET embedding = ?, embedding_profile = ?, embedding_dimensions = ?,
                search_content = COALESCE(NULLIF(search_content, ''), ?)
            WHERE id = ? AND doc_id = ?
        `, [JSON.stringify(vector), profile, vector.length, buildRagSearchContent(`${chunks[index].heading_path || ''}\n${chunks[index].content || ''}`), chunks[index].id, docId]);
        indexed += 1;
        dimensions.add(vector.length);
    }
    const status = missing > 0 ? 'lexical_ready' : 'ready';
    await execute(`
        UPDATE knowledge_docs SET status = ?, error_message = CASE WHEN ? = 'ready' THEN '' ELSE error_message END,
            updated_at = now() AT TIME ZONE 'Asia/Shanghai'
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [status, status, docId, ownerId]);
    await execute(`
        UPDATE knowledge_document_versions version
        SET embedding_profile = ?, updated_at = now() AT TIME ZONE 'Asia/Shanghai'
        FROM knowledge_documents product
        WHERE product.id = version.document_id AND product.legacy_doc_id = ?
          AND product.owner_user_id = ? AND version.id = product.current_version_id
    `, [profile, docId, ownerId]);
    for (const dimension of dimensions) {
        await ensureKnowledgeVectorIndex(dimension, profile).catch(error => {
            logger.warn({ err: error.message, dimension, profile }, '人工文章 HNSW 索引检查失败');
        });
    }
    return { indexed, missing, status, embeddingProfile: profile };
}

async function recoverManualKnowledgeArticleEmbeddings({ limit = 50, logger = defaultLogger } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 500));
    const rows = await query(`
        SELECT d.id, d.user_id,
               STRING_AGG(DISTINCT NULLIF(chunk.embedding_profile, ''), CHR(31)) AS embedding_profiles
        FROM knowledge_docs d
        JOIN knowledge_documents product ON product.id = d.product_document_id AND product.deleted_at IS NULL
        JOIN knowledge_sources source ON source.id = product.source_id AND source.deleted_at IS NULL
        JOIN knowledge_chunks chunk ON chunk.doc_id = d.id
        WHERE source.kind = 'manual' AND product.lifecycle_status = 'published'
          AND d.deleted_at IS NULL AND d.status IN ('ready', 'lexical_ready')
        GROUP BY d.id, d.user_id
        ORDER BY d.updated_at ASC, d.id ASC LIMIT ?
    `, [safeLimit]);
    let ready = 0;
    let lexicalReady = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            const config = getEmbeddingConfig(row.user_id);
            if (!String(config?.http?.url || '').trim()) {
                lexicalReady += 1;
                continue;
            }
            const expectedProfile = getEmbeddingProfile(config);
            const profiles = String(row.embedding_profiles || '').split(String.fromCharCode(31)).filter(Boolean);
            const hasMissing = !profiles.length;
            if (!hasMissing && profiles.length === 1 && profiles[0] === expectedProfile) continue;
            const result = await hydrateManualKnowledgeArticleEmbeddings({ legacyDocId: row.id, userId: row.user_id, logger });
            if (result.status === 'ready') ready += 1;
            else lexicalReady += 1;
        } catch (error) {
            failed += 1;
            logger.warn({ err: error.message, docId: row.id }, '人工文章向量补齐巡检失败');
        }
    }
    return { scanned: rows.length, ready, lexicalReady, failed };
}

module.exports = { hydrateManualKnowledgeArticleEmbeddings, recoverManualKnowledgeArticleEmbeddings };
