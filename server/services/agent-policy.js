const { normalizeToolContract, validateToolInput } = require('./agent-contracts');

class PolicyError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'PolicyError';
        this.code = 'AGENT_POLICY_DENIED';
        this.category = 'policy';
        this.details = details;
    }
}

function normalizeAllowlist(value) {
    if (Array.isArray(value)) return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
    if (typeof value === 'string') return normalizeAllowlist(value.split(','));
    return [];
}

function evaluateToolPolicy({ run = {}, tool: rawTool = {}, input = {}, user = null, budget = null } = {}) {
    const tool = normalizeToolContract(rawTool);
    const policy = String(run.tool_policy || run.toolPolicy || 'all');
    const allowlist = normalizeAllowlist(run.tool_allowlist || run.toolAllowlist);
    const reasons = [];
    if (!tool.name) reasons.push('工具契约缺少名称。');
    const inputIssues = validateToolInput(tool, input);
    if (inputIssues.length) reasons.push(`工具输入契约校验失败：${inputIssues[0]}`);
    if (policy === 'builtin_only' && tool.source === 'mcp') reasons.push('当前任务仅允许内置工具。');
    if (allowlist.length && !allowlist.includes(tool.name)) reasons.push('工具不在任务允许列表中。');
    const capabilityAllowlist = normalizeAllowlist(run.capability_allowlist || run.capabilityAllowlist || run.capabilities);
    if (capabilityAllowlist.length && !tool.capabilities.some(capability => capabilityAllowlist.includes(capability))) {
        reasons.push('工具能力不在当前任务能力上下文中。');
    }
    if (tool.network && run.network_policy?.enabled === false) reasons.push('任务网络策略已禁用网络访问。');
    if (reasons.length) return { decision: 'denied', tool, reasons, input, userId: user?.id || null };

    const risk = tool.risk_level;
    const approvalPolicy = String(run.approval_policy || run.approvalPolicy || 'safe_mcp_auto');
    const approvalRequired = tool.approval_required
        || (tool.source === 'mcp' && (approvalPolicy === 'approve_all_mcp' || risk >= 4));
    if (approvalRequired) return { decision: 'require_approval', tool, reasons: ['工具风险或任务审批策略要求人工确认。'], input, userId: user?.id || null };

    if (budget && typeof budget.consumeTool === 'function') {
        try {
            budget.consumeTool(tool);
        } catch (error) {
            return { decision: 'denied', tool, reasons: [error.message], error, input, userId: user?.id || null };
        }
    }
    return { decision: 'allow', tool, reasons: [], input, userId: user?.id || null };
}

function enforceToolPolicy(options = {}) {
    const result = evaluateToolPolicy(options);
    if (result.decision === 'denied') {
        throw new PolicyError(`工具调用被策略拦截：${result.reasons.join('；')}`, result);
    }
    if (result.decision === 'require_approval' && options.allowApproval !== true) {
        const error = new PolicyError(`工具调用需要人工审批：${result.tool.title || result.tool.name}`, result);
        error.code = 'AGENT_APPROVAL_REQUIRED';
        throw error;
    }
    return result;
}

module.exports = {
    PolicyError,
    enforceToolPolicy,
    evaluateToolPolicy,
    normalizeAllowlist
};
