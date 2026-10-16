'use strict';

const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function trimAuditText(value, maximum) {
    const text = String(value || '').trim();
    return text.length > maximum ? `${text.slice(0, maximum)}…（已截断）` : text;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeEvidence(matches = []) {
    return (Array.isArray(matches) ? matches : []).filter(item => item?.selected).slice(0, 20).map(item => ({
        chunkId: normalizeId(item.chunkId),
        citationKey: trimAuditText(item.citationKey, 180),
        documentId: normalizeId(item.documentId || item.docId),
        title: trimAuditText(item.title || item.documentName || item.source, 500),
        headingPath: trimAuditText(item.headingPath, 500),
        score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
        retrievalQueries: Array.isArray(item.retrievalQueryIndexes) ? item.retrievalQueryIndexes.slice(0, 3) : []
    }));
}

function normalizeNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : null;
}

function normalizeRetrieval(retrieval = {}, matches = []) {
    const value = retrieval && typeof retrieval === 'object' ? retrieval : {};
    const plan = value.queryPlan || value.retrievalPlan || {};
    const scope = value.scope && typeof value.scope === 'object' ? value.scope : {};
    const sourceSummary = value.sourceSummary && typeof value.sourceSummary === 'object' ? value.sourceSummary : {};
    return {
        candidateCount: normalizeNumber(value.candidateCount, { max: 100_000 }),
        retrievalMode: trimAuditText(value.retrievalMode, 160),
        retrievalModes: (Array.isArray(value.retrievalModes) ? value.retrievalModes : []).map(item => trimAuditText(item, 80)).filter(Boolean).slice(0, 10),
        queryPlan: {
            originalQuery: trimAuditText(plan.originalQuery, 4000),
            rewrittenQuery: trimAuditText(plan.rewrittenQuery, 4000),
            followUpResolved: plan.followUpResolved === true,
            retrievalQueries: (Array.isArray(plan.retrievalQueries) ? plan.retrievalQueries : []).map(item => trimAuditText(item, 1000)).filter(Boolean).slice(0, 3)
        },
        scope: {
            collectionId: normalizeId(scope.collectionId),
            collectionIds: (Array.isArray(scope.collectionIds) ? scope.collectionIds : []).map(normalizeId).filter(Boolean).slice(0, 20),
            tagName: trimAuditText(scope.tagName, 160),
            tagNames: (Array.isArray(scope.tagNames) ? scope.tagNames : []).map(item => trimAuditText(item, 160)).filter(Boolean).slice(0, 20)
        },
        sourceSummary: {
            citationCount: normalizeNumber(sourceSummary.citationCount, { max: 100_000 }),
            sourceCount: normalizeNumber(sourceSummary.sourceCount, { max: 100_000 }),
            sources: (Array.isArray(sourceSummary.sources) ? sourceSummary.sources : []).map(item => trimAuditText(item, 500)).filter(Boolean).slice(0, 20),
            citationKeys: (Array.isArray(sourceSummary.citationKeys) ? sourceSummary.citationKeys : []).map(item => trimAuditText(item, 180)).filter(Boolean).slice(0, 20)
        },
        selectedEvidence: normalizeEvidence(matches)
    };
}

function normalizeUsage(usage = {}) {
    const value = usage && typeof usage === 'object' ? usage : {};
    const inputTokens = value.inputTokens ?? value.prompt_tokens ?? value.promptTokens ?? value.input_tokens;
    const outputTokens = value.outputTokens ?? value.completion_tokens ?? value.completionTokens ?? value.output_tokens;
    const totalTokens = value.totalTokens ?? value.total_tokens;
    return {
        inputTokens: normalizeNumber(inputTokens, { max: 10_000_000 }),
        outputTokens: normalizeNumber(outputTokens, { max: 10_000_000 }),
        totalTokens: normalizeNumber(totalTokens, { max: 10_000_000 })
    };
}

function normalizeGrounding(grounding = {}) {
    const value = grounding && typeof grounding === 'object' ? grounding : {};
    return {
        accepted: value.accepted === true,
        status: trimAuditText(value.status, 100),
        semanticStatus: trimAuditText(value.semanticStatus, 100),
        sourceCount: Math.max(0, Math.min(Number(value.sourceCount) || 0, 100)),
        citedSourceIndexes: (Array.isArray(value.citedSourceIndexes) ? value.citedSourceIndexes : []).map(Number).filter(Number.isSafeInteger).slice(0, 30),
        unsupportedClaimCount: Array.isArray(value.unsupportedClaims) ? value.unsupportedClaims.length : 0
    };
}

