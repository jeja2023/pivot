'use strict';

const DEFAULT_IDLE_DAYS = 7;
const MESSAGE = '任务等待补充信息已超过保留时间，已结束本次等待；已有结果会保留，如需继续可续跑任务。';

function idleDays(env = process.env) {
    const raw = String(env.AGENT_CHAT_INPUT_IDLE_DAYS ?? '').trim();
    if (!raw) return DEFAULT_IDLE_DAYS;
    if (!/^\d+$/.test(raw)) return DEFAULT_IDLE_DAYS;
    return Math.min(Number(raw), 365);
}

async function expireIdleChatTasks({ query, publishAgentRunEvent, recordAgentEvent, finalizeTerminalRun, logger, env = process.env } = {}) {
    const days = idleDays(env);
    if (!days) return 0;
    // 单条条件更新保障与继续、补充信息及多节点巡检竞争时只有一个执行者生效。
    const rows = await query(`
        UPDATE agent_runs r SET status = CASE WHEN COALESCE(r.final_answer, '') <> '' THEN 'partial' ELSE 'error' END,
            error_message = ?, completed_at = NOW(), updated_at = NOW(),
            metadata = COALESCE(r.metadata, '{}'::jsonb) || jsonb_build_object('chatInputExpired', true, 'chatInputPreviousError', COALESCE(r.error_message, ''))
        WHERE r.id IN (
            SELECT candidate.id FROM agent_runs candidate
            WHERE candidate.status = 'needs_input' AND candidate.deleted_at IS NULL
              AND candidate.session_id IS NOT NULL AND candidate.schedule_id IS NULL
              AND candidate.metadata->'chatBridge' IS NOT NULL
              AND COALESCE(candidate.error_message, '') <> '智能体运行已由用户暂停，可从安全检查点续跑。'
              AND candidate.updated_at < NOW() - (? * INTERVAL '1 day')
              AND NOT EXISTS (SELECT 1 FROM agent_task_transactions t WHERE t.run_id = candidate.id AND t.status IN ('awaiting_commit', 'compensating'))
              AND NOT EXISTS (SELECT 1 FROM agent_task_effects e WHERE e.run_id = candidate.id)
              AND NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.run_id = candidate.id AND c.status = 'pending' AND c.idempotent = FALSE)
              AND NOT EXISTS (SELECT 1 FROM agent_control_messages m WHERE m.to_run_id = candidate.id AND m.status IN ('pending', 'claimed', 'delivered'))
            ORDER BY candidate.updated_at ASC LIMIT 100 FOR UPDATE SKIP LOCKED
        ) AND r.status = 'needs_input' AND r.updated_at < NOW() - (? * INTERVAL '1 day')
        RETURNING r.id, r.status
    `, [MESSAGE, days, days]);
    for (const row of rows) {
        try {
            await publishAgentRunEvent(row.id, 'updated');
            await recordAgentEvent({ runId: row.id, type: 'run.completed', payload: { from: 'needs_input', to: row.status, reason: 'input_idle_timeout' }, eventKey: 'status:input-idle-timeout' });
        } catch (error) { logger?.warn?.({ runId: row.id, err: error.message }, '等待超时状态通知写入失败'); }
        try { await finalizeTerminalRun(row.id, row.status); }
        catch (error) { logger?.warn?.({ runId: row.id, err: error.message }, '等待超时任务收尾失败'); }
    }
    return rows.length;
}

module.exports = { idleDays, expireIdleChatTasks, MESSAGE };
