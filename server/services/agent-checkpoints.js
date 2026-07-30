const { randomUUID } = require('crypto');
const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');

const MAX_CHECKPOINT_STATE_LENGTH = 120000;
const CHECKPOINT_TYPES = new Set(['plan', 'tool', 'dag', 'approval', 'control']);

function parseCheckpointState(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (e) { return {}; }
}

function serializeCheckpointState(value) {
    try {
        const text = JSON.stringify(value ?? {});
        if (text.length <= MAX_CHECKPOINT_STATE_LENGTH) return text;
        return JSON.stringify({
            truncated: true,
            summary: text.slice(0, MAX_CHECKPOINT_STATE_LENGTH),
            originalLength: text.length
        });
    } catch (e) {
        return JSON.stringify({ serializationError: true });
    }
}

function recordAgentCheckpoint(runId, data = {}) {
    if (!runId) return null;
    const type = CHECKPOINT_TYPES.has(String(data.type || '')) ? String(data.type) : 'control';
    try {
        const checkpointId = randomUUID();
        const info = db.prepare(`
            INSERT INTO agent_run_checkpoints (
                checkpoint_id, run_id, step_index, checkpoint_type, status, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            checkpointId,
            runId,
            Math.max(Number(data.stepIndex) || 0, 0),
            type,
            String(data.status || 'completed').slice(0, 30),
            serializeCheckpointState(data.state || {}),
            data.createdAt || getBeijingTimestamp()
        );
        return info.changes ? checkpointId : null;
    } catch (e) {
        return null;
    }
}

function listAgentCheckpoints(runId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    return db.prepare(`
        SELECT checkpoint_id, run_id, step_index, checkpoint_type, status, state, created_at
        FROM agent_run_checkpoints
        WHERE run_id = ?
        ORDER BY step_index DESC, id DESC
        LIMIT ?
    `).all(runId, limit).map(row => ({ ...row, state: parseCheckpointState(row.state) }));
}

function listAgentCheckpointsForUser(runId, user, options = {}) {
    const run = db.prepare('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(runId, user.id);
    return run ? listAgentCheckpoints(runId, options) : null;
}

function getLatestAgentCheckpoint(runId) {
    return listAgentCheckpoints(runId, { limit: 1 })[0] || null;
}

function buildAgentResumeContext(runId) {
    const allCheckpoints = listAgentCheckpoints(runId, { limit: 80 }).reverse();
    const checkpoints = allCheckpoints.filter(item => ['completed', 'success'].includes(String(item.status || '')));
    const observations = checkpoints
        .filter(item => ['tool', 'dag'].includes(item.checkpoint_type))
        .map(item => ({
            step: item.step_index,
            tool: item.state.toolName || '',
            node: item.state.nodeId || '',
            input: item.state.input || {},
            output: item.state.output,
            resumedFromCheckpointId: item.checkpoint_id
        }))
        .slice(-20);
    const recentFailures = allCheckpoints
        .filter(item => item.status === 'error')
        .map(item => ({
            step: item.step_index,
            tool: item.state.toolName || '',
            node: item.state.nodeId || '',
            error: item.state.errorMessage || item.state.output?.error || '执行失败'
        }))
        .slice(-5);
    const latest = checkpoints[checkpoints.length - 1] || null;
    return {
        sourceRunId: runId,
        latestCheckpointId: latest?.checkpoint_id || '',
        latestStepIndex: Number(latest?.step_index || 0),
        checkpointCount: checkpoints.length,
        observations,
        recentFailures
    };
}

function summarizeAgentCheckpoints(runId) {
    const row = db.prepare(`
        SELECT COUNT(*) AS total,
               MAX(step_index) AS latest_step,
               MAX(created_at) AS latest_at,
               SUM(CASE WHEN checkpoint_type = 'tool' THEN 1 ELSE 0 END) AS tool_count,
               SUM(CASE WHEN checkpoint_type = 'dag' THEN 1 ELSE 0 END) AS dag_count
        FROM agent_run_checkpoints WHERE run_id = ?
    `).get(runId) || {};
    return {
        total: Number(row.total || 0),
        latestStep: Number(row.latest_step || 0),
        latestAt: row.latest_at || '',
        toolCount: Number(row.tool_count || 0),
        dagCount: Number(row.dag_count || 0)
    };
}

module.exports = {
    buildAgentResumeContext,
    getLatestAgentCheckpoint,
    listAgentCheckpoints,
    listAgentCheckpointsForUser,
    parseCheckpointState,
    recordAgentCheckpoint,
    serializeCheckpointState,
    summarizeAgentCheckpoints
};
