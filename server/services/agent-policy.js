const { normalizeToolContract, validateToolInput } = require('./agent-contracts');
const { capabilitiesCoverTool, normalizeCapabilityList } = require('./agent-capability-registry');
const { recordLegacyUnrestrictedHit, recordPolicyDecision } = require('./agent-governance-metrics');
const { getBeijingTimestamp } = require('../time');

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

/**
 * 历史（fail-open）语义下的权限别名匹配。
 * 仅用于影子模式计算「默认拒绝改造会新增多少拒绝」，绝不参与实际放行判定。
 * 其中 code.python_execute → code.execute、code.duckdb_query → code.execute
 * 属于放大方向（声明窄能力却匹配宽能力），已由能力注册表的收敛匹配取代。
 */
const LEGACY_PERMISSION_ALIASES = Object.freeze({
    'filesystem.read': 'filesystem.read_workspace',
    'filesystem.write': 'filesystem.write_workspace',
    'code.python_execute': 'code.execute',
    'code.duckdb_query': 'code.execute'
});

function legacyPermissionMatches(capability, permission) {
    const cap = String(capability || '').trim();
    const item = String(permission || '').trim();
    if (!cap || !item) return false;
    if (cap === item) return true;
    return LEGACY_PERMISSION_ALIASES[item] === cap;
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

function parseRunMetadata(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return {};
    try { return JSON.parse(value) || {}; } catch (_) { return {}; }
}

/** 判定 legacy_unrestricted 兜底标记是否仍在有效期内。到期即自动失效并恢复默认拒绝。 */
function isLegacyUnrestrictedEffective(context) {
    if (context.legacyUnrestricted !== true) return false;
    if (!context.legacyUnrestrictedUntil) return true;
    return String(context.legacyUnrestrictedUntil) > getBeijingTimestamp();
}

/**
 * 解析 run 上下文中的 Skill 约束。
 * 关键点一：必须能区分「本次任务不由 Skill 驱动」（不施加 Skill 约束）与
 * 「Skill 上下文存在但声明为空」（拒绝全部工具），后者是 v1.2 A1 的修复目标。
 * 关键点二：agent_runs.metadata 的内容对调用方可写，因此
 * 「上下文不存在」与「legacy_unrestricted 兜底」两类会放宽判定的信号，
 * 只认服务端在 run 创建时写入的 metadata.skillConstraints 结构，
 * 绝不接受调用方在 metadata 顶层自报的同名键，否则等于把 PEP 关掉。
 */
function resolveSkillPolicyContext(run = {}) {
    const runMetadata = parseRunMetadata(run.metadata);
    const constraints = runMetadata.skillConstraints && typeof runMetadata.skillConstraints === 'object'
        ? runMetadata.skillConstraints
        : {};
    const capabilities = normalizeCapabilityList(
        constraints.capabilities
        ?? run.skill_capabilities ?? run.skillCapabilities ?? runMetadata.skillCapabilities
        ?? run.skill_permissions ?? run.skillPermissions ?? runMetadata.skillPermissions
    );
    const tools = normalizeAllowlist(
        constraints.tools ?? run.skill_tools ?? run.skillTools ?? runMetadata.skillTools
    );
    const reference = String(
        constraints.reference
        ?? run.skill_id ?? run.skillId ?? runMetadata.skillId
        ?? run.skill_name ?? run.skillName ?? runMetadata.skillName ?? ''
    ).trim();
    // present 只做单向放严：服务端标记为 true，或存在任何 Skill 绑定痕迹即施加约束。
    // 不提供「声明不存在」的关闭开关，避免调用方通过 metadata 关掉 Skill 约束。
    const present = constraints.present === true
        || Boolean(reference)
        || capabilities.length > 0
        || tools.length > 0;
    return {
        present,
        capabilities,
        tools,
        reference,
        legacyUnrestricted: constraints.legacyUnrestricted === true,
        legacyUnrestrictedUntil: String(constraints.legacyUnrestrictedUntil ?? '').trim()
    };
}

/** 影子模式只记录不生效，用于评估默认拒绝改造的真实影响面（落地方案 §12.3、R1）。 */
function isShadowMode(env = process.env) {
    return String(env.PIVOT_AGENT_PEP_MODE || 'enforce').trim().toLowerCase() === 'shadow';
}

/**
 * 计算 Skill 级判定。返回的每条拒绝都标注 legacy：
 * legacy=true 表示历史 fail-open 语义下同样会拒绝，改造未新增影响面；
 * legacy=false 表示这是默认拒绝改造新增的拒绝，影子模式下只记录不生效。
 */
function evaluateSkillConstraints(skillContext, tool) {
    if (!skillContext.present) return [];
    if (isLegacyUnrestrictedEffective(skillContext)) {
        recordLegacyUnrestrictedHit();
        return [];
    }
    const denials = [];
    const toolCapabilities = normalizeCapabilityList(tool.capabilities);
    if (!skillContext.capabilities.length) {
        denials.push({
            code: 'skill_capabilities_empty',
            message: '当前 Skill 未声明任何能力，按默认拒绝语义拒绝全部工具调用。',
            legacy: false
        });
    } else if (!capabilitiesCoverTool(skillContext.capabilities, toolCapabilities)) {
        const legacyAllowed = toolCapabilities.some(capability => skillContext.capabilities
            .some(declared => legacyPermissionMatches(capability, declared)));
        denials.push({
            code: 'skill_capability_not_declared',
            message: '工具能力未在当前 Skill 声明的最小能力集合中。',
            legacy: !legacyAllowed
        });
    }
    if (!skillContext.tools.length) {
        denials.push({
            code: 'skill_tools_empty',
            message: '当前 Skill 未声明任何工具，按默认拒绝语义拒绝全部工具调用。',
            legacy: false
        });
    } else if (!skillContext.tools.includes(tool.name)) {
        denials.push({
            code: 'skill_tool_not_declared',
            message: '工具未在当前 Skill 声明的工具集合中。',
            legacy: true
        });
    }
    return denials;
}

function evaluateToolPolicy({ run = {}, tool: rawTool = {}, input = {}, user = null, budget = null, allowApproval = false } = {}) {
    const tool = normalizeToolContract(rawTool);
    input = normalizeToolInput(tool.name, input, run);
    const policy = String(run.tool_policy || run.toolPolicy || 'all');
    const allowlist = normalizeAllowlist(run.tool_allowlist || run.toolAllowlist);
    const reasons = [];
    const reasonCodes = [];
    const deny = (code, message) => { reasonCodes.push(code); reasons.push(message); };
    if (!tool.name) deny('tool_name_missing', '工具契约缺少名称。');
    const inputIssues = validateToolInput(tool, input);
    if (inputIssues.length) deny('tool_input_invalid', `工具输入契约校验失败：${inputIssues[0]}`);
    if (policy === 'builtin_only' && tool.source === 'mcp') deny('tool_policy_builtin_only', '当前任务仅允许内置工具。');
    // 任务级 allowlist 保持「未设置表示不额外收窄」语义，与 Skill 级默认拒绝语义相互独立。
    if (allowlist.length && !allowlist.includes(tool.name)) deny('task_tool_allowlist', '工具不在任务允许列表中。');
    const capabilityAllowlist = normalizeAllowlist(run.capability_allowlist || run.capabilityAllowlist || run.capabilities);
    if (capabilityAllowlist.length && !tool.capabilities.some(capability => capabilityAllowlist.includes(capability))) {
        deny('task_capability_allowlist', '工具能力不在当前任务能力上下文中。');
    }
    const skillContext = resolveSkillPolicyContext(run);
    const skillDenials = evaluateSkillConstraints(skillContext, tool);
    const shadow = isShadowMode();
    skillDenials.forEach(item => {
        if (shadow && item.legacy === false) {
            // 影子模式：只记录默认拒绝改造新增的影响面，不改变本次放行结果。
            recordPolicyDecision({ decision: 'denied', reason: item.code, shadow: true });
            return;
        }
        deny(item.code, item.message);
    });
    if (tool.network && run.network_policy?.enabled === false) deny('network_policy_disabled', '任务网络策略已禁用网络访问。');
    if (reasons.length) {
        recordPolicyDecision({ decision: 'denied', reason: reasonCodes[0] });
        return { decision: 'denied', tool, reasons, reasonCodes, skillContext, input, userId: user?.id || null };
    }

    const risk = tool.risk_level;
    const approvalPolicy = String(run.approval_policy || run.approvalPolicy || 'safe_mcp_auto');
    const approvalRequired = tool.approval_required
        || (tool.source === 'mcp' && (approvalPolicy === 'approve_all_mcp' || risk >= 4));
    if (approvalRequired && allowApproval !== true) {
        return {
            decision: 'require_approval',
            tool,
            reasons: ['工具风险或任务审批策略要求人工确认。'],
            reasonCodes: ['approval_required'],
            skillContext,
            input,
            userId: user?.id || null
        };
    }

    if (budget && typeof budget.consumeTool === 'function') {
        try {
            budget.consumeTool(tool);
        } catch (error) {
            recordPolicyDecision({ decision: 'denied', reason: 'budget_exhausted' });
            return { decision: 'denied', tool, reasons: [error.message], reasonCodes: ['budget_exhausted'], skillContext, error, input, userId: user?.id || null };
        }
    }
    recordPolicyDecision({ decision: 'allow' });
    return { decision: 'allow', tool, reasons: [], reasonCodes: [], skillContext, input, userId: user?.id || null };
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
    isShadowMode,
    normalizeAllowlist,
    normalizeModelReference,
    normalizeToolInput,
    resolveSkillPolicyContext
};
