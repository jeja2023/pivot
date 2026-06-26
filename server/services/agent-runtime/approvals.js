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
        function isApprovalGranted(run, toolName) {    
        // approveAgentTool persists approved tools in metadata.approvedTools.    
        // Keep this check scoped so pendingApproval cleanup remains in the approval flow.    
        const metadata = getRunMetadata(run);    
        const approved = Array.isArray(metadata.approvedTools) ? metadata.approvedTools : [];    
        return approved.includes(toolName);    
    }    
        
    function shouldPauseForApproval(run, tool) {    
        if (!tool || tool.source !== 'mcp') return false;    
        if (isApprovalGranted(run, tool.name)) return false;    
        const policy = normalizeApprovalPolicy(run.approval_policy);    
        if (policy === 'approve_all_mcp') return true;    
        return Boolean(tool.requiresApproval || tool.risk === 'high');    
    }    
        
    function maybePauseForApproval(run, tool, input) {    
        if (!shouldPauseForApproval(run, tool)) return false;    
        const now = getTimestamp();    
        setRunMetadata(run.id, {    
            pendingApproval: {    
                tool: tool.name,    
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
            output: { status: 'approval_required', tool: tool.name }    
        });    
        createAgentNotification(run.user_id, run.id, 'approval', 'Agent run requires tool approval', tool.title || tool.name);    
        return true;    
    }

    return { isApprovalGranted, shouldPauseForApproval, maybePauseForApproval };
}

module.exports = { createApprovalHelpers };
