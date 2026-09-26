/* 智能体输入规范化与常量 Agent Validators & Constants
 *
 * 从 agent-runtime.js 中拆出的纯函数部分，便于：
 *   - 减少 agent-runtime.js 的体积，下一步拆 DAG/调度器/产物时各子模块共享同一套校验。
 *   - 单测覆盖更直接，所有 normalize* 都不依赖数据库。
 *
 * 重要：本文件不引入业务依赖（db、http、模型调用等），保持纯逻辑。
 */

const MAX_STEPS = 60;
const DEFAULT_STEPS = 30;
const AUTO_STEPS_BY_RUN_MODE = Object.freeze({
    standard: 30,
    deep: 50,
    audit: 60,
    dag: 20
});
const MAX_STEPS_BY_RUN_MODE = Object.freeze({
    standard: 30,
    deep: 50,
    audit: 60,
    dag: 60
});
const ACTIVE_STATUSES = new Set([
    'queued', 'planning', 'executing', 'observing', 'diagnosing', 'replanning',
    'running', 'verifying', 'approval_required', 'awaiting_approval', 'waiting_approval', 'resuming', 'needs_input'
]);
// 统一智能体与工作流任务状态中文映射字典
const AGENT_STATUS_LABELS = Object.freeze({
    awaiting_approval: '等待审批',
    approval_required: '待审批',
    waiting_approval: '待审批',
    queued: '排队中',
    planning: '规划中',
    executing: '执行中',
    observing: '观察中',
    diagnosing: '诊断中',
    replanning: '重规划中',
    verifying: '验证结果中',
    resuming: '恢复中',
    pending: '待执行',
    running: '运行中',
    completed: '已完成',
    completed_with_errors: '完成（含部分异常）',
    partial: '部分完成',
    needs_input: '需要补充信息',
    continued_error: '失败后继续',
    issues_found: '存在问题',
    passed: '未发现问题',
    incomplete: '未完整处理',
    success: '成功',
    error: '运行异常',
    failed: '已失败',
    cancelled: '已停止',
    canceled: '已停止',
    skipped: '已跳过',
    deleted: '已删除',
    timeout: '运行超时',
    paused: '已暂停',
    active: '运行中',
    draft: '草稿',
    validating: '验证中',
    validated: '已验证',
    published: '已发布',
    rejected: '已拒绝'
});

function formatAgentStatus(status) {
    const key = String(status || '').trim().toLowerCase();
    return AGENT_STATUS_LABELS[key] || status || '未知';
}

const MAX_GOAL_LENGTH = 2000;
const MAX_DAG_NODES = 100;
const MAX_DAG_DEPENDENCIES = 50;
const SCHEDULE_FREQUENCIES = new Set(['manual', 'interval', 'daily', 'weekly', 'cron']);
const TOOL_POLICIES = new Set(['all', 'builtin_only']);
const RUN_MODES = new Set(['standard', 'deep', 'audit', 'dag']);
const APPROVAL_POLICIES = new Set(['safe_mcp_auto', 'approve_all_mcp']);
// 普通聊天会额外保留会话桥接上下文，允许比手工 Agent 目标更长的当前消息。
const MAX_CHAT_AGENT_GOAL_LENGTH = 12000;
const { normalizeJsonSchema } = require('./agent-dag-contracts');

// 解码 U+FFFD 替换字符；不能直接出现在源文件中，否则会被 check:text 误报为乱码
const REPLACEMENT_CHAR = String.fromCharCode(0xFFFD);
const CORRUPT_TITLE_FULL_RE = new RegExp(`^[?${REPLACEMENT_CHAR}\\s._-]+$`);
const CORRUPT_TITLE_RUN_RE = new RegExp(`[?${REPLACEMENT_CHAR}]{3,}`);
const CORRUPT_TITLE_COUNT_RE = new RegExp(`[?${REPLACEMENT_CHAR}]`, 'g');

// 与 llm.js 的 stripThoughtContent 同一组模式：闭合块整段删除，未闭合块删到文末
//（未闭合意味着思考把输出预算耗尽、正式结果压根没生成，返回空比返回半截思考更正确）。
const THOUGHT_BLOCK_PATTERNS = [
    /<thought\b[^>]*>[\s\S]*?<\/thought>/gi,
    /<thought\b[^>]*>[\s\S]*$/gi,
    /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
    /<thinking\b[^>]*>[\s\S]*$/gi,
    /<think\b[^>]*>[\s\S]*?<\/think>/gi,
    /<think\b[^>]*>[\s\S]*$/gi
];

