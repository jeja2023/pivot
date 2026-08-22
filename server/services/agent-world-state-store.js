const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { createAgentStepContext, hashValue } = require('./agent-step-context');
const { recordAgentEvent } = require('./agent-event-log');

const FULL_REFRESH_REASONS = new Set([
    'initial',
    'provider_independent',
    'context_compacted',
    'model_changed',
    'permission_changed',
    'workspace_changed',
    'schema_changed',
    'manual'
]);

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function newId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeRefreshReason(value) {
    const reason = String(value || '').trim().toLowerCase();
    return FULL_REFRESH_REASONS.has(reason) ? reason : '';
}

function contextualCompactionRequested(options = {}) {
    if (options.contextCompacted === true) return true;
    const context = options.contextConfig && typeof options.contextConfig === 'object'
        ? options.contextConfig
        : parseJson(options.contextConfig, {});
    return Boolean(context.contextCompacted || context.context_compacted || context.compacted || context.newContextWindow);
}

function modelFingerprint(state = {}) {
    const model = state.model || {};
    return hashValue({ id: model.id ?? null, name: model.name || '', modelName: model.modelName || '' });
}

function permissionFingerprint(state = {}) {
    const run = state.run || {};
    return hashValue({
        policy: run.policy || '',
        allowlist: run.allowlist || [],
        approvalPolicy: run.approvalPolicy || '',
        networkPolicy: run.networkPolicy || {},
        budgetConfig: run.budgetConfig || {}
    });
}

function workspaceFingerprint(state = {}) {
    const environment = state.environment || {};
    return hashValue({
        workspace: environment.workspace || environment.workspacePath || '',
        workspaceRoot: environment.workspaceRoot || '',
        executionProfile: environment.executionProfile || ''
    });
}

function determineFullRefreshReason(currentState, previousState, options = {}) {
    const explicit = normalizeRefreshReason(options.fullRefreshReason);
    if (explicit) return explicit;
    if (contextualCompactionRequested(options)) return 'context_compacted';
    if (!previousState) return 'initial';
    if (Number(previousState.schemaVersion || 0) !== Number(currentState.schemaVersion || 0)) return 'schema_changed';
    if (modelFingerprint(previousState) !== modelFingerprint(currentState)) return 'model_changed';
    if (permissionFingerprint(previousState) !== permissionFingerprint(currentState)) return 'permission_changed';
    if (workspaceFingerprint(previousState) !== workspaceFingerprint(currentState)) return 'workspace_changed';
    return options.forceWorldStateFull ? 'provider_independent' : '';
}

function shouldRotateWindow(reason) {
    return ['context_compacted', 'model_changed', 'permission_changed', 'workspace_changed', 'schema_changed', 'manual'].includes(reason);
}

function parseSnapshot(row) {
    if (!row) return null;
    return {
        ...row,
        state: parseJson(row.state, {}),
        patch: parseJson(row.patch, [])
    };
}

async function getLatestWorldStateSnapshot(runId, userId, trx = null) {
    const db = trx || { queryOne };
    const row = await db.queryOne(`
        SELECT snapshot_id, run_id, user_id, window_id, snapshot_version, turn_id, step_index,
               context_hash, state_hash, base_state_hash, injection_mode, full_refresh_reason,
               state, patch, created_at
        FROM agent_world_state_snapshots
        WHERE run_id = ? AND user_id = ?
        ORDER BY snapshot_version DESC
        LIMIT 1
    `, [runId, userId]);
    return parseSnapshot(row);
}

