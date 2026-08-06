const { db } = require('../db');
const {
    ACTIVE_STATUSES,
    normalizeMaxSteps
} = require('./agent-validators');
const { isSuperAdmin } = require('../permissions');
const { getAgentTraceForUser } = require('./agent-traces');
const { summarizeAgentCheckpoints } = require('./agent-checkpoints');
const runRepository = require('../repositories/agent-runs');

function getRunForUser(runId, user, options = {}) {
    return runRepository.getRunForUser(runId, user.id, {
        includeDeleted: Boolean(options.includeDeleted)
    });
}

function listRuns(user, options = {}) {
    return runRepository.listRuns(user.id, options);
}

function listDeletedRunsForAdmin(user, limit = 100) {
    if (!isSuperAdmin(user)) {
        const err = new Error('仅 admin 权限层级可查看智能体任务删除审计。');
        err.status = 403;
        throw err;
    }
    return runRepository.listDeletedRunsForAdmin(limit);
}

function listSteps(runId) {
    return runRepository.listSteps(runId);
}

function safeWorkflowNodeId(value, fallback = 'node') {
    const normalized = String(value || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^\w-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return normalized || fallback;
}

function uniqueWorkflowNodeId(used, value, fallback) {
    const base = safeWorkflowNodeId(value, fallback);
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
        candidate = `${base}_${index}`;
        index += 1;
    }
    used.add(candidate);
    return candidate;
}

function normalizeWorkflowDraftInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    try {
        return JSON.parse(JSON.stringify(input));
    } catch (e) {
        return {};
    }
}

function buildWorkflowDraftLlmPrompt(run, toolNodes) {
    const referencedOutputs = toolNodes
        .map(node => `- ${node.title}：{{nodes.${node.id}.output}}`)
        .join('\n');
    const upstreamText = referencedOutputs || '- 没有可复用工具节点，请直接围绕 {{goal}} 形成结果。';
    return [
        '请基于自由任务目标和上游节点输出，整理为可交付的中文结果。',
        '',
        '任务目标：{{goal}}',
        '',
        '上游节点输出：',
        upstreamText,
        '',
        '输出要求：',
        '1. 先给结论，再列依据和下一步建议。',
        '2. 明确说明哪些内容来自工具结果，哪些是你的分析。',
        '3. 如果上游结果不足，请指出需要补充的资料或能力。'
    ].join('\n');
}

function buildWorkflowDraftFromRun(run, steps = []) {
    const used = new Set();
    const toolSteps = steps
        .filter(step => step.type === 'tool' && step.tool_name && step.status !== 'error')
        .slice(0, 12);
    const toolNodes = toolSteps.map((step, index) => {
        const id = uniqueWorkflowNodeId(used, step.tool_name || step.title, `tool_${index + 1}`);
        return {
            id,
            title: String(step.title || `执行工具：${step.tool_name}`).replace(/^工具执行完成：/, '').slice(0, 120) || `工具节点 ${index + 1}`,
            tool: step.tool_name,
            input: normalizeWorkflowDraftInput(step.input),
            dependsOn: index === 0 ? [] : [Array.from(used)[index - 1]],
            condition: 'success',
            retryLimit: 1,
            timeoutMs: 0,
            onError: 'skip_dependents'
        };
    });
    const llmId = uniqueWorkflowNodeId(used, 'llm_summary', 'llm_summary');
    const modelId = String(run.model_id || '').trim();
    const llmNode = {
        id: llmId,
        title: '汇总自由任务结果',
        tool: 'agent.llm',
        input: {
            prompt: buildWorkflowDraftLlmPrompt(run, toolNodes),
            model: modelId,
            maxSteps: Number(run.max_steps || 20) || 20
        },
        dependsOn: toolNodes.length ? [toolNodes[toolNodes.length - 1].id] : [],
        condition: 'success',
        retryLimit: 0,
        timeoutMs: 0,
        onError: 'skip_dependents'
    };
    const sourceTitle = String(run.title || run.goal || '').trim();
    return {
        name: `由自由任务生成：${sourceTitle || run.id}`.slice(0, 100),
        description: `从自由任务 ${run.id} 生成的工作流草稿。请在编排页检查节点、参数和发布策略后再用于生产任务。`.slice(0, 300),
        dagSpec: { nodes: [...toolNodes, llmNode] },
        sourceRun: {
            id: run.id,
            title: run.title || '',
            goal: run.goal || '',
            run_mode: run.run_mode || '',
            status: run.status || '',
            model_id: run.model_id || null,
            model_name: run.model_name || ''
        },
        summary: {
            toolNodeCount: toolNodes.length,
            nodeCount: toolNodes.length + 1,
            generatedAt: new Date().toISOString()
        }
    };
}

