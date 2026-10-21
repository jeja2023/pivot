const crypto = require('crypto');

function approvalInputHash(input) {
    return crypto.createHash('sha256').update(JSON.stringify(input ?? {})).digest('hex');
}

function assertApprovalBinding(pending = {}, expected = null, approve = true) {
    if (!pending.tool) throw Object.assign(new Error('授权请求已变化，请刷新任务后重新确认。'), { status: 409, code: 'AGENT_APPROVAL_STALE' });
    if (expected && (typeof expected.inputHash !== 'string' || expected.inputHash !== (pending.inputHash || approvalInputHash(pending.input || {}))
        || String(expected.key || '') !== String(pending.key || '')
        || String(expected.requestedAt || '') !== String(pending.requestedAt || ''))) {
        throw Object.assign(new Error('操作目标或参数已经变化，请查看最新请求后重新确认。'), { status: 409, code: 'AGENT_APPROVAL_STALE' });
    }
    const expiry = String(pending.expiresAt || '');
    const expiresAt = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(expiry) ? expiry : `${expiry.replace(' ', 'T')}+08:00`);
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
        const metadata = getRunMetadata(run);
        const hash = approvalInputHash(input);
        const grants = Array.isArray(metadata.approvalGrants) ? metadata.approvalGrants : [];
        const exactGrant = grants.find(grant => grant
            && grant.tool === toolName
            && (grant.rememberForRun === true || (String(grant.key || '') === String(approvalKey || '') && grant.inputHash === hash))
            && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()));
        return Boolean(exactGrant);
    }

    function shouldPauseForApproval(run, tool, approvalKey = '', input = {}) {
        if (!tool || isApprovalGranted(run, tool.name, approvalKey, input)) return false;
        if (tool.alwaysRequiresApproval) return true;
        if (tool.source !== 'mcp') return false;
        const policy = normalizeApprovalPolicy(run.approval_policy);
        if (policy === 'approve_all_mcp') return true;
        return Boolean(tool.requiresApproval || tool.risk === 'high');
    }

    async function maybePauseForApproval(run, tool, input, approvalKey = '') {
        const scopedKey = String(approvalKey || '').trim();
        if (!shouldPauseForApproval(run, tool, scopedKey, input)) return false;
        const user = { id: run.user_id };
        const review = await require('../chat-action-review').reviewChatAction({ run, tool, input, user });
        if (review.allowed) {
            const { updateAgentRunMetadataWithRetry } = require('../agent-run-metadata-patch');
            const grant = { tool: tool.name, key: scopedKey, inputHash: approvalInputHash(input), expiresAt: getTimestamp(new Date(Date.now() + 2 * 60 * 1000)), source: 'independent_readonly_review', reviewer: review.reviewer };
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
