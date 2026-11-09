'use strict';

function executedToolEvidence(tool, output) {
    if (tool?.name === 'tools.batch_read' && output?.type === 'tools_batch_read') return { batch: output.results.map(item => item.executedTool).filter(Boolean) };
    if (!tool?.name || tool.name.startsWith('tools.') || output?.executed === false || output?.error || output?.isError) return null;
    return { toolName: tool.name, capabilities: tool.capabilities || [], riskLevel: Number(tool.risk_level) || 0,
        idempotent: tool.idempotent === true, sideEffect: tool.side_effect === true, version: tool.version || '' };
}

function resolveLearningToolCalls(calls) {
    return calls.flatMap(call => {
        const context = typeof call.context_snapshot === 'string' ? JSON.parse(call.context_snapshot) : call.context_snapshot || {};
        const evidence = context.executedTool;
        if (call.tool_name === 'tools.batch_read' && Array.isArray(evidence?.batch) && call.status === 'success' && call.policy_decision === 'allow') {
            const resolved = evidence.batch.filter(item => item.toolName && !item.toolName.startsWith('tools.') && item.idempotent && !item.sideEffect)
                .map(item => ({ ...call, tool_name: item.toolName, idempotent: true, risk_level: item.riskLevel,
                    input_payload: (call.input_payload?.calls || []).find(input => input.toolRef?.toolName === item.toolName)?.input || {}, resolvedFromToolMeta: true }));
            return resolved.length ? resolved : [call];
        }
        if (call.tool_name !== 'tools.execute' || !evidence || !evidence.toolName || evidence.toolName.startsWith('tools.')
            || evidence.sideEffect || !evidence.idempotent || call.status !== 'success' || call.policy_decision !== 'allow') return call;
        return { ...call, tool_name: evidence.toolName, idempotent: true, risk_level: evidence.riskLevel,
            input_payload: call.input_payload?.input || {}, resolvedFromToolMeta: true };
    });
}

module.exports = { executedToolEvidence, resolveLearningToolCalls };
