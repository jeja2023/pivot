'use strict';

function createApprovalRevocation({
    getRunForUser,
    getRunMetadata,
    updateRunCas,
    setRunMetadata,
    insertStep,
    listSteps,
    recordAgentEvent,
    createAgentNotification,
    getAgentRunTitle,
    getTimestamp
} = {}) {
    async function revokeApprovedAgentTool(runId, user, approvalKey = '') {
        const run = await getRunForUser(runId, user);
        if (!run) return null;
        if (run.status !== 'queued') {
            const error = new Error('只有尚未被执行器领取的已批准任务可以撤销授权。');
            error.code = 'AGENT_APPROVAL_REVOCATION_TOO_LATE';
            error.status = 409;
            throw error;
        }
        const key = String(approvalKey || '').trim();
        if (!key) {
            const error = new Error('撤销审批需要明确的审批键。');
            error.code = 'AGENT_APPROVAL_KEY_REQUIRED';
            error.status = 400;
            throw error;
        }
        const metadata = getRunMetadata(run);
        const grants = Array.isArray(metadata.approvalGrants) ? metadata.approvalGrants : [];
        const revoked = grants.find(item => item && String(item.key || '') === key && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
        if (!revoked) {
            const error = new Error('指定审批不存在、已过期或已撤销。');
            error.code = 'AGENT_APPROVAL_GRANT_NOT_ACTIVE';
            error.status = 409;
            throw error;
        }
        const now = getTimestamp();
        const changed = await updateRunCas(runId, ['queued'], {
            status: 'needs_input',
            error_message: '用户已撤销尚未执行的工具授权；重新继续任务时必须再次审批。',
            updated_at: now,
            last_heartbeat_at: now
        });
        if (!changed) {
            const error = new Error('任务已被执行器领取，不能安全撤销该审批。');
            error.code = 'AGENT_APPROVAL_REVOCATION_RACED';
            error.status = 409;
            throw error;
        }
        await setRunMetadata(runId, {
            approvalGrants: grants.filter(item => String(item?.key || '') !== key),
            pendingApproval: null,
            revokedApproval: { key, tool: String(revoked.tool || ''), inputHash: String(revoked.inputHash || ''), revokedAt: now }
        });
        await insertStep(runId, (await listSteps(runId)).length + 1, {
            type: 'approval', title: 'User revoked approved tool call', toolName: String(revoked.tool || ''),
            output: { status: 'revoked', key, inputHash: String(revoked.inputHash || '') }
        });
        try {
            await recordAgentEvent({ runId, userId: user.id, type: 'approval.revoked', payload: { tool: String(revoked.tool || ''), key, inputHash: String(revoked.inputHash || '') }, eventKey: `approval:${key}:revoked:${String(revoked.inputHash || '')}` });
        } catch (_) {}
        await createAgentNotification(user.id, runId, 'warning', '工具授权已撤销', getAgentRunTitle(run));
        return await getRunForUser(runId, user);
    }

    return { revokeApprovedAgentTool };
}

module.exports = { createApprovalRevocation };
