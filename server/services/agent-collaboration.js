const { query } = require('../db/client');

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

async function listCollaboratorRuns(parentRunId, user) {
    const parent = await query(`SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [String(parentRunId || ''), user.id]);
    if (!parent.length) return null;
    const rows = await query(`SELECT id, parent_run_id, title, goal, status, metadata, created_at, updated_at, completed_at, error_message FROM agent_runs WHERE parent_run_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [String(parentRunId), user.id]);
    return rows.map(row => ({ ...row, metadata: parseJson(row.metadata, {}) }));
}

function normalizeDelegationInput(input = {}) {
    const goal = String(input.goal || '').trim().slice(0, 12000);
    if (goal.length < 4) throw Object.assign(new Error('协作委派目标不能为空。'), { status: 400, code: 'AGENT_DELEGATION_INVALID' });
    return { goal, title: String(input.title || '协作子任务').trim().slice(0, 160), maxSteps: Math.max(1, Math.min(Number.parseInt(input.maxSteps || input.max_steps, 10) || 6, 60)), maxTokenBudget: Math.max(0, Math.min(Number.parseInt(input.maxTokenBudget || input.max_token_budget, 10) || 0, 10000000)), approvalPolicy: String(input.approvalPolicy || input.approval_policy || 'safe_mcp_auto').slice(0, 40), toolPolicy: String(input.toolPolicy || input.tool_policy || 'builtin_only').slice(0, 40), forkHistory: String(input.forkHistory || input.fork_history || 'none').slice(0, 20) };
}

async function buildDelegationContext(parentRunId, user) {
    const row = await query(`SELECT id, title, goal, status, metadata FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL`, [String(parentRunId || ''), user.id]);
    if (!row.length) return null;
    return { parentRunId: row[0].id, parentTitle: row[0].title, parentGoal: row[0].goal, parentStatus: row[0].status, parentMetadata: parseJson(row[0].metadata, {}) };
}

module.exports = { buildDelegationContext, listCollaboratorRuns, normalizeDelegationInput };
