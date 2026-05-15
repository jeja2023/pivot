const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { estimateTokens } = require('../llm');
const { getAccessibleModel, recordModelTokenUsage } = require('./models');
const { buildChatCompletionsUrl, buildModelHeaders } = require('./model-adapter');
const { clampText, executeBuiltInTool, getBuiltInToolDefinitions } = require('./agent-tools');
const { executeMcpTool, listCachedMcpTools } = require('./mcp-client');

const MAX_STEPS = 8;
const DEFAULT_STEPS = 5;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const MAX_GOAL_LENGTH = 2000;

function createRunId() {
    return `run_${crypto.randomBytes(12).toString('hex')}`;
}

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

function normalizeAgentGoal(goal) {
    const cleanGoal = String(goal || '').trim();
    if (cleanGoal.length < 4) {
        const err = new Error('请填写更明确的自动化目标。');
        err.status = 400;
        throw err;
    }
    if (cleanGoal.length > MAX_GOAL_LENGTH) {
        const err = new Error(`自动化目标不能超过 ${MAX_GOAL_LENGTH} 个字符。`);
        err.status = 400;
        throw err;
    }
    return cleanGoal;
}

function getRunForUser(runId, user, options = {}) {
    const includeDeleted = Boolean(options.includeDeleted);
    return db.prepare(`
        SELECT * FROM agent_runs
        WHERE id = ? AND user_id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).get(runId, user.id);
}

function listRuns(user, limit = 30) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
    return db.prepare(`
        SELECT r.id, r.session_id, r.model_id, r.title, r.goal, r.status, r.final_answer, r.error_message,
               r.max_steps, r.parent_run_id, r.cancelled_at, r.created_at, r.updated_at, r.completed_at,
               m.name AS model_name,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id) AS step_count,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id AND s.type = 'tool') AS tool_count,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id AND s.status = 'error') AS error_count
        FROM agent_runs r
        LEFT JOIN models m ON m.id = r.model_id
        WHERE r.user_id = ?
          AND r.deleted_at IS NULL
        ORDER BY r.created_at DESC
        LIMIT ?
    `).all(user.id, safeLimit);
}

function listDeletedRunsForAdmin(user, limit = 100) {
    if (user?.username !== 'admin') {
        const err = new Error('仅 admin 超级管理员可查看自动化任务删除审计。');
        err.status = 403;
        throw err;
    }
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    return db.prepare(`
        SELECT r.id, r.user_id, u.username, u.nickname, u.unit, r.session_id, r.model_id,
               m.name AS model_name, r.title, r.goal, r.status, r.error_message, r.max_steps,
               r.parent_run_id, r.cancelled_at, r.created_at, r.updated_at, r.completed_at,
               r.deleted_at, r.deleted_by_user, r.delete_reason,
               du.username AS deleted_by_username, du.nickname AS deleted_by_nickname,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id) AS step_count,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id AND s.type = 'tool') AS tool_count,
               (SELECT COUNT(*) FROM agent_steps s WHERE s.run_id = r.id AND s.status = 'error') AS error_count
        FROM agent_runs r
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN users du ON du.id = r.deleted_by_user
        LEFT JOIN models m ON m.id = r.model_id
        WHERE r.deleted_at IS NOT NULL
        ORDER BY r.deleted_at DESC
        LIMIT ?
    `).all(safeLimit);
}

function listSteps(runId) {
    return db.prepare(`
        SELECT id, step_index, type, title, tool_name, input, output, status, duration_ms, created_at
        FROM agent_steps
        WHERE run_id = ?
        ORDER BY step_index ASC, id ASC
    `).all(runId).map(step => ({
        ...step,
        input: parseJsonObject(step.input) || step.input,
        output: parseJsonObject(step.output) || step.output
    }));
}

function updateRun(runId, fields = {}) {
    const allowed = ['status', 'final_answer', 'error_message', 'completed_at', 'updated_at', 'title', 'cancelled_at', 'deleted_at', 'deleted_by_user', 'delete_reason'];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return;
    const set = entries.map(([key]) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE agent_runs SET ${set} WHERE id = ?`).run(...entries.map(([, value]) => value), runId);
}

function getRunStatus(runId) {
    return db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(runId)?.status || '';
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
        percent: active ? Math.min(Math.round((Math.max(planCount, toolCount) / maxSteps) * 100), 95) : (run?.status === 'completed' ? 100 : 0)
    };
}

function getRunDetailForUser(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    const steps = listSteps(run.id);
    return { run, steps, progress: getRunProgress(run, steps) };
}

function isRunCancelled(runId) {
    return getRunStatus(runId) === 'cancelled';
}

function assertRunNotCancelled(runId) {
    if (isRunCancelled(runId)) {
        const err = new Error('自动化任务已停止。');
        err.code = 'AGENT_RUN_CANCELLED';
        throw err;
    }
}

