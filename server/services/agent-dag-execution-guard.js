'use strict';

const { isPreviewAgentRun } = require('./agent-runtime/metadata');

function toolHasSideEffectsOrApproval(tool = {}) {
    return Boolean(tool?.side_effect || tool?.sideEffect || tool?.approval_required || tool?.approvalRequired
        || tool?.requiresApproval || tool?.alwaysRequiresApproval);
}

function assertPreviewToolAllowed(run, tool) {
    if (!isPreviewAgentRun(run) || !toolHasSideEffectsOrApproval(tool)) return;
    const error = new Error('预览模式禁止执行副作用或需审批的工具。');
    error.code = 'AGENT_PREVIEW_SIDE_EFFECT_BLOCKED';
    error.status = 409;
    error.category = 'policy';
    throw error;
}

module.exports = { assertPreviewToolAllowed, toolHasSideEffectsOrApproval };
