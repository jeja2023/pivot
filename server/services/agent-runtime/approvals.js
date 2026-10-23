const { evaluateToolPolicy } = require('../agent-policy');
const { approvalInputHash, approvalExpiryMs, findApprovalGrant, resolveApprovalKey } = require('../agent-approval-grants');

function assertApprovalBinding(pending = {}, expected = null, approve = true) {
    if (!pending.tool) throw Object.assign(new Error('授权请求已变化，请刷新任务后重新确认。'), { status: 409, code: 'AGENT_APPROVAL_STALE' });
    if (expected && (typeof expected.inputHash !== 'string' || expected.inputHash !== (pending.inputHash || approvalInputHash(pending.input || {}))
        || String(expected.key || '') !== String(pending.key || '')
        || String(expected.requestedAt || '') !== String(pending.requestedAt || ''))) {
        throw Object.assign(new Error('操作目标或参数已经变化，请查看最新请求后重新确认。'), { status: 409, code: 'AGENT_APPROVAL_STALE' });
    }
    const expiry = String(pending.expiresAt || '');
    const expiresAt = approvalExpiryMs(expiry);
    if (approve && expiry && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
        throw Object.assign(new Error('本次授权请求已过期，请刷新任务后重新确认。'), { status: 409, code: 'AGENT_APPROVAL_EXPIRED' });
    }
}

function createApprovalHelpers({
    getRunMetadata,
    normalizeApprovalPolicy,
    getTimestamp,
    setRunMetadata,
    updateRun,
    insertStep,
    listSteps,
    createAgentNotification,
    recordAgentEvent = null
}) {
    function isApprovalGranted(run, toolName, approvalKey = '', input = {}) {
        return Boolean(findApprovalGrant({ ...run, metadata: getRunMetadata(run) }, toolName, approvalKey, input));
    }

    function shouldPauseForApproval(run, tool, approvalKey = '', input = {}) {
        if (!tool || isApprovalGranted(run, tool.name, approvalKey, input)) return false;
        const approvalPolicy = normalizeApprovalPolicy ? normalizeApprovalPolicy(run.approval_policy || run.approvalPolicy) : run.approval_policy;
        return evaluateToolPolicy({ run: { ...run, approval_policy: approvalPolicy }, tool, input, user: { id: run.user_id } }).decision === 'require_approval';
    }

    async function maybePauseForApproval(run, tool, input, approvalKey = '') {
        const scopedKey = resolveApprovalKey(run, tool.name, input, String(approvalKey || '').trim());
        if (!shouldPauseForApproval(run, tool, scopedKey, input)) return false;
        const user = { id: run.user_id };
        const review = await require('../chat-action-review').reviewChatAction({ run, tool, input, user });
        if (review.allowed) {
            const { updateAgentRunMetadataWithRetry } = require('../agent-run-metadata-patch');
            const grant = { tool: tool.name, key: scopedKey, inputHash: approvalInputHash(input), hashVersion: 2, expiresAt: getTimestamp(new Date(Date.now() + 2 * 60 * 1000)), source: 'independent_readonly_review', reviewer: review.reviewer };
            const nextMetadata = await updateAgentRunMetadataWithRetry(run.id, current => ({ ...current, approvalGrants: [...(current.approvalGrants || []), grant].slice(-100) }), { userId: run.user_id });
            run.metadata = nextMetadata;
            await recordAgentEvent?.({ runId: run.id, userId: run.user_id, type: 'approval.auto_reviewed', payload: { tool: tool.name, key: scopedKey, inputHash: grant.inputHash, reviewer: review.reviewer }, eventKey: `auto-review:${scopedKey}:${grant.inputHash}` });
            return false;
        }
        const now = getTimestamp();
        await setRunMetadata(run.id, {
            pendingApproval: {
                tool: tool.name,
                key: scopedKey,
                title: tool.title || tool.name,
                requestedAt: now,
                expiresAt: getTimestamp(new Date(Date.now() + 15 * 60 * 1000)),
                inputHash: approvalInputHash(input),
                hashVersion: 2,
                input
            }
        });
        await updateRun(run.id, {
            status: 'approval_required',
            error_message: `工具需要审批：${tool.title || tool.name}`,
            updated_at: now,
            last_heartbeat_at: now
        });
        const steps = await listSteps(run.id);
        await insertStep(run.id, (steps || []).length + 1, {
            type: 'approval',
            title: `等待工具审批：${tool.title || tool.name}`,
            toolName: tool.name,
            input,
            output: { status: 'approval_required', tool: tool.name, key: scopedKey }
        });
        try {
            await recordAgentEvent?.({
                runId: run.id,
                userId: run.user_id,
                type: 'approval.requested',
                payload: {
                    tool: tool.name,
                    key: scopedKey,
                    inputHash: approvalInputHash(input),
                    riskLevel: Number(tool.risk_level || tool.riskLevel || 0) || 0
                },
                eventKey: `approval:${scopedKey}:${approvalInputHash(input)}`
            });
        } catch (_) {}
        await createAgentNotification(run.user_id, run.id, 'approval', '任务需要审批', tool.title || tool.name);
        return true;
    }

    return { approvalInputHash, isApprovalGranted, shouldPauseForApproval, maybePauseForApproval };
}

module.exports = { approvalInputHash, assertApprovalBinding, createApprovalHelpers };
