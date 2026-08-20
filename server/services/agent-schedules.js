const { randomUUID } = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { nowExpr } = require('../db/dialect');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { getRunnableModelForUserAsync } = require('./models');
const { resolveAgentWorkflowVersion, normalizeDagInputsPayload } = require('./agent-workflows');
const { resolveAgentWorkflowDependencyBindings } = require('./agent-workflow-dependencies');
const { assertTemplateAccess } = require('./agent-templates');
const { computeNextCronDate } = require('./cron-expression');
const {
    MAX_GOAL_LENGTH,
    parseJsonObject,
    normalizeOptionalMaxSteps,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizeApprovalPolicy,
    normalizePositiveInt,
    SCHEDULE_FREQUENCIES,
    normalizeContextConfig,
    normalizeDagSpec,
    normalizeToolAllowlist
} = require('./agent-validators');

const MAX_AGENT_SCHEDULES_PER_USER = 100;
const SCHEDULE_CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_DISPATCH_FAILURES = 5;
const MIN_SCHEDULE_INTERVAL_MINUTES = 5;
const MAX_SCHEDULE_INTERVAL_MINUTES = 24 * 60;

let createAgentRunCallback = null;
let createAgentNotificationCallback = () => null;
// 触发器轮询入口由运行时注入，避免计划服务和触发器服务互相引用
let pollingTriggerRunner = null;
let approvalTimeoutRunner = null;

function configureAgentSchedules({ createAgentRun, createAgentNotification, runPollingTriggers, runApprovalTimeouts } = {}) {
    if (typeof createAgentRun === 'function') createAgentRunCallback = createAgentRun;
    if (typeof createAgentNotification === 'function') createAgentNotificationCallback = createAgentNotification;
    if (typeof runPollingTriggers === 'function') pollingTriggerRunner = runPollingTriggers;
    if (typeof runApprovalTimeouts === 'function') approvalTimeoutRunner = runApprovalTimeouts;
}

