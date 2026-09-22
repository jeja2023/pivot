// 知识库文档质量辅助：只读取文档元数据，不参与检索或模型调用。
const { query, queryOne } = require('../db/client');

async function listDuplicateKnowledgeDocuments(userId, { limit = 20 } = {}) {
    const normalizedUserId = Number.parseInt(userId, 10);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
        return { groups: [], unhashedReady: 0 };
    }
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50);
    const duplicateHashes = await query(`
        SELECT source_hash, COUNT(*) AS count
        FROM knowledge_docs
        WHERE user_id = ?
          AND deleted_at IS NULL
          AND status = 'ready'
          AND source_hash IS NOT NULL
          AND source_hash != ''
        GROUP BY source_hash
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC, source_hash ASC
        LIMIT ?
    `, [normalizedUserId, safeLimit]);
    const hashes = (duplicateHashes || []).map(row => String(row.source_hash || '')).filter(Boolean);
    let documents = [];
    if (hashes.length) {
        documents = await query(`
            SELECT id, name, source_hash, source_size, collection_id, updated_at
            FROM knowledge_docs
            WHERE user_id = ? AND deleted_at IS NULL AND source_hash IN (${hashes.map(() => '?').join(',')})
            ORDER BY source_hash ASC, updated_at DESC, id DESC
        `, [normalizedUserId, ...hashes]);
    }
    const grouped = new Map(hashes.map(hash => [hash, []]));
    for (const document of documents || []) grouped.get(String(document.source_hash))?.push({
        id: document.id,
        name: document.name,
        sourceSize: Number(document.source_size || 0),
        collectionId: document.collection_id || null,
        updatedAt: document.updated_at
    });
    const unhashedRow = await queryOne(`
        SELECT COUNT(*) AS count
        FROM knowledge_docs
        WHERE user_id = ? AND deleted_at IS NULL AND status = 'ready'
          AND (source_hash IS NULL OR source_hash = '')
    `, [normalizedUserId]);
    return {
        groups: [...grouped.entries()].map(([sourceHash, docs]) => ({
            sourceHash,
            count: docs.length,
            documents: docs
        })).filter(group => group.count > 1),
        unhashedReady: Number(unhashedRow?.count || 0)
    };
}

function clampQualityScore(value) {
    const score = Math.round(Number(value) || 0);
    return Math.max(0, Math.min(score, 100));
}

function buildKnowledgeQualitySignals({ overview, feedback, graph, duplicates = null }) {
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
    const duplicateGroups = Number(duplicates?.groups?.length || 0);

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
        graphRelations,
        duplicateGroups
    };
}

module.exports = { listDuplicateKnowledgeDocuments, clampQualityScore, buildKnowledgeQualitySignals };
