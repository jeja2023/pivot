const { parseJsonObject, normalizeAgentTitle } = require('../agent-validators');

function getAgentRunTitle(run) {
    return normalizeAgentTitle(run?.title, run?.goal);
}

function getRunMetadata(run) {
    const parsed = parseJsonObject(run?.metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
}

function isPreviewAgentRun(run) {
    const metadata = getRunMetadata(run);
    return String(metadata.workflowRunSource || metadata.workflow_run_source || metadata.runSource || '').toLowerCase() === 'preview';
}

module.exports = {
    getAgentRunTitle,
    getRunMetadata,
    isPreviewAgentRun
};
