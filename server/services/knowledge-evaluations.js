'use strict';

// 知识库黄金问题与检索评测。评测数据和运行记录全部持久化，避免仅凭调试
// 面板的主观反馈判断 RAG 是否变好。当前先覆盖可验证的检索/引用指标；答案
// 事实点字段也会随结果保留，供后续本地 judge 模型或人工复核扩展。
const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { debugRetrieveContext } = require('./rag-index');
const { getAccessibleModelAsync } = require('./models');
const { callModelTextWithBudget } = require('./model-text-call');

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeArray(value, max = 200) {
    const raw = Array.isArray(value) ? value : (() => {
        try { return JSON.parse(String(value || '[]')); } catch (_) { return []; }
    })();
    return Array.isArray(raw) ? raw.slice(0, max) : [];
}

function normalizeIdArray(value, max = 200) {
    return [...new Set(normalizeArray(value, max)
        .map(normalizeId)
        .filter(Boolean))];
}

function normalizeTextArray(value, max = 50, itemMax = 1000) {
    return [...new Set(normalizeArray(value, max)
        .map(item => String(item || '').trim().slice(0, itemMax))
        .filter(Boolean))];
}

function parseRowCase(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        userId: Number(row.user_id),
        collectionId: normalizeId(row.collection_id),
        name: row.name,
        query: row.query,
        expectedDocumentIds: normalizeIdArray(row.expected_document_ids),
        expectedChunkIds: normalizeIdArray(row.expected_chunk_ids),
        expectedAnswerPoints: normalizeTextArray(row.expected_answer_points),
        expectedCitationKeys: normalizeTextArray(row.expected_citation_keys),
        difficulty: row.difficulty || 'normal',
        status: row.status || 'active',
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function uniqueNumbers(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).map(normalizeId).filter(Boolean))];
}

function dcg(relevances = []) {
    return relevances.reduce((score, relevant, index) => score + (relevant ? 1 / Math.log2(index + 2) : 0), 0);
}

function computeRetrievalMetrics({ expectedDocumentIds = [], expectedChunkIds = [], retrievedDocumentIds = [], retrievedChunkIds = [] } = {}) {
    const expectedDocs = new Set(uniqueNumbers(expectedDocumentIds));
    const expectedChunks = new Set(uniqueNumbers(expectedChunkIds));
    const retrievedDocs = uniqueNumbers(retrievedDocumentIds);
    const retrievedChunks = uniqueNumbers(retrievedChunkIds);
    const hasExpected = expectedDocs.size > 0 || expectedChunks.size > 0;
    const relevantAt = index => {
        const chunk = retrievedChunks[index];
        const document = retrievedDocs[index];
        return expectedChunks.has(chunk) || expectedDocs.has(document);
    };
    const ranks = retrievedChunks.map((_, index) => index).filter(relevantAt);
    const firstRank = ranks.length ? ranks[0] + 1 : null;
    const relevance5 = Array.from({ length: Math.min(5, retrievedChunks.length) }, (_, index) => relevantAt(index));
    const idealRelevantCount = expectedChunks.size || expectedDocs.size;
    const ideal5 = Array.from({ length: Math.min(5, idealRelevantCount) }, () => true);
    const precisionAt = limit => {
        const slice = Array.from({ length: Math.min(limit, retrievedChunks.length) }, (_, index) => relevantAt(index));
        return slice.length ? slice.filter(Boolean).length / slice.length : 0;
    };
    return {
        hasExpected,
        recallAt1: hasExpected ? (relevance5[0] ? 1 : 0) : null,
        recallAt3: hasExpected ? (relevance5.slice(0, 3).some(Boolean) ? 1 : 0) : null,
        recallAt5: hasExpected ? (relevance5.some(Boolean) ? 1 : 0) : null,
        precisionAt1: hasExpected ? precisionAt(1) : null,
        precisionAt3: hasExpected ? precisionAt(3) : null,
        precisionAt5: hasExpected ? precisionAt(5) : null,
        mrr: hasExpected && firstRank ? 1 / firstRank : 0,
        ndcgAt5: hasExpected ? (dcg(relevance5) / (dcg(ideal5) || 1)) : null,
        firstRelevantRank: firstRank,
        relevantRetrieved: ranks.length,
        expectedCount: idealRelevantCount,
        abstentionCorrect: hasExpected ? null : retrievedChunks.length === 0
    };
}

