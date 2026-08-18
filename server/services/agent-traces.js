const { randomUUID } = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const TERMINAL_TRACE_STATUSES = new Set(['completed', 'completed_with_errors', 'error', 'cancelled', 'deleted']);
const SECRET_KEY_RE = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i;
const MAX_SUMMARY_LENGTH = 6000;

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function redactTraceValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}...[已截断]` : value;
    if (typeof value !== 'object') return value;
    if (depth >= 6) return '[层级已截断]';
    if (seen.has(value)) return '[循环引用]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 40).map(item => redactTraceValue(item, depth + 1, seen));
    const entries = Object.entries(value).slice(0, 80).map(([key, item]) => [
        key,
        SECRET_KEY_RE.test(key) ? '[已脱敏]' : redactTraceValue(item, depth + 1, seen)
    ]);
    return Object.fromEntries(entries);
}

function serializeTraceValue(value) {
    if (value === undefined || value === null || value === '') return '';
    try {
        const text = JSON.stringify(redactTraceValue(value));
        return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH)}...[已截断]` : text;
    } catch (e) {
        return JSON.stringify({ summary: String(value).slice(0, MAX_SUMMARY_LENGTH) });
    }
}

async function ensureAgentTrace(run, metadata = {}) {
    if (!run?.id || !run?.user_id) return null;
    const now = getBeijingTimestamp();
    const hasMetadata = metadata && typeof metadata === 'object'
        ? Object.keys(metadata).length > 0
        : Boolean(metadata);
    const metadataText = hasMetadata ? serializeTraceValue(metadata) : '';
    try {
        await execute(`
            INSERT INTO agent_traces (run_id, user_id, status, metadata, started_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                metadata = CASE WHEN excluded.metadata = '' THEN agent_traces.metadata ELSE excluded.metadata END,
                started_at = COALESCE(agent_traces.started_at, excluded.started_at),
                updated_at = excluded.updated_at
        `, [
            run.id,
            run.user_id,
            run.status || 'queued',
            metadataText,
            run.started_at || now,
            now,
            now
        ]);
        return run.id;
    } catch (e) {
        return null;
    }
}

async function startAgentTraceSpan(runId, data = {}) {
    if (!runId) return '';
    const spanId = randomUUID();
    const now = data.startedAt || getBeijingTimestamp();
    try {
        await execute(`
            INSERT INTO agent_trace_spans (
                span_id, run_id, parent_span_id, span_type, name, status,
                input_summary, details, started_at, created_at
            ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
        `, [
            spanId,
            runId,
            data.parentSpanId || null,
            String(data.type || 'operation').slice(0, 40),
            String(data.name || '运行步骤').slice(0, 160),
            serializeTraceValue(data.input),
            serializeTraceValue(data.details),
            now,
            now
        ]);
        return spanId;
    } catch (e) {
        return '';
    }
}

async function finishAgentTraceSpan(spanId, data = {}) {
    if (!spanId) return false;
    const completedAt = data.completedAt || getBeijingTimestamp();
    try {
        const current = await queryOne('SELECT started_at FROM agent_trace_spans WHERE span_id = ?', [spanId]);
        const measured = current?.started_at ? Math.max(Date.now() - new Date(`${current.started_at} GMT+0800`).getTime(), 0) : 0;
        const durationMs = Math.max(Number(data.durationMs) || measured || 0, 0);
        const changes = await execute(`
            UPDATE agent_trace_spans
            SET status = ?, output_summary = ?, details = CASE WHEN ? = '' THEN details ELSE ? END,
                error_message = ?, input_tokens = ?, output_tokens = ?,
                completed_at = ?, duration_ms = ?
            WHERE span_id = ?
        `, [
            data.status || (data.errorMessage ? 'error' : 'completed'),
            serializeTraceValue(data.output),
            serializeTraceValue(data.details),
            serializeTraceValue(data.details),
            String(data.errorMessage || '').slice(0, 2000),
            Math.max(Number(data.inputTokens) || 0, 0),
            Math.max(Number(data.outputTokens) || 0, 0),
            completedAt,
            durationMs,
            spanId
        ]);
        return changes > 0;
    } catch (e) {
        return false;
    }
}

async function recordAgentTraceSpan(runId, data = {}) {
    const spanId = await startAgentTraceSpan(runId, data);
    if (!spanId) return '';
    await finishAgentTraceSpan(spanId, data);
    return spanId;
}

async function syncAgentTraceFromRun(runId) {
    if (!runId) return null;
    try {
        const run = await queryOne(`
            SELECT id, user_id, status, started_at, completed_at, created_at
            FROM agent_runs WHERE id = ?
        `, [runId]);
        if (!run) return null;
        await ensureAgentTrace(run);
        const completedAt = run.completed_at || (TERMINAL_TRACE_STATUSES.has(run.status) ? getBeijingTimestamp() : null);
        const startedAt = run.started_at || run.created_at;
        const durationMs = completedAt && startedAt
            ? Math.max(new Date(`${completedAt} GMT+0800`).getTime() - new Date(`${startedAt} GMT+0800`).getTime(), 0)
            : 0;
        await execute(`
            UPDATE agent_traces
            SET status = ?, started_at = COALESCE(started_at, ?), completed_at = ?, duration_ms = ?, updated_at = ?
            WHERE run_id = ?
        `, [run.status, startedAt, completedAt, durationMs, getBeijingTimestamp(), runId]);
        return run;
    } catch (e) {
        return null;
    }
}

async function getAgentTraceForUser(runId, user) {
    const run = await queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [runId, user.id]);
    if (!run) return null;
    await syncAgentTraceFromRun(runId);
    const trace = await queryOne(`
        SELECT run_id, status, metadata, started_at, completed_at, duration_ms, created_at, updated_at
        FROM agent_traces WHERE run_id = ? AND user_id = ?
    `, [runId, user.id]);
    const rawSpans = await query(`
        SELECT span_id, parent_span_id, span_type, name, status, input_summary, output_summary,
               details, error_message, input_tokens, output_tokens, started_at, completed_at,
               duration_ms, created_at
        FROM agent_trace_spans
        WHERE run_id = ?
        ORDER BY COALESCE(started_at, created_at) ASC, id ASC
    `, [runId]);
    const spans = rawSpans.map(span => ({
        ...span,
        input: safeJsonParse(span.input_summary, span.input_summary || null),
        output: safeJsonParse(span.output_summary, span.output_summary || null),
        details: safeJsonParse(span.details, span.details || null),
        input_summary: undefined,
        output_summary: undefined
    }));
    const typeCounts = {};
    spans.forEach(span => { typeCounts[span.span_type] = (typeCounts[span.span_type] || 0) + 1; });
    return {
        trace: trace ? { ...trace, metadata: safeJsonParse(trace.metadata, {}) } : null,
        spans,
        summary: {
            spanCount: spans.length,
            errorCount: spans.filter(span => span.status === 'error').length,
            totalDurationMs: Number(trace?.duration_ms || 0),
            inputTokens: spans.reduce((sum, span) => sum + (Number(span.input_tokens) || 0), 0),
            outputTokens: spans.reduce((sum, span) => sum + (Number(span.output_tokens) || 0), 0),
            typeCounts
        }
    };
}

module.exports = {
    ensureAgentTrace,
    finishAgentTraceSpan,
    getAgentTraceForUser,
    recordAgentTraceSpan,
    redactTraceValue,
    serializeTraceValue,
    startAgentTraceSpan,
    syncAgentTraceFromRun
};
