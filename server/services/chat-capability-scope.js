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

async function getChatCapabilityAvailability(user, deps = {}, options = {}) {
    try {
        const tools = await (deps.filterMcpToolsByCapability || filterMcpToolsByCapability)(await (deps.listCachedMcpTools || listCachedMcpTools)(null, user), user);
        const visible = tools.filter(raw => !Array.isArray(options.manualAllowlist) || options.manualAllowlist.includes(raw.fullName || raw.name));
        const summaries = visible.map(raw => {
            const tool = visibleToolContract(raw);
            return { name: raw.fullName || tool.name, sourceName: redactRoutingText(String(raw.serverName || '')).slice(0, 80), description: redactRoutingText(String(tool.description || '')).slice(0, 240), capabilities: tool.capabilities,
                readOnly: !tool.side_effect, idempotent: tool.idempotent === true, requiresApproval: tool.approval_required || tool.risk_level >= 4 };
        });
        const selected = new Set(options.selectedTools || []);
        const ranked = require('./tool-discovery').rankTools(options.prompt || '', summaries).map(item => item.tool);
        const ordered = [...summaries.filter(tool => selected.has(tool.name)), ...ranked, ...summaries];
        const unique = [...new Map(ordered.map(tool => [tool.name, tool])).values()];
        const limit = Math.max(24, Math.min(selected.size, 100));
        return { status: unique.length > limit ? 'partial' : 'available', totalTools: unique.length, tools: unique.slice(0, limit) };
    } catch (_) { return { status: 'unavailable', tools: [] }; }
}

module.exports = { isAutomaticReadTool, getChatCapabilityAvailability };
