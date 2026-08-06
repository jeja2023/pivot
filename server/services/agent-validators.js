/* 智能体输入规范化与常量 Agent Validators & Constants
 *
 * 从 agent-runtime.js 中拆出的纯函数部分，便于：
 *   - 减少 agent-runtime.js 的体积，下一步拆 DAG/调度器/产物时各子模块共享同一套校验。
 *   - 单测覆盖更直接，所有 normalize* 都不依赖数据库。
 *
 * 重要：本文件不引入业务依赖（db、http、模型调用等），保持纯逻辑。
 */

const MAX_STEPS = 50;
const DEFAULT_STEPS = 10;
const ACTIVE_STATUSES = new Set(['queued', 'running', 'approval_required', 'awaiting_approval']);
const MAX_GOAL_LENGTH = 2000;
const MAX_DAG_NODES = 100;
const MAX_DAG_DEPENDENCIES = 50;
const SCHEDULE_FREQUENCIES = new Set(['manual', 'daily', 'weekly', 'cron']);
const TOOL_POLICIES = new Set(['all', 'builtin_only']);
const RUN_MODES = new Set(['standard', 'deep', 'audit', 'dag']);
const APPROVAL_POLICIES = new Set(['safe_mcp_auto', 'approve_all_mcp']);
const { normalizeJsonSchema } = require('./agent-dag-contracts');

// 解码 U+FFFD 替换字符；不能直接出现在源文件中，否则会被 check:text 误报为乱码
const REPLACEMENT_CHAR = String.fromCharCode(0xFFFD);
const CORRUPT_TITLE_FULL_RE = new RegExp(`^[?${REPLACEMENT_CHAR}\\s._-]+$`);
const CORRUPT_TITLE_RUN_RE = new RegExp(`[?${REPLACEMENT_CHAR}]{3,}`);
const CORRUPT_TITLE_COUNT_RE = new RegExp(`[?${REPLACEMENT_CHAR}]`, 'g');

function parseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch (err) {
            return null;
        }
    }
}

function normalizeMaxSteps(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STEPS;
    return Math.min(parsed, MAX_STEPS);
}

function normalizePriority(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(Math.min(parsed, 9), -9);
}

function normalizeRunMode(value) {
    const mode = String(value || 'standard').trim();
    return RUN_MODES.has(mode) ? mode : 'standard';
}

function normalizeToolPolicy(value) {
    const policy = String(value || 'all').trim();
    return TOOL_POLICIES.has(policy) ? policy : 'all';
}

function normalizeApprovalPolicy(value) {
    const policy = String(value || 'safe_mcp_auto').trim();
    return APPROVAL_POLICIES.has(policy) ? policy : 'safe_mcp_auto';
}

function normalizePositiveInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
}

function normalizeDagCoordinate(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(Math.max(0, Math.min(parsed, 100000)) * 100) / 100;
}

function normalizeScheduleFrequency(value) {
    const frequency = String(value || 'manual').trim();
    return SCHEDULE_FREQUENCIES.has(frequency) ? frequency : 'manual';
}

