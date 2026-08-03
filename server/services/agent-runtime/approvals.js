function createApprovalHelpers({
    getRunMetadata,
    normalizeApprovalPolicy,
    getTimestamp,
    setRunMetadata,
    updateRun,
    insertStep,
    listSteps,
    createAgentNotification
}) {
    function isApprovalGranted(run, toolName, approvalKey = '') {
        const metadata = getRunMetadata(run);
        const approvedTools = Array.isArray(metadata.approvedTools) ? metadata.approvedTools : [];
        const approvedKeys = Array.isArray(metadata.approvedApprovalKeys) ? metadata.approvedApprovalKeys : [];
        return (approvalKey && approvedKeys.includes(approvalKey)) || approvedTools.includes(toolName);
    }

    function shouldPauseForApproval(run, tool, approvalKey = '') {
        if (!tool || isApprovalGranted(run, tool.name, approvalKey)) return false;
        if (tool.alwaysRequiresApproval) return true;
        if (tool.source !== 'mcp') return false;
        const policy = normalizeApprovalPolicy(run.approval_policy);
        if (policy === 'approve_all_mcp') return true;
        return Boolean(tool.requiresApproval || tool.risk === 'high');
    }

    function maybePauseForApproval(run, tool, input, approvalKey = '') {
        const scopedKey = String(approvalKey || '').trim();
        if (!shouldPauseForApproval(run, tool, scopedKey)) return false;
        const now = getTimestamp();
        setRunMetadata(run.id, {
            pendingApproval: {
                tool: tool.name,
                key: scopedKey,
                title: tool.title || tool.name,
                requestedAt: now,
                input
            }
        });
        updateRun(run.id, {
            status: 'approval_required',
            error_message: `工具需要审批：${tool.title || tool.name}`,
            updated_at: now,
            last_heartbeat_at: now
        });
        insertStep(run.id, listSteps(run.id).length + 1, {
            type: 'approval',
            title: `等待工具审批：${tool.title || tool.name}`,
            toolName: tool.name,
            input,
            output: { status: 'approval_required', tool: tool.name, key: scopedKey }
        });
        createAgentNotification(run.user_id, run.id, 'approval', '任务需要审批', tool.title || tool.name);
        return true;
    }

    return { isApprovalGranted, shouldPauseForApproval, maybePauseForApproval };
}

module.exports = { createApprovalHelpers };
