'use strict';

const { listCachedMcpTools } = require('./mcp-client');
const { filterMcpToolsByCapability } = require('./capability-market');
const { normalizeToolContract } = require('./agent-contracts');
const { capabilitiesCoverTool } = require('./agent-capability-registry');
const { redactRoutingText } = require('./decision-provider');

function visibleToolContract(raw) {
    const managed = ['database', 'reports', 'imported_dataset', 'imported_report'].includes(raw.serverType) || /^mcp\.0\./.test(String(raw.fullName || ''));
    return normalizeToolContract({ ...raw, source: raw.fullName ? 'mcp' : raw.source,
        risk: raw.governance?.riskLevel ?? raw.risk_level ?? raw.risk ?? (managed ? 'medium' : 'high'),
        approvalRequired: raw.governance?.approvalRequired || raw.approval_required || raw.requiresApproval });
}

function isAutomaticReadTool(raw, capabilities = []) {
    const tool = visibleToolContract(raw);
    return !tool.side_effect && !tool.approval_required && tool.idempotent === true && tool.risk_level < 4
        && tool.capabilities.length > 0 && tool.capabilities.every(cap => capabilitiesCoverTool(capabilities, [cap]));
}

async function getChatCapabilityAvailability(user, deps = {}) {
    try {
        const tools = await (deps.filterMcpToolsByCapability || filterMcpToolsByCapability)(await (deps.listCachedMcpTools || listCachedMcpTools)(null, user), user);
        return { status: tools.length > 24 ? 'partial' : 'available', totalTools: tools.length, tools: tools.slice(0, 24).map(raw => {
            const tool = visibleToolContract(raw);
            return { name: raw.fullName || tool.name, sourceName: redactRoutingText(String(raw.serverName || '')).slice(0, 80), description: redactRoutingText(String(tool.description || '')).slice(0, 240), capabilities: tool.capabilities,
                readOnly: !tool.side_effect, requiresApproval: tool.approval_required || tool.risk_level >= 4 };
        }) };
    } catch (_) { return { status: 'unavailable', tools: [] }; }
}

module.exports = { isAutomaticReadTool, getChatCapabilityAvailability };
