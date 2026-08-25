const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { redactTraceValue } = require('./agent-traces');
const { putAgentBlob } = require('./agent-blob-store');

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value ?? {})).digest('hex'); }

async function recordAgentToolCall(data = {}) {
    if (!data.runId || !data.toolName) return null;
    const id = data.id || crypto.randomUUID();
    const input = redactTraceValue(data.input ?? {});
    const output = redactTraceValue(data.output ?? {});
    const outputBlob = await putAgentBlob(output, { runId: data.runId });
    const now = data.createdAt || getBeijingTimestamp();
    const sql = `
        INSERT INTO agent_tool_calls (
            id, run_id, step_id, tool_name, capability, risk_level, policy_decision,
            policy_version, approval_id, idempotent, input_payload, input_hash,
            output_payload_ref, output_hash, status, error_category, error_message,
            duration_ms, created_at, attempt, operation_key, context_hash
            ,tenant_id, tool_version, task_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        id,
        data.runId,
        String(data.stepId || id),
        String(data.toolName).slice(0, 128),
        String(data.capability || 'agent.execute').slice(0, 128),
        Number(data.riskLevel) || 0,
        String(data.policyDecision || 'allow').slice(0, 32),
        String(data.policyVersion || 'v1').slice(0, 32),
        data.approvalId || null,
        Boolean(data.idempotent),
        JSON.stringify(input || {}),
        data.inputHash || digest(input),
        data.outputPayloadRef || outputBlob.ref || null,
        data.outputHash || digest(output),
        String(data.status || 'success').slice(0, 32),
        String(data.errorCategory || '').slice(0, 32),
        String(data.errorMessage || '').slice(0, 2000),
        Math.max(Number(data.durationMs) || 0, 0),
        now,
        Math.max(Number(data.attempt) || 1, 1),
        data.operationKey || null,
        String(data.contextHash || '').slice(0, 64)
        ,data.tenantId || data.tenant_id || null
        ,String(data.toolVersion || data.tool_version || '').slice(0, 64)
        ,String(data.taskType || data.task_type || '').slice(0, 160)
    ];
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await execute(sql, params);
            lastError = null;
            break;
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError) {
        // Unit-level DAG execution and recovery probes may use an ephemeral run id.
        // Keep the audit side channel from masking the real tool outcome when the
        // durable run row is intentionally absent; production runs always have it.
        if (lastError.code === '23503' && String(lastError.constraint || '').includes('run_id')) {
            logger.warn({ runId: data.runId, toolName: data.toolName }, '工具审计跳过：运行记录不存在');
            return null;
        }
        lastError.code = lastError.code || 'AGENT_AUDIT_WRITE_FAILED';
        throw lastError;
    }
    if (String(data.status || '') === 'error' || String(data.status || '') === 'failed' || String(data.status || '') === 'denied') {
        try {
            const run = await queryOne('SELECT user_id FROM agent_runs WHERE id = ?', [data.runId]);
            if (run?.user_id) {
                const { createAgentInboxEvent } = require('./agent-inbox');
                await createAgentInboxEvent({ id: run.user_id }, { eventKey: `tool.error:${data.runId}:${data.toolName}:${data.inputHash || digest(input)}`, eventType: 'tool.error', sourceRunId: data.runId, sourceId: data.toolName, title: '工具调用异常', body: String(data.errorMessage || data.errorCategory || '工具调用失败').slice(0, 1000), risk: data.policyDecision === 'denied' ? 'high' : 'medium', payload: { tool: data.toolName, status: data.status, category: data.errorCategory || '' } });
            }
        } catch (_) {}
    }
    return id;
}

async function listAgentToolCalls(runId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    const rows = await query(`
        SELECT id, run_id, step_id, tool_name, capability, risk_level, policy_decision,
               policy_version, approval_id, idempotent, input_payload, input_hash,
               output_payload_ref, output_hash, status, error_category, error_message,
               duration_ms, created_at, context_hash
        FROM agent_tool_calls WHERE run_id = ? ORDER BY created_at ASC LIMIT ?
    `, [runId, limit]);
    return rows.map(row => {
        let input = {};
        try { input = JSON.parse(row.input_payload || '{}'); } catch (_) {}
        return { ...row, input_payload: input };
    });
}

module.exports = { digest, listAgentToolCalls, recordAgentToolCall };
