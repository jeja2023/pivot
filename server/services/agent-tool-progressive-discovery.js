'use strict';

/* The planner only receives the three discovery meta-tools. The complete,
 * authorization-filtered catalog remains available to the execution runtime
 * after tools.execute has resolved a previously described toolRef. */
const META_TOOL_NAMES = Object.freeze(new Set(['tools.search', 'tools.describe', 'tools.execute']));

function buildProgressivePlannerToolList(toolList = []) {
    return (toolList || [])
        .filter(tool => META_TOOL_NAMES.has(String(tool?.name || '')))
        .map(tool => ({
            ...tool,
            description: `${String(tool.description || '').trim()} 必须遵循 search → describe → execute 顺序。`
        }));
}

function plannerToolNames(toolList = []) {
    return new Set(buildProgressivePlannerToolList(toolList).map(tool => String(tool.name)));
}

function createToolDiscoveryState() {
    return { searched: new Set(), described: new Set() };
}

function referenceKey(reference = {}) {
    const name = String(reference.toolName || reference.tool_name || reference.name || '').trim();
    const release = reference.releaseId ?? reference.release_id ?? '';
    const digest = String(reference.definitionDigest || reference.definition_digest || '').trim();
    return `${name}|${release}|${digest}`;
}

function discoveryError(message, code) {
    const error = new Error(message);
    error.code = code;
    error.status = 409;
    error.statusCode = 409;
    return error;
}

function rememberSearch(state, result = {}) {
    if (!state?.searched) return;
    (result.candidates || []).forEach(candidate => {
        const key = referenceKey(candidate?.toolRef || {});
        if (key !== '||') state.searched.add(key);
    });
}

function rememberDescription(state, reference = {}) {
    if (!state?.described) return;
    const key = referenceKey(reference);
    if (key !== '||') state.described.add(key);
}

function assertSearched(state, reference = {}) {
    if (!state?.searched) return;
    if (!state.searched.has(referenceKey(reference))) {
        throw discoveryError('请先使用 tools.search 获取当前已授权工具的 toolRef，再读取其契约。', 'TOOL_DISCOVERY_SEARCH_REQUIRED');
    }
}

function assertDescribed(state, reference = {}) {
    if (!state?.described) return;
    if (!state.described.has(referenceKey(reference))) {
        throw discoveryError('请先使用 tools.describe 确认该工具的输入、风险和权限要求，再执行。', 'TOOL_DISCOVERY_DESCRIBE_REQUIRED');
    }
}

module.exports = {
    assertDescribed,
    assertSearched,
    buildProgressivePlannerToolList,
    createToolDiscoveryState,
    plannerToolNames,
    referenceKey,
    rememberDescription,
    rememberSearch
};