function parseBeijingDate(value) {
    const text = String(value || '').replace(' ', 'T');
    const date = text ? new Date(text) : new Date();
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toBeijingTimestamp(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function computeNextScheduleRun(
    frequency,
    timeOfDay = '09:00',
    dayOfWeek = 1,
    from = getBeijingTimestamp(),
    cronExpression = '',
    intervalMinutes = 0
) {
    const normalized = String(frequency || 'manual').trim();
    if (normalized === 'manual') return null;
    const base = parseBeijingDate(from);
    if (normalized === 'interval') {
        const minutes = normalizePositiveInt(
            intervalMinutes,
            MIN_SCHEDULE_INTERVAL_MINUTES,
            MIN_SCHEDULE_INTERVAL_MINUTES,
            MAX_SCHEDULE_INTERVAL_MINUTES
        );
        return toBeijingTimestamp(new Date(base.getTime() + minutes * 60 * 1000));
    }
    // cron 计划走独立求值路径，支持分钟级和多时段
    if (normalized === 'cron') {
        const next = computeNextCronDate(cronExpression, base);
        return next ? toBeijingTimestamp(next) : null;
    }
    const match = String(timeOfDay || '09:00').match(/^(\d{1,2}):(\d{2})$/);
    const hour = Math.min(Number(match?.[1] || 9), 23);
    const minute = Math.min(Number(match?.[2] || 0), 59);
    const candidate = new Date(base);
    candidate.setHours(hour, minute, 0, 0);
    if (normalized === 'daily') {
        if (candidate <= base) candidate.setDate(candidate.getDate() + 1);
        return toBeijingTimestamp(candidate);
    }
    const parsedDay = Number.parseInt(dayOfWeek, 10);
    const targetDay = Number.isInteger(parsedDay) ? Math.max(0, Math.min(parsedDay, 6)) : 1;
    let diff = (targetDay - candidate.getDay() + 7) % 7;
    if (diff === 0 && candidate <= base) diff = 7;
    candidate.setDate(candidate.getDate() + diff);
    return toBeijingTimestamp(candidate);
}

function invalid(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function normalizeSchedulePayload(body = {}) {
    const name = String(body.name || '').trim().slice(0, 80);
    const goal = String(body.goal || '').trim();
    if (!name || goal.length < 4) {
        throw invalid('请填写计划名称和明确的任务目标。');
    }
    if (body.frequency !== undefined && !SCHEDULE_FREQUENCIES.has(body.frequency)) {
        throw invalid('计划周期无效。');
    }
    const frequency = body.frequency || 'daily';
    const rawInterval = body.intervalMinutes ?? body.interval_minutes;
    if (frequency === 'interval') {
        if (rawInterval !== undefined) {
            const num = Number(rawInterval);
            if (!Number.isInteger(num) || num < MIN_SCHEDULE_INTERVAL_MINUTES || num > MAX_SCHEDULE_INTERVAL_MINUTES) {
                throw invalid(`时间间隔必须在 ${MIN_SCHEDULE_INTERVAL_MINUTES} 到 ${MAX_SCHEDULE_INTERVAL_MINUTES} 分钟之间。`);
            }
        }
    }
    const intervalMinutes = normalizePositiveInt(
        rawInterval,
        60,
        MIN_SCHEDULE_INTERVAL_MINUTES,
        MAX_SCHEDULE_INTERVAL_MINUTES
    );
    const cronExpression = String(body.cronExpression || body.cron_expression || '').trim();
    if (frequency === 'cron') {
        const next = computeNextCronDate(cronExpression, new Date());
        if (!next) {
            throw invalid('Cron 表达式无效，请使用标准的 5 位或 6 位 Cron 格式（如 0 9 * * 1-5）。');
        }
    }
    const timeOfDayRaw = body.timeOfDay ?? body.time_of_day;
    if (timeOfDayRaw !== undefined && timeOfDayRaw !== null && String(timeOfDayRaw).trim() !== '') {
        const timeOfDayStr = String(timeOfDayRaw).trim();
        const match = timeOfDayStr.match(/^(\d{1,2}):(\d{2})$/);
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
            throw invalid('执行时间必须是有效的 HH:MM 格式。');
        }
    }
    const timeOfDay = String(timeOfDayRaw || '09:00').trim();
    const dayOfWeek = normalizePositiveInt(body.dayOfWeek ?? body.day_of_week, 1, 0, 6);
    const status = body.status === 'paused' ? 'paused' : 'active';
    const templateId = body.templateId ? Number.parseInt(body.templateId, 10) || null : null;
    const modelId = body.modelId ? Number.parseInt(body.modelId, 10) || null : null;
    const runMode = normalizeRunMode(body.runMode || body.run_mode);
    const workflowId = runMode === 'dag' ? (Number.parseInt(body.workflowId || body.workflow_id, 10) || null) : null;
    return {
        name,
        goal: goal.slice(0, MAX_GOAL_LENGTH),
        frequency,
        timeOfDay: /^(\d{1,2}):(\d{2})$/.test(timeOfDay) ? timeOfDay : '09:00',
        dayOfWeek,
        intervalMinutes,
        cronExpression,
        status,
        templateId,
        modelId,
        runConfig: {
            runMode,
            maxSteps: normalizeOptionalMaxSteps(body.maxSteps ?? body.max_steps),
            toolPolicy: normalizeToolPolicy(body.toolPolicy || body.tool_policy),
            toolAllowlist: normalizeToolAllowlist(body.toolAllowlist || body.tool_allowlist),
            approvalPolicy: normalizeApprovalPolicy(body.approvalPolicy || body.approval_policy),
            retryLimit: normalizePositiveInt(body.retryLimit || body.retry_limit, 1, 0, 5),
            maxTokenBudget: normalizePositiveInt(body.maxTokenBudget || body.max_token_budget, 0, 0, 10000000),
            contextConfig: normalizeContextConfig(body.contextConfig || body.context_config),
            dagSpec: runMode === 'dag' ? normalizeDagSpec(body.dagSpec || body.dag_spec || {}) : { nodes: [] },
            dagInputs: runMode === 'dag' ? normalizeDagInputsPayload(body.dagInputs || body.dag_inputs || {}) : {},
            workflowId,
            workflowVersion: String(body.workflowVersion ?? body.workflow_version ?? '').trim() || null
        }
    };
}

async function assertScheduleTemplateAccess(templateId, user) {
    if (!templateId) return;
    const template = await queryOne('SELECT * FROM agent_templates WHERE id = ?', [templateId]);
    if (!assertTemplateAccess(template, user, false)) throw invalid('任务模板不存在或无权使用。', 403);
}

async function listAgentSchedules(user) {
    return await query(`
        SELECT s.*, t.name AS template_name, m.name AS model_name
        FROM agent_schedules s
        LEFT JOIN agent_templates t ON t.id = s.template_id
        LEFT JOIN models m ON m.id = s.model_id
        WHERE s.user_id = ? AND s.deleted_at IS NULL
        ORDER BY s.status ASC, COALESCE(s.dispatch_retry_at, s.next_run_at) ASC, s.updated_at DESC
    `, [user.id]);
}

async function createAgentSchedule(user, body = {}) {
    const data = normalizeSchedulePayload(body);
    const countRow = await queryOne('SELECT COUNT(*) AS count FROM agent_schedules WHERE user_id = ? AND deleted_at IS NULL', [user.id]);
    const count = Number(countRow?.count || 0);
    if (count >= MAX_AGENT_SCHEDULES_PER_USER) throw invalid(`每个账号最多创建 ${MAX_AGENT_SCHEDULES_PER_USER} 个自动化计划。`, 409);
    await assertScheduleTemplateAccess(data.templateId, user);
    const modelCfg = await getRunnableModelForUserAsync(data.modelId, user);
    if (!modelCfg && data.runConfig.runMode !== 'dag') throw invalid('请选择当前账号可用的模型后再创建计划。');
    if (data.runConfig.runMode === 'dag' && data.runConfig.workflowId) {
        const resolved = await resolveAgentWorkflowVersion(data.runConfig.workflowId, user, data.runConfig.workflowVersion || 'current');
        if (!resolved) throw invalid('请选择当前账号可用且已发布的工作流。', 404);
        await resolveAgentWorkflowDependencyBindings(resolved, user);
    }
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO agent_schedules (
            user_id, template_id, model_id, name, goal, frequency, time_of_day, day_of_week,
            interval_minutes, cron_expression, status, run_config, next_run_at, dispatch_failures, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        RETURNING id
    `, [
        user.id, data.templateId, modelCfg?.id || null, data.name, data.goal, data.frequency,
        data.timeOfDay, data.dayOfWeek, data.intervalMinutes, data.cronExpression, data.status, JSON.stringify(data.runConfig),
        data.status === 'active'
            ? computeNextScheduleRun(data.frequency, data.timeOfDay, data.dayOfWeek, now, data.cronExpression, data.intervalMinutes)
            : null,
        now, now
    ]);
    return await queryOne('SELECT * FROM agent_schedules WHERE id = ?', [row?.id]);
}

async function updateAgentSchedule(scheduleId, user, body = {}) {
    const schedule = await queryOne('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [scheduleId, user.id]);
    if (!schedule) return null;
    const data = normalizeSchedulePayload(body);
    await assertScheduleTemplateAccess(data.templateId, user);
    const modelCfg = await getRunnableModelForUserAsync(data.modelId, user);
    if (!modelCfg && data.runConfig.runMode !== 'dag') throw invalid('请选择当前账号可用的模型后再更新计划。');
    if (data.runConfig.runMode === 'dag' && data.runConfig.workflowId) {
        const resolved = await resolveAgentWorkflowVersion(data.runConfig.workflowId, user, data.runConfig.workflowVersion || 'current');
        if (!resolved) throw invalid('请选择当前账号可用且已发布的工作流。', 404);
        await resolveAgentWorkflowDependencyBindings(resolved, user);
    }
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE agent_schedules
        SET template_id = ?, model_id = ?, name = ?, goal = ?, frequency = ?, time_of_day = ?,
            day_of_week = ?, interval_minutes = ?, cron_expression = ?, status = ?, run_config = ?, next_run_at = ?,
            dispatch_retry_at = NULL, dispatch_failures = 0, last_error = NULL,
            claim_token = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE id = ?
    `, [
        data.templateId, modelCfg?.id || null, data.name, data.goal, data.frequency, data.timeOfDay,
        data.dayOfWeek, data.intervalMinutes, data.cronExpression, data.status, JSON.stringify(data.runConfig),
        data.status === 'active'
            ? computeNextScheduleRun(data.frequency, data.timeOfDay, data.dayOfWeek, now, data.cronExpression, data.intervalMinutes)
            : null,
        now, scheduleId
    ]);
    return await queryOne('SELECT * FROM agent_schedules WHERE id = ?', [scheduleId]);
}

async function deleteAgentSchedule(scheduleId, user) {
    const schedule = await queryOne('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [scheduleId, user.id]);
    if (!schedule) return null;
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE agent_schedules
        SET deleted_at = ?, next_run_at = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE id = ?
    `, [now, now, scheduleId]);
    return schedule;
}

function ensureCreateAgentRun() {
    if (typeof createAgentRunCallback !== 'function') throw new Error('智能体定时调度运行时未完成配置。');
    return createAgentRunCallback;
}

async function runAgentScheduleNow(scheduleId, user, options = {}) {
    const schedule = await queryOne('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [scheduleId, user.id]);
    if (!schedule) return null;
    const account = await queryOne("SELECT id FROM users WHERE id = ? AND COALESCE(status, 'active') != 'disabled' AND deleted_at IS NULL", [user.id]);
    if (!account) return null;
    const cfg = parseJsonObject(schedule.run_config) || {};
    const createAgentRun = ensureCreateAgentRun();
    const scheduledFor = options.scheduledFor ? String(options.scheduledFor).slice(0, 32) : '';
    const idempotencyKey = String(options.idempotencyKey || '').trim().slice(0, 180);
    const dedupeKey = scheduledFor
        ? `schedule:${schedule.id}:${scheduledFor}`
        : (idempotencyKey ? `manual:${schedule.id}:${idempotencyKey}` : null);
    const run = await createAgentRun({
        user,
        goal: schedule.goal,
        modelId: schedule.model_id,
        title: schedule.name,
        maxSteps: cfg.maxSteps,
        runMode: cfg.runMode,
        toolPolicy: cfg.toolPolicy,
        toolAllowlist: cfg.toolAllowlist,
        approvalPolicy: cfg.approvalPolicy,
        retryLimit: cfg.retryLimit,
        maxTokenBudget: cfg.maxTokenBudget,
        templateId: schedule.template_id,
        scheduleId: schedule.id,
        contextConfig: cfg.contextConfig,
        dagSpec: cfg.dagSpec,
        dagInputs: cfg.dagInputs,
        workflowId: cfg.workflowId,
        workflowVersion: cfg.workflowVersion,
        priority: 0,
        dedupeKey,
        metadata: scheduledFor ? { scheduledFor } : {}
    });
    await execute('UPDATE agent_schedules SET last_run_at = ?, last_run_id = ?, updated_at = ? WHERE id = ?', [
        getBeijingTimestamp(), run.id, getBeijingTimestamp(), schedule.id
    ]);
    return run;
}

async function runDueAgentSchedules(limit = 20) {
    const currTime = nowExpr();
    const due = await query(`
        SELECT s.*, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username,
               u.nickname, u.unit, u.role
        FROM agent_schedules s
        JOIN users u ON u.id = s.user_id
        WHERE s.status = 'active'
          AND COALESCE(u.status, 'active') != 'disabled'
          AND u.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND s.next_run_at IS NOT NULL
          AND COALESCE(s.dispatch_retry_at, s.next_run_at) <= ${currTime}
          AND (s.claim_token IS NULL OR s.claim_expires_at IS NULL OR s.claim_expires_at <= ${currTime})
        ORDER BY COALESCE(s.dispatch_retry_at, s.next_run_at) ASC
        LIMIT ?
    `, [normalizePositiveInt(limit, 20, 1, 100)]);
    const created = [];
    for (const schedule of due) {
        const user = { id: schedule.user_id, username: schedule.username, nickname: schedule.nickname, unit: schedule.unit, role: schedule.role };
        const claimToken = randomUUID();
        try {
            const changes = await execute(`
                UPDATE agent_schedules
                SET claim_token = ?, claim_expires_at = ?, updated_at = ?
                WHERE id = ? AND status = 'active' AND deleted_at IS NULL AND next_run_at = ?
                  AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ${currTime})
            `, [
                claimToken,
                toBeijingTimestamp(new Date(Date.now() + SCHEDULE_CLAIM_LEASE_MS)),
                getBeijingTimestamp(),
                schedule.id,
                schedule.next_run_at
            ]);
            if (changes === 0) continue;
            const run = await runAgentScheduleNow(schedule.id, user, { scheduledFor: schedule.next_run_at });
            if (!run) throw new Error('计划所属账号已被禁用或删除。');
            const nextRunAt = computeNextScheduleRun(
                schedule.frequency,
                schedule.time_of_day,
                schedule.day_of_week,
                getBeijingTimestamp(),
                schedule.cron_expression,
                schedule.interval_minutes
            );
            await execute(`
                UPDATE agent_schedules
                SET next_run_at = ?, last_run_id = ?, last_run_at = ?, dispatch_retry_at = NULL,
                    dispatch_failures = 0, last_error = NULL, claim_token = NULL,
                    claim_expires_at = NULL, updated_at = ?
                WHERE id = ? AND claim_token = ?
            `, [nextRunAt, run.id, getBeijingTimestamp(), getBeijingTimestamp(), schedule.id, claimToken]);
            try {
                await createAgentNotificationCallback(user.id, run.id, 'schedule', '计划任务已入队', schedule.name);
            } catch (notificationError) {
                logger.warn({ err: notificationError.message, scheduleId: schedule.id }, '计划通知写入失败');
            }
            created.push(run);
        } catch (e) {
            logger.error({ err: e.message, scheduleId: schedule.id }, '智能体计划调度失败');
            const current = await queryOne('SELECT dispatch_failures FROM agent_schedules WHERE id = ? AND claim_token = ?', [schedule.id, claimToken]);
            if (!current) continue;
            const failures = Number(current.dispatch_failures || 0) + 1;
            const paused = failures >= MAX_DISPATCH_FAILURES;
            const retryDelay = Math.min(60 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.min(failures - 1, 4)));
            await execute(`
                UPDATE agent_schedules
                SET status = ?, dispatch_failures = ?, last_error = ?, dispatch_retry_at = ?,
                    claim_token = NULL, claim_expires_at = NULL,
                    next_run_at = CASE WHEN ? = 1 THEN NULL ELSE next_run_at END, updated_at = ?
                WHERE id = ? AND claim_token = ?
            `, [
                paused ? 'paused' : 'active', failures, String(e.message || '计划调度失败').slice(0, 1000),
                paused ? null : toBeijingTimestamp(new Date(Date.now() + retryDelay)), paused ? 1 : 0,
                getBeijingTimestamp(), schedule.id, claimToken
            ]);
            try {
                await createAgentNotificationCallback(user.id, null, paused ? 'error' : 'warning', paused ? '计划任务已暂停' : '计划任务将自动重试', `${schedule.name}: ${e.message}`);
            } catch (notificationError) {
                logger.warn({ err: notificationError.message, scheduleId: schedule.id }, '计划错误通知写入失败');
            }
        }
    }
    return created;
}

function startAgentScheduleRunner() {
    const tick = () => {
        runDueAgentSchedules().catch(e => {
            logger.error({ err: e.message }, '智能体计划调度器执行失败');
        });
        // 文件落地和数据变更触发器共用同一个 tick，失败不影响计划调度
        Promise.resolve()
            .then(() => pollingTriggerRunner?.())
            .catch(e => logger.error({ err: e.message }, '触发器轮询执行失败'));
        Promise.resolve()
            .then(() => approvalTimeoutRunner?.())
            .catch(e => logger.error({ err: e.message }, '审批超时处理执行失败'));
    };
    const initial = setTimeout(tick, 5000);
    initial.unref?.();
    const timer = setInterval(tick, 60 * 1000);
    timer.unref?.();
    return timer;
}

module.exports = {
    configureAgentSchedules,
    computeNextScheduleRun,
    createAgentSchedule,
    deleteAgentSchedule,
    listAgentSchedules,
    runAgentScheduleNow,
    runDueAgentSchedules,
    startAgentScheduleRunner,
    updateAgentSchedule
};