function createWorkflowDraftFromRun(runId, user) {
    const run = db.prepare(`
        SELECT r.*, m.name AS model_name
        FROM agent_runs r
        LEFT JOIN models m ON m.id = r.model_id
        WHERE r.id = ? AND r.user_id = ? AND r.deleted_at IS NULL
    `).get(runId, user.id);
    if (!run) return null;
    if (String(run.run_mode || '') === 'dag') {
        const err = new Error('工作流任务已经具备编排结构，请直接在工作流页加载或复制。');
        err.status = 400;
        throw err;
    }
    return buildWorkflowDraftFromRun(run, listSteps(run.id));
}

function sortDagNodesByDependencies(nodes = []) {
    const entries = nodes.map((node, index) => ({
        node,
        index,
        key: String(node.node_key || node.id || `__node_${index}`),
        uniqueKey: `${String(node.node_key || node.id || '__node')}::${index}`
    }));
    const keys = new Set(entries.map(entry => entry.key));
    const dependencyKeys = (node) => (Array.isArray(node.depends_on) ? node.depends_on : [])
        .map(dep => String(dep || '').trim())
        .filter(dep => dep && keys.has(dep));
    const ordered = [];
    const placed = new Set();
    const placedKeys = new Set();
    while (ordered.length < entries.length) {
        const remaining = entries.filter(entry => !placed.has(entry.uniqueKey));
        const ready = remaining.filter(entry => dependencyKeys(entry.node).every(dep => placedKeys.has(dep)));
        const layer = ready.length ? ready : remaining;
        layer.sort((a, b) => a.index - b.index);
        layer.forEach(entry => {
            if (placed.has(entry.uniqueKey)) return;
            placed.add(entry.uniqueKey);
            placedKeys.add(entry.key);
            ordered.push(entry.node);
        });
    }
    return ordered;
}

function listDagNodes(runId) {
    const nodes = runRepository.listDagNodes(runId);
    return sortDagNodesByDependencies(nodes);
}

function getRunProgress(run, steps = []) {
    const maxSteps = normalizeMaxSteps(run?.max_steps);
    const planCount = steps.filter(step => step.type === 'plan').length;
    const toolCount = steps.filter(step => step.type === 'tool').length;
    const errorCount = steps.filter(step => step.status === 'error').length;
    const totalDurationMs = steps.reduce((sum, step) => sum + (Number(step.duration_ms) || 0), 0);
    const active = run && ACTIVE_STATUSES.has(run.status);
    return {
        maxSteps,
        planCount,
        toolCount,
        errorCount,
        stepCount: steps.length,
        totalDurationMs,
        isLimitReached: active && Math.max(planCount, toolCount) >= maxSteps,
        percent: active ? Math.min(Math.round((Math.max(planCount, toolCount) / maxSteps) * 100), 95) : (['completed', 'completed_with_errors'].includes(run?.status) ? 100 : 0)
    };
}

function getRunDetailForUser(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    const steps = listSteps(run.id);
    return {
        run,
        steps,
        dagNodes: listDagNodes(run.id),
        progress: getRunProgress(run, steps),
        trace: getAgentTraceForUser(run.id, user),
        checkpoints: summarizeAgentCheckpoints(run.id)
    };
}

module.exports = {
    createWorkflowDraftFromRun,
    getRunDetailForUser,
    getRunForUser,
    getRunProgress,
    listDagNodes,
    listDeletedRunsForAdmin,
    listRuns,
    sortDagNodesByDependencies,
    listSteps
};
