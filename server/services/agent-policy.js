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

function skillPermissionMatches(capability, permission) {
    const cap = String(capability || '').trim();
    const item = String(permission || '').trim();
    if (!cap || !item) return false;
    if (cap === item) return true;
    const aliases = {
        'filesystem.read': 'filesystem.read_workspace',
        'filesystem.write': 'filesystem.write_workspace',
        'code.python_execute': 'code.execute',
        'code.duckdb_query': 'code.execute'
    };
    return aliases[item] === cap;
}

function normalizeModelReference(value) {
    if (value && typeof value === 'object') {
        return String(value.id ?? value.model_id ?? value.modelId ?? value.model_name ?? value.name ?? '').trim();
    }
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text || !/^[{[]/.test(text)) return value;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return normalizeModelReference(parsed);
    } catch (e) {
        // Keep the original text; the schema validator will report a useful error.
    }
    return value;
}

function normalizeToolInput(toolName, input = {}, run = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const normalized = { ...source };
    ['model', 'modelId', 'model_id'].forEach(key => {
        if (Object.prototype.hasOwnProperty.call(normalized, key)) {
            normalized[key] = normalizeModelReference(normalized[key]);
        }
    });
    if (String(toolName || '').trim() === 'agent.content_review'
        && (!normalized.model || typeof normalized.model !== 'string' || !normalized.model.trim())) {
        normalized.model = String(run.chosen_model_id ?? run.model_id_selected ?? run.model_id ?? run.modelId ?? '').trim();
    }
    if (String(toolName || '').trim() === 'agent.content_review' && !normalized.records) {
        normalized.records = normalized.rows ?? normalized.data ?? normalized.items ?? normalized.content
            ?? normalized.text ?? normalized.articles ?? normalized.news_list ?? normalized.results;
    }
    return normalized;
}

function evaluateToolPolicy({ run = {}, tool: rawTool = {}, input = {}, user = null, budget = null, allowApproval = false } = {}) {
    const tool = normalizeToolContract(rawTool);
    input = normalizeToolInput(tool.name, input, run);
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
    let runMetadata = run.metadata;
    if (typeof runMetadata === 'string') {
        try { runMetadata = JSON.parse(runMetadata); } catch (_) { runMetadata = {}; }
    }
    const skillPermissions = normalizeAllowlist(run.skill_permissions || run.skillPermissions || runMetadata?.skillPermissions);
    if (skillPermissions.length && !tool.capabilities.some(capability => skillPermissions.some(permission => skillPermissionMatches(capability, permission)))) {
        reasons.push('工具能力未在当前 Skill 声明的最小权限中。');
    }
    const skillTools = normalizeAllowlist(run.skill_tools || run.skillTools || runMetadata?.skillTools);
    if (skillTools.length && !skillTools.includes(tool.name)) reasons.push('工具未在当前 Skill 声明的工具集合中。');
    if (tool.network && run.network_policy?.enabled === false) reasons.push('任务网络策略已禁用网络访问。');
    if (reasons.length) return { decision: 'denied', tool, reasons, input, userId: user?.id || null };

    const risk = tool.risk_level;
    const approvalPolicy = String(run.approval_policy || run.approvalPolicy || 'safe_mcp_auto');
    const approvalRequired = tool.approval_required
        || (tool.source === 'mcp' && (approvalPolicy === 'approve_all_mcp' || risk >= 4));
    if (approvalRequired && allowApproval !== true) return { decision: 'require_approval', tool, reasons: ['工具风险或任务审批策略要求人工确认。'], input, userId: user?.id || null };

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
    normalizeAllowlist,
    normalizeModelReference,
    normalizeToolInput
};
