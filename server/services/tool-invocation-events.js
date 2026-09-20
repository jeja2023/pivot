'use strict';

const crypto = require('crypto');
const { execute, query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { redactSecrets } = require('../security');

function hash(value) {
    let text = '';
    try { text = JSON.stringify(redactSecrets(value ?? {})); } catch (_) { text = String(value ?? ''); }
    return crypto.createHash('sha256').update(text).digest('hex');
}

function newEventId() {
    return `tinv_${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizedReasonCodes(value) {
    return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))].slice(0, 30);
}

function errorClass(error) {
    if (!error) return '';
    if (error.code === 'AGENT_APPROVAL_REQUIRED') return 'approval';
    if (error.status === 401 || error.status === 403) return 'authorization';
    if (error.status === 429 || error.code === 'RATE_LIMITED') return 'rate_limit';
    if (/timeout/i.test(String(error.code || error.message || ''))) return 'timeout';
    if (/schema|input/i.test(String(error.code || error.message || ''))) return 'validation';
    if (/network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(String(error.code || error.message || ''))) return 'network';
    return 'execution';
}

async function recordToolInvocationEvent(data = {}, deps = {}) {
    const write = deps.execute || execute;
    const now = deps.getBeijingTimestamp || getBeijingTimestamp;
    const id = String(data.id || newEventId()).slice(0, 80);
    const input = data.input ?? {};
    const output = data.output ?? {};
    const error = data.error || null;
    const startedAt = Number(data.startedAt || 0);
    const totalMs = Math.max(Number(data.totalMs) || (startedAt ? Date.now() - startedAt : 0), 0);
    const status = String(data.status || (error ? 'error' : 'success')).slice(0, 32);
    try {
        await write(`
            INSERT INTO tool_invocation_events (
                id, trace_id, span_id, parent_span_id, run_id, step_id, session_id, tenant_id, actor_id,
                tool_item_id, release_id, server_id, connection_account_id, tool_name, definition_digest,
                policy_decision, policy_reason_codes, approval_id, source, request_digest, input_ref, output_ref,
                output_digest, attempt, queue_ms, network_ms, execution_ms, total_ms, status, error_class,
                error_code, retryable, cancelled, input_tokens, output_tokens, estimated_cost, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            String(data.traceId || data.trace_id || '').slice(0, 128),
            String(data.spanId || data.span_id || '').slice(0, 128),
            String(data.parentSpanId || data.parent_span_id || '').slice(0, 128),
            data.runId || data.run_id || null,
            String(data.stepId || data.step_id || '').slice(0, 128),
            String(data.sessionId || data.session_id || '').slice(0, 128),
            data.tenantId || data.tenant_id || null,
            data.actorId || data.actor_id || data.user?.id || null,
            data.toolItemId || data.tool_item_id || null,
            data.releaseId || data.release_id || null,
            data.serverId || data.server_id || null,
            data.connectionAccountId || data.connection_account_id || null,
            String(data.toolName || data.tool_name || '').slice(0, 320),
            String(data.definitionDigest || data.definition_digest || '').slice(0, 128),
            String(data.policyDecision || data.policy_decision || (error ? 'denied' : 'allow')).slice(0, 32),
            JSON.stringify(normalizedReasonCodes(data.reasonCodes || data.reason_codes)),
            String(data.approvalId || data.approval_id || '').slice(0, 128),
            String(data.source || 'unknown').slice(0, 64),
            String(data.requestDigest || data.request_digest || hash(input)).slice(0, 128),
            String(data.inputRef || data.input_ref || '').slice(0, 4000),
            String(data.outputRef || data.output_ref || '').slice(0, 4000),
            String(data.outputDigest || data.output_digest || hash(output)).slice(0, 128),
            Math.max(Number(data.attempt) || 1, 1),
            Math.max(Number(data.queueMs || data.queue_ms) || 0, 0),
            Math.max(Number(data.networkMs || data.network_ms) || 0, 0),
            Math.max(Number(data.executionMs || data.execution_ms) || totalMs, 0),
            totalMs,
            status,
            String(data.errorClass || data.error_class || errorClass(error)).slice(0, 64),
            String(data.errorCode || data.error_code || error?.code || '').slice(0, 128),
            Boolean(data.retryable),
            Boolean(data.cancelled),
            Math.max(Number(data.inputTokens || data.input_tokens) || 0, 0),
            Math.max(Number(data.outputTokens || data.output_tokens) || 0, 0),
            Math.max(Number(data.estimatedCost || data.estimated_cost) || 0, 0),
            now()
        ]);
        return id;
    } catch (recordError) {
        // Observability cannot make a user-visible tool invocation fail. The
        // primary Agent ledger remains available as a second audit channel.
        return null;
    }
}

async function listToolInvocationEventsForUser(user, options = {}, deps = {}) {
    const read = deps.query || query;
    const limit = Math.min(Math.max(Number(options.limit) || 60, 1), 500);
    const rows = await read(`
        SELECT * FROM tool_invocation_events
        WHERE actor_id = ?
        ORDER BY created_at DESC LIMIT ?
    `, [user?.id || 0, limit]);
    return rows.map(row => ({ ...row, policy_reason_codes: row.policy_reason_codes || [] }));
}

async function getToolInvocationEventForUser(id, user, deps = {}) {
    const readOne = deps.queryOne || queryOne;
    return await readOne('SELECT * FROM tool_invocation_events WHERE id = ? AND actor_id = ?', [id, user?.id || 0]);
}

module.exports = {
    listToolInvocationEventsForUser,
    getToolInvocationEventForUser,
    recordToolInvocationEvent
};
