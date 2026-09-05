function createRunState(deps = {}) {
const {
    crypto,
    queryOne,
    execute,
    logger,
    getBeijingTimestamp,
    getAgentRunTitle,
    getRunMetadata,
    assertAgentRunStatusTransition,
    canTransitionAgentRunStatus,
    TERMINAL_STATUSES,
    releaseChildRunReservation,
    persistAgentRunChatResult,
    recordAgentRunOutcome,
    recordAgentEvent,
    publishUserEvent,
    parseJsonObject
} = deps;

async function updateRun(runId, fields = {}, maxRetries = 3) {
    const allowed = [
        'status', 'final_answer', 'error_message', 'completed_at', 'updated_at', 'title',
        'cancelled_at', 'deleted_at', 'deleted_by_user', 'delete_reason', 'started_at',
        'last_heartbeat_at', 'priority', 'run_mode', 'tool_policy', 'tool_allowlist',
        'approval_policy', 'timeout_ms', 'tool_timeout_ms', 'retry_limit', 'retry_count',
        'max_token_budget', 'export_count', 'template_id', 'schedule_id', 'context_config',
        'resume_from_step', 'metadata', 'locked_by', 'lock_expires_at',
        'input_tokens', 'output_tokens', 'total_tokens', 'budget_config', 'usage_stats', 'network_policy'
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return 0;
    const statusEntry = entries.find(([key]) => key === 'status');
    const targetStatus = statusEntry ? statusEntry[1] : null;
    const finalAnswerEntry = entries.find(([key]) => key === 'final_answer');
    if (finalAnswerEntry && typeof finalAnswerEntry[1] === 'string' && !finalAnswerEntry[1].startsWith('已使用个人经验：')) {
        const metadataRow = await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId]);
        const metadata = getRunMetadata(metadataRow || {});
        if (metadata.learnedSkillAuto === true && String(metadata.skillTitle || '').trim()) {
            finalAnswerEntry[1] = `已使用个人经验：${String(metadata.skillTitle).trim().slice(0, 120)}\n\n${finalAnswerEntry[1]}`;
        }
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        let currentStatus = '';
        if (statusEntry) {
            const row = await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
            currentStatus = row?.status || '';
            assertAgentRunStatusTransition(currentStatus, targetStatus, { runId });
        }
        const set = entries.map(([key]) => `${key} = ?`).join(', ');
        const where = statusEntry ? 'WHERE id = ? AND status = ?' : 'WHERE id = ?';
        const params = [...entries.map(([, value]) => value), runId];
        if (statusEntry) params.push(currentStatus);
        const changes = await execute(`UPDATE agent_runs SET ${set} ${where}`, params);
        if (changes > 0) {
            if (entries.some(([key]) => [
                'status',
                'final_answer',
                'error_message',
                'completed_at',
                'cancelled_at',
                'deleted_at',
                'last_heartbeat_at'
            ].includes(key))) {
                await publishAgentRunEvent(runId, 'updated');
            }
            if (statusEntry) {
                try {
                    await recordAgentEvent({
                        runId,
                        type: ['approval_required', 'waiting_approval', 'awaiting_approval'].includes(targetStatus)
                            ? 'run.paused'
                            : ['resuming'].includes(targetStatus)
                                ? 'run.resumed'
                                : ['completed', 'completed_with_errors', 'error', 'failed', 'cancelled'].includes(targetStatus)
                                    ? 'run.completed'
                                    : 'run.status_changed',
                        payload: { from: currentStatus, to: targetStatus },
                        eventKey: `status:${currentStatus}->${targetStatus}`
                    });
                } catch (eventError) {
                    logger.warn({ runId, err: eventError.message }, 'Agent 状态事件写入失败');
                }
                if (TERMINAL_STATUSES.has(targetStatus)) {
                    try { await releaseChildRunReservation(runId); } catch (resourceError) {
                        logger.warn({ runId, err: resourceError.message }, 'Agent 子运行资源预留释放失败');
                    }
                    try {
                        await persistAgentRunChatResult(runId);
                    } catch (chatBridgeError) {
                        logger.error({ runId, err: chatBridgeError.message }, 'Agent 聊天结果回写失败');
                    }
                    if (targetStatus !== 'deleted') {
                        try { await recordAgentRunOutcome(runId, targetStatus); } catch (feedbackError) {
                            logger.warn({ runId, err: feedbackError.message }, 'Agent 结果反馈基线写入失败');
                        }
                    }
                }
            }
            return changes;
        }
        if (!statusEntry) return 0;

        const row = await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
        const latestStatus = row?.status || '';
        if (latestStatus === targetStatus) {
            return 1;
        }
        if (!canTransitionAgentRunStatus(latestStatus, targetStatus)) {
            const error = new Error(`Agent run status changed concurrently: ${currentStatus || '<missing>'} -> ${latestStatus || '<missing>'}`);
            error.code = 'AGENT_STATUS_CONFLICT';
            error.runId = runId;
            throw error;
        }
    }
    return 0;
}

