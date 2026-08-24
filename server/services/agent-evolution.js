const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { updateAgentProfile } = require('./agent-profile');

const PROPOSAL_KINDS = Object.freeze(['skill', 'workflow', 'preference']);
const PROPOSAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'applied', 'cancelled']);

function proposalError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function serializeProposal(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        title: row.title,
        description: row.description || '',
        proposedChange: parseJson(row.proposed_change, {}),
        sourceRunId: row.source_run_id || null,
        status: row.status,
        version: Number(row.version || 1),
        reviewedBy: row.reviewed_by || null,
        reviewNote: row.review_note || '',
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        reviewedAt: row.reviewed_at || null,
        appliedAt: row.applied_at || null
    };
}

function normalizeProposalInput(input = {}) {
    const kind = String(input.kind || '').trim().toLowerCase();
    if (!PROPOSAL_KINDS.includes(kind)) throw proposalError('进化提议类型只能是 skill、workflow 或 preference。');
    const title = String(input.title || '').trim().slice(0, 255);
    if (!title) throw proposalError('进化提议标题不能为空。');
    const proposedChange = input.proposedChange ?? input.proposed_change ?? input.change ?? {};
    if (!proposedChange || typeof proposedChange !== 'object' || Array.isArray(proposedChange)) throw proposalError('进化提议必须是结构化变更。');
    if (JSON.stringify(proposedChange).length > 24000) throw proposalError('进化提议变更过大，请拆分为多个版本。');
    return {
        kind,
        title,
        description: String(input.description || '').trim().slice(0, 4000),
        proposedChange,
        sourceRunId: input.sourceRunId || input.source_run_id || null
    };
}

async function createEvolutionProposal(user, input = {}) {
    const normalized = normalizeProposalInput(input);
    if (normalized.sourceRunId && !(await queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [String(normalized.sourceRunId), user.id]))) {
        throw proposalError('来源任务不存在或无权引用。', 404);
    }
    const id = `evo_${crypto.randomUUID()}`;
    const now = getBeijingTimestamp();
    await execute(`
        INSERT INTO agent_evolution_proposals (id, user_id, kind, title, description, proposed_change, source_run_id, status, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
    `, [id, user.id, normalized.kind, normalized.title, normalized.description, JSON.stringify(normalized.proposedChange), normalized.sourceRunId, now, now]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [id, user.id]));
}

async function listEvolutionProposals(user, options = {}) {
    const status = String(options.status || '').trim();
    const params = [user.id];
    const where = ['user_id = ?'];
    if (PROPOSAL_STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    params.push(limit);
    const rows = await query(`SELECT * FROM agent_evolution_proposals WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, created_at DESC LIMIT ?`, params);
    return rows.map(serializeProposal);
}

async function decideEvolutionProposal(user, id, decision, note = '') {
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalizedDecision)) throw proposalError('审批决定只能是 approve 或 reject。');
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row) return null;
    if (row.status !== 'pending') throw proposalError('只有待审批提议可以处理。', 409);
    const now = getBeijingTimestamp();
    const status = normalizedDecision === 'approve' ? 'approved' : 'rejected';
    await execute('UPDATE agent_evolution_proposals SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = ?', [status, user.id, String(note || '').slice(0, 4000), now, now, row.id, user.id, 'pending']);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [row.id, user.id]));
}

async function applyEvolutionProposal(user, id) {
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row) return null;
    if (row.status !== 'approved') throw proposalError('只有已审批提议可以应用。', 409);
    const change = parseJson(row.proposed_change, {});
    if (row.kind !== 'preference') {
        return { proposal: serializeProposal(row), applied: false, requiresVersionedAction: true, reason: 'Skill 和工作流必须在版本化编辑器中应用。' };
    }
    const profile = await updateAgentProfile(user.id, change);
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_evolution_proposals SET status = 'applied', applied_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND user_id = ? AND status = 'approved'", [now, now, row.id, user.id]);
    return {
        proposal: serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [row.id, user.id])),
        applied: true,
        profile
    };
}

module.exports = {
    PROPOSAL_KINDS,
    PROPOSAL_STATUSES,
    applyEvolutionProposal,
    createEvolutionProposal,
    decideEvolutionProposal,
    listEvolutionProposals,
    normalizeProposalInput,
    serializeProposal
};