function normalizeContextConfig(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (e) {
            parsed = { mode: value };
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    const mode = ['none', 'auto', 'recent', 'knowledge', 'custom'].includes(String(parsed.mode || 'auto'))
        ? String(parsed.mode || 'auto')
        : 'auto';
    return {
        mode,
        notes: String(parsed.notes || '').trim().slice(0, 1000)
    };
}

function serializeContextConfig(value) {
    return JSON.stringify(normalizeContextConfig(value));
}

const DAG_WHEN_OPERATORS = new Set([
    'equals',
    'not_equals',
    'contains',
    'not_contains',
    'starts_with',
    'ends_with',
    'greater_than',
    'greater_or_equal',
    'less_than',
    'less_or_equal',
    'empty',
    'not_empty',
    'exists',
    'not_exists',
    'is_true',
    'is_false'
]);

function normalizeDagWhen(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const rawSource = Array.isArray(value.source || value.variable_selector)
        ? (value.source || value.variable_selector).join('.')
        : String(value.source || value.variable || '').trim();
    const source = rawSource
        .replace(/^\s*\{\{\s*/, '')
        .replace(/\s*\}\}\s*$/, '')
        .trim()
        .slice(0, 240);
    if (!source) return null;
    const operator = DAG_WHEN_OPERATORS.has(String(value.operator || '').trim())
        ? String(value.operator || '').trim()
        : 'equals';
    let expected = value.value;
    if (expected === undefined || expected === null) expected = '';
    if (!['string', 'number', 'boolean'].includes(typeof expected)) {
        try {
            expected = JSON.stringify(expected);
        } catch (e) {
            expected = String(expected || '');
        }
    }
    if (typeof expected === 'string') expected = expected.slice(0, 2000);
    return { source, operator, value: expected };
}

function normalizeDagSpec(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (e) {
            parsed = {};
        }
    }
    const rawNodes = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.nodes) ? parsed.nodes : []);
    if (rawNodes.length > MAX_DAG_NODES) {
        const err = new Error(`工作流最多允许 ${MAX_DAG_NODES} 个节点，当前为 ${rawNodes.length} 个。`);
        err.status = 400;
        err.code = 'AGENT_DAG_NODE_LIMIT';
        throw err;
    }
    const rawLayout = !Array.isArray(parsed) && parsed?.layout && typeof parsed.layout === 'object' && !Array.isArray(parsed.layout)
        ? parsed.layout
        : {};
    const nodes = rawNodes.map((node, index) => {
        const key = String(node.id || node.key || `node_${index + 1}`).trim().replace(/[^\w.-]/g, '_').slice(0, 60) || `node_${index + 1}`;
        const dependsOn = Array.isArray(node.dependsOn || node.depends_on)
            ? (node.dependsOn || node.depends_on).map(item => String(item || '').trim()).filter(Boolean)
            : String(node.dependsOn || node.depends_on || '').split(',').map(item => item.trim()).filter(Boolean);
        if (dependsOn.length > MAX_DAG_DEPENDENCIES) {
            const err = new Error(`节点“${node.title || key}”最多允许 ${MAX_DAG_DEPENDENCIES} 个上游依赖。`);
            err.status = 400;
            err.code = 'AGENT_DAG_DEPENDENCY_LIMIT';
            throw err;
        }
        const savedPosition = rawLayout[key] || node.position || {};
        const x = normalizeDagCoordinate(savedPosition.x ?? node._x);
        const y = normalizeDagCoordinate(savedPosition.y ?? node._y);
        const when = normalizeDagWhen(node.when || node.when_rule);
        return {
            id: key,
            title: String(node.title || key).trim().slice(0, 120),
            tool: String(node.tool || node.toolName || node.tool_name || '').trim(),
            input: node.input && typeof node.input === 'object' ? node.input : {},
            inputSchema: normalizeJsonSchema(node.inputSchema || node.input_schema || {}),
            outputSchema: normalizeJsonSchema(node.outputSchema || node.output_schema || {}),
            dependsOn,
            condition: ['always', 'success', 'failure'].includes(String(node.condition || 'success')) ? String(node.condition || 'success') : 'success',
            ...(when ? { when } : {}),
            retryLimit: normalizePositiveInt(node.retryLimit ?? node.retry_limit, 0, 0, 5),
            timeoutMs: normalizePositiveInt(node.timeoutMs ?? node.timeout_ms, 0, 0, 10 * 60 * 1000),
            onError: ['skip_dependents', 'continue', 'stop'].includes(String(node.onError || node.on_error || 'skip_dependents'))
                ? String(node.onError || node.on_error || 'skip_dependents')
                : 'skip_dependents',
            _layout: x === null || y === null ? null : { x, y }
        };
    });
    const layout = Object.fromEntries(nodes
        .filter(node => node._layout)
        .map(node => [node.id, node._layout]));
    const cleanNodes = nodes.map(({ _layout, ...node }) => node);
    return {
        nodes: cleanNodes,
        layout
    };
}

