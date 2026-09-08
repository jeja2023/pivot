'use strict';

const { approvalInputHash } = require('./agent-runtime/approvals');

function resolveDagToolApproval({ run, node, selectedTool, input, isApprovalGranted }) {
    const approvalKey = `${node.tool}:${node.id}`;
    const approvalGranted = Boolean(
        selectedTool
        && typeof isApprovalGranted === 'function'
        && isApprovalGranted(run, selectedTool.name, approvalKey, input)
    );
    return { approvalKey, approvalGranted };
}

function stableDagOperationKey(run, node, input) {
    const runId = String(run?.id || '').trim();
    const nodeId = String(node?.id || '').trim();
    if (!runId || !nodeId) return '';
    return `${runId}:dag:${nodeId}:${approvalInputHash(input)}`;
}

module.exports = { resolveDagToolApproval, stableDagOperationKey };