async function createPersistedAgentStepContext(options = {}) {
    const run = options.run || {};
    const runId = String(run.id || '').trim();
    const userId = Number(options.user?.id ?? run.user_id ?? 0);
    if (!runId || !Number.isSafeInteger(userId) || userId <= 0) {
        return createAgentStepContext(options);
    }

    // Build the current state before acquiring the run lock. The state compiler is pure and
    // deliberately excludes secrets; the transaction below serializes version allocation.
    const draft = createAgentStepContext({
        ...options,
        previousWorldState: null,
        forceWorldStateFull: true
    });
    const now = getBeijingTimestamp();

    const stepContext = await transaction(async trx => {
        const ownedRun = await trx.queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? FOR UPDATE', [runId, userId]);
        if (!ownedRun) return draft;

        const previousSnapshot = await getLatestWorldStateSnapshot(runId, userId, trx);
        const previousState = previousSnapshot?.state || null;
        const fullRefreshReason = determineFullRefreshReason(draft.worldState, previousState, options);
        const forceWorldStateFull = Boolean(fullRefreshReason || options.forceWorldStateFull);

        let window = await trx.queryOne(`
            SELECT window_id, window_version, parent_window_id, status
            FROM agent_context_windows
            WHERE run_id = ? AND user_id = ? AND status = 'active'
            ORDER BY window_version DESC
            LIMIT 1
            FOR UPDATE
        `, [runId, userId]);

        if (!window || (previousSnapshot && shouldRotateWindow(fullRefreshReason))) {
            if (window) {
                await trx.execute(`
                    UPDATE agent_context_windows
                    SET status = 'superseded', closed_at = ?
                    WHERE window_id = ? AND status = 'active'
                `, [now, window.window_id]);
            }
            const versionRow = await trx.queryOne(`
                SELECT COALESCE(MAX(window_version), 0) + 1 AS next_version
                FROM agent_context_windows
                WHERE run_id = ?
            `, [runId]);
            window = {
                window_id: newId('ctxw'),
                window_version: Number(versionRow?.next_version || 1),
                parent_window_id: window?.window_id || previousSnapshot?.window_id || null,
                status: 'active'
            };
            await trx.execute(`
                INSERT INTO agent_context_windows (
                    window_id, run_id, user_id, window_version, parent_window_id,
                    status, opened_reason, initial_state_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
            `, [
                window.window_id,
                runId,
                userId,
                window.window_version,
                window.parent_window_id,
                fullRefreshReason || 'initial',
                draft.worldStateHash,
                now
            ]);
        }

        const snapshotVersionRow = await trx.queryOne(`
            SELECT COALESCE(MAX(snapshot_version), 0) + 1 AS next_version
            FROM agent_world_state_snapshots
            WHERE run_id = ?
        `, [runId]);
        const snapshotId = newId('wss');
        const captured = createAgentStepContext({
            ...options,
            worldState: draft.worldState,
            previousWorldState: forceWorldStateFull ? null : previousState,
            forceWorldStateFull,
            worldStateWindow: {
                windowId: window.window_id,
                windowVersion: Number(window.window_version),
                parentWindowId: window.parent_window_id || '',
                snapshotId,
                snapshotVersion: Number(snapshotVersionRow?.next_version || 1),
                fullRefreshReason
            }
        });
        const injection = captured.worldStateInjection || {};
        await trx.execute(`
            INSERT INTO agent_world_state_snapshots (
                snapshot_id, run_id, user_id, window_id, snapshot_version,
                turn_id, step_index, context_hash, state_hash, base_state_hash,
                injection_mode, full_refresh_reason, state, patch, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            snapshotId,
            runId,
            userId,
            window.window_id,
            Number(snapshotVersionRow?.next_version || 1),
            captured.turnId,
            captured.stepIndex,
            captured.contextHash,
            captured.worldStateHash,
            injection.baseHash || '',
            injection.mode || 'full',
            fullRefreshReason,
            JSON.stringify(captured.worldState || {}),
            JSON.stringify(injection.patch || []),
            now
        ]);
        return captured;
    });
    if (stepContext?.contextHash) {
        try {
            await recordAgentEvent({
                runId,
                userId,
                turnId: stepContext.turnId,
                stepIndex: stepContext.stepIndex,
                type: 'step.context_captured',
                payload: {
                    contextHash: stepContext.contextHash,
                    worldStateHash: stepContext.worldStateHash,
                    worldStateMode: stepContext.worldStateInjection?.mode || 'full',
                    previousWorldStateHash: stepContext.previousWorldStateHash || '',
                    contextWindow: stepContext.worldStateWindow || {}
                },
                eventKey: stepContext.contextHash
            });
        } catch (_) {
            // A context snapshot is already durable. Event publication must not invalidate it.
        }
    }
    if (stepContext?.worldStateWindow?.fullRefreshReason === 'context_compacted') {
        try {
            await recordAgentEvent({
                runId,
                userId,
                turnId: stepContext.turnId,
                stepIndex: stepContext.stepIndex,
                type: 'context.compacted',
                payload: {
                    contextHash: stepContext.contextHash,
                    worldStateHash: stepContext.worldStateHash,
                    contextWindow: stepContext.worldStateWindow,
                    reason: 'context_compacted'
                },
                eventKey: `${stepContext.contextHash}:context_compacted`
            });
        } catch (_) {
            // Context capture remains durable even if the explanatory event is unavailable.
        }
    }
    const snapshotVersion = Number(stepContext?.worldStateWindow?.snapshotVersion || 0);
    if (options.pruneSnapshots === true || (snapshotVersion > 0 && snapshotVersion % 20 === 0)) {
        try {
            await pruneAgentWorldStateSnapshots(runId, { id: userId }, options.snapshotRetention || {});
        } catch (_) {
            // Retention is maintenance work; never invalidate a durable context capture.
        }
    }
    return stepContext;
}

async function listAgentContextWindowsForUser(runId, user, { limit = 100 } = {}) {
    const userId = Number(user?.id || 0);
    if (!runId || !userId) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return await query(`
        SELECT window_id, run_id, user_id, window_version, parent_window_id, status,
               opened_reason, initial_state_hash, created_at, closed_at
        FROM agent_context_windows
        WHERE run_id = ? AND user_id = ?
        ORDER BY window_version ASC
        LIMIT ?
    `, [runId, userId, safeLimit]);
}

async function listAgentWorldStateSnapshotsForUser(runId, user, { after = 0, limit = 200, windowId = '' } = {}) {
    const userId = Number(user?.id || 0);
    if (!runId || !userId) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const clauses = ['run_id = ?', 'user_id = ?', 'snapshot_version > ?'];
    const params = [runId, userId, Math.max(Number(after) || 0, 0)];
    if (windowId) {
        clauses.push('window_id = ?');
        params.push(String(windowId));
    }
    params.push(safeLimit);
    const rows = await query(`
        SELECT snapshot_id, run_id, user_id, window_id, snapshot_version, turn_id, step_index,
               context_hash, state_hash, base_state_hash, injection_mode, full_refresh_reason,
               state, patch, created_at
        FROM agent_world_state_snapshots
        WHERE ${clauses.join(' AND ')}
        ORDER BY snapshot_version ASC
        LIMIT ?
    `, params);
    return rows.map(parseSnapshot);
}

async function pruneAgentWorldStateSnapshots(runId, user, { keepLatest = 120, keepPerWindow = 2 } = {}) {
    const userId = Number(user?.id || 0);
    if (!runId || !userId) return { deleted: 0, kept: 0 };
    const latestLimit = Math.min(Math.max(Number(keepLatest) || 120, 1), 1000);
    const perWindow = Math.min(Math.max(Number(keepPerWindow) || 2, 1), 20);
    return await transaction(async trx => {
        const rows = await trx.query(`
            WITH latest AS (
                SELECT snapshot_id
                FROM agent_world_state_snapshots
                WHERE run_id = ? AND user_id = ?
                ORDER BY snapshot_version DESC
                LIMIT ?
            ), baselines AS (
                SELECT DISTINCT ON (window_id) snapshot_id
                FROM agent_world_state_snapshots
                WHERE run_id = ? AND user_id = ?
                ORDER BY window_id, snapshot_version ASC
            ), recent_per_window AS (
                SELECT snapshot_id
                FROM (
                    SELECT snapshot_id,
                           ROW_NUMBER() OVER (PARTITION BY window_id ORDER BY snapshot_version DESC) AS row_number
                    FROM agent_world_state_snapshots
                    WHERE run_id = ? AND user_id = ?
                ) ranked
                WHERE row_number <= ?
            )
            SELECT snapshot_id FROM latest
            UNION
            SELECT snapshot_id FROM baselines
            UNION
            SELECT snapshot_id FROM recent_per_window
        `, [runId, userId, latestLimit, runId, userId, runId, userId, perWindow]);
        const keepIds = rows.map(row => String(row.snapshot_id)).filter(Boolean);
        if (!keepIds.length) return { deleted: 0, kept: 0 };
        const deleted = await trx.execute(`
            DELETE FROM agent_world_state_snapshots
            WHERE run_id = ? AND user_id = ? AND NOT (snapshot_id = ANY(?))
        `, [runId, userId, keepIds]);
        return { deleted, kept: keepIds.length };
    });
}

module.exports = {
    FULL_REFRESH_REASONS,
    createPersistedAgentStepContext,
    determineFullRefreshReason,
    getLatestWorldStateSnapshot,
    listAgentContextWindowsForUser,
    listAgentWorldStateSnapshotsForUser,
    normalizeRefreshReason,
    pruneAgentWorldStateSnapshots,
    shouldRotateWindow
};
