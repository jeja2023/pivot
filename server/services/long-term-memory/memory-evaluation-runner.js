'use strict';

const { execute, query, queryOne, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { retrieveLongTermMemories } = require('./index');
const { estimateTokens } = require('../../llm');
const { buildLongTermMemoryContextMessage } = require('./memory-retrieval');
const {
    evaluateMemoryRetrievalCase,
    summarizeMemoryEvaluation
} = require('./memory-evaluations');

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeIds(value, limit = 100) {
    const items = Array.isArray(value) ? value : parseJson(value, []);
    return [...new Set((Array.isArray(items) ? items : []).map(normalizeId).filter(Boolean))].slice(0, limit);
}

function normalizeScope(value) {
    const source = value && typeof value === 'object' ? value : parseJson(value, {});
    return {
        sessionId: String(source?.sessionId || source?.session_id || '').trim().slice(0, 160),
        projectId: String(source?.projectId || source?.project_id || '').trim().slice(0, 160)
    };
}

function serializeCase(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        userId: Number(row.user_id),
        name: String(row.name || ''),
        query: String(row.query || ''),
        expectedMemoryIds: normalizeIds(row.expected_memory_ids),
        forbiddenMemoryIds: normalizeIds(row.forbidden_memory_ids),
        scope: normalizeScope(row.scope),
        category: String(row.category || 'general'),
        status: String(row.status || 'active'),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

function serializeRun(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        userId: Number(row.user_id),
        status: row.status || 'completed',
        strategy: row.strategy || 'current',
        summary: parseJson(row.summary, {}),
        createdAt: row.created_at || null,
        completedAt: row.completed_at || null
    };
}

async function listMemoryEvaluationCases(user, options = {}) {
    const status = ['active', 'disabled'].includes(String(options.status || '')) ? String(options.status) : '';
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 100, 500));
    const rows = await query(`
        SELECT * FROM memory_evaluation_cases
        WHERE user_id = ? AND deleted_at IS NULL${status ? ' AND status = ?' : ''}
        ORDER BY updated_at DESC, id DESC LIMIT ?
    `, status ? [Number(user.id), status, limit] : [Number(user.id), limit]);
    return rows.map(serializeCase);
}