function computeCitationMetrics({ expectedCitationKeys = [], citationKeys = [] } = {}) {
    const expected = new Set(normalizeTextArray(expectedCitationKeys, 100, 180));
    const actual = [...new Set(normalizeTextArray(citationKeys, 100, 180))];
    if (!expected.size) return { hasExpectedCitations: false, citationPrecision: null, citationRecall: null, citationF1: null, matchedCitations: 0 };
    const matched = actual.filter(key => expected.has(key)).length;
    const precision = actual.length ? matched / actual.length : 0;
    const recall = matched / expected.size;
    return {
        hasExpectedCitations: true,
        citationPrecision: precision,
        citationRecall: recall,
        citationF1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
        matchedCitations: matched
    };
}

function computeAnswerPointCoverage(answer = '', expectedAnswerPoints = []) {
    const expected = normalizeTextArray(expectedAnswerPoints, 50, 1000);
    if (!expected.length) return { hasExpectedAnswerPoints: false, answerPointCoverage: null, matchedAnswerPoints: 0 };
    const text = String(answer || '').toLowerCase();
    const matched = expected.filter(point => text.includes(point.toLowerCase())).length;
    return {
        hasExpectedAnswerPoints: true,
        answerPointCoverage: matched / expected.length,
        matchedAnswerPoints: matched
    };
}

function buildEvaluationAnswerMessages(query, context) {
    return [
        { role: 'system', content: '你是知识库评测助手。只能依据提供的检索证据回答；证据不足时明确回答“知识库中未找到足够依据”。不要编造来源或事实。' },
        { role: 'user', content: `【问题】\n${query}\n\n【检索证据】\n${context}` }
    ];
}

function aggregateMetrics(results = []) {
    const completed = results.filter(result => result?.metrics && !result.error);
    const numbers = key => completed
        .map(result => result.metrics[key])
        .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
        .map(Number);
    const average = key => {
        const values = numbers(key);
        return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null;
    };
    const abstention = completed.map(result => result.metrics.abstentionCorrect).filter(value => typeof value === 'boolean');
    return {
        cases: results.length,
        completed: completed.length,
        failed: results.filter(result => result?.error).length,
        recallAt1: average('recallAt1'),
        recallAt3: average('recallAt3'),
        recallAt5: average('recallAt5'),
        precisionAt1: average('precisionAt1'),
        precisionAt3: average('precisionAt3'),
        precisionAt5: average('precisionAt5'),
        mrr: average('mrr'),
        ndcgAt5: average('ndcgAt5'),
        citationPrecision: average('citationPrecision'),
        citationRecall: average('citationRecall'),
        citationF1: average('citationF1'),
        answerPointCoverage: average('answerPointCoverage'),
        abstentionAccuracy: abstention.length ? Number((abstention.filter(Boolean).length / abstention.length).toFixed(4)) : null
    };
}

async function listKnowledgeEvaluationCases(userId, { status = '', limit = 200 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 500));
    const safeStatus = ['active', 'disabled'].includes(String(status || '')) ? String(status) : '';
    const rows = await query(`
        SELECT * FROM knowledge_eval_cases
        WHERE user_id = ? AND deleted_at IS NULL ${safeStatus ? 'AND status = ?' : ''}
        ORDER BY updated_at DESC, id DESC LIMIT ?
    `, safeStatus ? [userId, safeStatus, safeLimit] : [userId, safeLimit]);
    return rows.map(parseRowCase);
}

