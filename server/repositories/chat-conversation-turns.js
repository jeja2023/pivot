'use strict';

const crypto = require('crypto');
const { transaction, query, queryOne, execute } = require('../db/client');
const { estimateTokens, getStoredMessageContextTokens } = require('../llm');

const parseTurnDecision = value => typeof value === 'string' ? JSON.parse(value) : value || {};

function decisionAudit(value = {}) {
    const keys = ['version','action','intent','nextAction','reasonCode','requiredCapabilities','evidenceRefs','confidence','continuationOf','conversationTaskId','decisionId','learningDecisionId','durationMs','modelId','modelCalls','policyVersion','shadow','projectId'];
    return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

async function claimTurn({ userId, sessionId, requestKey, inputHash, content, modelId }) {
    return transaction(async trx => {
        // 会话锁使消息落库与幂等认领原子化；服务进程重启后仍只保留一条用户消息。
        const session = await trx.queryOne('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE', [sessionId, userId]);
        if (!session) throw Object.assign(new Error('会话不存在或无权访问。'), { code: 'FORBIDDEN' });
        const id = `ct_${crypto.randomUUID()}`;
        const token = `ctl_${crypto.randomUUID()}`;
        await trx.execute(`INSERT INTO chat_conversation_turns (id,user_id,session_id,request_key,input_hash) VALUES (?,?,?,?,?) ON CONFLICT(user_id,session_id,request_key) DO NOTHING`, [id, userId, sessionId, requestKey, inputHash]);
        const row = await trx.queryOne(`SELECT t.*, (SELECT m.id FROM messages m WHERE m.conversation_turn_id = t.id AND m.role = 'assistant' AND m.user_id = t.user_id AND m.deleted_at IS NULL LIMIT 1) AS persisted_assistant_id
            FROM chat_conversation_turns t WHERE user_id = ? AND session_id = ? AND request_key = ? FOR UPDATE`, [userId, sessionId, requestKey]);
        if (row.input_hash !== inputHash) throw Object.assign(new Error('同一请求标识不能用于不同内容，请重新发送。'), { code: 'CHAT_REQUEST_CONFLICT' });
        if (row.run_id || row.assistant_message_id || row.persisted_assistant_id) return { ...row, assistant_message_id: row.assistant_message_id || row.persisted_assistant_id, replay: true };
        if (row.lease_until && Date.parse(row.lease_until) > Date.now()) return { ...row, busy: true };
        let messageId = row.user_message_id;
        if (!messageId) {
            const tokenCount = estimateTokens(content);
            const contextTokenCount = getStoredMessageContextTokens({ role: 'user', content, token_count: tokenCount });
            const message = await trx.queryOne(`INSERT INTO messages (session_id,user_id,role,content,token_count,context_token_count,model_id,created_at) VALUES (?,?,'user',?,?,?,?,NOW()) RETURNING id`, [sessionId, userId, content, tokenCount, contextTokenCount, modelId]);
            messageId = message.id;
        }
        await trx.execute(`UPDATE chat_conversation_turns SET user_message_id = ?, status = 'processing', lease_token = ?, lease_until = NOW() + INTERVAL '2 minutes', updated_at = NOW() WHERE id = ?`, [messageId, token, row.id]);
        return { ...row, user_message_id: messageId, lease_token: token, decision: parseTurnDecision(row.decision) };
    });
}

async function updateTurn(turn, patch = {}) {
    if (!turn?.id || !turn.lease_token) return;
    const allowed = ['assistant_message_id', 'run_id', 'conversation_task_id', 'decision', 'outcome', 'status'];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key)).map(([key, value]) => [key, key === 'decision' ? decisionAudit(value) : value]);
    if (!entries.length) return;
    const sets = entries.map(([key]) => `${key} = ?${['decision', 'outcome'].includes(key) ? '::jsonb' : ''}`);
    const changed = await execute(`UPDATE chat_conversation_turns SET ${sets.join(',')}, updated_at = NOW() WHERE id = ? AND user_id = ? AND lease_token = ?`, [...entries.map(([key, value]) => ['decision', 'outcome'].includes(key) ? JSON.stringify(value) : value), turn.id, turn.user_id, turn.lease_token]);
    if (changed) Object.assign(turn, patch);
    return changed;
}

