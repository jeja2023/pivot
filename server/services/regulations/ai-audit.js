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
        contextExcerpt: trimAuditText(source?.contextExcerpt, 3000),
        headingPath: trimAuditText(source?.headingPath || source?.heading_path, 255),
        pageStart: Number(source?.pageStart || source?.page_start) || null,
        pageEnd: Number(source?.pageEnd || source?.page_end) || null,
        effectiveFrom: trimAuditText(source?.effectiveFrom || source?.effective_from, 40),
        effectiveTo: trimAuditText(source?.effectiveTo || source?.effective_to, 40),
        effectStatus: trimAuditText(source?.effectStatus || source?.effect_status, 40),
        reviewStatus: trimAuditText(source?.reviewStatus || source?.review_status, 40),
        retrieval: trimAuditText(source?.retrieval, 40),
        selected: Boolean(source?.selected),
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

async function getRegulationAiQualityMetrics({ userId = null, documentId = null, days = 30 } = {}) {
    const uid = normalizeRegulationId(userId);
    const did = normalizeRegulationId(documentId);
    const safeDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 1), 365);
    const clauses = ['created_at >= (NOW() AT TIME ZONE \'Asia/Shanghai\') - (? * INTERVAL \'1 day\')'];
    const params = [safeDays];
    if (uid) {
        clauses.push('user_id = ?');
        params.push(uid);
    }
    if (did) {
        clauses.push('document_id = ?');
        params.push(did);
    }
    const where = clauses.join(' AND ');
    const [summary, statuses, reasons] = await Promise.all([
        queryOne(`
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE COALESCE(usage_json->'grounding'->>'accepted', 'false') = 'true') AS accepted,
                   AVG(COALESCE((usage_json->'grounding'->>'candidateCount')::numeric, 0)) AS avg_candidates,
                   AVG(COALESCE((usage_json->'grounding'->>'directCandidateCount')::numeric, 0)) AS avg_direct_candidates
            FROM regulation_ai_answer_logs WHERE ${where}
        `, params),
        query(`
            SELECT COALESCE(usage_json->'grounding'->>'status', 'unknown') AS status, COUNT(*) AS count
            FROM regulation_ai_answer_logs WHERE ${where}
            GROUP BY COALESCE(usage_json->'grounding'->>'status', 'unknown')
            ORDER BY count DESC
        `, params),
        query(`
            SELECT reason, COUNT(*) AS count
            FROM regulation_ai_answer_logs logs
            CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(logs.usage_json->'grounding'->'reasonCodes', '[]'::jsonb)) reason
            WHERE ${where}
            GROUP BY reason
            ORDER BY count DESC
        `, params)
    ]);
    return {
        days: safeDays,
        total: Number(summary?.total || 0),
        accepted: Number(summary?.accepted || 0),
        acceptanceRate: Number(summary?.total || 0) > 0 ? Number(summary.accepted || 0) / Number(summary.total) : 0,
        averageCandidates: Number(summary?.avg_candidates || 0),
        averageDirectCandidates: Number(summary?.avg_direct_candidates || 0),
        statuses: statuses.map(row => ({ status: row.status, count: Number(row.count || 0) })),
        reasons: reasons.map(row => ({ reason: row.reason, count: Number(row.count || 0) }))
    };
}

module.exports = { getRegulationAiQualityMetrics, listRegulationAiAnswerLogs, recordRegulationAiAnswer };