async function createKnowledgeEvaluationCase(user, body = {}) {
    const name = String(body.name || '').trim().slice(0, 160);
    const question = String(body.query || '').trim().slice(0, 4000);
    if (!user?.id || !name || !question) return null;
    const timestamp = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO knowledge_eval_cases (
            user_id, collection_id, name, query, expected_document_ids, expected_chunk_ids,
            expected_answer_points, expected_citation_keys, difficulty, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) RETURNING *
    `, [
        user.id,
        normalizeId(body.collectionId),
        name,
        question,
        JSON.stringify(normalizeIdArray(body.expectedDocumentIds)),
        JSON.stringify(normalizeIdArray(body.expectedChunkIds)),
        JSON.stringify(normalizeTextArray(body.expectedAnswerPoints)),
        JSON.stringify(normalizeTextArray(body.expectedCitationKeys, 50, 180)),
        ['easy', 'normal', 'hard'].includes(body.difficulty) ? body.difficulty : 'normal',
        timestamp,
        timestamp
    ]);
    return parseRowCase(row);
}

async function updateKnowledgeEvaluationCase(user, caseId, body = {}) {
    const id = normalizeId(caseId);
    const current = id ? await queryOne('SELECT * FROM knowledge_eval_cases WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, user?.id]) : null;
    if (!current) return null;
    const name = body.name === undefined ? current.name : String(body.name || '').trim().slice(0, 160);
    const question = body.query === undefined ? current.query : String(body.query || '').trim().slice(0, 4000);
    if (!name || !question) return null;
    const timestamp = getBeijingTimestamp();
    const row = await queryOne(`
        UPDATE knowledge_eval_cases
        SET collection_id = ?, name = ?, query = ?, expected_document_ids = ?, expected_chunk_ids = ?,
            expected_answer_points = ?, expected_citation_keys = ?, difficulty = ?, status = ?, updated_at = ?
        WHERE id = ? AND user_id = ? RETURNING *
    `, [
        body.collectionId === undefined ? current.collection_id : normalizeId(body.collectionId),
        name,
        question,
        body.expectedDocumentIds === undefined ? current.expected_document_ids : JSON.stringify(normalizeIdArray(body.expectedDocumentIds)),
        body.expectedChunkIds === undefined ? current.expected_chunk_ids : JSON.stringify(normalizeIdArray(body.expectedChunkIds)),
        body.expectedAnswerPoints === undefined ? current.expected_answer_points : JSON.stringify(normalizeTextArray(body.expectedAnswerPoints)),
        body.expectedCitationKeys === undefined ? current.expected_citation_keys : JSON.stringify(normalizeTextArray(body.expectedCitationKeys, 50, 180)),
        body.difficulty === undefined ? current.difficulty : (['easy', 'normal', 'hard'].includes(body.difficulty) ? body.difficulty : 'normal'),
        body.status === undefined ? current.status : (['active', 'disabled'].includes(body.status) ? body.status : 'active'),
        timestamp,
        id,
        user.id
    ]);
    return parseRowCase(row);
}

async function deleteKnowledgeEvaluationCase(user, caseId) {
    const id = normalizeId(caseId);
    if (!id || !user?.id) return false;
    const changed = await execute(`
        UPDATE knowledge_eval_cases SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [getBeijingTimestamp(), getBeijingTimestamp(), id, user.id]);
    return Number(changed || 0) > 0;
}

async function resolveSelectedDocumentIds(selectedChunkIds) {
    const ids = uniqueNumbers(selectedChunkIds).slice(0, 500);
    if (!ids.length) return [];
    const rows = await query(`
        SELECT id, doc_id FROM knowledge_chunks WHERE id IN (${ids.map(() => '?').join(',')})
    `, ids);
    const byChunk = new Map(rows.map(row => [Number(row.id), Number(row.doc_id)]));
    return ids.map(id => byChunk.get(id)).filter(Boolean);
}

async function resolveExpectedLegacyDocumentIds(expectedProductDocumentIds) {
    const ids = uniqueNumbers(expectedProductDocumentIds).slice(0, 500);
    if (!ids.length) return [];
    const rows = await query(`
        SELECT legacy_doc_id FROM knowledge_documents
        WHERE id IN (${ids.map(() => '?').join(',')}) AND legacy_doc_id IS NOT NULL
    `, ids);
    return rows.map(row => normalizeId(row.legacy_doc_id)).filter(Boolean);
}

