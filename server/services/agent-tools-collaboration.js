'use strict';

const { query, queryOne } = require('../db/client');
const { normalizeToolAllowlist } = require('./agent-validators');
const { sendAgentControlMessage } = require('./agent-control');

const MAX_CHILDREN_PER_SPAWN = 8;
const TERMINAL_CHILD_STATUSES = new Set(['completed', 'completed_with_errors', 'partial', 'error', 'failed', 'cancelled', 'deleted']);

function getAgentCollaborationToolDefinitions(asJsonSchema) {
    return [
        {
            name: 'agent.spawn', title: '创建自主子任务',
            description: '创建继承父任务预算和权限边界的自主子任务。子任务可独立使用获授权工具并通过结构化结果回报。',
            input_schema: asJsonSchema({
                goal: { type: 'string', maxLength: 12000 }, title: { type: 'string', maxLength: 160 }, agentName: { type: 'string', maxLength: 80 },
                role: { type: 'string', maxLength: 30 }, instructions: { type: 'string', maxLength: 6000 }, modelId: { type: 'string' },
                maxSteps: { type: 'integer', minimum: 1, maximum: 60 }, maxTokenBudget: { type: 'integer', minimum: 0, maximum: 10000000 },
                toolPolicy: { type: 'string', enum: ['all', 'builtin_only'] }, toolAllowlist: { type: 'array', items: { type: 'string' } },
                taskContract: { type: 'object' }, tasks: { type: 'array', maxItems: MAX_CHILDREN_PER_SPAWN, items: { type: 'object' } }
            })
        },
        {
            name: 'agent.wait', title: '查看子任务状态', description: '读取当前任务直接子任务的持久状态；不会空转等待或占用执行槽。',
            input_schema: asJsonSchema({ childRunIds: { type: 'array', items: { type: 'string' }, maxItems: 32 } })
        },
        {
            name: 'agent.message', title: '向子任务发送要求', description: '向当前任务的直接子任务发送可恢复的补充要求或纠偏指令。',
            input_schema: asJsonSchema({ childRunId: { type: 'string' }, message: { type: 'string', maxLength: 120000 }, payload: { type: 'object' } }, ['childRunId'])
        },
        {
            name: 'agent.cancel', title: '停止子任务', description: '停止当前任务的直接子任务；已发生的外部副作用会保留审计记录。',
            input_schema: asJsonSchema({ childRunId: { type: 'string' } }, ['childRunId'])
        },
        {
            name: 'agent.join', title: '汇总子任务', description: '收集直接子任务的结果与错误；未结束的子任务会明确保留为未完成。',
            input_schema: asJsonSchema({ childRunIds: { type: 'array', items: { type: 'string' }, maxItems: 32 } })
        }
    ];
}

function collaborationError(message, code = 'AGENT_COLLABORATION_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function parentRun(context = {}) {
    const run = context.run || {};
    if (!run.id || !run.user_id) throw collaborationError('协作工具只能在持久化 Agent Run 中执行。', 'AGENT_COLLABORATION_RUN_REQUIRED', 409);
    return run;
}

function parentAllowlist(run = {}) {
    return normalizeToolAllowlist(run.tool_allowlist || run.toolAllowlist || []);
}

function inheritedToolAllowlist(run, requested) {
    const parent = parentAllowlist(run);
    const child = normalizeToolAllowlist(requested || []);
    if (!parent.length) return child;
    return child.length ? parent.filter(name => child.includes(name)) : parent;
}

function runtimeFor(context = {}) {
    if (context.collaborationRuntime) return context.collaborationRuntime;
    const runtime = require('./agent-runtime');
    return runtime.runs;
}

async function loadDirectChildren(run, user) {
    return await query(`
        SELECT id, title, goal, status, final_answer, error_message, created_at, updated_at, completed_at, metadata
        FROM agent_runs
        WHERE parent_run_id = ? AND user_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC
    `, [run.id, user.id]);
}

function publicChild(row) {
    return {
        id: row.id,
        title: row.title || '',
        status: row.status || '',
        finalAnswer: String(row.final_answer || '').slice(0, 12000),
        error: String(row.error_message || '').slice(0, 2000),
        completedAt: row.completed_at || null,
        metadata: parseJson(row.metadata, {})
    };
}

async function assertDirectChild(run, user, childRunId) {
    const child = await queryOne(`
        SELECT * FROM agent_runs
        WHERE id = ? AND parent_run_id = ? AND user_id = ? AND deleted_at IS NULL
    `, [String(childRunId || ''), run.id, user.id]);
    if (!child) throw collaborationError('子任务不存在、不是当前任务的直接子任务或无权访问。', 'AGENT_CHILD_NOT_FOUND', 404);
    return child;
}

