'use strict';

const crypto = require('crypto');
const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { digest } = require('./tool-catalog-releases');

function newTaskId() {
    return `tooltask_${crypto.randomBytes(24).toString('base64url')}`;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || '') || fallback; } catch (_) { return fallback; }
}

function publicTask(row = {}) {
    return {
        id: row.id,
        toolName: row.tool_name,
        status: row.status,
        pollAfterMs: Math.max(Number(row.poll_after_ms) || 1000, 250),
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        result: ['completed', 'failed', 'cancelled', 'expired'].includes(row.status) ? parseJson(row.result_json, {}) : undefined,
        error: row.error_code ? { code: row.error_code, message: row.error_message || '' } : undefined,
        inputRequest: row.status === 'input_required' ? parseJson(row.input_request, {}) : undefined,
        cancelRequested: Boolean(row.cancel_requested_at)
    };
}

function createToolTaskStore(deps = {}) {
    const readOne = deps.queryOne || queryOne;
    const write = deps.execute || execute;
    const now = deps.getBeijingTimestamp || getBeijingTimestamp;
    const controllers = new Map();

    async function expireIfNeeded(row) {
        if (!row || !['working', 'input_required'].includes(row.status) || !row.expires_at || Date.parse(row.expires_at) > Date.now()) return row;
        await write(`
            UPDATE tool_tasks
            SET status = 'expired', error_code = 'TOOL_TASK_EXPIRED', error_message = '工具任务已过期。', updated_at = ?
            WHERE id = ? AND status IN ('working', 'input_required')
        `, [now(), row.id]);
        return await readOne('SELECT * FROM tool_tasks WHERE id = ?', [row.id]);
    }

    async function create({ user, tenantId = null, invocationEventId = null, toolName, releaseId = null, inputRequest = {}, pollAfterMs = 1000, ttlMs = 10 * 60 * 1000 } = {}) {
        if (!user?.id || !toolName) {
            const error = new Error('创建工具任务缺少用户或工具名称。');
            error.status = 400;
            throw error;
        }
        const id = newTaskId();
        const expiresAt = getBeijingTimestamp(new Date(Date.now() + Math.min(Math.max(Number(ttlMs) || 0, 10_000), 24 * 60 * 60 * 1000)));
        await write(`
            INSERT INTO tool_tasks (
                id, user_id, tenant_id, invocation_event_id, tool_name, release_id, status,
                input_request, poll_after_ms, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'working', ?::jsonb, ?, ?, ?, ?)
        `, [id, user.id, tenantId, invocationEventId, String(toolName).slice(0, 320), releaseId, JSON.stringify(inputRequest || {}), Math.min(Math.max(Number(pollAfterMs) || 1000, 250), 60_000), expiresAt, now(), now()]);
        return publicTask(await readOne('SELECT * FROM tool_tasks WHERE id = ?', [id]));
    }

    async function getForUser(id, user) {
        const row = await expireIfNeeded(await readOne('SELECT * FROM tool_tasks WHERE id = ? AND user_id = ?', [id, user?.id || 0]));
        return row ? publicTask(row) : null;
    }

    async function requestCancel(id, user) {
        const current = await readOne('SELECT * FROM tool_tasks WHERE id = ? AND user_id = ?', [id, user?.id || 0]);
        if (!current) return null;
        const task = await expireIfNeeded(current);
        if (!['working', 'input_required'].includes(task.status)) return publicTask(task);
        await write(`
            UPDATE tool_tasks SET status = 'cancelled', cancel_requested_at = ?, error_code = 'TOOL_TASK_CANCELLED',
                error_message = '用户取消了工具任务。', updated_at = ?
            WHERE id = ? AND user_id = ? AND status IN ('working', 'input_required')
        `, [now(), now(), id, user.id]);
        const controller = controllers.get(String(id));
        if (controller && !controller.signal.aborted) {
            const error = new Error('工具任务已取消。');
            error.code = 'TOOL_TASK_CANCELLED';
            controller.abort(error);
        }
        return publicTask(await readOne('SELECT * FROM tool_tasks WHERE id = ?', [id]));
    }

    function beginExecution(id) {
        const key = String(id || '');
        const controller = new AbortController();
        controllers.set(key, controller);
        return controller;
    }

    function endExecution(id, controller = null) {
        const key = String(id || '');
        if (!controller || controllers.get(key) === controller) controllers.delete(key);
    }

    async function complete(id, user, result = {}, options = {}) {
        const current = await readOne('SELECT * FROM tool_tasks WHERE id = ? AND user_id = ?', [id, user?.id || 0]);
        if (!current) return null;
        const task = await expireIfNeeded(current);
        if (!['working', 'input_required'].includes(task.status)) return publicTask(task);
        const failed = options.failed === true;
        const status = failed ? 'failed' : 'completed';
        await write(`
            UPDATE tool_tasks
            SET status = ?, result_json = ?::jsonb, result_digest = ?, invocation_event_id = COALESCE(?, invocation_event_id), error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND status IN ('working', 'input_required')
        `, [status, JSON.stringify(result ?? {}), digest(result ?? {}), options.invocationEventId || null, String(options.errorCode || '').slice(0, 128), String(options.errorMessage || '').slice(0, 2000), now(), id, user.id]);
        return publicTask(await readOne('SELECT * FROM tool_tasks WHERE id = ?', [id]));
    }

    async function requestInput(id, user, inputRequest = {}) {
        const current = await readOne('SELECT * FROM tool_tasks WHERE id = ? AND user_id = ?', [id, user?.id || 0]);
        if (!current) return null;
        const task = await expireIfNeeded(current);
        if (task.status !== 'working') return publicTask(task);
        await write("UPDATE tool_tasks SET status = 'input_required', input_request = ?::jsonb, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'working'", [JSON.stringify(inputRequest || {}), now(), id, user.id]);
        return publicTask(await readOne('SELECT * FROM tool_tasks WHERE id = ?', [id]));
    }

    async function submitInput(id, user, input = {}) {
        const current = await readOne('SELECT * FROM tool_tasks WHERE id = ? AND user_id = ?', [id, user?.id || 0]);
        if (!current) return null;
        const task = await expireIfNeeded(current);
        if (task.status !== 'input_required') return publicTask(task);
        await write("UPDATE tool_tasks SET status = 'working', input_request = ?::jsonb, updated_at = ? WHERE id = ? AND user_id = ?", [JSON.stringify({ response: input || {} }), now(), id, user.id]);
        return publicTask(await readOne('SELECT * FROM tool_tasks WHERE id = ?', [id]));
    }

    return { beginExecution, complete, create, endExecution, getForUser, requestCancel, requestInput, submitInput };
}

const defaultStore = createToolTaskStore();

module.exports = { newTaskId, ...defaultStore };
