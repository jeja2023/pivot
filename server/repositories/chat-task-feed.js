'use strict';

const { query, queryOne } = require('../db/client');

// 对话只读取展示所需字段，避免反复加载聊天历史、工具结果和完整诊断。
async function getTaskSnapshot(runId, userId) {
    return queryOne(`
        SELECT r.id, r.user_id, r.session_id, r.title, r.status, r.final_answer, r.error_message,
               r.created_at, r.updated_at, r.started_at, r.completed_at, r.last_heartbeat_at,
               r.input_tokens, r.output_tokens, r.total_tokens, r.event_seq,
               COALESCE(cm.name, m.name, '') AS model_name,
               r.metadata->>'conversationTaskId' AS conversation_task_id,
               COALESCE(r.metadata->'chatBridge'->>'messageId',
                   (SELECT id::text FROM messages WHERE agent_run_id = r.id AND user_id = r.user_id
                       AND deleted_at IS NULL AND role = 'assistant' LIMIT 1)) AS message_id,
               r.metadata->'pendingApproval' AS pending_approval,
               jsonb_build_object('outcomeStatus', r.metadata->'taskVerification'->>'outcomeStatus',
                   'verifiedAt', r.metadata->'taskVerification'->>'verifiedAt',
                   'semanticVerification', r.metadata->'taskVerification'->'semanticVerification') AS legacy_verification,
               v.outcome_status AS verification_status,
               jsonb_build_object('outcomeStatus', v.outcome_status, 'verifiedAt', v.report->>'verifiedAt',
                   'semanticVerification', v.report->'semanticVerification') AS verification_report,
               EXISTS (SELECT 1 FROM agent_events e WHERE e.run_id = r.id) AS has_events,
               EXISTS (SELECT 1 FROM agent_events e WHERE e.run_id = r.id
                   AND e.event_type IN ('tool.requested', 'tool.started', 'tool.completed', 'tool.failed',
                       'tool.denied', 'tool.replayed', 'sandbox.denied', 'transaction.denied', 'transaction.effect_staged')) AS has_tool_events
        FROM agent_runs r
        LEFT JOIN models m ON m.id = r.model_id
        LEFT JOIN models cm ON cm.id = r.chosen_model_id
        LEFT JOIN agent_verifications v ON v.run_id = r.id AND v.user_id = r.user_id
        WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL
          AND (r.session_id IS NULL OR EXISTS (SELECT 1 FROM sessions s
              WHERE s.id = r.session_id AND s.user_id = r.user_id AND s.deleted_at IS NULL))
    `, [runId, userId]);
}

async function listTaskEvents(runId, userId, { after, before, highWater, limit, types }) {
    const forward = after !== undefined;
    const direction = forward ? 'ASC' : 'DESC';
    const boundary = forward ? 'AND event_seq > ?' : (before ? 'AND event_seq < ?' : '');
    const parameters = [runId, userId, highWater, ...types];
    if (forward || before) parameters.push(forward ? after : before);
    parameters.push(limit + 1);
    return query(`
        SELECT id, event_seq, event_type, step_index, payload, created_at
        FROM agent_events
        WHERE run_id = ? AND user_id = ? AND event_seq <= ?
          AND event_type IN (${types.map(() => '?').join(',')}) ${boundary}
        ORDER BY event_seq ${direction} LIMIT ?
    `, parameters);
}

async function listLegacySteps(runId, { beforeStep = 0, limit = 40 } = {}) {
    return query(`
        SELECT id, step_index, type, title, tool_name, status, duration_ms, completed_at, created_at
        FROM agent_steps WHERE run_id = ? AND (? = 0 OR id < ?)
        ORDER BY id DESC LIMIT ?
    `, [runId, beforeStep, beforeStep, limit + 1]);
}

async function listTaskArtifacts(runId, userId, tenantId, client = { query }) {
    return client.query(`
        SELECT a.id, a.title, a.type, COALESCE(av.version, a.version, 1) AS version, a.updated_at,
               ar.id AS rendition_id, ar.format, ar.mime_type, ar.byte_size, ar.status AS rendition_status,
               ar.expires_at, d.state AS delivery_state, d.updated_at AS delivery_updated_at
        FROM agent_artifacts a
        LEFT JOIN agent_artifact_versions av ON av.id::text = to_jsonb(a)->>'current_version_id' AND av.artifact_id = a.id
        LEFT JOIN LATERAL (SELECT id, format, mime_type, byte_size, status, expires_at
            FROM agent_artifact_renditions WHERE artifact_id::text = a.id::text AND created_by = ? AND tenant_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 8) ar ON TRUE
        LEFT JOIN LATERAL (SELECT state, updated_at FROM agent_artifact_delivery_intents
            WHERE rendition_id = ar.id AND requested_by = ? AND tenant_id = ? AND channel = 'local_device'
            ORDER BY updated_at DESC, id DESC LIMIT 1) d ON TRUE
        WHERE a.run_id = ? AND a.user_id::text = ?::text AND COALESCE(a.status, 'active') = 'active'
        ORDER BY a.updated_at DESC, a.id DESC, ar.id DESC LIMIT 40
    `, [userId, tenantId, userId, tenantId, runId, userId]);
}

module.exports = { getTaskSnapshot, listTaskEvents, listLegacySteps, listTaskArtifacts };