async function executeAgentSpawn(input = {}, user, context = {}) {
    const run = parentRun(context);
    const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
    if (!tasks.length || tasks.length > MAX_CHILDREN_PER_SPAWN) {
        throw collaborationError(`一次委派必须包含 1 至 ${MAX_CHILDREN_PER_SPAWN} 个子任务。`, 'AGENT_CHILD_BATCH_LIMIT');
    }
    const runtime = runtimeFor(context);
    if (typeof runtime.createAgentRun !== 'function') throw collaborationError('当前执行面未配置子任务运行时。', 'AGENT_CHILD_RUNTIME_UNAVAILABLE', 503);
    const children = [];
    for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index] && typeof tasks[index] === 'object' ? tasks[index] : {};
        const goal = String(task.goal || task.task || '').trim().slice(0, 12000);
        if (!goal) throw collaborationError(`第 ${index + 1} 个子任务缺少目标。`, 'AGENT_CHILD_GOAL_REQUIRED');
        const child = await runtime.createAgentRun({
            user,
            parentRunId: run.id,
            goal,
            title: String(task.title || `子任务 ${index + 1}`).trim().slice(0, 160),
            modelId: task.modelId || task.model_id || run.chosen_model_id || run.model_id || null,
            maxSteps: task.maxSteps || task.max_steps || Math.min(Number(run.max_steps || 6), 12),
            maxTokenBudget: task.maxTokenBudget || task.max_token_budget || 0,
            runMode: task.runMode || task.run_mode || run.run_mode || 'standard',
            toolPolicy: String(run.tool_policy || '') === 'builtin_only' ? 'builtin_only' : (task.toolPolicy || task.tool_policy || run.tool_policy || 'builtin_only'),
            toolAllowlist: inheritedToolAllowlist(run, task.toolAllowlist || task.tool_allowlist),
            approvalPolicy: task.approvalPolicy || task.approval_policy || run.approval_policy || 'safe_mcp_auto',
            networkPolicy: parseJson(run.network_policy, {}),
            taskContract: task.taskContract || task.task_contract || null,
            forkHistory: task.forkHistory || task.fork_history || 'none',
            metadata: {
                source: 'agent_spawn',
                collaboration: {
                    supervisorRunId: run.id,
                    agentName: String(task.agentName || task.agent_name || `子智能体 ${index + 1}`).slice(0, 80),
                    role: String(task.role || 'custom').slice(0, 30),
                    instructions: String(task.instructions || '').slice(0, 6000),
                    spawnedAt: new Date().toISOString()
                }
            }
        });
        children.push({ id: child.id, title: child.title, status: child.status });
    }
    return { type: 'agent_spawn', parentRunId: run.id, children, text: `已创建 ${children.length} 个子任务。` };
}

async function executeAgentWait(input = {}, user, context = {}) {
    const run = parentRun(context);
    const requested = Array.isArray(input.childRunIds || input.child_run_ids)
        ? new Set((input.childRunIds || input.child_run_ids).map(String)) : null;
    const children = (await loadDirectChildren(run, user))
        .filter(child => !requested || requested.has(String(child.id)))
        .map(publicChild);
    const complete = children.length > 0 && children.every(child => TERMINAL_CHILD_STATUSES.has(child.status));
    return { type: 'agent_wait', parentRunId: run.id, complete, children, text: complete ? '所有目标子任务均已结束。' : '子任务仍在运行或等待输入。' };
}

async function executeAgentMessage(input = {}, user, context = {}) {
    const run = parentRun(context);
    const child = await assertDirectChild(run, user, input.childRunId || input.child_run_id);
    const payload = input.payload && typeof input.payload === 'object'
        ? input.payload
        : { instruction: String(input.message || input.instruction || '').trim().slice(0, 120000) };
    if (!Object.keys(payload).length || !String(payload.instruction || payload.message || '').trim()) {
        throw collaborationError('发送给子任务的消息不能为空。', 'AGENT_CHILD_MESSAGE_REQUIRED');
    }
    const message = await sendAgentControlMessage({ user, fromRunId: run.id, toRunId: child.id, type: 'request', payload });
    return { type: 'agent_message', childRunId: child.id, messageId: message.message_id, text: '已将补充要求发送给子任务。' };
}

async function executeAgentCancel(input = {}, user, context = {}) {
    const run = parentRun(context);
    const child = await assertDirectChild(run, user, input.childRunId || input.child_run_id);
    const runtime = runtimeFor(context);
    if (typeof runtime.cancelAgentRun !== 'function') throw collaborationError('当前执行面未配置子任务取消能力。', 'AGENT_CHILD_RUNTIME_UNAVAILABLE', 503);
    const cancelled = await runtime.cancelAgentRun(child.id, user);
    return { type: 'agent_cancel', childRunId: child.id, status: cancelled?.status || 'cancelled', text: '已请求停止子任务。' };
}

async function executeAgentJoin(input = {}, user, context = {}) {
    const waiting = await executeAgentWait(input, user, context);
    const failures = waiting.children.filter(child => !['completed', 'partial'].includes(child.status));
    return {
        type: 'agent_join',
        parentRunId: waiting.parentRunId,
        complete: waiting.complete,
        failures,
        results: waiting.children.map(child => ({ id: child.id, title: child.title, status: child.status, finalAnswer: child.finalAnswer, error: child.error })),
        text: waiting.complete ? '子任务结果已汇总。' : '仍有子任务未结束，不能生成完整汇总。'
    };
}

module.exports = {
    executeAgentCancel,
    executeAgentJoin,
    executeAgentMessage,
    executeAgentSpawn,
    executeAgentWait,
    getAgentCollaborationToolDefinitions
};
