const crypto = require('crypto');
const { query, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { createAgentStepContext, hashValue } = require('./agent-step-context');

const ROTATING_REASONS = new Set(['context_compacted', 'model_changed', 'permission_changed', 'schema_changed', 'manual']);

function newId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function resolveRefreshReason(previousState, currentState, options = {}) {
    if (!previousState) return 'initial';
    if (options.contextCompacted === true || options.contextConfig?.contextCompacted === true) return 'context_compacted';
    if (hashValue(previousState.model || {}) !== hashValue(currentState.model || {})) return 'model_changed';
    if (hashValue(previousState.run?.networkPolicy || {}) !== hashValue(currentState.run?.networkPolicy || {})) return 'permission_changed';
    if (Number(previousState.schemaVersion || 0) !== Number(currentState.schemaVersion || 0)) return 'schema_changed';
    return options.forceWorldStateFull === true ? 'manual' : '';
}

function shouldRotate(reason) {
    return ROTATING_REASONS.has(String(reason || ''));
}

async function createPersistedChatStepContext({
    sessionId,
    user,
    modelCfg = null,
    toolList = [],
    contextConfig = {},
    environment = { entrypoint: 'chat' },
    memory = {},
    turnId = '',
    stepIndex = 0,
    forceWorldStateFull = false,
    contextCompacted = false
} = {}) {
    const safeSessionId = String(sessionId || '').trim();
    const userId = Number(user?.id || 0);
    if (!safeSessionId || !Number.isSafeInteger(userId) || userId <= 0) {
        return createAgentStepContext({
            run: { id: `chat:${safeSessionId}`, user_id: userId, goal: contextConfig.goal || '', tool_policy: 'all', approval_policy: 'safe_mcp_auto' },
            turnId,
            stepIndex,
            modelCfg,
            toolList,
            contextConfig,
            environment,
            memory,
            forceWorldStateFull
        });
    }
    const run = {
        id: `chat:${safeSessionId}`,
        user_id: userId,
        goal: String(contextConfig.goal || ''),
        run_mode: 'chat',
        tool_policy: 'all',
        approval_policy: 'safe_mcp_auto',
        network_policy: contextConfig.networkPolicy || {},
        budget_config: contextConfig.budgetConfig || {},
        metadata: { entrypoint: 'chat' }
    };
    const draft = createAgentStepContext({
        run,
        turnId: turnId || `${safeSessionId}:turn:${stepIndex}`,
        stepIndex,
        modelCfg,
        toolList,
        contextConfig,
        environment,
        memory,
        forceWorldStateFull: true
    });
    const now = getBeijingTimestamp();
    return await transaction(async trx => {
        const previousRow = await trx.queryOne(`
            SELECT snapshot_id, window_id, snapshot_version, state, state_hash
            FROM chat_context_snapshots
            WHERE session_id = ? AND user_id = ?
            ORDER BY snapshot_version DESC
            LIMIT 1
            FOR UPDATE
        `, [safeSessionId, userId]);
        const previousState = parseJson(previousRow?.state, null);
        const reason = resolveRefreshReason(previousState, draft.worldState, { contextCompacted, contextConfig, forceWorldStateFull });
        let window = await trx.queryOne(`
            SELECT window_id, window_version, parent_window_id
            FROM chat_context_windows
            WHERE session_id = ? AND user_id = ? AND status = 'active'
            ORDER BY window_version DESC
            LIMIT 1
            FOR UPDATE
        `, [safeSessionId, userId]);
        if (!window || (previousRow && shouldRotate(reason))) {
            if (window) {
                await trx.execute(`UPDATE chat_context_windows SET status = 'superseded', closed_at = ? WHERE window_id = ? AND status = 'active'`, [now, window.window_id]);
            }
            const version = await trx.queryOne(`
                SELECT COALESCE(MAX(window_version), 0) + 1 AS next_version
                FROM chat_context_windows WHERE session_id = ? AND user_id = ?
            `, [safeSessionId, userId]);
            window = {
                window_id: newId('chatctxw'),
                window_version: Number(version?.next_version || 1),
                parent_window_id: window?.window_id || previousRow?.window_id || null
            };
            await trx.execute(`
                INSERT INTO chat_context_windows (
                    window_id, session_id, user_id, window_version, parent_window_id,
                    status, opened_reason, initial_state_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
            `, [window.window_id, safeSessionId, userId, window.window_version, window.parent_window_id, reason || 'initial', draft.worldStateHash, now]);
        }
        const version = await trx.queryOne(`
            SELECT COALESCE(MAX(snapshot_version), 0) + 1 AS next_version
            FROM chat_context_snapshots WHERE session_id = ? AND user_id = ?
        `, [safeSessionId, userId]);
        const snapshotId = newId('chatctxs');
        const forceFull = Boolean(reason || forceWorldStateFull);
        const captured = createAgentStepContext({
            run,
            turnId: turnId || `${safeSessionId}:turn:${stepIndex}`,
            stepIndex,
            modelCfg,
            toolList,
            contextConfig,
            environment,
            memory,
            worldState: draft.worldState,
            previousWorldState: forceFull ? null : previousState,
            forceWorldStateFull: forceFull,
            worldStateWindow: {
                windowId: window.window_id,
                windowVersion: Number(window.window_version),
                parentWindowId: window.parent_window_id || '',
                snapshotId,
                snapshotVersion: Number(version?.next_version || 1),
                fullRefreshReason: reason
            }
        });
        const injection = captured.worldStateInjection || {};
        await trx.execute(`
            INSERT INTO chat_context_snapshots (
                snapshot_id, session_id, user_id, window_id, snapshot_version,
                turn_id, context_hash, state_hash, base_state_hash,
                injection_mode, full_refresh_reason, state, patch, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            snapshotId,
            safeSessionId,
            userId,
            window.window_id,
            Number(version?.next_version || 1),
            captured.turnId,
            captured.contextHash,
            captured.worldStateHash,
            injection.baseHash || '',
            injection.mode || 'full',
            reason,
            JSON.stringify(captured.worldState || {}),
            JSON.stringify(injection.patch || []),
            now
        ]);
        return captured;
    });
}

async function listChatContextWindowsForUser(sessionId, user, { limit = 100 } = {}) {
    const userId = Number(user?.id || 0);
    if (!sessionId || !userId) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return await query(`
        SELECT window_id, session_id, user_id, window_version, parent_window_id,
               status, opened_reason, initial_state_hash, created_at, closed_at
        FROM chat_context_windows
        WHERE session_id = ? AND user_id = ?
        ORDER BY window_version ASC LIMIT ?
    `, [String(sessionId), userId, safeLimit]);
}

async function listChatContextSnapshotsForUser(sessionId, user, { after = 0, limit = 200, windowId = '' } = {}) {
    const userId = Number(user?.id || 0);
    if (!sessionId || !userId) return [];
    const clauses = ['session_id = ?', 'user_id = ?', 'snapshot_version > ?'];
    const params = [String(sessionId), userId, Math.max(Number(after) || 0, 0)];
    if (windowId) { clauses.push('window_id = ?'); params.push(String(windowId)); }
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 500));
    const rows = await query(`
        SELECT snapshot_id, session_id, user_id, window_id, snapshot_version,
               turn_id, context_hash, state_hash, base_state_hash,
               injection_mode, full_refresh_reason, state, patch, created_at
        FROM chat_context_snapshots
        WHERE ${clauses.join(' AND ')}
        ORDER BY snapshot_version ASC LIMIT ?
    `, params);
    return rows.map(row => ({ ...row, state: parseJson(row.state), patch: parseJson(row.patch, []) }));
}

module.exports = {
    createPersistedChatStepContext,
    listChatContextSnapshotsForUser,
    listChatContextWindowsForUser
};
