'use strict';

const { assertApprovalBinding } = require('./approvals');

// 审批决定先以参数绑定的比较更新认领，避免并发决定重复放行。
function createApprovalDecision({ getRunForUser, getRunMetadata, getBeijingTimestamp, updateRunCas,
    insertStep, listSteps, recordAgentEvent, createAgentNotification, getAgentRunTitle,
    approvalInputHash, buildAgentResumeContext, enqueueAgentRun }) {
    async function approveAgentTool(runId, user, approve = true, expected = null) {
        const run = await getRunForUser(runId, user);
        if (!run) return null;
        if (run.status !== 'approval_required') return run;
        const metadata = getRunMetadata(run);
        const pending = metadata.pendingApproval || {};
        assertApprovalBinding(pending, expected, approve);
        const now = getBeijingTimestamp();
        if (!approve) {
            const changed = await updateRunCas(runId, ['approval_required'], {
                status: 'cancelled',
                error_message: `用户拒绝工具审批：${pending.tool || '-'}`,
                cancelled_at: now,
                completed_at: now,
                updated_at: now,
                metadata: JSON.stringify({ pendingApproval: null })
            }, { mergeMetadata: true, approvalBinding: pending });
            if (!changed) {
                const current = await getRunForUser(runId, user);
                if (current?.status === 'approval_required') throw Object.assign(new Error('授权请求已变化，请查看最新操作后重新决定。'), { status: 409, code: 'AGENT_APPROVAL_STALE' });
                return current;
            }
            await insertStep(runId, (await listSteps(runId)).length + 1, {
                type: 'approval',
                title: '用户拒绝了本次操作授权',
                toolName: pending.tool || '',
                output: { status: 'rejected' }
            });
            try {
                await recordAgentEvent({
                    runId,
                    userId: user.id,
                    type: 'approval.rejected',
                    payload: { tool: pending.tool || '', key: pending.key || '' },
                    eventKey: `approval:${pending.key || pending.tool || 'unknown'}:rejected`
                });
            } catch (_) {}
            await createAgentNotification(user.id, runId, 'cancelled', '审批未通过', pending.tool || getAgentRunTitle(run));
            return await getRunForUser(runId, user);
        }
        const approvedTools = new Set(Array.isArray(metadata.approvedTools) ? metadata.approvedTools : []);
        const approvedApprovalKeys = new Set(Array.isArray(metadata.approvedApprovalKeys) ? metadata.approvedApprovalKeys : []);
        if (pending.key) approvedApprovalKeys.add(pending.key);
        else if (pending.tool) approvedTools.add(pending.tool);
        const rememberForRun = Boolean(expected?.rememberForRun);
        const approvalGrant = {
            tool: pending.tool || '',
            key: pending.key || '',
            inputHash: pending.inputHash || approvalInputHash(pending.input || {}),
            rememberForRun,
            grantedAt: now,
            expiresAt: pending.expiresAt || getBeijingTimestamp(new Date(Date.now() + (rememberForRun ? 60 * 60 * 1000 : 15 * 60 * 1000)))
        };
        const approvalGrants = Array.isArray(metadata.approvalGrants)
            ? metadata.approvalGrants.filter(item => item && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()))
            : [];
        approvalGrants.push(approvalGrant);
        const resumeContext = await buildAgentResumeContext(runId);
        const approvalPatch = {
            pendingApproval: null,
            approvalGrants,
            approvedTools: [...approvedTools],
            approvedApprovalKeys: [...approvedApprovalKeys],
            resumeContext: {
                ...resumeContext,
                previousStatus: run.status,
                approvedTool: pending.tool || '',
                approvedInputHash: approvalGrant.inputHash
            }
        };
        const changed = await updateRunCas(runId, ['approval_required'], {
            status: 'queued',
            error_message: '',
            resume_from_step: Number(resumeContext.latestStepIndex || run.resume_from_step || 0) || 0,
            updated_at: now,
            metadata: JSON.stringify(approvalPatch)
        }, { mergeMetadata: true, approvalBinding: pending });
        if (!changed) {
            const current = await getRunForUser(runId, user);
            if (current?.status === 'approval_required') throw Object.assign(new Error('授权请求已变化，请查看最新操作后重新确认。'), { status: 409, code: 'AGENT_APPROVAL_STALE' });
            return current;
        }
        await insertStep(runId, (await listSteps(runId)).length + 1, {
            type: 'approval',
            title: '用户允许了本次操作',
            toolName: pending.tool || '',
            output: { status: 'approved', tool: pending.tool || '' }
        });
        try {
            await recordAgentEvent({
                runId,
                userId: user.id,
                type: 'approval.granted',
                payload: { tool: pending.tool || '', key: pending.key || '', inputHash: approvalGrant.inputHash },
                eventKey: `approval:${pending.key || pending.tool || 'unknown'}:granted:${approvalGrant.inputHash}`
            });
        } catch (_) {}
        enqueueAgentRun(runId, user);
        return await getRunForUser(runId, user);
    }
    return approveAgentTool;
}

module.exports = { createApprovalDecision };
