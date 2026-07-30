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
const ACTIVE_STATUSES = new Set(['queued', 'running', 'approval_required']);
const MAX_GOAL_LENGTH = 2000;
const SCHEDULE_FREQUENCIES = new Set(['manual', 'daily', 'weekly']);
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
    const rawLayout = !Array.isArray(parsed) && parsed?.layout && typeof parsed.layout === 'object' && !Array.isArray(parsed.layout)
        ? parsed.layout
        : {};
    const seen = new Set();
    const nodes = rawNodes.slice(0, 24).map((node, index) => {
        const key = String(node.id || node.key || `node_${index + 1}`).trim().replace(/[^\w.-]/g, '_').slice(0, 60) || `node_${index + 1}`;
        const uniqueKey = seen.has(key) ? `${key}_${index + 1}` : key;
        seen.add(uniqueKey);
        const dependsOn = Array.isArray(node.dependsOn || node.depends_on)
            ? (node.dependsOn || node.depends_on).map(item => String(item || '').trim()).filter(Boolean).slice(0, 12)
            : String(node.dependsOn || node.depends_on || '').split(',').map(item => item.trim()).filter(Boolean).slice(0, 12);
        const savedPosition = rawLayout[key] || rawLayout[uniqueKey] || node.position || {};
        const x = normalizeDagCoordinate(savedPosition.x ?? node._x);
        const y = normalizeDagCoordinate(savedPosition.y ?? node._y);
        return {
            id: uniqueKey,
            title: String(node.title || uniqueKey).trim().slice(0, 120),
            tool: String(node.tool || node.toolName || node.tool_name || '').trim(),
            input: node.input && typeof node.input === 'object' ? node.input : {},
            inputSchema: normalizeJsonSchema(node.inputSchema || node.input_schema || {}),
            outputSchema: normalizeJsonSchema(node.outputSchema || node.output_schema || {}),
            dependsOn,
            condition: ['always', 'success'].includes(String(node.condition || 'success')) ? String(node.condition || 'success') : 'success',
            retryLimit: normalizePositiveInt(node.retryLimit ?? node.retry_limit, 0, 0, 5),
            timeoutMs: normalizePositiveInt(node.timeoutMs ?? node.timeout_ms, 0, 0, 10 * 60 * 1000),
            onError: ['skip_dependents', 'continue', 'stop'].includes(String(node.onError || node.on_error || 'skip_dependents'))
                ? String(node.onError || node.on_error || 'skip_dependents')
                : 'skip_dependents',
            _layout: x === null || y === null ? null : { x, y }
        };
    }).filter(node => node.tool);
    const validKeys = new Set(nodes.map(node => node.id));
    const layout = Object.fromEntries(nodes
        .filter(node => node._layout)
        .map(node => [node.id, node._layout]));
    const cleanNodes = nodes.map(({ _layout, ...node }) => ({
        ...node,
        dependsOn: node.dependsOn.filter(dep => validKeys.has(dep) && dep !== node.id)
    }));
    const requestedPrimaryId = String(
        (!Array.isArray(parsed) && (parsed?.primaryLlmNodeId ?? parsed?.primary_llm_node_id)) || ''
    ).trim().replace(/[^\w.-]/g, '_').slice(0, 60);
    const llmIds = cleanNodes
        .filter(node => node.tool === 'agent.llm')
        .map(node => node.id);
    return {
        nodes: cleanNodes,
        primaryLlmNodeId: llmIds.includes(requestedPrimaryId) ? requestedPrimaryId : (llmIds[0] || ''),
        layout
    };
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
    normalizeToolAllowlist,
    serializeToolAllowlist,
    normalizeAgentGoal,
    looksLikeCorruptTitle,
    normalizeAgentTitle
};