async function releaseTurn(turn) {
    if (!turn?.lease_token) return;
    return execute(`UPDATE chat_conversation_turns SET lease_until = NOW(), lease_token = NULL, status = CASE WHEN status = 'processing' THEN 'interrupted' ELSE status END WHERE id = ? AND user_id = ? AND lease_token = ?`, [turn.id, turn.user_id, turn.lease_token]);
}

async function renewTurn(turn) {
    return execute(`UPDATE chat_conversation_turns SET lease_until = NOW() + INTERVAL '2 minutes' WHERE id = ? AND user_id = ? AND lease_token = ?`, [turn.id, turn.user_id, turn.lease_token]);
}

async function replayTurn(turn) {
    return turn.assistant_message_id ? queryOne('SELECT id,content FROM messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [turn.assistant_message_id, turn.user_id]) : null;
}

async function listSessionTasks(sessionId, userId) {
    return query(`SELECT r.* FROM agent_runs r WHERE r.session_id = ? AND r.user_id = ? AND r.deleted_at IS NULL AND r.metadata->'chatBridge' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_runs c WHERE c.parent_run_id = r.id AND c.user_id = r.user_id AND c.deleted_at IS NULL AND c.metadata->>'resumedFromRunId' = r.id)
        ORDER BY r.created_at DESC LIMIT 12`, [sessionId, userId]);
}

async function findTaskContinuation(runId, userId) {
    return queryOne(`SELECT * FROM agent_runs WHERE parent_run_id = ? AND user_id = ? AND deleted_at IS NULL
        AND metadata->>'resumedFromRunId' = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [runId, userId, runId]);
}

async function requeueWaitingTask(runId, userId, resumeFromStep = 0) {
    // 只续接等待输入的同一运行；终态和审批边界不能被改写成新执行。
    return execute(`UPDATE agent_runs SET status = 'queued', error_message = '', resume_from_step = GREATEST(COALESCE(resume_from_step,0),?), updated_at = NOW() WHERE id = ? AND user_id = ? AND status = 'needs_input' AND deleted_at IS NULL`, [resumeFromStep, runId, userId]);
}

async function recordRunOutcome(runId, outcome) {
    return execute(`UPDATE chat_conversation_turns t SET outcome = outcome || ?::jsonb, status = 'completed',
        assistant_message_id = COALESCE(t.assistant_message_id,(SELECT m.id FROM messages m WHERE m.agent_run_id = t.run_id AND m.user_id = t.user_id AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1)),
        updated_at = NOW() WHERE run_id = ? AND decision->>'action' = 'agent_run'`, [JSON.stringify(outcome), runId]);
}

async function readyRunArtifacts(runId, userId) {
    return query(`SELECT a.title, d.id, d.format, d.tenant_id, d.content_digest, d.storage_ref FROM agent_artifact_renditions d
        JOIN agent_artifacts a ON a.id = d.artifact_id WHERE d.run_id = ? AND a.user_id = ? AND d.status = 'ready'
          AND (d.expires_at IS NULL OR d.expires_at > NOW())`, [runId, userId]);
}

async function currentExecutionScope(runId, userId) {
    const row = await queryOne(`SELECT r.status,r.metadata,r.tool_policy,r.tool_allowlist,r.network_policy, CASE WHEN r.metadata->'chatBridge' IS NULL THEN TRUE ELSE EXISTS (
        SELECT 1 FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id::text = r.metadata->'chatBridge'->>'userMessageId'
            AND m.user_id = r.user_id AND m.session_id = r.session_id AND m.deleted_at IS NULL AND s.deleted_at IS NULL
    ) END AS source_active FROM agent_runs r WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL`, [runId, userId]);
    if (row) {
        row.tool_allowlist = typeof row.tool_allowlist === 'string' ? JSON.parse(row.tool_allowlist) : row.tool_allowlist || [];
        row.network_policy = parseTurnDecision(row.network_policy);
    }
    return row;
}

async function readTaskSource(runId, userId, messageId = null) {
    const run = await queryOne(`SELECT r.session_id,r.metadata FROM agent_runs r
        JOIN sessions s ON s.id = r.session_id AND s.deleted_at IS NULL
        WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL`, [runId, userId]);
    if (!run) return null;

    let metadata = run.metadata || {};
    if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch (_) { metadata = {}; }
    }
    const originalMessageId = String(metadata.chatBridge?.userMessageId || '');
    if (!/^\d+$/.test(originalMessageId)) return null;
    const requestedMessageId = messageId === null || messageId === undefined ? '' : String(messageId);
    const allowedMessageIds = new Set([
        originalMessageId,
        ...(Array.isArray(metadata.conversationMessageIds) ? metadata.conversationMessageIds.map(String) : [])
    ]);
    const requestedIsAllowed = /^\d+$/.test(requestedMessageId) && allowedMessageIds.has(requestedMessageId);
    const resolvedMessageId = requestedIsAllowed ? requestedMessageId : originalMessageId;
    const source = await queryOne(`SELECT m.id,m.content FROM agent_runs r
        JOIN messages m ON m.id::text = ?::text
        JOIN sessions s ON s.id = r.session_id
        WHERE r.id = ? AND r.user_id = ? AND m.user_id = r.user_id
          AND m.session_id = r.session_id AND r.deleted_at IS NULL AND m.deleted_at IS NULL AND s.deleted_at IS NULL
          AND (m.id::text = r.metadata->'chatBridge'->>'userMessageId' OR COALESCE(r.metadata->'conversationMessageIds','[]'::jsonb) @> to_jsonb(ARRAY[m.id]))`, [resolvedMessageId, runId, userId]);
    return source ? { ...source, requestedMessageId: requestedMessageId || null, requestedMessageFallback: Boolean(requestedMessageId && !requestedIsAllowed) } : null;
}

async function getExecutionMetrics(userId, { admin = false, days = 30 } = {}) {
    return query(`SELECT decision->>'action' AS action, decision->>'policyVersion' AS policy_version, decision->>'reasonCode' AS reason,
        COUNT(*)::integer AS count, AVG(COALESCE((decision->>'durationMs')::numeric,0)) AS avg_route_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (outcome->>'firstContentMs')::numeric) AS p95_first_content_ms,
        SUM(COALESCE((outcome->>'routerModelCalls')::integer,0))::integer AS router_model_calls,
        SUM(COALESCE((outcome->>'totalTokens')::bigint,0)) AS total_tokens,
        COUNT(*) FILTER (WHERE outcome->>'verified' = 'true')::integer AS verified,
        COUNT(*) FILTER (WHERE outcome->>'status' IN ('error','failed','partial'))::integer AS failures,
        COUNT(*) FILTER (WHERE outcome->>'learnedSkillAuto' = 'true')::integer AS experience_reuse,
        COUNT(*) FILTER (WHERE outcome->>'correction' = 'true')::integer AS corrections
        ,COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM decision_outcomes o WHERE o.decision_id = t.decision->>'decisionId' AND o.event_type = 'verification' AND o.is_verified = TRUE AND o.verified_action_id <> t.decision->>'action'))::integer AS verified_route_mismatches
        ,COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM decision_outcomes o WHERE o.decision_id = t.decision->>'decisionId' AND o.event_type = 'verification' AND o.is_verified = TRUE))::integer AS reviewed_routes
        FROM chat_conversation_turns t WHERE (?::boolean OR user_id = ?) AND created_at >= NOW() - (?::integer * INTERVAL '1 day')
        GROUP BY 1,2,3 ORDER BY 1,2,3`, [admin, userId, Math.max(1, Math.min(Number(days) || 30, 90))]);
}

module.exports = { claimTurn, updateTurn, releaseTurn, renewTurn, replayTurn, listSessionTasks, findTaskContinuation, requeueWaitingTask, recordRunOutcome, readyRunArtifacts, currentExecutionScope, readTaskSource, getExecutionMetrics };
