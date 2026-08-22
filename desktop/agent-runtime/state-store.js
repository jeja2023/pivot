const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
    assertAgentRunStatusTransition,
    TERMINAL_STATUSES
} = require('../../server/services/agent-runtime/state-machine');

function json(value, fallback = {}) {
    try { return JSON.stringify(value ?? fallback); } catch (_) { return JSON.stringify(fallback); }
}

function parse(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function nowIso() { return new Date().toISOString(); }

class DesktopAgentStateStore {
    constructor(dbPath) {
        const target = path.resolve(String(dbPath || path.join(process.cwd(), 'data', 'agent-state.db')));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        this.db = new Database(target);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
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
                created_at TEXT NOT NULL,
                committed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS agent_checkpoints (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                step_index INTEGER NOT NULL,
                status TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_desktop_agent_steps_run ON agent_steps(run_id, step_index);
            CREATE INDEX IF NOT EXISTS idx_desktop_agent_calls_run ON agent_tool_calls(run_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_desktop_agent_checkpoints_run ON agent_checkpoints(run_id, step_index);
        `);
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
        this.db.prepare(`
            INSERT INTO agent_steps (id, run_id, step_index, phase, tool_name, input_payload, output_payload, status, error_category, error_message, duration_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, runId, Number(step.stepIndex) || 0, String(step.phase || 'control'), step.toolName || null,
            json(step.input), step.output === undefined ? null : json(step.output), String(step.status || 'success'),
            step.errorCategory || null, step.errorMessage || null, Math.max(Number(step.durationMs) || 0, 0), step.createdAt || nowIso());
        return id;
    }

    beginTool({ runId, stepId, operationKey, toolName, input, inputHash, idempotent, policyDecision = 'allow' }) {
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
            this.db.prepare(`UPDATE agent_tool_calls SET status = 'pending', attempt = attempt + 1, policy_decision = ?, input_payload = ? WHERE operation_key = ?`)
                .run(policyDecision, json(input), operationKey);
        } else {
            this.db.prepare(`
                INSERT INTO agent_tool_calls (id, run_id, step_id, operation_key, tool_name, input_hash, idempotent, policy_decision, status, input_payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            `).run(id, runId, stepId, operationKey, toolName, inputHash, idempotent ? 1 : 0, policyDecision, json(input), nowIso());
        }
        return { replay: false, id };
    }

    completeTool(operationKey, output, error = null) {
        const status = error ? 'error' : 'completed';
        this.db.prepare(`UPDATE agent_tool_calls SET status = ?, output_payload = ?, error_message = ?, committed_at = ? WHERE operation_key = ? AND status = 'pending'`)
            .run(status, error ? null : json(output), error ? String(error.message || error) : null, nowIso(), operationKey);
        return this.db.prepare('SELECT * FROM agent_tool_calls WHERE operation_key = ?').get(operationKey);
    }

    writeCheckpoint(runId, stepIndex, state, status = 'completed') {
        const id = crypto.randomUUID();
        this.db.prepare('INSERT INTO agent_checkpoints (id, run_id, step_index, status, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, runId, Number(stepIndex) || 0, status, json(state), nowIso());
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

    listSteps(runId) { return this.db.prepare('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_index, created_at').all(runId).map(row => ({ ...row, input: parse(row.input_payload), output: parse(row.output_payload, null) })); }
    listToolCalls(runId) {
        return this.db.prepare('SELECT * FROM agent_tool_calls WHERE run_id = ? ORDER BY created_at').all(runId).map(row => ({
            ...row,
            input: parse(row.input_payload),
            output: parse(row.output_payload, null),
            tool_name: row.tool_name,
            input_hash: row.input_hash,
            side_effect: row.idempotent !== 1
        }));
    }
    close() { this.db.close(); }
}

module.exports = { DesktopAgentStateStore, parse, json };