async function createMemoryEvaluationCase(user, input = {}) {
    const name = String(input.name || '').trim().slice(0, 180);
    const question = String(input.query || '').trim().slice(0, 4000);
    if (!user?.id || !name || !question) return null;
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO memory_evaluation_cases (
            user_id, name, query, expected_memory_ids, forbidden_memory_ids, scope, category, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) RETURNING *
    `, [
        Number(user.id), name, question,
        JSON.stringify(normalizeIds(input.expectedMemoryIds || input.expected_memory_ids)),
        JSON.stringify(normalizeIds(input.forbiddenMemoryIds || input.forbidden_memory_ids)),
        JSON.stringify(normalizeScope(input.scope)),
        String(input.category || 'general').trim().slice(0, 32) || 'general',
        now, now
    ]);
    return serializeCase(row);
}

async function updateMemoryEvaluationCase(user, caseId, input = {}) {
    const id = normalizeId(caseId);
    const current = id ? await queryOne('SELECT * FROM memory_evaluation_cases WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [id, Number(user?.id)]) : null;
    if (!current) return null;
    const name = input.name === undefined ? current.name : String(input.name || '').trim().slice(0, 180);
    const question = input.query === undefined ? current.query : String(input.query || '').trim().slice(0, 4000);
    if (!name || !question) return null;
    const row = await queryOne(`
        UPDATE memory_evaluation_cases
        SET name = ?, query = ?, expected_memory_ids = ?, forbidden_memory_ids = ?, scope = ?,
            category = ?, status = ?, updated_at = ?
        WHERE id = ? AND user_id = ? RETURNING *
    `, [
        name,
        question,
        input.expectedMemoryIds === undefined ? current.expected_memory_ids : JSON.stringify(normalizeIds(input.expectedMemoryIds || input.expected_memory_ids)),
        input.forbiddenMemoryIds === undefined ? current.forbidden_memory_ids : JSON.stringify(normalizeIds(input.forbiddenMemoryIds || input.forbidden_memory_ids)),
        input.scope === undefined ? current.scope : JSON.stringify(normalizeScope(input.scope)),
        input.category === undefined ? current.category : (String(input.category || '').trim().slice(0, 32) || 'general'),
        input.status === undefined ? current.status : (['active', 'disabled'].includes(input.status) ? input.status : 'active'),
        getBeijingTimestamp(),
        id,
        Number(user.id)
    ]);
    return serializeCase(row);
}

async function deleteMemoryEvaluationCase(user, caseId) {
    const id = normalizeId(caseId);
    if (!id || !user?.id) return false;
    return (await execute(`
        UPDATE memory_evaluation_cases SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `, [getBeijingTimestamp(), getBeijingTimestamp(), id, Number(user.id)])) > 0;
}

async function runMemoryEvaluation(user, options = {}) {
    const requestedIds = normalizeIds(options.caseIds || options.case_ids, 500);
    const where = ['user_id = ?', 'deleted_at IS NULL', "status = 'active'"];
    const params = [Number(user.id)];
    if (requestedIds.length) {
        where.push(`id IN (${requestedIds.map(() => '?').join(',')})`);
        params.push(...requestedIds);
    }
    const rows = await query(`SELECT * FROM memory_evaluation_cases WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`, [...params, 500]);
    const cases = rows.map(serializeCase);
    const results = [];
    for (const evaluationCase of cases) {
        try {
            const startedAt = Date.now();
            const matches = await retrieveLongTermMemories(user.id, evaluationCase.query, {
                user,
                sessionId: evaluationCase.scope.sessionId,
                projectId: evaluationCase.scope.projectId,
                limit: 8
            });
            const contextMessage = buildLongTermMemoryContextMessage(matches, { maxTokens: 1200 });
            const injectedIds = new Set(contextMessage?.metadata?.memoryIds || []);
            const injected = matches.filter(memory => injectedIds.has(memory.id));
            results.push({
                ...evaluateMemoryRetrievalCase(evaluationCase, injected),
                candidateIds: matches.map(memory => Number(memory.id)).filter(Number.isSafeInteger),
                retrievalLatencyMs: Date.now() - startedAt,
                estimatedInjectedTokens: estimateTokens(contextMessage?.content || '')
            });
        } catch (error) {
            results.push({ id: evaluationCase.id, category: evaluationCase.category, error: String(error.message || error), passed: false });
        }
    }
    const summary = summarizeMemoryEvaluation(results);
    const now = getBeijingTimestamp();
    const run = await transaction(async trx => {
        const inserted = await trx.queryOne(`
            INSERT INTO memory_evaluation_runs (user_id, status, strategy, summary, created_at, completed_at)
            VALUES (?, 'completed', 'current', ?, ?, ?) RETURNING *
        `, [Number(user.id), JSON.stringify(summary), now, now]);
        for (const result of results) {
            await trx.execute(`
                INSERT INTO memory_evaluation_results (run_id, case_id, result, created_at)
                VALUES (?, ?, ?, ?)
            `, [inserted.id, Number(result.id), JSON.stringify(result), now]);
        }
        return inserted;
    });
    return { run: serializeRun(run), results };
}

async function listMemoryEvaluationRuns(user, options = {}) {
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 20, 100));
    const rows = await query(`
        SELECT * FROM memory_evaluation_runs WHERE user_id = ?
        ORDER BY id DESC LIMIT ?
    `, [Number(user.id), limit]);
    return rows.map(serializeRun);
}

module.exports = {
    createMemoryEvaluationCase,
    deleteMemoryEvaluationCase,
    listMemoryEvaluationCases,
    listMemoryEvaluationRuns,
    runMemoryEvaluation,
    updateMemoryEvaluationCase
};
