'use strict';

const { assertDescribed, isDiscoveryRecoveryError } = require('./agent-tool-progressive-discovery');
const { describeToolForUser } = require('./tool-discovery');
const { normalizeToolReference } = require('./agent-tools-discovery');

function progressiveExecutionError(message, code = 'TOOL_DISCOVERY_EXECUTION_INVALID') {
    const error = new Error(message);
    error.code = code;
    error.status = 409;
    error.statusCode = 409;
    return error;
}

function findTool(toolList = [], name = '') {
    return (toolList || []).find(item => String(item?.name || item?.fullName || '') === String(name || '')) || null;
}

async function resolveProgressiveExecution({ toolName, input = {}, user, toolList = [], state = null, run = null } = {}) {
    if (run) await require('./agent-tool-discovery-scope').refreshDiscoveryScope(run, user);
    const name = String(toolName || '').trim();
    const selectedTool = findTool(toolList, name);
    if (!selectedTool) throw progressiveExecutionError(`工具不可用或无权访问：${name || '-'}`, 'TOOL_NOT_AVAILABLE');
    if (name !== 'tools.execute') return { selectedTool, approvalTool: selectedTool, approvalToolName: name, approvalInput: input };
    const actualInput = input.input === undefined ? {} : input.input;
    if (!actualInput || typeof actualInput !== 'object' || Array.isArray(actualInput)) throw progressiveExecutionError('tools.execute 的 input 必须是对象。', 'TOOL_DISCOVERY_INPUT_INVALID');
    input.input = actualInput;
    const reference = normalizeToolReference(input);
    input.toolRef = reference;
    let described;
    let currentTools;
    try {
        assertDescribed(state, reference);
        const { formatToolList } = require('./agent-tool-catalog');
        const { filterRunToolCatalog } = require('./agent-tool-discovery-scope');
        currentTools = filterRunToolCatalog(await formatToolList(user, {
            toolPolicy: run?.tool_policy || run?.toolPolicy || 'all',
            toolAllowlist: run?.tool_allowlist || run?.toolAllowlist || null
        }), run || {}, user);
        described = await describeToolForUser(user, reference, { formatToolList: async () => currentTools }, {
            toolPolicy: run?.tool_policy || run?.toolPolicy || 'all',
            toolAllowlist: run?.tool_allowlist || run?.toolAllowlist || null
        });
    } catch (error) {
        if (!isDiscoveryRecoveryError(error)) throw error;
        return { selectedTool, approvalTool: selectedTool, approvalToolName: name, approvalInput: input, discoveryRequired: error.code };
    }
    if (String(described.name || '').startsWith('tools.')) throw progressiveExecutionError('工具发现元工具不能递归执行。', 'TOOL_META_RECURSION_FORBIDDEN');
    const approvalTool = findTool(currentTools, described.name);
    if (!approvalTool) throw progressiveExecutionError('已描述工具不再可用或当前无权访问，请重新搜索。', 'TOOL_REFERENCE_STALE');
    return { selectedTool, approvalTool, approvalToolName: described.name, approvalInput: actualInput, description: described };
}

module.exports = { resolveProgressiveExecution };