function cancelAgentRun(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (!ACTIVE_STATUSES.has(run.status)) return run;
    const now = getBeijingTimestamp();
    updateRun(runId, {
        status: 'cancelled',
        error_message: '用户已停止任务。',
        cancelled_at: now,
        completed_at: now,
        updated_at: now
    });
    insertStep(runId, listSteps(runId).length + 1, {
        type: 'control',
        title: '用户停止任务',
        output: { status: 'cancelled' }
    });
    return getRunForUser(runId, user);
}

function createChildRunFromExisting(run, user) {
    return createAgentRun({
        user,
        goal: run.goal,
        modelId: run.model_id,
        sessionId: run.session_id,
        title: run.title,
        maxSteps: run.max_steps,
        parentRunId: run.id
    });
}

function rerunAgentRun(runId, user) {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    return createChildRunFromExisting(run, user);
}

function softDeleteAgentRun(runId, user, reason = '') {
    const run = getRunForUser(runId, user);
    if (!run) return null;
    if (ACTIVE_STATUSES.has(run.status)) {
        const err = new Error('请先停止正在运行的自动化任务，再移除记录。');
        err.status = 400;
        throw err;
    }
    const now = getBeijingTimestamp();
    updateRun(runId, {
        deleted_at: now,
        deleted_by_user: user.id,
        delete_reason: String(reason || '').trim().slice(0, 500),
        updated_at: now
    });
    insertStep(runId, listSteps(runId).length + 1, {
        type: 'control',
        title: '用户移除任务记录',
        output: {
            status: 'deleted',
            deletedAt: now,
            deletedBy: user.username || user.id
        }
    });
    return getRunForUser(runId, user, { includeDeleted: true });
}

