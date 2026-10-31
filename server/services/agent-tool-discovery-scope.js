'use strict';

const { evaluateToolPolicy, normalizeAllowlist, resolveSkillPolicyContext } = require('./agent-policy');
const { isDiscoveryMetaTool } = require('./agent-tool-progressive-discovery');
const { narrowDatabaseConnections } = require('./agent-tool-identities');

function runMetadata(run = {}) {
    if (run.metadata && typeof run.metadata === 'object') return run.metadata;
    try { return JSON.parse(run.metadata || '{}') || {}; } catch (_) { return {}; }
}

function filterRunToolCatalog(tools = [], run = {}, user = null) {
    const metadata = runMetadata(run);
    const bridge = metadata.chatBridge;
    const skill = resolveSkillPolicyContext(run);
    const allowlists = [normalizeAllowlist(run.tool_allowlist || run.toolAllowlist), ...(skill.present ? [skill.tools] : [])];
    return tools.map(tool => {
        if (isDiscoveryMetaTool(tool)) return tool;
        tool = narrowDatabaseConnections(tool, allowlists);
        if (!tool) return null;
        if (bridge?.mcpEnabled === true && Array.isArray(bridge.mcpToolAllowlist) && tool.source === 'mcp') {
            const allowed = new Set(bridge.mcpToolAllowlist.map(String));
            if (!allowed.has(tool.name)) {
                const connections = tool.databaseTool && tool.databaseConnections?.filter(connection => allowed.has(String(connection.fullName)));
                if (!connections?.length) return null;
                tool = { ...tool, databaseConnections: connections };
            }
        }
        if (bridge && bridge.ragEnabled !== true && ['rag.search', 'knowledge.list', 'knowledge.graph.query'].includes(tool.name)) return null;
        if (bridge && bridge.mcpEnabled !== true && !metadata.automaticExecution
            && (tool.network || tool.side_effect || tool.approval_required || tool.requiresApproval || tool.alwaysRequiresApproval)) return null;
        // 浏览目录时尚未填写业务参数；仅跳过参数校验，仍检查任务/能力/Skill
        // 范围。实际调用保持完整输入、审批、实时授权和网络检查。
        return evaluateToolPolicy({ run, tool, user, inspectOnly: true, allowApproval: true }).decision === 'allow' ? tool : null;
    }).filter(Boolean);
}

async function refreshDiscoveryScope(run = {}, user = null, deps = {}) {
    if (!run.id || !user?.id || runMetadata(run).capabilityConstraints?.present !== true) return run;
    const current = await (deps.currentExecutionScope || require('../repositories/chat-conversation-turns').currentExecutionScope)(run.id, user.id);
    if (!current || current.source_active === false || ['needs_input', 'cancelled', 'deleted', 'completed', 'partial', 'error', 'failed'].includes(current.status)) {
        const error = new Error('当前任务已暂停、结束或原始授权来源已撤回，不能继续读取工具目录。');
        error.code = 'AGENT_DISCOVERY_SCOPE_REVOKED'; error.status = 409; error.category = 'policy';
        throw error;
    }
    run.metadata = current.metadata;
    for (const key of ['tool_policy', 'tool_allowlist', 'network_policy']) {
        if (current[key] !== undefined) run[key] = current[key];
    }
    return run;
}

module.exports = { filterRunToolCatalog, refreshDiscoveryScope };