function stripThoughtBlocks(text = '') {
    let value = String(text ?? '');
    THOUGHT_BLOCK_PATTERNS.forEach(pattern => {
        value = value.replace(pattern, '\n');
    });
    return value;
}

function parseJsonObject(text) {
    if (text && typeof text === 'object' && !Array.isArray(text)) return text;
    // 端点忽略 chat_template_kwargs 时思维链会混在响应里，而思考中往往含 JSON 草稿：
    // 下面的花括号兜底匹配会从思考里的第一个 { 一直吃到正式答案的最后一个 }，必然解析失败。
    // 所以先剥掉思维链再解析。本文件约定不引入业务依赖，故与 llm.js 的 stripThoughtContent 同源内联。
    const raw = stripThoughtBlocks(text).trim();
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

function maxStepsLimitForRunMode(runMode = '') {
    if (!String(runMode || '').trim()) return MAX_STEPS;
    return MAX_STEPS_BY_RUN_MODE[normalizeRunMode(runMode)] || MAX_STEPS;
}

function normalizeMaxSteps(value, runMode = '') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return runMode ? defaultMaxStepsForRunMode(runMode) : DEFAULT_STEPS;
    return Math.min(parsed, maxStepsLimitForRunMode(runMode));
}

function normalizeOptionalMaxSteps(value, runMode = '') {
    if (value === null || value === undefined || String(value).trim() === '') return 0;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(parsed, maxStepsLimitForRunMode(runMode));
}

function defaultMaxStepsForRunMode(value) {
    return AUTO_STEPS_BY_RUN_MODE[normalizeRunMode(value)] || DEFAULT_STEPS;
}

