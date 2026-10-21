'use strict';

const { assertApprovalBinding } = require('./approvals');

function createApprovalRefresh({ getRunForUser, getRunMetadata, updateRunCas, getTimestamp, recordAgentEvent }) {
    return async function refreshAgentToolApproval(runId, user, expected) {
        const run = await getRunForUser(runId, user);
        if (!run) return null;
        if (run.status !== 'approval_required') return run;
        const pending = getRunMetadata(run).pendingApproval || {};
        assertApprovalBinding(pending, expected, false);
        const now = getTimestamp();
        const renewed = { ...pending, requestedAt: now, expiresAt: getTimestamp(new Date(Date.now() + 15 * 60 * 1000)) };
        const changed = await updateRunCas(runId, ['approval_required'], {
            metadata: JSON.stringify({ pendingApproval: renewed }), updated_at: now
        }, { mergeMetadata: true, approvalBinding: pending });
        if (!changed) throw Object.assign(new Error('授权请求已变化，请查看最新请求。'), { status: 409, code: 'AGENT_APPROVAL_STALE' });
        try {
            await recordAgentEvent({ runId, userId: user.id, type: 'approval.requested',
                payload: { tool: pending.tool, key: pending.key || '', inputHash: pending.inputHash, renewed: true },
                eventKey: `approval:renewed:${pending.inputHash}:${renewed.expiresAt}` });
        } catch (_) {
            // 请求已持久化，事件旁路失败不应把有效的新请求显示为失败。
        }
        return getRunForUser(runId, user);
    };
}

module.exports = { createApprovalRefresh };
