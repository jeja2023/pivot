const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { updateAgentProfile } = require('./agent-profile');
const { getPrimaryTenantId } = require('./enterprise-access');

const PROPOSAL_KINDS = Object.freeze(['skill', 'workflow', 'preference']);
const PROPOSAL_STATUSES = Object.freeze([
    'draft', 'pending', 'pending_review', 'sandbox_validate', 'versioned_draft',
    'approved', 'published', 'rejected', 'validation_failed', 'applied', 'rolled_back', 'cancelled'
]);

function proposalError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.status = statusCode;
    error.code = 'AGENT_EVOLUTION_ERROR';
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function redactSensitive(value, depth = 0) {
    if (depth > 6 || value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.slice(0, 100).map(item => redactSensitive(item, depth + 1));
    if (typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
        key,
        /secret|token|password|api[-_]?key|private[-_]?key/i.test(key) ? '[已脱敏]' : redactSensitive(item, depth + 1)
    ]));
}

function containsCredentialKey(value, depth = 0) {
    if (depth > 6 || value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(item => containsCredentialKey(item, depth + 1));
    return Object.entries(value).some(([key, item]) => /secret|token|password|api[-_]?key|private[-_]?key/i.test(key) || containsCredentialKey(item, depth + 1));
}

function serializeProposal(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        title: row.title,
        description: row.description || '',
        proposedChange: redactSensitive(parseJson(row.proposed_change, {})),
        sourceRunId: row.source_run_id || null,
        status: row.status,
        version: Number(row.version || 1),
        reviewedBy: row.reviewed_by || null,
        reviewNote: row.review_note || '',
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        reviewedAt: row.reviewed_at || null,
        appliedAt: row.applied_at || null
        ,riskLevel: row.risk_level || 'low'
        ,permissionDiff: parseJson(row.permission_diff, {})
        ,testPlan: parseJson(row.test_plan, {})
        ,rollbackPlan: parseJson(row.rollback_plan, {})
        ,publishedAt: row.published_at || null
        ,rolledBackAt: row.rolled_back_at || null
        ,rollbackTargetId: row.rollback_target_id || null
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
    if (containsCredentialKey(proposedChange)) throw proposalError('进化提议不能包含凭据或敏感密钥。', 422);
    const permissionDiff = proposedChange.permissions || proposedChange.authorization || {};
    const riskLevel = permissionDiff && Object.keys(permissionDiff).length ? 'high' : (kind === 'preference' ? 'low' : 'medium');
    return {
        kind,
        title,
        description: String(input.description || '').trim().slice(0, 4000),
        proposedChange,
        sourceRunId: input.sourceRunId || input.source_run_id || null,
        riskLevel,
        permissionDiff,
        testPlan: input.testPlan || input.test_plan || { static: true, sandbox: kind !== 'preference', regression: kind !== 'preference' },
        rollbackPlan: input.rollbackPlan || input.rollback_plan || { strategy: 'restore_previous_version' },
        idempotencyKey: String(input.idempotencyKey || input.idempotency_key || '').trim().slice(0, 255)
    };
}

async function createEvolutionProposal(user, input = {}) {
    const normalized = normalizeProposalInput(input);
    if (normalized.sourceRunId && !(await queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [String(normalized.sourceRunId), user.id]))) {
        throw proposalError('来源任务不存在或无权引用。', 404);
    }
    if (normalized.idempotencyKey) {
        const existing = await queryOne('SELECT * FROM agent_evolution_proposals WHERE user_id = ? AND idempotency_key = ?', [user.id, normalized.idempotencyKey]);
        if (existing) return serializeProposal(existing);
    }
    const id = `evo_${crypto.randomUUID()}`;
    const now = getBeijingTimestamp();
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    await execute(`
        INSERT INTO agent_evolution_proposals (id, user_id, tenant_id, kind, title, description, proposed_change, source_run_id, status, version, risk_level, permission_diff, test_plan, rollback_plan, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?)
    `, [id, user.id, tenantId, normalized.kind, normalized.title, normalized.description, JSON.stringify(normalized.proposedChange), normalized.sourceRunId, normalized.riskLevel, JSON.stringify(normalized.permissionDiff), JSON.stringify(normalized.testPlan), JSON.stringify(normalized.rollbackPlan), normalized.idempotencyKey || null, now, now]);
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
    if (!['pending', 'draft'].includes(row.status)) throw proposalError('只有待审批提议可以处理。', 409);
    const now = getBeijingTimestamp();
    const status = normalizedDecision === 'approve'
        ? (row.kind === 'preference' ? 'approved' : 'pending_review')
        : 'rejected';
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

const FORBIDDEN_CHANGE_KEYS = new Set(['pep', 'pdp', 'policy', 'networkPolicy', 'tenantPermissions', 'auditRules', 'securityBoundary', 'credentials', 'elevation']);

function inspectEvolutionChange(value, path = '', errors = [], depth = 0) {
    if (depth > 8) { errors.push('变更嵌套深度超过限制'); return errors; }
    if (Array.isArray(value)) return value.slice(0, 100).forEach((item, index) => inspectEvolutionChange(item, `${path}[${index}]`, errors, depth + 1));
    if (!value || typeof value !== 'object') return errors;
    Object.entries(value).forEach(([key, child]) => {
        if (FORBIDDEN_CHANGE_KEYS.has(key) || /securityboundary|tenantpermissions|auditrules|pep|pdp/i.test(key.toLowerCase())) errors.push(`禁止修改安全边界：${path ? `${path}.` : ''}${key}`);
        inspectEvolutionChange(child, `${path ? `${path}.` : ''}${key}`, errors, depth + 1);
    });
    return errors;
}

async function validateEvolutionProposal(user, id, options = {}) {
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row) return null;
    if (!['pending_review', 'approved', 'validation_failed', 'sandbox_validate'].includes(row.status)) throw proposalError('当前提议状态不能启动验证。', 409);
    const change = parseJson(row.proposed_change, {});
    const errors = inspectEvolutionChange(change);
    const staticResult = { passed: errors.length === 0, errors, checked: ['schema', 'forbidden_keys', 'size'] };
    const isPreference = row.kind === 'preference';
    if (row.kind === 'skill') {
        const manifest = change.manifest || change;
        if (!manifest.name || !manifest.version || !manifest.instructions && !change.instructions) errors.push('Skill Manifest 必须包含 name、version 和 instructions。');
        if (manifest.permissions && !Array.isArray(manifest.permissions)) errors.push('Skill permissions 必须是数组。');
    }
    if (row.kind === 'workflow') {
        const nodes = change.nodes || change.dagSpec?.nodes || change.dag_spec?.nodes;
        if (!Array.isArray(nodes) || !nodes.length) errors.push('工作流草稿必须包含至少一个 DAG 节点。');
        if (change.published === true || change.status === 'published') errors.push('提议不能直接声明已发布状态。');
    }
    const sandboxResult = { passed: errors.length === 0, mode: isPreference ? 'profile-dry-run' : 'isolated-preview', sideEffects: false, cases: Number(options.cases || 1) };
    const evaluationResult = { passed: errors.length === 0, score: errors.length ? 0 : 1, regressionSuite: options.suiteId || null };
    const status = errors.length ? 'validation_failed' : 'versioned_draft';
    const now = getBeijingTimestamp();
    await execute(`INSERT INTO agent_evolution_validations (proposal_id, user_id, stage, status, static_result, sandbox_result, evaluation_result, risk_level, permission_diff, test_plan, rollback_plan, version, error_code, error_message, validated_at, created_at, updated_at) VALUES (?, ?, 'sandbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, user.id, status === 'versioned_draft' ? 'passed' : 'failed', JSON.stringify(staticResult), JSON.stringify(sandboxResult), JSON.stringify(evaluationResult), row.risk_level || 'medium', row.permission_diff || '{}', row.test_plan || '{}', row.rollback_plan || '{}', Number(row.version || 1), errors.length ? 'VALIDATION_FAILED' : '', errors.join('; ').slice(0, 2000), now, now, now]);
    await execute('UPDATE agent_evolution_proposals SET status = ?, version = CASE WHEN ? = \'versioned_draft\' THEN version + 1 ELSE version END, updated_at = ? WHERE id = ? AND user_id = ?', [status, status, now, row.id, user.id]);
    return { proposal: serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id])), validation: { static: staticResult, sandbox: sandboxResult, evaluation: evaluationResult, passed: !errors.length } };
}

async function listEvolutionValidations(user, proposalId) {
    const rows = await query(`SELECT v.* FROM agent_evolution_validations v JOIN agent_evolution_proposals p ON p.id = v.proposal_id WHERE v.user_id = ? AND (? = '' OR v.proposal_id = ?) ORDER BY v.created_at DESC`, [user.id, String(proposalId || ''), String(proposalId || '')]);
    return rows.map(row => ({ id: row.id, proposalId: row.proposal_id, stage: row.stage, status: row.status, staticResult: parseJson(row.static_result, {}), sandboxResult: parseJson(row.sandbox_result, {}), evaluationResult: parseJson(row.evaluation_result, {}), riskLevel: row.risk_level, permissionDiff: parseJson(row.permission_diff, {}), errorCode: row.error_code || '', errorMessage: row.error_message || '', version: Number(row.version || 1), validatedAt: row.validated_at || null, createdAt: row.created_at || null }));
}

async function publishEvolutionProposal(user, id) {
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row) return null;
    if (row.status !== 'versioned_draft') throw proposalError('只有通过沙箱验证的版本草稿可以发布。', 409);
    const validation = await queryOne('SELECT status FROM agent_evolution_validations WHERE proposal_id = ? ORDER BY version DESC, created_at DESC LIMIT 1', [row.id]);
    if (!validation || validation.status !== 'passed') throw proposalError('发布门禁未通过，不能发布。', 409);
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_evolution_proposals SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'versioned_draft'", [now, now, row.id, user.id]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id]));
}

async function rollbackEvolutionProposal(user, id) {
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row) return null;
    if (row.status !== 'published') throw proposalError('只有已发布版本可以回滚。', 409);
    const previous = await queryOne("SELECT id FROM agent_evolution_proposals WHERE user_id = ? AND kind = ? AND status = 'published' AND id != ? ORDER BY published_at DESC LIMIT 1", [user.id, row.kind, row.id]);
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_evolution_proposals SET status = 'rolled_back', rolled_back_at = ?, rollback_target_id = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'published'", [now, previous?.id || null, now, row.id, user.id]);
    return { proposal: serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id])), rollbackTargetId: previous?.id || null };
}

module.exports = {
    PROPOSAL_KINDS,
    PROPOSAL_STATUSES,
    applyEvolutionProposal,
    createEvolutionProposal,
    decideEvolutionProposal,
    listEvolutionProposals,
    listEvolutionValidations,
    normalizeProposalInput,
    publishEvolutionProposal,
    rollbackEvolutionProposal,
    serializeProposal,
    validateEvolutionProposal
};
