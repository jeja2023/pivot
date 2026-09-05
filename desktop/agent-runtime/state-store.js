const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    assertAgentRunStatusTransition,
    TERMINAL_STATUSES
} = require('../../server/services/agent-runtime/state-machine');

function openSqliteDatabase(target) {
    try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(target);
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA foreign_keys = ON;');
        return db;
    } catch (_) {
        const Database = require('better-sqlite3');
        const db = new Database(target);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        return db;
    }
}

function json(value, fallback = {}) {
    try { return JSON.stringify(value ?? fallback); } catch (_) { return JSON.stringify(fallback); }
}

function parse(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function nowIso() { return new Date().toISOString(); }

function ensureColumn(db, table, column, definition) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(item => item.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

class DesktopAgentStateStore {
    constructor(dbPath) {
        const target = path.resolve(String(dbPath || path.join(process.cwd(), 'data', 'agent-state.db')));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        this.db = openSqliteDatabase(target);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                goal TEXT NOT NULL,
                status TEXT NOT NULL,
                budget_config TEXT NOT NULL DEFAULT '{}',
                usage_stats TEXT NOT NULL DEFAULT '{}',
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS agent_steps (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                step_index INTEGER NOT NULL,
                phase TEXT NOT NULL,
                tool_name TEXT,
                input_payload TEXT,
                output_payload TEXT,
                status TEXT NOT NULL,
                error_category TEXT,
                error_message TEXT,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                context_hash TEXT NOT NULL DEFAULT '',
                world_state_hash TEXT NOT NULL DEFAULT '',
                context_snapshot TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_tool_calls (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                step_id TEXT NOT NULL,
                operation_key TEXT NOT NULL UNIQUE,
                tool_name TEXT NOT NULL,
                input_hash TEXT NOT NULL,
                idempotent INTEGER NOT NULL DEFAULT 0,
                policy_decision TEXT NOT NULL,
                status TEXT NOT NULL,
                input_payload TEXT NOT NULL DEFAULT '{}',
                output_payload TEXT,
                error_message TEXT,
                attempt INTEGER NOT NULL DEFAULT 1,
                context_hash TEXT NOT NULL DEFAULT '',
                world_state_hash TEXT NOT NULL DEFAULT '',
                context_snapshot TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                committed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS agent_checkpoints (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                step_index INTEGER NOT NULL,
                status TEXT NOT NULL,
                state TEXT NOT NULL,
                context_snapshot TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_context_windows (
                window_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                window_version INTEGER NOT NULL,
                parent_window_id TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                full_refresh_reason TEXT NOT NULL DEFAULT 'initial',
                created_at TEXT NOT NULL,
                closed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS agent_world_state_snapshots (
                snapshot_id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                window_id TEXT NOT NULL REFERENCES agent_context_windows(window_id) ON DELETE CASCADE,
                snapshot_version INTEGER NOT NULL,
                turn_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                context_hash TEXT NOT NULL,
                world_state_hash TEXT NOT NULL,
                state TEXT NOT NULL,
                context_snapshot TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                UNIQUE(window_id, snapshot_version)
            );
            CREATE INDEX IF NOT EXISTS idx_desktop_agent_steps_run ON agent_steps(run_id, step_index);
            CREATE INDEX IF NOT EXISTS idx_desktop_agent_calls_run ON agent_tool_calls(run_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_desktop_agent_checkpoints_run ON agent_checkpoints(run_id, step_index);
            CREATE INDEX IF NOT EXISTS idx_desktop_agent_context_window ON agent_context_windows(run_id, window_version DESC);
            CREATE INDEX IF NOT EXISTS idx_desktop_agent_context_snapshot ON agent_world_state_snapshots(run_id, snapshot_version DESC);
        `);
        ensureColumn(this.db, 'agent_steps', 'context_hash', "TEXT NOT NULL DEFAULT ''");
        ensureColumn(this.db, 'agent_steps', 'world_state_hash', "TEXT NOT NULL DEFAULT ''");
        ensureColumn(this.db, 'agent_steps', 'context_snapshot', "TEXT NOT NULL DEFAULT '{}'");
        ensureColumn(this.db, 'agent_tool_calls', 'context_hash', "TEXT NOT NULL DEFAULT ''");
        ensureColumn(this.db, 'agent_tool_calls', 'world_state_hash', "TEXT NOT NULL DEFAULT ''");
        ensureColumn(this.db, 'agent_tool_calls', 'context_snapshot', "TEXT NOT NULL DEFAULT '{}'");
        ensureColumn(this.db, 'agent_checkpoints', 'context_snapshot', "TEXT NOT NULL DEFAULT '{}'");
        this.path = target;
    }

    createRun({ id = `run_${crypto.randomUUID()}`, goal, status = 'queued', budgetConfig = {}, metadata = {} } = {}) {
        if (!String(goal || '').trim()) throw new Error('桌面 Agent 任务目标不能为空。');
        const timestamp = nowIso();
        this.db.prepare(`
            INSERT INTO agent_runs (id, goal, status, budget_config, usage_stats, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, '{}', ?, ?, ?)
        `).run(id, String(goal).trim(), status, json(budgetConfig), json(metadata), timestamp, timestamp);
        return this.getRun(id);
    }

    getRun(id) {
        const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(String(id));
        if (!row) return null;
        return { ...row, budgetConfig: parse(row.budget_config), usageStats: parse(row.usage_stats), metadata: parse(row.metadata) };
    }

    transitionRun(id, status, patch = {}) {
        const current = this.db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(String(id));
        if (!current) throw new Error(`桌面 Agent 任务不存在：${id}`);
        assertAgentRunStatusTransition(current.status, status, { runId: id });
        const timestamp = nowIso();
        const updates = { ...patch, status, updated_at: timestamp };
        if (TERMINAL_STATUSES.has(status)) updates.completed_at = updates.completed_at || timestamp;
        const keys = Object.keys(updates).filter(key => ['status', 'budget_config', 'usage_stats', 'metadata', 'updated_at', 'completed_at'].includes(key));
        const values = keys.map(key => updates[key] && typeof updates[key] === 'object' ? json(updates[key]) : updates[key]);
        this.db.prepare(`UPDATE agent_runs SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ? AND status = ?`).run(...values, String(id), current.status);
        return this.getRun(id);
    }

    updateUsageStats(id, usageStats) {
        const timestamp = nowIso();
        this.db.prepare('UPDATE agent_runs SET usage_stats = ?, updated_at = ? WHERE id = ?')
            .run(json(usageStats), timestamp, String(id));
        return this.getRun(id);
    }

    appendStep(runId, step = {}) {
        const id = step.id || crypto.randomUUID();
        const context = step.stepContext || step.contextSnapshot || {};
        this.db.prepare(`
            INSERT INTO agent_steps (id, run_id, step_index, phase, tool_name, input_payload, output_payload, status, error_category, error_message, duration_ms, context_hash, world_state_hash, context_snapshot, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, runId, Number(step.stepIndex) || 0, String(step.phase || 'control'), step.toolName || null,
            json(step.input), step.output === undefined ? null : json(step.output), String(step.status || 'success'),
            step.errorCategory || null, step.errorMessage || null, Math.max(Number(step.durationMs) || 0, 0),
            String(context.contextHash || step.contextHash || ''), String(context.worldStateHash || step.worldStateHash || ''),
            json(context), step.createdAt || nowIso());
        return id;
    }

    beginTool({ runId, stepId, operationKey, toolName, input, inputHash, idempotent, policyDecision = 'allow', contextSnapshot = {} }) {
        const existing = this.db.prepare('SELECT * FROM agent_tool_calls WHERE operation_key = ?').get(operationKey);
        if (existing && existing.input_hash && inputHash && String(existing.input_hash) !== String(inputHash)) {
            const error = new Error('工具操作键与输入摘要不匹配，已拒绝潜在重放混淆。');
            error.code = 'AGENT_OPERATION_INPUT_MISMATCH';
            error.category = 'policy';
            throw error;
        }
        if (existing?.status === 'completed') return { replay: true, output: parse(existing.output_payload, null), id: existing.id };
        if (existing && !idempotent && policyDecision !== 'allow') {
            const error = new Error('未完成的非幂等工具调用需要重新审批。');
            error.code = 'AGENT_RECOVERY_REQUIRES_APPROVAL';
            throw error;
        }
        const id = existing?.id || crypto.randomUUID();
        if (existing) {
            this.db.prepare(`UPDATE agent_tool_calls SET status = 'pending', attempt = attempt + 1, policy_decision = ?, input_payload = ?, context_hash = ?, world_state_hash = ?, context_snapshot = ? WHERE operation_key = ?`)
                .run(policyDecision, json(input), String(contextSnapshot.contextHash || ''), String(contextSnapshot.worldStateHash || ''), json(contextSnapshot), operationKey);
        } else {
            this.db.prepare(`
                INSERT INTO agent_tool_calls (id, run_id, step_id, operation_key, tool_name, input_hash, idempotent, policy_decision, status, input_payload, context_hash, world_state_hash, context_snapshot, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
            `).run(id, runId, stepId, operationKey, toolName, inputHash, idempotent ? 1 : 0, policyDecision, json(input), String(contextSnapshot.contextHash || ''), String(contextSnapshot.worldStateHash || ''), json(contextSnapshot), nowIso());
        }
        return { replay: false, id };
    }

    completeTool(operationKey, output, error = null) {
        const status = error ? 'error' : 'completed';
        this.db.prepare(`UPDATE agent_tool_calls SET status = ?, output_payload = ?, error_message = ?, committed_at = ? WHERE operation_key = ? AND status = 'pending'`)
            .run(status, error ? null : json(output), error ? String(error.message || error) : null, nowIso(), operationKey);
        return this.db.prepare('SELECT * FROM agent_tool_calls WHERE operation_key = ?').get(operationKey);
    }

    writeCheckpoint(runId, stepIndex, state, status = 'completed', contextSnapshot = {}) {
        const id = crypto.randomUUID();
        this.db.prepare('INSERT INTO agent_checkpoints (id, run_id, step_index, status, state, context_snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, runId, Number(stepIndex) || 0, status, json(state), json(contextSnapshot), nowIso());
        return id;
    }

    prepareWorldStateWindow({ runId, turnId, stepIndex, worldState = {} }) {
        const now = nowIso();
        const previous = this.db.prepare(`
            SELECT * FROM agent_world_state_snapshots
            WHERE run_id = ?
            ORDER BY created_at DESC, snapshot_version DESC
            LIMIT 1
        `).get(String(runId));
        const previousState = previous ? parse(previous.state, {}) : null;
        let window = this.db.prepare(`
            SELECT * FROM agent_context_windows
            WHERE run_id = ? AND status = 'active'
            ORDER BY window_version DESC
            LIMIT 1
        `).get(String(runId));
        const previousModelId = String(previousState?.model?.id ?? '');
        const nextModelId = String(worldState?.model?.id ?? '');
        const modelChanged = Boolean(previous && previousModelId !== nextModelId);
        let reason = previous ? '' : 'initial';
        if (!window || modelChanged) {
            if (window) {
                this.db.prepare("UPDATE agent_context_windows SET status = 'superseded', closed_at = ? WHERE window_id = ?")
                    .run(now, window.window_id);
            }
            const version = Number(this.db.prepare('SELECT COALESCE(MAX(window_version), 0) AS value FROM agent_context_windows WHERE run_id = ?').get(String(runId))?.value || 0) + 1;
            reason = modelChanged ? 'model_changed' : 'initial';
            window = {
                window_id: `desktopctxw_${crypto.randomUUID()}`,
                window_version: version,
                parent_window_id: window?.window_id || previous?.window_id || null,
                status: 'active',
                full_refresh_reason: reason
            };
            this.db.prepare(`
                INSERT INTO agent_context_windows (window_id, run_id, window_version, parent_window_id, status, full_refresh_reason, created_at)
                VALUES (?, ?, ?, ?, 'active', ?, ?)
            `).run(window.window_id, String(runId), version, window.parent_window_id, reason, now);
        }
        const snapshotVersion = Number(this.db.prepare('SELECT COALESCE(MAX(snapshot_version), 0) AS value FROM agent_world_state_snapshots WHERE window_id = ?').get(window.window_id)?.value || 0) + 1;
        return {
            previousWorldState: previousState,
            forceWorldStateFull: !previous || Boolean(reason),
            worldStateWindow: {
                windowId: window.window_id,
                windowVersion: Number(window.window_version || 1),
                parentWindowId: window.parent_window_id || '',
                snapshotVersion,
                turnId: String(turnId || ''),
                stepIndex: Number(stepIndex || 0),
                fullRefreshReason: reason || ''
            }
        };
    }

    persistWorldStateSnapshot({ runId, turnId, stepIndex, stepContext }) {
        const context = stepContext || {};
        const window = context.worldStateWindow || {};
        if (!window.windowId) return null;
        const id = `desktopctxs_${crypto.randomUUID()}`;
        this.db.prepare(`
            INSERT INTO agent_world_state_snapshots (
                snapshot_id, run_id, window_id, snapshot_version, turn_id, step_index,
                context_hash, world_state_hash, state, context_snapshot, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, String(runId), String(window.windowId), Number(window.snapshotVersion || 1),
            String(turnId || context.turnId || ''), Number(stepIndex || context.stepIndex || 0),
            String(context.contextHash || ''), String(context.worldStateHash || ''), json(context.worldState || {}),
            json(context), nowIso()
        );
        return id;
    }

    listIncompleteRuns() {
        return this.db.prepare("SELECT id FROM agent_runs WHERE status IN ('queued', 'running', 'executing', 'observing', 'diagnosing', 'replanning', 'approval_required', 'awaiting_approval', 'waiting_approval', 'resuming') ORDER BY created_at").all();
    }

    recoverRun(id) {
        const run = this.getRun(id);
        if (!run) return null;
        const pending = this.db.prepare("SELECT * FROM agent_tool_calls WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(id);
        const checkpoint = this.db.prepare('SELECT * FROM agent_checkpoints WHERE run_id = ? ORDER BY step_index DESC, created_at DESC LIMIT 1').get(id);
        return { run, pendingTool: pending ? { ...pending, input: parse(pending.input_payload) } : null, checkpoint: checkpoint ? { ...checkpoint, state: parse(checkpoint.state) } : null };
    }

    listSteps(runId) { return this.db.prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_index, created_at').all(runId).map(row => ({ ...row, input: parse(row.input_payload), output: parse(row.output_payload, null), contextSnapshot: parse(row.context_snapshot, {}) })); }
    listToolCalls(runId) {
        return this.db.prepare('SELECT * FROM agent_tool_calls WHERE run_id = ? ORDER BY created_at').all(runId).map(row => ({
            ...row,
            input: parse(row.input_payload),
            output: parse(row.output_payload, null),
            contextSnapshot: parse(row.context_snapshot, {}),
            tool_name: row.tool_name,
            input_hash: row.input_hash,
            side_effect: row.idempotent !== 1
        }));
    }
    listWorldStateSnapshots(runId) {
        return this.db.prepare('SELECT * FROM agent_world_state_snapshots WHERE run_id = ? ORDER BY created_at, snapshot_version').all(String(runId))
            .map(row => ({ ...row, state: parse(row.state, {}), contextSnapshot: parse(row.context_snapshot, {}) }));
    }
    close() { this.db.close(); }
}

module.exports = { DesktopAgentStateStore, parse, json };