function publicAuditRow(row = {}) {
    return {
        id: Number(row.id),
        sessionId: row.session_id || '',
        surface: row.surface || 'chat',
        question: row.question || '',
        rewrittenQuery: row.rewritten_query || '',
        answer: row.answer || '',
        modelName: row.model_name || '',
        retrieval: parseJson(row.retrieval_json),
        grounding: parseJson(row.grounding_json),
        usage: parseJson(row.usage_json),
        createdAt: row.created_at
    };
}

async function recordKnowledgeAiAnswer({
    userId,
    sessionId = '',
    surface = 'chat',
    question = '',
    rewrittenQuery = '',
    answer = '',
    modelName = '',
    matches = [],
    retrieval = {},
    grounding = {},
    usage = {}
} = {}) {
    const uid = normalizeId(userId);
    if (!uid) return null;
    const safeSurface = ['chat', 'workbench', 'evaluation'].includes(surface) ? surface : 'chat';
    const retrievalPayload = normalizeRetrieval(retrieval, matches);
    const row = await queryOne(`
        INSERT INTO knowledge_ai_answer_logs (
            user_id, session_id, surface, question, rewritten_query, answer, model_name,
            retrieval_json, grounding_json, usage_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?)
        RETURNING *
    `, [
        uid,
        trimAuditText(sessionId, 180) || null,
        safeSurface,
        trimAuditText(question, 4000),
        trimAuditText(rewrittenQuery, 4000),
        trimAuditText(answer, 24000),
        trimAuditText(modelName, 320),
        JSON.stringify(retrievalPayload),
        JSON.stringify(normalizeGrounding(grounding)),
        JSON.stringify(normalizeUsage(usage)),
        getBeijingTimestamp()
    ]);
    return publicAuditRow(row);
}

async function listKnowledgeAiAnswerLogs(userId, { limit = 30, offset = 0 } = {}) {
    const uid = normalizeId(userId);
    if (!uid) return { data: [], total: 0, limit: 30, offset: 0 };
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const [total, rows] = await Promise.all([
        queryOne('SELECT COUNT(*) AS count FROM knowledge_ai_answer_logs WHERE user_id = ?', [uid]),
        query(`
            SELECT * FROM knowledge_ai_answer_logs WHERE user_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
        `, [uid, safeLimit, safeOffset])
    ]);
    return { data: rows.map(publicAuditRow), total: Number(total?.count || 0), limit: safeLimit, offset: safeOffset };
}

async function getKnowledgeAiQualityMetrics(userId, { days = 30 } = {}) {
    const uid = normalizeId(userId);
    const safeDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 1), 365);
    if (!uid) return { days: safeDays, total: 0, accepted: 0, acceptanceRate: 0, statuses: [] };
    const params = [uid, safeDays];
    const where = "user_id = ? AND created_at >= (NOW() AT TIME ZONE 'Asia/Shanghai') - (? * INTERVAL '1 day')";
    const [summary, statuses] = await Promise.all([
        queryOne(`
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE COALESCE(grounding_json->>'accepted', 'false') = 'true') AS accepted,
                   AVG((retrieval_json->>'candidateCount')::numeric) AS average_candidates,
                   AVG((grounding_json->>'sourceCount')::numeric) AS average_sources
            FROM knowledge_ai_answer_logs WHERE ${where}
        `, params),
        query(`
            SELECT COALESCE(grounding_json->>'status', 'unknown') AS status, COUNT(*) AS count
            FROM knowledge_ai_answer_logs WHERE ${where}
            GROUP BY COALESCE(grounding_json->>'status', 'unknown')
            ORDER BY count DESC
        `, params)
    ]);
    const total = Number(summary?.total || 0);
    const accepted = Number(summary?.accepted || 0);
    return {
        days: safeDays,
        total,
        accepted,
        acceptanceRate: total ? Number((accepted / total).toFixed(4)) : 0,
        averageCandidates: Number(summary?.average_candidates || 0),
        averageSources: Number(summary?.average_sources || 0),
        statuses: statuses.map(item => ({ status: item.status, count: Number(item.count || 0) }))
    };
}

module.exports = {
    getKnowledgeAiQualityMetrics,
    listKnowledgeAiAnswerLogs,
    recordKnowledgeAiAnswer
};