async function executeKnowledgeEvaluationRun(runId, deps = {}) {
    const id = normalizeId(runId);
    if (!id) return null;
    const executeDebug = deps.debugRetrieveContext || debugRetrieveContext;
    const getModel = deps.getAccessibleModelAsync || getAccessibleModelAsync;
    const callModel = deps.callModelTextWithBudget || callModelTextWithBudget;
    const claim = await transaction(async trx => {
        const run = await trx.queryOne(`
            SELECT * FROM knowledge_eval_runs WHERE id = ? FOR UPDATE
        `, [id]);
        if (!run || !['queued', 'retry_wait'].includes(run.status)) return null;
        await trx.execute(`
            UPDATE knowledge_eval_runs SET status = 'running', started_at = ?, error_message = '', updated_at = ? WHERE id = ?
        `, [getBeijingTimestamp(), getBeijingTimestamp(), id]);
        return run;
    });
    if (!claim) return null;
    const user = await queryOne('SELECT id, username, role, unit FROM users WHERE id = ? AND deleted_at IS NULL', [claim.user_id]);
    if (!user) throw new Error('评测运行所属用户不存在。');
    const config = normalizeArray(claim.config_json, 1)[0] || (() => { try { return JSON.parse(claim.config_json || '{}'); } catch (_) { return {}; } })();
    const caseIds = normalizeIdArray(config.caseIds || config.case_ids, 500);
    const cases = await query(`
        SELECT * FROM knowledge_eval_cases
        WHERE user_id = ? AND status = 'active' AND deleted_at IS NULL
        ${caseIds.length ? `AND id IN (${caseIds.map(() => '?').join(',')})` : ''}
        ORDER BY id ASC
    `, [user.id, ...caseIds]);
    const answerModel = config.modelId ? await getModel(config.modelId, user) : null;
    const results = [];
    for (const row of cases) {
        const evaluationCase = parseRowCase(row);
        try {
            const retrieval = await executeDebug(user.id, evaluationCase.query, {
                topK: config.topK,
                candidateLimit: config.candidateLimit,
                scoreThreshold: config.scoreThreshold,
                scope: evaluationCase.collectionId ? { collectionId: evaluationCase.collectionId } : {},
                user
            });
            const ranked = (retrieval.matches || []).filter(match => match.matched).slice(0, 5);
            const retrievedChunkIds = ranked.map(match => normalizeId(match.chunkId)).filter(Boolean);
            const retrievedDocumentIds = await resolveSelectedDocumentIds(retrievedChunkIds);
            const expectedLegacyDocumentIds = await resolveExpectedLegacyDocumentIds(evaluationCase.expectedDocumentIds);
            const citationKeys = (retrieval.matches || []).filter(match => match.selected && match.citationKey).map(match => match.citationKey);
            let answer = '';
            if (answerModel && retrieval.injectedContext) {
                const completion = await callModel({
                    modelCfg: answerModel,
                    user,
                    messages: buildEvaluationAnswerMessages(evaluationCase.query, retrieval.injectedContext),
                    source: 'knowledge_evaluation',
                    maxTokens: 1600,
                    temperature: 0
                });
                answer = String(completion?.content || '').trim();
            }
            const metrics = {
                ...computeRetrievalMetrics({
                expectedDocumentIds: expectedLegacyDocumentIds,
                expectedChunkIds: evaluationCase.expectedChunkIds,
                retrievedDocumentIds,
                retrievedChunkIds
                }),
                ...computeCitationMetrics({ expectedCitationKeys: evaluationCase.expectedCitationKeys, citationKeys }),
                ...computeAnswerPointCoverage(answer, evaluationCase.expectedAnswerPoints)
            };
            await execute(`
                INSERT INTO knowledge_eval_results (
                    run_id, case_id, status, retrieved_document_ids, retrieved_chunk_ids, citation_keys,
                    answer, metrics_json, error_message, created_at
                ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, '', ?)
                ON CONFLICT DO NOTHING
            `, [id, evaluationCase.id, JSON.stringify(retrievedDocumentIds), JSON.stringify(retrievedChunkIds), JSON.stringify(citationKeys), answer, JSON.stringify(metrics), getBeijingTimestamp()]);
            results.push({ caseId: evaluationCase.id, metrics });
        } catch (error) {
            await execute(`
                INSERT INTO knowledge_eval_results (
                    run_id, case_id, status, retrieved_document_ids, retrieved_chunk_ids, citation_keys,
                    answer, metrics_json, error_message, created_at
                ) VALUES (?, ?, 'failed', '[]', '[]', '[]', '', '{}', ?, ?)
                ON CONFLICT DO NOTHING
            `, [id, evaluationCase.id, String(error.message || error).slice(0, 1500), getBeijingTimestamp()]);
            results.push({ caseId: evaluationCase.id, error: error.message || String(error) });
        }
    }
    const summary = aggregateMetrics(results);
    await execute(`
        UPDATE knowledge_eval_runs
        SET status = 'completed', summary_json = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `, [JSON.stringify(summary), getBeijingTimestamp(), getBeijingTimestamp(), id]);
    return { runId: id, summary, results };
}

