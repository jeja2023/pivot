const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { hasSensitiveContent } = require('./long-term-memory/memory-utils');
const { getPrimaryTenantId } = require('./enterprise-access');

const OUTCOMES = Object.freeze(['success', 'partial', 'failure', 'unknown']);

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeOutcome(value) {
    const outcome = String(value || '').trim().toLowerCase();
    return OUTCOMES.includes(outcome) ? outcome : 'unknown';
}

function normalizeRating(value) {
    if (value === null || value === undefined || value === '') return null;
    const rating = Number.parseInt(value, 10);
    return Number.isSafeInteger(rating) ? Math.max(1, Math.min(5, rating)) : null;
}

function normalizeFailures(value) {
    const list = Array.isArray(value) ? value : [];
    return list.slice(0, 50).map(item => {
        if (typeof item === 'string') return { tool: item.slice(0, 160), count: 1 };
        return {
            tool: String(item?.tool || item?.toolName || '').slice(0, 160),
            count: Math.max(1, Number.parseInt(item?.count, 10) || 1),
            error: String(item?.error || '').slice(0, 500)
        };
    }).filter(item => item.tool);
}

function redactSensitiveText(value, maxLength) {
    const text = String(value || '').trim().slice(0, maxLength);
    return hasSensitiveContent(text) ? '[已按记忆治理策略脱敏]' : text;
}