async function updateRunCas(runId, expectedStatuses = [], fields = {}) {
    const allowedStatuses = [...new Set((Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses])
        .map(value => String(value || '').trim())
        .filter(Boolean))];
    if (!allowedStatuses.length) return 0;
    const row = await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
    const currentStatus = row?.status || '';
    if (!allowedStatuses.includes(currentStatus)) return 0;
    if (fields.status) assertAgentRunStatusTransition(currentStatus, fields.status, { runId });
    const allowed = [
        'status', 'final_answer', 'error_message', 'completed_at', 'updated_at', 'title',
        'cancelled_at', 'deleted_at', 'deleted_by_user', 'delete_reason', 'started_at',
        'last_heartbeat_at', 'priority', 'run_mode', 'tool_policy', 'tool_allowlist',
        'approval_policy', 'timeout_ms', 'tool_timeout_ms', 'retry_limit', 'retry_count',
        'max_token_budget', 'export_count', 'template_id', 'schedule_id', 'context_config',
        'resume_from_step', 'metadata', 'locked_by', 'lock_expires_at',
        'input_tokens', 'output_tokens', 'total_tokens', 'budget_config', 'usage_stats', 'network_policy'
    ];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (!entries.length) return 0;
    const placeholders = allowedStatuses.map(() => '?').join(', ');
    const set = entries.map(([key]) => `${key} = ?`).join(', ');
    const changes = await execute(`UPDATE agent_runs SET ${set} WHERE id = ? AND status IN (${placeholders})`,
        [...entries.map(([, value]) => value), runId, ...allowedStatuses]);
    if (changes) await publishAgentRunEvent(runId, 'updated');
    return changes;
}

async function publishAgentRunEvent(runId, reason = 'updated', extra = {}) {
    const run = await queryOne(`
        SELECT id, user_id, title, goal, status, updated_at, started_at, completed_at, last_heartbeat_at, error_message
        FROM agent_runs
        WHERE id = ?
    `, [runId]);
    if (!run) return 0;
    return publishUserEvent(run.user_id, 'agent.run', {
        reason,
        run: {
            id: run.id,
            title: getAgentRunTitle(run),
            goal: run.goal,
            status: run.status,
            updated_at: run.updated_at,
            started_at: run.started_at,
            completed_at: run.completed_at,
            last_heartbeat_at: run.last_heartbeat_at,
            error_message: run.error_message
        },
        ...extra
    });
}

async function getRunStatus(runId) {
    const row = await queryOne('SELECT status FROM agent_runs WHERE id = ?', [runId]);
    return row?.status || '';
}

async function getRunUser(runId) {
    return await queryOne("SELECT u.id, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, u.unit, u.role FROM agent_runs r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND COALESCE(u.status, 'active') != 'disabled' AND u.deleted_at IS NULL", [runId]);
}

async function assertRunUserActive(user) {
    const active = await queryOne("SELECT id FROM users WHERE id = ? AND COALESCE(status, 'active') != 'disabled' AND deleted_at IS NULL", [user?.id]);
    if (!active) {
        const err = new Error('任务所属账号已被禁用或删除。');
        err.code = 'AGENT_USER_REVOKED';
        throw err;
    }
}

async function markRunError(runId, message) {
    await updateRun(runId, {
        status: 'error',
        error_message: message,
        completed_at: getBeijingTimestamp(),
        last_heartbeat_at: getBeijingTimestamp(),
        updated_at: getBeijingTimestamp()
    });
}

    async function setRunMetadata(runId, patch = {}) {
        const row = (await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId])) || {};
        const current = parseJsonObject(row.metadata) || {};
        await updateRun(runId, { metadata: JSON.stringify({ ...current, ...patch }), updated_at: getBeijingTimestamp() });
    }

    function stableWorkflowDelayKey(toolName, _step, input = {}) {
        const hash = crypto.createHash('sha256')
            .update(JSON.stringify(input || {}))
            .digest('hex')
            .slice(0, 16);
        return `${toolName}:standard:${hash}`;
    }

    async function appendRunMetadataList(runId, key, item, limit = 20) {
        const row = (await queryOne('SELECT metadata FROM agent_runs WHERE id = ?', [runId])) || {};
        const current = parseJsonObject(row.metadata) || {};
        const list = Array.isArray(current[key]) ? current[key].slice(-(limit - 1)) : [];
        list.push(item);
        await updateRun(runId, { metadata: JSON.stringify({ ...current, [key]: list }), updated_at: getBeijingTimestamp() });
    }

    async function recordRunRetryReason(runId, input = {}) {
        await appendRunMetadataList(runId, 'retryReasons', {
            at: getBeijingTimestamp(),
            attempt: input.attempt || null,
            limit: input.limit || null,
            code: input.code || '',
            reason: input.reason || input.error || 'unknown_error'
        });
    }

    return {
        appendRunMetadataList,
        assertRunUserActive,
        getRunStatus,
        getRunUser,
        markRunError,
        publishAgentRunEvent,
        recordRunRetryReason,
        setRunMetadata,
        stableWorkflowDelayKey,
        updateRun,
        updateRunCas
    };
}

module.exports = { createRunState };