function insertStep(runId, stepIndex, data = {}) {
    db.prepare(`
        INSERT INTO agent_steps (run_id, step_index, type, title, tool_name, input, output, status, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        stepIndex,
        data.type || 'note',
        data.title || '',
        data.toolName || '',
        data.input === undefined ? '' : JSON.stringify(data.input),
        data.output === undefined ? '' : JSON.stringify(data.output),
        data.status || 'success',
        Number(data.durationMs) || 0,
        getBeijingTimestamp()
    );
}

function formatToolList(user) {
    const builtIns = getBuiltInToolDefinitions(user).map(tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        input_schema: tool.input_schema,
        admin: Boolean(tool.admin)
    }));
    const mcpTools = listCachedMcpTools(null, user).map(tool => ({
        name: tool.fullName,
        description: `[${tool.serverName}] ${tool.description || tool.name}`,
        input_schema: tool.input_schema
    }));
    return [...builtIns, ...mcpTools];
}

async function callModelJson(modelCfg, messages) {
    const response = await axios.post(buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false }), {
        model: modelCfg.model_name || modelCfg.name,
        messages,
        stream: false,
        temperature: 0.2,
        max_tokens: 1200
    }, {
        headers: buildModelHeaders(modelCfg, { acceptJson: true }),
        timeout: 180000,
        proxy: false
    });
    return response.data?.choices?.[0]?.message?.content || response.data?.output_text || '';
}

async function callModelText(modelCfg, messages) {
    try {
        return await callModelJson(modelCfg, messages);
    } catch (e) {
        if (!e.response || e.response.status < 400) throw e;
        throw e;
    }
}

function recordAgentModelUsage(user, modelCfg, messages, output, source = 'agent') {
    const inputTokens = estimateTokens(JSON.stringify(messages || []));
    const outputTokens = estimateTokens(output || '');
    recordModelTokenUsage(user.id, modelCfg.id, inputTokens + outputTokens, source, inputTokens, outputTokens);
}

function buildPlannerMessages(goal, toolList, observations) {
    return [
        {
            role: 'system',
            content: [
                '你是 Pivot 智能体运行时，负责为私有企业 AI 平台决定下一步动作。',
                '只能返回严格 JSON，不要返回 Markdown。',
                'Schema: {"thought":"short reasoning","action":"tool|final","tool":"tool.name","input":{},"answer":"final answer"}',
                '当需要项目内最新数据时使用工具；证据足够后给出中文最终答案。',
                '可用工具：',
                JSON.stringify(toolList, null, 2)
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `目标：${goal}`,
                '已有观察：',
                observations.length ? JSON.stringify(observations, null, 2) : '[]'
            ].join('\n\n')
        }
    ];
}

async function executeToolByName(name, input, user) {
    if (String(name).startsWith('mcp.')) {
        return executeMcpTool(name, input, user);
    }
    return executeBuiltInTool(name, input, user);
}

async function synthesizeFinalAnswer(modelCfg, goal, observations, user = null) {
    const messages = [
        {
            role: 'system',
            content: '请用简洁中文为用户总结智能体工作，包含有用发现、已执行动作、错误和下一步建议。'
        },
        {
            role: 'user',
            content: `目标：${goal}\n\n执行记录：\n${JSON.stringify(observations, null, 2)}`
        }
    ];
    const content = await callModelText(modelCfg, messages);
    if (user) recordAgentModelUsage(user, modelCfg, messages, content, 'agent_summary');
    return content || '任务已完成，但模型没有返回总结。';
}

async function runAgent(runId, user) {
    try {
        const run = getRunForUser(runId, user, { includeDeleted: true });
        if (!run) throw new Error('智能体任务不存在。');
        if (run.deleted_at) return;
        assertRunNotCancelled(runId);
        const modelCfg = getAccessibleModel(run.model_id, user);
        if (!modelCfg) throw new Error('当前智能体任务没有可用模型。');

        const observations = [];
        const toolList = formatToolList(user);
        assertRunNotCancelled(runId);
        updateRun(runId, { status: 'running', updated_at: getBeijingTimestamp() });

        for (let step = 1; step <= normalizeMaxSteps(run.max_steps); step += 1) {
            assertRunNotCancelled(runId);
            const plannerMessages = buildPlannerMessages(run.goal, toolList, observations);
            const plannedText = await callModelText(modelCfg, plannerMessages);
            recordAgentModelUsage(user, modelCfg, plannerMessages, plannedText, 'agent_planner');
            assertRunNotCancelled(runId);
            const plan = parseJsonObject(plannedText) || {};
            insertStep(runId, step, {
                type: 'plan',
                title: plan.thought || '规划下一步',
                input: { goal: run.goal },
                output: plan
            });

            if (plan.action === 'final' || !plan.tool) {
                const answer = plan.answer || await synthesizeFinalAnswer(modelCfg, run.goal, observations, user);
                updateRun(runId, {
                    status: 'completed',
                    final_answer: answer,
                    completed_at: getBeijingTimestamp(),
                    updated_at: getBeijingTimestamp()
                });
                return;
            }

            const startedAt = Date.now();
            try {
                assertRunNotCancelled(runId);
                const output = await executeToolByName(plan.tool, plan.input || {}, user);
                assertRunNotCancelled(runId);
                const compactOutput = clampText(output, 10000);
                observations.push({
                    step,
                    tool: plan.tool,
                    input: plan.input || {},
                    output: compactOutput
                });
                insertStep(runId, step, {
                    type: 'tool',
                    title: `调用工具：${plan.tool}`,
                    toolName: plan.tool,
                    input: plan.input || {},
                    output: compactOutput,
                    durationMs: Date.now() - startedAt
                });
            } catch (toolErr) {
                observations.push({
                    step,
                    tool: plan.tool,
                    input: plan.input || {},
                    error: toolErr.message
                });
                insertStep(runId, step, {
                    type: 'tool',
                    title: `工具调用失败：${plan.tool}`,
                    toolName: plan.tool,
                    input: plan.input || {},
                    output: { error: toolErr.message },
                    status: 'error',
                    durationMs: Date.now() - startedAt
                });
            }
        }

        assertRunNotCancelled(runId);
        const answer = await synthesizeFinalAnswer(modelCfg, run.goal, observations, user);
        assertRunNotCancelled(runId);
        updateRun(runId, {
            status: 'completed',
            final_answer: answer,
            completed_at: getBeijingTimestamp(),
            updated_at: getBeijingTimestamp()
        });
    } catch (e) {
        if (e.code === 'AGENT_RUN_CANCELLED') {
            updateRun(runId, { updated_at: getBeijingTimestamp() });
            return;
        }
        logger.error({ err: e.message, runId }, 'Agent run failed');
        updateRun(runId, {
            status: 'error',
            error_message: e.message,
            completed_at: getBeijingTimestamp(),
            updated_at: getBeijingTimestamp()
        });
    }
}

function createAgentRun({ user, goal, modelId, sessionId = null, title = '', maxSteps = DEFAULT_STEPS, parentRunId = null }) {
    const cleanGoal = normalizeAgentGoal(goal);
    const modelCfg = getAccessibleModel(modelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the agent.');
    const runId = createRunId();
    const now = getBeijingTimestamp();
    db.prepare(`
        INSERT INTO agent_runs (id, user_id, session_id, model_id, title, goal, status, max_steps, parent_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        user.id,
        sessionId || null,
        modelCfg.id,
        title || cleanGoal.slice(0, 40),
        cleanGoal,
        'queued',
        normalizeMaxSteps(maxSteps),
        parentRunId || null,
        now,
        now
    );
    setImmediate(() => {
        runAgent(runId, user).catch(err => {
            logger.error({ err: err.message, runId }, 'Agent run failed outside runtime guard');
            updateRun(runId, {
                status: 'error',
                error_message: err.message,
                completed_at: getBeijingTimestamp(),
                updated_at: getBeijingTimestamp()
            });
        });
    });
    return getRunForUser(runId, user);
}

module.exports = {
    createAgentRun,
    cancelAgentRun,
    formatToolList,
    getRunDetailForUser,
    getRunForUser,
    getRunProgress,
    listDeletedRunsForAdmin,
    listRuns,
    listSteps,
    normalizeAgentGoal,
    parseJsonObject,
    rerunAgentRun,
    runAgent,
    softDeleteAgentRun
};
