const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { clearRagCacheForUser } = require('./rag-cache');

function normalizeFeedbackChunkId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function recordRagFeedback({ userId, query: userQuery, chunkId, docName, score, helpful, note }) {
    const safeQuery = String(userQuery || '').trim().slice(0, 1000);
    if (!safeQuery) return null;
    const row = await queryOne(`
        INSERT INTO rag_feedback (user_id, query, chunk_id, doc_name, score, helpful, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id
    `, [
        userId,
        safeQuery,
        normalizeFeedbackChunkId(chunkId),
        String(docName || '').slice(0, 255),
        Number.isFinite(Number(score)) ? Number(score) : null,
        helpful ? 1 : 0,
        String(note || '').slice(0, 1000),
        getBeijingTimestamp()
    ]);
    clearRagCacheForUser(userId);
    return { id: row?.id };
}

async function getRagFeedbackSummary(userId) {
    const rows = await query(`
        SELECT doc_name, helpful, COUNT(*) AS count
        FROM rag_feedback
        WHERE user_id = ?
        GROUP BY doc_name, helpful
    `, [userId]);
    const summary = { helpful: 0, unhelpful: 0, byDoc: [] };
    const byDoc = new Map();
    for (const row of rows) {
        const count = Number(row.count || 0);
        const isHelpful = row.helpful === true || Number(row.helpful) === 1 || String(row.helpful) === '1' || String(row.helpful).toLowerCase() === 'true';
        if (isHelpful) summary.helpful += count;
        else summary.unhelpful += count;
        const name = row.doc_name || '未知文档';
        const item = byDoc.get(name) || { docName: name, helpful: 0, unhelpful: 0 };
        if (isHelpful) item.helpful += count;
        else item.unhelpful += count;
        byDoc.set(name, item);
    }
    summary.byDoc = Array.from(byDoc.values()).sort((left, right) => right.unhelpful - left.unhelpful).slice(0, 10);
    return summary;
}

module.exports = { getRagFeedbackSummary, recordRagFeedback };