function serializeFeedback(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        runId: row.run_id,
        outcome: normalizeOutcome(row.outcome),
        rating: normalizeRating(row.rating),
        correction: redactSensitiveText(row.correction || '', 4000),
        modifiedAnswer: redactSensitiveText(row.modified_answer || '', 12000),
        toolFailures: normalizeFailures(parseJson(row.tool_failures, [])),
        metadata: parseJson(row.metadata, {}),
        source: String(row.source || 'user'),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

async function getOwnedRun(userId, runId) {
    return queryOne('SELECT id, user_id, status, final_answer, error_message FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [String(runId || ''), userId]);
}

async function recordAgentFeedback(user, runId, input = {}, options = {}) {
    const userId = Number.parseInt(user?.id || user, 10);
    const normalizedRunId = String(runId || '').trim();
    if (!Number.isSafeInteger(userId) || userId <= 0 || !normalizedRunId) throw new Error('用户或任务标识无效。');
    const run = await getOwnedRun(userId, normalizedRunId);
    if (!run) return null;
    const now = getBeijingTimestamp();
    const tenantId = options.tenantId || await getPrimaryTenantId(userId);
    const outcome = normalizeOutcome(input.outcome || (['completed'].includes(run.status) ? 'success' : ['failed', 'error', 'cancelled'].includes(run.status) ? 'failure' : 'unknown'));
    const feedback = {
        outcome,
        rating: normalizeRating(input.rating),
        correction: redactSensitiveText(input.correction || '', 4000),
        modifiedAnswer: redactSensitiveText(input.modifiedAnswer || input.modified_answer || '', 12000),
        toolFailures: normalizeFailures(input.toolFailures || input.tool_failures),
        metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
        source: String(options.source || input.source || 'user').slice(0, 32)
    };
    if (JSON.stringify(feedback.metadata).length > 8000) feedback.metadata = { truncated: true };
    if (feedback.source !== 'user' && !['runtime', 'system'].includes(feedback.source)) feedback.source = 'user';
    const row = await queryOne(`
        INSERT INTO agent_feedback (user_id, tenant_id, run_id, outcome, rating, correction, modified_answer, tool_failures, metadata, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, run_id) DO UPDATE SET
            outcome = excluded.outcome,
            rating = COALESCE(excluded.rating, agent_feedback.rating),
            correction = CASE WHEN excluded.correction <> '' THEN excluded.correction ELSE agent_feedback.correction END,
            modified_answer = CASE WHEN excluded.modified_answer <> '' THEN excluded.modified_answer ELSE agent_feedback.modified_answer END,
            tool_failures = CASE WHEN excluded.tool_failures <> '[]' THEN excluded.tool_failures ELSE agent_feedback.tool_failures END,
            metadata = excluded.metadata,
            source = excluded.source,
            updated_at = excluded.updated_at
        RETURNING *
    `, [userId, tenantId, normalizedRunId, feedback.outcome, feedback.rating, feedback.correction, feedback.modifiedAnswer, JSON.stringify(feedback.toolFailures), JSON.stringify(feedback.metadata), feedback.source, now, now]);
    return serializeFeedback(row);
}

async function recordAgentRunOutcome(runId, status, options = {}) {
    const run = await queryOne('SELECT id, user_id, status, final_answer, error_message FROM agent_runs WHERE id = ?', [String(runId || '')]);
    if (!run?.user_id) return null;
    let failures = [];
    try {
        const rows = await query(`SELECT tool_name AS tool, COUNT(*) AS count FROM agent_tool_calls WHERE run_id = ? AND status IN ('error', 'failed', 'denied') GROUP BY tool_name ORDER BY count DESC LIMIT 20`, [String(run.id)]);
        failures = rows.map(row => ({ tool: row.tool, count: Number(row.count || 0) }));
    } catch (_) {}
    const result = await recordAgentFeedback({ id: run.user_id }, run.id, {
        outcome: ['completed'].includes(String(status)) ? 'success' : ['completed_with_errors'].includes(String(status)) ? 'partial' : 'failure',
        toolFailures: failures,
        metadata: { status, finalAnswerPresent: Boolean(run.final_answer), error: String(run.error_message || '').slice(0, 500) }
    }, { source: options.source || 'runtime' });
    try {
        const { recordAgentGoalRunOutcome } = require('./agent-goals');
        await recordAgentGoalRunOutcome(run.id, result?.outcome);
    } catch (_) {}
    return result;
}

async function listAgentFeedback(user, options = {}) {
    const userId = Number.parseInt(user?.id || user, 10);
    const tenantId = options.tenantId || user?.tenant_id || await getPrimaryTenantId(userId);
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    const rows = await query('SELECT * FROM agent_feedback WHERE user_id = ? AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY updated_at DESC, id DESC LIMIT ?', [userId, tenantId, limit]);
    return rows.map(serializeFeedback);
}

async function getAgentFeedbackSummary(user, options = {}) {
    const userId = Number.parseInt(user?.id || user, 10);
    const tenantId = options.tenantId || user?.tenant_id || await getPrimaryTenantId(userId);
    const days = Math.max(1, Math.min(Number.parseInt(options.days, 10) || 30, 365));
    const cutoff = getBeijingTimestamp(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    const rows = await query('SELECT * FROM agent_feedback WHERE user_id = ? AND (tenant_id IS NULL OR tenant_id = ?) AND created_at >= ? ORDER BY created_at DESC', [userId, tenantId, cutoff]);
    const feedback = rows.map(serializeFeedback);
    const byOutcome = Object.fromEntries(OUTCOMES.map(key => [key, 0]));
    const toolFailures = {};
    feedback.forEach(item => {
        byOutcome[item.outcome] += 1;
        item.toolFailures.forEach(failure => { toolFailures[failure.tool] = (toolFailures[failure.tool] || 0) + failure.count; });
    });
    const rated = feedback.filter(item => item.rating !== null);
    return {
        days,
        total: feedback.length,
        byOutcome,
        successRate: feedback.length ? (byOutcome.success / feedback.length) : 1,
        averageRating: rated.length ? rated.reduce((sum, item) => sum + item.rating, 0) / rated.length : null,
        frequentToolFailures: Object.entries(toolFailures).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tool, count]) => ({ tool, count })),
        recent: feedback.slice(0, 10)
    };
}

async function getAgentFeedbackSignals(userId, options = {}) {
    const summary = await getAgentFeedbackSummary({ id: userId }, options);
    return {
        successRate: summary.successRate,
        averageRating: summary.averageRating,
        unreliableTools: summary.frequentToolFailures.filter(item => item.count >= 2).map(item => item.tool)
    };
}

module.exports = {
    OUTCOMES,
    getAgentFeedbackSignals,
    getAgentFeedbackSummary,
    listAgentFeedback,
    normalizeOutcome,
    recordAgentFeedback,
    recordAgentRunOutcome,
    serializeFeedback
};