function inspectDagTopology(value) {
    const dag = value && Array.isArray(value.nodes) ? value : normalizeDagSpec(value);
    const nodes = dag.nodes || [];
    const blockers = [];
    const warnings = [];
    if (!nodes.length) blockers.push('工作流至少需要一个节点。');
    if (nodes.length > MAX_DAG_NODES) blockers.push(`工作流最多允许 ${MAX_DAG_NODES} 个节点。`);
    const counts = new Map();
    nodes.forEach(node => counts.set(node.id, (counts.get(node.id) || 0) + 1));
    [...counts.entries()].filter(([, count]) => count > 1).forEach(([id]) => blockers.push(`节点 ID 重复：${id}`));
    const ids = new Set(nodes.map(node => node.id));
    nodes.forEach(node => {
        if (!String(node.tool || '').trim()) blockers.push(`节点“${node.title || node.id}”未选择工具。`);
        const dependencies = Array.isArray(node.dependsOn) ? node.dependsOn : [];
        if (dependencies.length > MAX_DAG_DEPENDENCIES) blockers.push(`节点“${node.title || node.id}”的上游依赖超过 ${MAX_DAG_DEPENDENCIES} 个。`);
        if (new Set(dependencies).size !== dependencies.length) blockers.push(`节点“${node.title || node.id}”存在重复依赖。`);
        dependencies.forEach(dep => {
            if (dep === node.id) blockers.push(`节点“${node.title || node.id}”不能依赖自身。`);
            else if (!ids.has(dep)) blockers.push(`节点“${node.title || node.id}”依赖了不存在的节点：${dep}`);
        });
    });
    const colors = new Map();
    const byId = new Map(nodes.map(node => [node.id, node]));
    const visit = id => {
        if (colors.get(id) === 1) return true;
        if (colors.get(id) === 2) return false;
        colors.set(id, 1);
        const cyclic = (byId.get(id)?.dependsOn || []).some(dep => byId.has(dep) && visit(dep));
        colors.set(id, 2);
        return cyclic;
    };
    if (nodes.some(node => visit(node.id))) blockers.push('工作流存在循环依赖。');
    if (nodes.length > 1) {
        const linked = new Map(nodes.map(node => [node.id, new Set()]));
        nodes.forEach(node => (node.dependsOn || []).forEach(dep => {
            if (!linked.has(dep)) return;
            linked.get(node.id).add(dep);
            linked.get(dep).add(node.id);
        }));
        const seen = new Set();
        const stack = [nodes[0].id];
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            linked.get(id)?.forEach(next => stack.push(next));
        }
        if (seen.size !== nodes.length) warnings.push('工作流包含彼此不连通的节点组；它们会并行执行并产生多个终点输出。');
    }
    return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)], nodeCount: nodes.length };
}

function normalizeToolAllowlist(value) {
    let list = value;
    if (typeof value === 'string') {
        try {
            list = JSON.parse(value);
        } catch (e) {
            list = value.split(',');
        }
    }
    if (!Array.isArray(list)) return [];
    return [...new Set(list
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 80))];
}

function serializeToolAllowlist(value) {
    const list = normalizeToolAllowlist(value);
    return list.length ? JSON.stringify(list) : '';
}

function normalizeAgentGoal(goal) {
    const cleanGoal = String(goal || '').trim();
    if (cleanGoal.length < 4) {
        const err = new Error('请填写更明确的智能体目标。');
        err.status = 400;
        throw err;
    }
    if (cleanGoal.length > MAX_GOAL_LENGTH) {
        const err = new Error(`智能体目标不能超过 ${MAX_GOAL_LENGTH} 个字符。`);
        err.status = 400;
        throw err;
    }
    return cleanGoal;
}

function looksLikeCorruptTitle(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    if (CORRUPT_TITLE_FULL_RE.test(text) && CORRUPT_TITLE_RUN_RE.test(text)) return true;
    const questionCount = (text.match(CORRUPT_TITLE_COUNT_RE) || []).length;
    return questionCount >= 3 && questionCount / Math.max(text.length, 1) > 0.55;
}

function normalizeAgentTitle(title, goal) {
    const fallback = String(goal || '').trim().slice(0, 40) || '智能体任务';
    const cleanTitle = String(title || '').trim();
    if (looksLikeCorruptTitle(cleanTitle)) return fallback;
    return cleanTitle.slice(0, 80);
}

module.exports = {
    MAX_STEPS,
    DEFAULT_STEPS,
    ACTIVE_STATUSES,
    MAX_GOAL_LENGTH,
    MAX_DAG_NODES,
    MAX_DAG_DEPENDENCIES,
    SCHEDULE_FREQUENCIES,
    TOOL_POLICIES,
    RUN_MODES,
    APPROVAL_POLICIES,
    parseJsonObject,
    normalizeMaxSteps,
    normalizePriority,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizeApprovalPolicy,
    normalizePositiveInt,
    normalizeScheduleFrequency,
    normalizeContextConfig,
    serializeContextConfig,
    normalizeDagSpec,
    inspectDagTopology,
    normalizeDagWhen,
    normalizeToolAllowlist,
    serializeToolAllowlist,
    normalizeAgentGoal,
    looksLikeCorruptTitle,
    normalizeAgentTitle
};
