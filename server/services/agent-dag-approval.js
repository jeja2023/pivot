'use strict';

const { approvalInputHash } = require('./agent-runtime/approvals');

function resolveDagToolApproval({ run, node, selectedTool, input, isApprovalGranted, executionPath = '' }) {
    const path = String(executionPath || '').trim();
    const approvalKey = `${node.tool}:${path ? `${path}:` : ''}${node.id}`;
    const approvalGranted = Boolean(
        selectedTool
        && typeof isApprovalGranted === 'function'
        && isApprovalGranted(run, selectedTool.name, approvalKey, input)
    );
    return { approvalKey, approvalGranted };
}

function stableDagOperationKey(run, node, input, executionPath = '') {
    const runId = String(run?.id || '').trim();
    const nodeId = String(node?.id || '').trim();
    if (!runId || !nodeId) return '';
    const path = String(executionPath || '').trim();
    return `${runId}:dag:${path ? `${path}:` : ''}${nodeId}:${approvalInputHash(input)}`;
}

module.exports = { resolveDagToolApproval, stableDagOperationKey };
