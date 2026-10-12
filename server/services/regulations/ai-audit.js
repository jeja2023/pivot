const { query, queryOne } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { normalizeRegulationId } = require('./shared');

function trimAuditText(value, maximum) {
    const text = String(value || '').trim();
    return text.length > maximum ? `${text.slice(0, maximum)}…（已截断）` : text;
}

function normalizeAuditSources(sources) {
    return (Array.isArray(sources) ? sources : []).slice(0, 50).map(source => ({
        index: Number(source?.index) || 0,
        documentId: normalizeRegulationId(source?.documentId || source?.document_id),
        versionId: normalizeRegulationId(source?.versionId || source?.version_id),
        articleId: normalizeRegulationId(source?.articleId || source?.article_id),
        label: trimAuditText(source?.label, 500),
        excerpt: trimAuditText(source?.excerpt, 1200),
        viaLink: Boolean(source?.viaLink || source?.via_link),
        relation: trimAuditText(source?.relation, 80)
    }));
}

async function recordRegulationAiAnswer({ userId, documentId = null, question, answer, modelName = '', contextSnapshot = '', sources = [], usage = {} } = {}) {
    const uid = normalizeRegulationId(userId);
    if (!uid) return null;
    return await queryOne(`
        INSERT INTO regulation_ai_answer_logs (
            user_id, document_id, question, answer, model_name, context_snapshot, sources_json, usage_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
        RETURNING id, user_id, document_id, question, answer, model_name, context_snapshot, sources_json, usage_json, created_at
    `, [
        uid,
        normalizeRegulationId(documentId),
        trimAuditText(question, 4000),
        trimAuditText(answer, 16000),
        trimAuditText(modelName, 320),
        trimAuditText(contextSnapshot, 24000),
        JSON.stringify(normalizeAuditSources(sources)),
        JSON.stringify(usage && typeof usage === 'object' ? usage : {}),
        getBeijingTimestamp()
    ]);
}

async function listRegulationAiAnswerLogs({ userId, documentId = null, limit = 30, offset = 0 } = {}) {
    const uid = normalizeRegulationId(userId);
    if (!uid) return { data: [], total: 0, limit: 30, offset: 0 };
    const did = normalizeRegulationId(documentId);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const clauses = ['user_id = ?'];
    const params = [uid];
    if (did) {
        clauses.push('document_id = ?');
        params.push(did);
    }
    const where = clauses.join(' AND ');
    const total = await queryOne(`SELECT COUNT(*) AS count FROM regulation_ai_answer_logs WHERE ${where}`, params);
    const data = await query(`
        SELECT id, user_id, document_id, question, answer, model_name, context_snapshot, sources_json, usage_json, created_at
        FROM regulation_ai_answer_logs
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `, [...params, safeLimit, safeOffset]);
    return { data, total: Number(total?.count || 0), limit: safeLimit, offset: safeOffset };
}

module.exports = { listRegulationAiAnswerLogs, recordRegulationAiAnswer };
