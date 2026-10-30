'use strict';

// 本机代码工作区的实际路径不离开桌面端。服务端只保存设备标识、受控工作树名和
// 由桌面端计算的工作区版本摘要，并用持久 outbox 把来源失效投递给长期记忆。
const crypto = require('crypto');
const { execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');

const DEFAULT_POLL_MS = 1000;
const DEFAULT_CLAIM_LIMIT = 30;
const CLAIM_TIMEOUT_MS = 90 * 1000;
const MUTATING_WORKSPACE_TOOLS = new Set([
    'workspace.patch', 'workspace.install', 'workspace.git_worktree', 'workspace.git_worktree_remove',
    'workspace.git_merge', 'workspace.git_abort_merge', 'workspace.git_commit', 'workspace.git_push', 'workspace.git_pr'
]);

function normalizeDeviceId(value) {
    const id = String(value || '').trim().slice(0, 64);
    return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : '';
}

function normalizeWorktreeName(value) {
    const name = String(value || 'primary').trim().slice(0, 64) || 'primary';
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : 'primary';
}

function workspaceMemorySourceReference(deviceId, worktreeName = '') {
    const device = normalizeDeviceId(deviceId);
    if (!device) return '';
    return `workspace:${device}:${normalizeWorktreeName(worktreeName)}`;
}

function normalizeWorkspaceRevision(value) {
    const revision = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(revision) ? revision : '';
}

function workspaceResultRevision(result = {}) {
    const source = result && typeof result === 'object' ? result : {};
    return normalizeWorkspaceRevision(source.revision || source.workspaceRevision || source.workspace?.revision || source.workspace?.workspaceRevision);
}

function workspaceEventKey({ userId, sourceRef, eventType, revision }) {
    return crypto.createHash('sha256').update(JSON.stringify({
        userId: Number(userId), sourceRef: String(sourceRef || ''), eventType: String(eventType || ''), revision: String(revision || '')
    })).digest('hex');
}

function workspaceEventForConnectorTask(task = {}, result = {}) {
    if (String(task.grant_type || '') !== 'local_workspace') return null;
    const toolName = String(task.tool_name || '');
    const input = typeof task.input === 'object' ? task.input : (() => { try { return JSON.parse(task.input_json || '{}'); } catch (_) { return {}; } })();
    const worktreeName = toolName === 'workspace.git_worktree_remove'
        ? (input.name || '')
        : (input.worktreeName || input.worktree_name || result.worktreeName || '');
    const sourceRef = workspaceMemorySourceReference(task.device_id, worktreeName);
    if (!sourceRef) return null;
    if (toolName === 'workspace.git_worktree_remove') {
        return { sourceRef, eventType: 'source_removed', sourceRevision: '' };
    }
    if (toolName === 'workspace.inspect' || MUTATING_WORKSPACE_TOOLS.has(toolName)) {
        const sourceRevision = workspaceResultRevision(result);
        if (!sourceRevision) {
            const error = new Error('本机工作区回执缺少 64 位版本摘要，不能确认来源变更。');
            error.code = 'LOCAL_WORKSPACE_REVISION_REQUIRED';
            error.status = 422;
            error.statusCode = 422;
            throw error;
        }
        return { sourceRef, eventType: 'source_changed', sourceRevision };
    }
    return null;
}

async function enqueueWorkspaceMemorySourceEvent({ userId, deviceId, sourceRef, eventType, sourceRevision = '' } = {}, deps = {}) {
    const safeUserId = Number.parseInt(userId, 10);
    const safeDeviceId = normalizeDeviceId(deviceId);
    const safeRef = String(sourceRef || '').trim().slice(0, 255);
    const safeType = ['source_changed', 'source_removed'].includes(String(eventType || '')) ? String(eventType) : '';
    const safeRevision = normalizeWorkspaceRevision(sourceRevision);
    if (!Number.isSafeInteger(safeUserId) || safeUserId <= 0 || !safeDeviceId || !safeRef || !safeType || (safeType === 'source_changed' && !safeRevision)) return null;
    const now = getBeijingTimestamp();
    const eventKey = workspaceEventKey({ userId: safeUserId, sourceRef: safeRef, eventType: safeType, revision: safeRevision });
    const insert = async db => await db.queryOne(`
        INSERT INTO workspace_memory_source_events (
            id, event_key, user_id, device_id, source_ref, event_type, source_revision,
            status, attempts, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET
            status = 'pending', attempts = 0, available_at = EXCLUDED.available_at,
            locked_by = '', locked_at = NULL, handled_at = NULL, last_error = '', updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [crypto.randomUUID(), eventKey, safeUserId, safeDeviceId, safeRef, safeType, safeRevision, now, now, now]);
    if (deps.trx) return await insert(deps.trx);
    return await (deps.transaction || transaction)(insert);
}

function normalizeWorkerId(value = '') {
    return String(value || '').trim().slice(0, 120) || `workspace-memory-source-${process.pid}`;
}

async function claimWorkspaceMemorySourceEvents({ workerId = '', limit = DEFAULT_CLAIM_LIMIT } = {}, deps = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_CLAIM_LIMIT, 1), 200);
    const now = getBeijingTimestamp();
    const staleBefore = getBeijingTimestamp(new Date(Date.now() - CLAIM_TIMEOUT_MS));
    return await (deps.transaction || transaction)(async trx => {
        await trx.execute(`
            UPDATE workspace_memory_source_events
            SET status = 'pending', locked_by = '', locked_at = NULL, available_at = ?, updated_at = ?
            WHERE status = 'claimed' AND locked_at IS NOT NULL AND locked_at < ?
        `, [now, now, staleBefore]);
        const rows = await trx.query(`
            SELECT * FROM workspace_memory_source_events
            WHERE status = 'pending' AND available_at <= ?
            ORDER BY created_at ASC LIMIT ? FOR UPDATE SKIP LOCKED
        `, [now, safeLimit]);
        for (const row of rows) {
            await trx.execute(`
                UPDATE workspace_memory_source_events
                SET status = 'claimed', attempts = attempts + 1, locked_by = ?, locked_at = ?, updated_at = ?
                WHERE id = ?
            `, [safeWorkerId, now, now, row.id]);
        }
        return rows.map(row => ({ ...row, status: 'claimed', locked_by: safeWorkerId }));
    });
}

async function completeWorkspaceMemorySourceEvent(id, workerId = '', deps = {}) {
    const now = getBeijingTimestamp();
    return await (deps.execute || execute)(`
        UPDATE workspace_memory_source_events
        SET status = 'completed', handled_at = ?, locked_by = '', locked_at = NULL, last_error = '', updated_at = ?
        WHERE id = ? AND status = 'claimed' AND locked_by = ?
    `, [now, now, id, normalizeWorkerId(workerId)]);
}

async function failWorkspaceMemorySourceEvent(id, workerId = '', error, deps = {}) {
    const now = getBeijingTimestamp();
    const attempts = Math.max(1, Number(error?.attempts || 1));
    const retryAt = getBeijingTimestamp(new Date(Date.now() + Math.min(5 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 8)))));
    return await (deps.execute || execute)(`
        UPDATE workspace_memory_source_events
        SET status = 'pending', available_at = ?, locked_by = '', locked_at = NULL,
            last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND locked_by = ?
    `, [retryAt, String(error?.message || error || '工作区来源事件处理失败。').slice(0, 1000), now, id, normalizeWorkerId(workerId)]);
}

async function handleWorkspaceMemorySourceEvent(event, deps = {}) {
    const memory = deps.memory || require('./long-term-memory');
    const userId = Number(event?.user_id);
    const sourceRef = String(event?.source_ref || '');
    if (String(event?.event_type || '') === 'source_removed') {
        return await memory.revokeMemoriesForSourceReference(userId, 'workspace', sourceRef, { reason: 'workspace_worktree_removed' });
    }
    const revision = normalizeWorkspaceRevision(event?.source_revision);
    if (!revision) throw new Error('工作区来源事件缺少有效版本摘要。');
    const fingerprint = memory.sourceFingerprint({ sourceKind: 'workspace', sourceRef, content: revision, version: revision });
    if (!fingerprint) {
        const error = new Error('未配置独立的来源指纹密钥，不能安全处理工作区来源变更。');
        error.code = 'MEMORY_SOURCE_FINGERPRINT_SECRET_MISSING';
        throw error;
    }
    return await memory.markMemoriesForChangedSource(userId, {
        sourceKind: 'workspace', sourceRef, sourceFingerprint: fingerprint, reason: 'workspace_revision_changed'
    });
}

async function dispatchWorkspaceMemorySourceEventBatch({ workerId = '', limit = DEFAULT_CLAIM_LIMIT } = {}, deps = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const events = await claimWorkspaceMemorySourceEvents({ workerId: safeWorkerId, limit }, deps);
    let completed = 0;
    for (const event of events) {
        try {
            await handleWorkspaceMemorySourceEvent(event, deps);
            await completeWorkspaceMemorySourceEvent(event.id, safeWorkerId, deps);
            completed += 1;
        } catch (error) {
            await failWorkspaceMemorySourceEvent(event.id, safeWorkerId, { ...error, attempts: event.attempts }, deps).catch(() => {});
            logger.warn({ err: error.message, eventId: event.id }, '工作区记忆来源事件投递失败');
        }
    }
    return { claimed: events.length, completed };
}

function createWorkspaceMemorySourceLifecycleWorker({ workerId = '', pollIntervalMs = DEFAULT_POLL_MS, logger: log = logger, deps = {} } = {}) {
    const safeWorkerId = normalizeWorkerId(workerId);
    const interval = Math.min(Math.max(Number.parseInt(pollIntervalMs, 10) || DEFAULT_POLL_MS, 250), 60000);
    let timer = null;
    let running = false;
    let inFlight = null;
    const runOnce = async () => {
        if (running) return null;
        running = true;
        try { return await dispatchWorkspaceMemorySourceEventBatch({ workerId: safeWorkerId }, deps); }
        catch (error) { log.warn?.({ err: error.message }, '工作区记忆来源生命周期 Worker 执行失败'); return null; }
        finally { running = false; }
    };
    const trackedRun = () => {
        if (inFlight) return inFlight;
        inFlight = Promise.resolve().then(runOnce).finally(() => { inFlight = null; });
        return inFlight;
    };
    return {
        start() { if (!timer) { timer = setInterval(() => { void trackedRun(); }, interval); timer.unref?.(); void trackedRun(); } return { workerId: safeWorkerId, started: true }; },
        async stop() { if (timer) clearInterval(timer); timer = null; if (inFlight) await inFlight; },
        runOnce: trackedRun,
        getRuntimeStatus: () => ({ workerId: safeWorkerId, started: Boolean(timer), running })
    };
}

module.exports = {
    MUTATING_WORKSPACE_TOOLS,

    createWorkspaceMemorySourceLifecycleWorker,

    enqueueWorkspaceMemorySourceEvent,
    handleWorkspaceMemorySourceEvent,
    workspaceEventForConnectorTask,
    workspaceMemorySourceReference,
    workspaceResultRevision
};