function resolveMaxSteps(value, runMode = 'standard') {
    return normalizeOptionalMaxSteps(value, runMode) || defaultMaxStepsForRunMode(runMode);
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
    // 工作流画布允许使用负坐标，以支持节点在逻辑原点的左侧或上方排布。
    // 限制为有限范围，避免恶意或损坏的布局数据放大 SVG 渲染开销。
    return Math.round(Math.max(-100000, Math.min(parsed, 100000)) * 100) / 100;
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
    let rawCollectionIds = parsed.collectionIds ?? parsed.collection_ids ?? parsed.knowledgeCollectionIds ?? parsed.knowledge_collection_ids ?? [];
    if (typeof rawCollectionIds === 'string') {
        try { rawCollectionIds = JSON.parse(rawCollectionIds); } catch (_) { rawCollectionIds = rawCollectionIds.split(','); }
    }
    if (!Array.isArray(rawCollectionIds)) rawCollectionIds = [rawCollectionIds];
    const collectionIds = [...new Set(rawCollectionIds
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0)
        .slice(0, 12))];
    const projectId = String(parsed.projectId ?? parsed.project_id ?? '').trim().slice(0, 160);
    return {
        mode,
        notes: String(parsed.notes || '').trim().slice(0, 1000),
        collectionIds,
        ...(projectId ? { projectId } : {})
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
    const rawEdges = !Array.isArray(parsed) && Array.isArray(parsed?.edges) ? parsed.edges : [];
    const requestedSchemaVersion = String(parsed?.schemaVersion || parsed?.schema_version || '').trim();
    const hasEdgeModel = rawEdges.length > 0 || requestedSchemaVersion === 'pivot.dag.v2';
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
            onError: ['skip_dependents', 'continue', 'fallback', 'stop'].includes(String(node.onError || node.on_error || 'skip_dependents'))
                ? String(node.onError || node.on_error || 'skip_dependents')
                : 'skip_dependents',
            ...(Object.prototype.hasOwnProperty.call(node, 'fallbackOutput') || Object.prototype.hasOwnProperty.call(node, 'fallback_output')
                ? { fallbackOutput: node.fallbackOutput ?? node.fallback_output }
                : {}),
            cache: node.cache !== false,
            joinMode: ['all', 'any_active'].includes(String(node.joinMode || node.join_mode || 'all'))
                ? String(node.joinMode || node.join_mode || 'all')
                : 'all',
            _layout: x === null || y === null ? null : { x, y }
        };
    });
    const layout = Object.fromEntries(nodes
        .filter(node => node._layout)
        .map(node => [node.id, node._layout]));
    const cleanNodes = nodes.map(({ _layout, ...node }) => node);
    const edges = rawEdges.slice(0, MAX_DAG_NODES * MAX_DAG_DEPENDENCIES).map(edge => {
        const from = String(edge?.from ?? edge?.source ?? '').trim();
        const to = String(edge?.to ?? edge?.target ?? '').trim();
        const route = String(edge?.route ?? 'default').trim().toLowerCase() || 'default';
        return { from, to, route };
    });
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    edges.forEach(edge => {
        const target = nodeById.get(edge.to);
        if (!target || !edge.from || edge.from === edge.to || !['default', 'true', 'false'].includes(edge.route)) return;
        if (!target.dependsOn.includes(edge.from)) target.dependsOn.push(edge.from);
    });
    if (hasEdgeModel) {
        nodes.forEach(node => (node.dependsOn || []).forEach(from => {
            if (!edges.some(edge => edge.from === from && edge.to === node.id)) edges.push({ from, to: node.id, route: 'default' });
        }));
    }
    const result = {
        nodes: cleanNodes,
        layout,
        cacheEnabled: parsed?.cacheEnabled !== false && parsed?.cache_enabled !== false
    };
    if (hasEdgeModel) {
        result.schemaVersion = 'pivot.dag.v2';
        result.edges = edges;
    }
    return result;
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
    const edges = Array.isArray(dag.edges) ? dag.edges : [];
    const seenEdges = new Set();
    edges.forEach(edge => {
        const from = String(edge?.from || '').trim();
        const to = String(edge?.to || '').trim();
        const route = String(edge?.route || 'default').trim().toLowerCase();
        const key = `${from}\u0000${to}\u0000${route}`;
        if (seenEdges.has(key)) blockers.push(`存在重复路由边：${from} → ${to}（${route}）`);
        seenEdges.add(key);
        if (!from || !to) blockers.push('路由边必须指定来源节点和目标节点。');
        if (from && from === to) blockers.push(`路由边不能连接节点自身：${from}`);
        if (!ids.has(from) || !ids.has(to)) blockers.push(`路由边引用了不存在的节点：${from} → ${to}`);
        if (!['default', 'true', 'false'].includes(route)) blockers.push(`路由边使用了不支持的分支：${route}`);
        const sourceNode = nodes.find(node => node.id === from);
        if (route !== 'default' && sourceNode?.tool !== 'workflow.condition') {
            blockers.push(`只有条件节点才能使用 True/False 路由：${from}`);
        }
    });
    const routeTargets = new Map();
    edges.forEach(edge => {
        const key = `${edge.from}\u0000${edge.to}`;
        if (!routeTargets.has(key)) routeTargets.set(key, new Set());
        routeTargets.get(key).add(String(edge.route || 'default'));
    });
    routeTargets.forEach((routes, key) => {
        if (routes.has('true') && routes.has('false')) blockers.push(`同一目标不能同时连接条件节点的 True 和 False 路由：${key.replace('\u0000', ' → ')}`);
    });
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

function normalizeAgentGoal(goal, options = {}) {
    const cleanGoal = String(goal || '').trim();
    const requestedMaxLength = typeof options === 'number' ? options : options?.maxLength;
    const maxLength = Number.isFinite(Number(requestedMaxLength))
        ? Math.max(MAX_GOAL_LENGTH, Math.min(Number(requestedMaxLength), MAX_CHAT_AGENT_GOAL_LENGTH))
        : MAX_GOAL_LENGTH;
    if (cleanGoal.length < 4) {
        const err = new Error('请填写更明确的智能体目标。');
        err.status = 400;
        throw err;
    }
    if (cleanGoal.length > maxLength) {
        const err = new Error(`智能体目标不能超过 ${maxLength} 个字符。`);
        err.status = 400;
        err.code = 'AGENT_GOAL_TOO_LONG';
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
    AUTO_STEPS_BY_RUN_MODE,
    MAX_STEPS_BY_RUN_MODE,
    ACTIVE_STATUSES,
    MAX_GOAL_LENGTH,
    MAX_DAG_NODES,
    MAX_DAG_DEPENDENCIES,
    SCHEDULE_FREQUENCIES,
    TOOL_POLICIES,
    RUN_MODES,
    APPROVAL_POLICIES,
    MAX_CHAT_AGENT_GOAL_LENGTH,
    parseJsonObject,
    normalizeMaxSteps,
    normalizeOptionalMaxSteps,
    defaultMaxStepsForRunMode,
    maxStepsLimitForRunMode,
    resolveMaxSteps,
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
    normalizeAgentTitle,
    AGENT_STATUS_LABELS,
    formatAgentStatus
};
