const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { getRunnableModelForUser } = require('./models');
const { resolveAgentWorkflowVersion, normalizeDagInputsPayload } = require('./agent-workflows');
const {
    MAX_GOAL_LENGTH,
    parseJsonObject,
    normalizeMaxSteps,
    normalizeRunMode,
    normalizeToolPolicy,
    normalizeApprovalPolicy,
    normalizePositiveInt,
    normalizeScheduleFrequency,
    normalizeContextConfig,
    normalizeDagSpec,
    normalizeToolAllowlist
} = require('./agent-validators');

let createAgentRunCallback = null;
let createAgentNotificationCallback = () => null;

function configureAgentSchedules({ createAgentRun, createAgentNotification } = {}) {
    if (typeof createAgentRun === 'function') createAgentRunCallback = createAgentRun;
    if (typeof createAgentNotification === 'function') createAgentNotificationCallback = createAgentNotification;
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

function computeNextScheduleRun(frequency, timeOfDay = '09:00', dayOfWeek = 1, from = getBeijingTimestamp()) {
    const normalized = normalizeScheduleFrequency(frequency);
    if (normalized === 'manual') return null;
    const match = String(timeOfDay || '09:00').match(/^(\d{1,2}):(\d{2})$/);
    const hour = Math.min(Number(match?.[1] || 9), 23);
    const minute = Math.min(Number(match?.[2] || 0), 59);
    const base = parseBeijingDate(from);
    const candidate = new Date(base);
    candidate.setHours(hour, minute, 0, 0);
    if (normalized === 'daily') {
        if (candidate <= base) candidate.setDate(candidate.getDate() + 1);
        return toBeijingTimestamp(candidate);
    }
    const targetDay = Math.max(0, Math.min(Number.parseInt(dayOfWeek, 10) || 1, 6));
    let diff = (targetDay - candidate.getDay() + 7) % 7;
    if (diff === 0 && candidate <= base) diff = 7;
    candidate.setDate(candidate.getDate() + diff);
    return toBeijingTimestamp(candidate);
}

function normalizeSchedulePayload(body = {}) {
    const name = String(body.name || '').trim().slice(0, 100);
    const goal = String(body.goal || '').trim();
    const frequency = normalizeScheduleFrequency(body.frequency);
    if (!name || goal.length < 4) {
        const err = new Error('请填写计划名称和明确的任务目标。');
        err.status = 400;
        throw err;
    }
    return {
        name,
        goal: goal.slice(0, MAX_GOAL_LENGTH),
        modelId: body.modelId || body.model_id,
        templateId: body.templateId || body.template_id || null,
        frequency,
        timeOfDay: String(body.timeOfDay || body.time_of_day || '09:00').slice(0, 5),
        dayOfWeek: normalizePositiveInt(body.dayOfWeek || body.day_of_week, 1, 0, 6),
        status: body.status === 'paused' ? 'paused' : 'active',
        runConfig: {
            maxSteps: normalizeMaxSteps(body.maxSteps || body.max_steps),
            runMode: normalizeRunMode(body.runMode || body.run_mode),
            toolPolicy: normalizeToolPolicy(body.toolPolicy || body.tool_policy),
            toolAllowlist: normalizeToolAllowlist(body.toolAllowlist || body.tool_allowlist),
            approvalPolicy: normalizeApprovalPolicy(body.approvalPolicy || body.approval_policy),
            retryLimit: normalizePositiveInt(body.retryLimit || body.retry_limit, 1, 0, 5),
            maxTokenBudget: normalizePositiveInt(body.maxTokenBudget || body.max_token_budget, 0, 0, 10000000),
            contextConfig: normalizeContextConfig(body.contextConfig || body.context_config),
            dagSpec: normalizeDagSpec(body.dagSpec || body.dag_spec || {}),
            dagInputs: normalizeDagInputsPayload(body.dagInputs || body.dag_inputs || {}),
            workflowId: body.workflowId || body.workflow_id || null,
            workflowVersion: String(body.workflowVersion || body.workflow_version || '').trim() || null
        }
    };
}

function listAgentSchedules(user) {
    return db.prepare(`
        SELECT s.*, t.name AS template_name, m.name AS model_name
        FROM agent_schedules s
        LEFT JOIN agent_templates t ON t.id = s.template_id
        LEFT JOIN models m ON m.id = s.model_id
        WHERE s.user_id = ? AND s.deleted_at IS NULL
        ORDER BY s.status ASC, s.next_run_at ASC, s.updated_at DESC
        LIMIT 100
    `).all(user.id);
}

function createAgentSchedule(user, body = {}) {
    const data = normalizeSchedulePayload(body);
    const modelCfg = getRunnableModelForUser(data.modelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the schedule.');
    if (data.runConfig.runMode === 'dag' && data.runConfig.workflowId) {
        resolveAgentWorkflowVersion(data.runConfig.workflowId, user, data.runConfig.workflowVersion || 'current');
    }
    const now = getBeijingTimestamp();
    const info = db.prepare(`
        INSERT INTO agent_schedules (
            user_id, template_id, model_id, name, goal, frequency, time_of_day, day_of_week,
            status, run_config, next_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        user.id, data.templateId, modelCfg.id, data.name, data.goal, data.frequency,
        data.timeOfDay, data.dayOfWeek, data.status, JSON.stringify(data.runConfig),
        data.status === 'active' ? computeNextScheduleRun(data.frequency, data.timeOfDay, data.dayOfWeek, now) : null,
        now, now
    );
    return db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(info.lastInsertRowid);
}

function updateAgentSchedule(scheduleId, user, body = {}) {
    const schedule = db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(scheduleId, user.id);
    if (!schedule) return null;
    const data = normalizeSchedulePayload(body);
    const modelCfg = getRunnableModelForUser(data.modelId, user);
    if (!modelCfg) throw new Error('Please choose an accessible model for the schedule.');
    if (data.runConfig.runMode === 'dag' && data.runConfig.workflowId) {
        resolveAgentWorkflowVersion(data.runConfig.workflowId, user, data.runConfig.workflowVersion || 'current');
    }
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE agent_schedules
        SET template_id = ?, model_id = ?, name = ?, goal = ?, frequency = ?, time_of_day = ?,
            day_of_week = ?, status = ?, run_config = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?
    `).run(
        data.templateId, modelCfg.id, data.name, data.goal, data.frequency, data.timeOfDay,
        data.dayOfWeek, data.status, JSON.stringify(data.runConfig),
        data.status === 'active' ? computeNextScheduleRun(data.frequency, data.timeOfDay, data.dayOfWeek, now) : null,
        now, scheduleId
    );
    return db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(scheduleId);
}

function deleteAgentSchedule(scheduleId, user) {
    const schedule = db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(scheduleId, user.id);
    if (!schedule) return null;
    db.prepare('UPDATE agent_schedules SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(getBeijingTimestamp(), getBeijingTimestamp(), scheduleId);
    return schedule;
}

function ensureCreateAgentRun() {
    if (typeof createAgentRunCallback !== 'function') throw new Error('Agent schedule runtime is not configured.');
    return createAgentRunCallback;
}

function runAgentScheduleNow(scheduleId, user) {
    const schedule = db.prepare('SELECT * FROM agent_schedules WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(scheduleId, user.id);
    if (!schedule) return null;
    const cfg = parseJsonObject(schedule.run_config) || {};
    const createAgentRun = ensureCreateAgentRun();
    const run = createAgentRun({
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
        priority: 1
    });
    db.prepare('UPDATE agent_schedules SET last_run_at = ?, last_run_id = ?, updated_at = ? WHERE id = ?')
        .run(getBeijingTimestamp(), run.id, getBeijingTimestamp(), schedule.id);
    return run;
}

function runDueAgentSchedules(limit = 20) {
    const due = db.prepare(`
        SELECT s.*, u.username, u.nickname, u.unit, u.role
        FROM agent_schedules s
        JOIN users u ON u.id = s.user_id
        WHERE s.status = 'active'
          AND s.deleted_at IS NULL
          AND s.next_run_at IS NOT NULL
          AND s.next_run_at <= datetime('now', '+8 hours')
        ORDER BY s.next_run_at ASC
        LIMIT ?
    `).all(normalizePositiveInt(limit, 20, 1, 100));
    const created = [];
    due.forEach(schedule => {
        const user = { id: schedule.user_id, username: schedule.username, nickname: schedule.nickname, unit: schedule.unit, role: schedule.role };
        try {
            const claimed = db.prepare(`
                UPDATE agent_schedules
                SET next_run_at = NULL, updated_at = ?
                WHERE id = ?
                  AND status = 'active'
                  AND deleted_at IS NULL
                  AND next_run_at = ?
            `).run(getBeijingTimestamp(), schedule.id, schedule.next_run_at);
            if (claimed.changes === 0) return;
            const run = runAgentScheduleNow(schedule.id, user);
            const nextRunAt = computeNextScheduleRun(schedule.frequency, schedule.time_of_day, schedule.day_of_week, getBeijingTimestamp());
            db.prepare('UPDATE agent_schedules SET next_run_at = ?, last_run_id = ?, last_run_at = ?, updated_at = ? WHERE id = ?')
                .run(nextRunAt, run.id, getBeijingTimestamp(), getBeijingTimestamp(), schedule.id);
            createAgentNotificationCallback(user.id, run.id, 'schedule', '计划任务已入队', schedule.name);
            created.push(run);
        } catch (e) {
            logger.error({ err: e.message, scheduleId: schedule.id }, 'Agent schedule failed');
            db.prepare('UPDATE agent_schedules SET status = ?, updated_at = ? WHERE id = ?')
                .run('paused', getBeijingTimestamp(), schedule.id);
            createAgentNotificationCallback(user.id, null, 'error', '计划任务已暂停', `${schedule.name}: ${e.message}`);
        }
    });
    return created;
}

function startAgentScheduleRunner() {
    const tick = () => {
        try {
            runDueAgentSchedules();
        } catch (e) {
            logger.error({ err: e.message }, 'Agent schedule runner failed');
        }
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