async function startKnowledgeEvaluation(user, body = {}) {
    if (!user?.id) return null;
    const timestamp = getBeijingTimestamp();
    const run = await queryOne(`
        INSERT INTO knowledge_eval_runs (user_id, name, status, config_json, summary_json, created_at, updated_at)
        VALUES (?, ?, 'queued', ?, '{}', ?, ?) RETURNING *
    `, [
        user.id,
        String(body.name || '知识库检索评测').trim().slice(0, 160),
        JSON.stringify({
            caseIds: normalizeIdArray(body.caseIds),
            topK: body.topK,
            candidateLimit: body.candidateLimit,
            scoreThreshold: body.scoreThreshold,
            modelId: body.modelId || null
        }),
        timestamp,
        timestamp
    ]);
    setImmediate(() => {
        executeKnowledgeEvaluationRun(run.id).catch(async error => {
            await execute(`
                UPDATE knowledge_eval_runs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?
            `, [String(error.message || error).slice(0, 1500), getBeijingTimestamp(), getBeijingTimestamp(), run.id]).catch(() => {});
        });
    });
    return { id: Number(run.id), status: 'queued', name: run.name };
}

async function listKnowledgeEvaluationRuns(userId, { limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
    const rows = await query(`
        SELECT * FROM knowledge_eval_runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    `, [userId, safeLimit]);
    return rows.map(row => ({
        id: Number(row.id), name: row.name, status: row.status,
        config: (() => { try { return JSON.parse(row.config_json || '{}'); } catch (_) { return {}; } })(),
        summary: (() => { try { return JSON.parse(row.summary_json || '{}'); } catch (_) { return {}; } })(),
        startedAt: row.started_at, completedAt: row.completed_at, errorMessage: row.error_message || '',
        createdAt: row.created_at, updatedAt: row.updated_at
    }));
}

async function getKnowledgeEvaluationRun(userId, runId) {
    const id = normalizeId(runId);
    const run = id ? await queryOne('SELECT * FROM knowledge_eval_runs WHERE id = ? AND user_id = ?', [id, userId]) : null;
    if (!run) return null;
    const results = await query(`
        SELECT result.*, evaluation.name, evaluation.query
        FROM knowledge_eval_results result
        JOIN knowledge_eval_cases evaluation ON evaluation.id = result.case_id
        WHERE result.run_id = ? ORDER BY result.id ASC
    `, [id]);
    return {
        id: Number(run.id), name: run.name, status: run.status,
        summary: (() => { try { return JSON.parse(run.summary_json || '{}'); } catch (_) { return {}; } })(),
        errorMessage: run.error_message || '', startedAt: run.started_at, completedAt: run.completed_at,
        results: results.map(result => ({
            caseId: Number(result.case_id), name: result.name, query: result.query, status: result.status,
            retrievedDocumentIds: normalizeIdArray(result.retrieved_document_ids),
            retrievedChunkIds: normalizeIdArray(result.retrieved_chunk_ids),
            citationKeys: normalizeTextArray(result.citation_keys, 100, 180),
            answer: result.answer || '',
            metrics: (() => { try { return JSON.parse(result.metrics_json || '{}'); } catch (_) { return {}; } })(),
            errorMessage: result.error_message || ''
        }))
    };
}

async function compareKnowledgeEvaluationRuns(userId, baseRunId, candidateRunId) {
    const [base, candidate] = await Promise.all([
        getKnowledgeEvaluationRun(userId, baseRunId),
        getKnowledgeEvaluationRun(userId, candidateRunId)
    ]);
    if (!base || !candidate) return null;
    const metricKeys = ['recallAt1', 'recallAt3', 'recallAt5', 'precisionAt1', 'precisionAt3', 'precisionAt5', 'mrr', 'ndcgAt5', 'citationPrecision', 'citationRecall', 'citationF1', 'answerPointCoverage', 'abstentionAccuracy'];
    const delta = Object.fromEntries(metricKeys.map(key => {
        const before = Number(base.summary?.[key]);
        const after = Number(candidate.summary?.[key]);
        return [key, Number.isFinite(before) && Number.isFinite(after) ? Number((after - before).toFixed(4)) : null];
    }));
    const baseByCase = new Map((base.results || []).map(result => [Number(result.caseId), result]));
    const regressions = (candidate.results || []).map(result => {
        const previous = baseByCase.get(Number(result.caseId));
        const before = Number(previous?.metrics?.recallAt3);
        const after = Number(result.metrics?.recallAt3);
        return previous && Number.isFinite(before) && Number.isFinite(after) && after < before
            ? { caseId: result.caseId, name: result.name, before, after }
            : null;
    }).filter(Boolean);
    return {
        base: { id: base.id, name: base.name, summary: base.summary },
        candidate: { id: candidate.id, name: candidate.name, summary: candidate.summary },
        delta,
        regressions
    };
}

async function getKnowledgeGapReport(userId, { limit = 30 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 30, 200));
    const latest = await queryOne(`
        SELECT id FROM knowledge_eval_runs
        WHERE user_id = ? AND status = 'completed' ORDER BY completed_at DESC, id DESC LIMIT 1
    `, [userId]);
    const evaluationGaps = latest ? await query(`
        SELECT c.id AS case_id, c.name, c.query, r.metrics_json
        FROM knowledge_eval_results r
        JOIN knowledge_eval_cases c ON c.id = r.case_id
        WHERE r.run_id = ? AND r.status = 'completed'
        ORDER BY r.id ASC
    `, [latest.id]) : [];
    const missedCases = evaluationGaps.map(row => {
        const metrics = (() => { try { return JSON.parse(row.metrics_json || '{}'); } catch (_) { return {}; } })();
        return Number(metrics.recallAt3) === 0 || Number(metrics.citationRecall) === 0
            ? { caseId: Number(row.case_id), name: row.name, query: row.query, metrics }
            : null;
    }).filter(Boolean).slice(0, safeLimit);
    const negativeFeedback = await query(`
        SELECT doc_name, query, COUNT(*) AS count
        FROM rag_feedback
        WHERE user_id = ? AND helpful = 0
        GROUP BY doc_name, query
        ORDER BY count DESC, MAX(created_at) DESC
        LIMIT ?
    `, [userId, safeLimit]);
    return { latestRunId: latest?.id ? Number(latest.id) : null, missedCases, negativeFeedback };
}

async function recoverKnowledgeEvaluationRuns() {
    const rows = await query(`
        SELECT id FROM knowledge_eval_runs WHERE status IN ('queued', 'retry_wait') ORDER BY created_at ASC LIMIT 20
    `);
    for (const row of rows) {
        setImmediate(() => { executeKnowledgeEvaluationRun(row.id).catch(() => {}); });
    }
    return { scheduled: rows.length };
}

module.exports = {
    aggregateMetrics,
    compareKnowledgeEvaluationRuns,
    computeAnswerPointCoverage,
    computeCitationMetrics,
    computeRetrievalMetrics,
    createKnowledgeEvaluationCase,
    deleteKnowledgeEvaluationCase,
    getKnowledgeEvaluationRun,
    getKnowledgeGapReport,
    listKnowledgeEvaluationCases,
    listKnowledgeEvaluationRuns,
    recoverKnowledgeEvaluationRuns,
    startKnowledgeEvaluation,
    updateKnowledgeEvaluationCase
};
