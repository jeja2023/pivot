'use strict';

const { query, queryOne } = require('../db/client');
const { sendAgentControlMessage } = require('./agent-control');
const { resolveChildDelegationConstraints } = require('./agent-collaboration');
const { getDelegationRolePolicySnapshot } = require('./agent-delegation-role-policies');

const MAX_CHILDREN_PER_SPAWN = 8;
const TERMINAL_CHILD_STATUSES = new Set(['completed', 'completed_with_errors', 'partial', 'error', 'failed', 'cancelled', 'deleted']);
const APPLIED_HANDOFF_STATUSES = new Set(['applied', 'acknowledged']);

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

function runtimeFor(context = {}) {
    if (context.collaborationRuntime) return context.collaborationRuntime;
    const runtime = require('./agent-runtime');
    return runtime.runs;
}

async function loadDirectChildren(run, user) {
    return await query(`
        SELECT r.id, r.title, r.goal, r.status, r.final_answer, r.error_message, r.created_at, r.updated_at, r.completed_at, r.metadata,
               v.outcome_status AS verification_outcome_status, v.report AS verification_report,
               handoff.status AS handoff_status, handoff.message_id AS handoff_message_id
        FROM agent_runs r
        LEFT JOIN agent_verifications v ON v.run_id = r.id
        LEFT JOIN LATERAL (
            SELECT c.status, c.message_id
            FROM agent_control_messages c
            WHERE c.from_run_id = r.id AND c.to_run_id = ? AND c.message_type = 'reply'
              AND c.payload ->> 'kind' = 'delegation_completion'
            ORDER BY c.id DESC LIMIT 1
        ) handoff ON true
        WHERE r.parent_run_id = ? AND r.user_id = ? AND r.deleted_at IS NULL
        ORDER BY r.created_at ASC
    `, [run.id, run.id, user.id]);
}

function childJoinAcceptance(row = {}) {
    const status = String(row.status || '');
    const verification = row.verification_outcome_status || '';
    const handoffStatus = String(row.handoff_status || '');
    const hasAnswer = Boolean(String(row.final_answer || '').trim());
    const terminal = TERMINAL_CHILD_STATUSES.has(status);
    const accepted = status === 'completed' && verification === 'verified' && hasAnswer && APPLIED_HANDOFF_STATUSES.has(handoffStatus);
    let reason = '';
    if (!terminal) reason = '子任务尚未结束。';
    else if (status !== 'completed') reason = `子任务终态为 ${status}，不能作为已验收交付。`;
    else if (verification !== 'verified') reason = verification ? `子任务验收状态为 ${verification}，未达到 verified。` : '子任务缺少独立 VerificationReport。';
    else if (!hasAnswer) reason = '子任务没有可汇合的最终结果。';
    else if (!APPLIED_HANDOFF_STATUSES.has(handoffStatus)) reason = handoffStatus ? `完成 Handoff 当前为 ${handoffStatus}，尚未由 Supervisor 持久应用。` : '子任务缺少已应用的完成 Handoff。';
    return { terminal, accepted, verificationOutcome: String(verification || ''), handoffStatus, rejectionReason: reason };
}

function publicChild(row) {
    const metadata = parseJson(row.metadata, {});
    const acceptance = childJoinAcceptance(row);
    return {
        id: row.id,
        title: row.title || '',
        status: row.status || '',
        finalAnswer: String(row.final_answer || '').slice(0, 12000),
        error: String(row.error_message || '').slice(0, 2000),
        completedAt: row.completed_at || null,
        metadata,
        ...acceptance
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
    const rolePolicySnapshot = await getDelegationRolePolicySnapshot(run.tenant_id || user.tenant_id || user.tenantId || 1);
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
        const constraints = resolveChildDelegationConstraints({ ...run, rolePolicies: rolePolicySnapshot.policies }, task);
        const child = await runtime.createAgentRun({
            user,
            parentRunId: run.id,
            goal,
            title: String(task.title || `子任务 ${index + 1}`).trim().slice(0, 160),
            modelId: constraints.modelId,
            maxSteps: constraints.maxSteps,
            maxTokenBudget: constraints.maxTokenBudget,
            timeoutMs: constraints.timeoutMs,
            toolTimeoutMs: constraints.toolTimeoutMs,
            runMode: constraints.runMode,
            toolPolicy: constraints.toolPolicy,
            toolAllowlist: constraints.toolAllowlist,
            approvalPolicy: constraints.approvalPolicy,
            networkPolicy: constraints.networkPolicy,
            taskContract: task.taskContract || task.task_contract || null,
            forkHistory: task.forkHistory || task.fork_history || 'none',
            metadata: {
                // 与 API 委派统一为 delegation，确保终态会生成持久化、可重试的
                // completion Handoff；否则 Supervisor 只能凭数据库终态猜测结果。
                source: 'delegation',
                collaboration: {
                    supervisorRunId: run.id,
                    agentName: String(task.agentName || task.agent_name || `子智能体 ${index + 1}`).slice(0, 80),
                    role: String(task.role || 'custom').slice(0, 30),
                    rolePolicy: constraints.rolePolicy,
                    rolePolicyRevision: rolePolicySnapshot.revision,
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
    if (requested && [...requested].some(id => !children.some(child => String(child.id) === id))) {
        throw collaborationError('指定的子任务不存在、无权访问或不是当前任务的直接子任务。', 'AGENT_CHILD_NOT_FOUND', 404);
    }
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
    const failures = waiting.children.filter(child => !child.accepted);
    const accepted = waiting.complete && failures.length === 0;
    return {
        type: 'agent_join',
        parentRunId: waiting.parentRunId,
        complete: waiting.complete,
        accepted,
        failures,
        results: waiting.children.map(child => ({
            id: child.id, title: child.title, status: child.status, finalAnswer: child.finalAnswer, error: child.error,
            terminal: child.terminal, accepted: child.accepted, verificationOutcome: child.verificationOutcome,
            handoffStatus: child.handoffStatus, rejectionReason: child.rejectionReason
        })),
        text: !waiting.complete
            ? '仍有子任务未结束，不能生成完整汇总。'
            : accepted ? '所有子任务均已通过独立验收，结果可汇总。' : '子任务虽已结束，但至少一项未通过汇合验收；不得生成完整交付结论。'
    };
}

module.exports = {
    executeAgentCancel,
    executeAgentJoin,
    executeAgentMessage,
    executeAgentSpawn,
    executeAgentWait,
    childJoinAcceptance,
    getAgentCollaborationToolDefinitions
};
