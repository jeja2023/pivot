const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { updateAgentProfile } = require('./agent-profile');
const { resolveTenantContext } = require('./agent-tenant-context');

async function resolveProposalTenantId(user) {
    const context = await resolveTenantContext(user);
    return context.resolvable ? context.tenantId : null;
}

async function canReviewOrganizationProposal(user, row) {
    if (!row || row.scope !== 'organization_candidate') return false;
    if (!['admin', 'root'].includes(String(user?.role || '').toLowerCase())) return false;
    const tenantId = await resolveProposalTenantId(user);
    return Boolean(tenantId && row.tenant_id && Number(tenantId) === Number(row.tenant_id));
}

async function getProposalForActor(user, id, options = {}) {
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [String(id || '')]);
    if (!row) return null;
    if (Number(row.user_id) === Number(user?.id)) return row;
    if (options.review === true && await canReviewOrganizationProposal(user, row)) return row;
    return null;
}

const PROPOSAL_KINDS = Object.freeze(['skill', 'workflow', 'preference']);
const PROPOSAL_STATUSES = Object.freeze([
    'draft', 'pending', 'pending_review', 'sandbox_validate', 'versioned_draft',
    'candidate_created', 'validating', 'waiting_user_review', 'personal_active', 'paused', 'archived',
    'approved', 'published', 'rejected', 'validation_failed', 'applied', 'rolled_back', 'cancelled'
]);
const PROPOSAL_SCOPES = Object.freeze(['personal', 'organization_candidate', 'organization']);
const ACTIVATION_MODES = Object.freeze(['auto', 'user_confirmed', 'admin_approved']);

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

function organizationCandidateKey(prefix = 'artifact') {
    return `${prefix}-${crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex').slice(0, 16)}`;
}

function buildOrganizationSkillManifest(version) {
    const source = parseJson(version?.manifest_json || version?.manifest_yaml, {});
    const key = organizationCandidateKey('org-skill');
    return {
        schemaVersion: 1,
        id: key,
        name: key,
        version: '1.0.0',
        title: '组织共享 Skill',
        description: '来自个人已验证经验的脱敏、受控只读处理流程。',
        tools: Array.isArray(source.tools) ? source.tools.map(item => String(item)).slice(0, 20) : [],
        capabilities: Array.isArray(source.capabilities) ? source.capabilities.map(item => String(item)).slice(0, 40) : [],
        inputs: source.inputs && typeof source.inputs === 'object' ? source.inputs : {},
        outputs: source.outputs && typeof source.outputs === 'object' ? source.outputs : {},
        tags: ['organization', 'shared', 'verified']
    };
}

function buildOrganizationSkillInstructions(manifest = {}) {
    const tools = Array.isArray(manifest.tools) ? manifest.tools.filter(Boolean).slice(0, 20) : [];
    return [
        '适用于已审批的同类业务任务；不携带来源用户的对话、文件、路径或记忆内容。',
        `允许使用的既有只读工具：${tools.join('、') || '无'}。`,
        '所有工具调用仍必须经过 Pivot 的权限、预算、网络与审批策略。',
        '输入不完整、策略拒绝或工具失败时，说明限制并停止；不得扩展权限、凭据或网络范围。'
    ].join('\n');
}

function buildOrganizationWorkflowDag(dagSpec = {}) {
    const draft = parseJson(dagSpec, {}) || {};
    const nodes = Array.isArray(draft.nodes) ? draft.nodes : [];
    return {
        nodes: nodes.slice(0, 100).map((node, index) => ({
            ...node,
            id: String(node?.id || `step_${index + 1}`).slice(0, 100),
            title: `受控步骤 ${index + 1}${node?.tool ? `：${String(node.tool).slice(0, 80)}` : ''}`,
            input: {},
            // 共享草稿不保留来源任务的字面量、模板变量或附件引用；管理员需在预览前重新配置输入。
            output: undefined
        }))
    };
}

async function createOrganizationCandidateArtifact(user, row) {
    if (row.kind === 'skill') {
        const { createSkillVersion, getSkillVersion } = require('./agent-releases');
        const source = await getSkillVersion(row.artifact_version_id, user, { action: 'read' });
        if (!source) throw proposalError('个人 Skill 源版本不存在或不可访问。', 409);
        const manifest = buildOrganizationSkillManifest(source);
        const version = await createSkillVersion(user, {
            manifest,
            instructions: buildOrganizationSkillInstructions(manifest),
            strictSpec: true
        });
        return { artifactType: 'skill', artifactId: String(version.skill_id || version.id), artifactVersionId: String(version.id) };
    }
    if (row.kind === 'workflow') {
        const { createAgentWorkflow, getAgentWorkflowForUser } = require('./agent-workflows');
        const source = await getAgentWorkflowForUser(row.artifact_id, user);
        if (!source) throw proposalError('个人工作流草稿不存在或不可访问。', 409);
        const workflow = await createAgentWorkflow(user, {
            name: `组织候选-${organizationCandidateKey('workflow').slice(-12)}`,
            description: '来自个人已验证流程的脱敏组织候选；发布前必须重新配置输入并通过评测。',
            dagSpec: buildOrganizationWorkflowDag(source.dag_spec),
            note: '由个人经验创建的脱敏组织共享候选'
        });
        return { artifactType: 'workflow', artifactId: String(workflow.id), artifactVersionId: String(workflow.version_id || workflow.current_version || 1) };
    }
    throw proposalError('只有 Skill 或工作流可以创建组织候选。', 409);
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
        ,sourceType: row.source_type || ''
        ,evidenceSummary: parseJson(row.evidence_summary, {})
        ,artifactType: row.artifact_type || ''
        ,artifactId: row.artifact_id || ''
        ,artifactVersionId: row.artifact_version_id || ''
        ,releaseId: row.release_id || ''
        ,scope: PROPOSAL_SCOPES.includes(String(row.scope || '')) ? row.scope : 'personal'
        ,activationMode: ACTIVATION_MODES.includes(String(row.activation_mode || '')) ? row.activation_mode : 'user_confirmed'
        ,confidence: Math.max(0, Math.min(Number(row.confidence || 0), 1))
        ,benefitMetrics: parseJson(row.benefit_metrics, {})
        ,reviewReason: row.review_reason || ''
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
    const tenantId = await resolveProposalTenantId(user);
    const internal = input._internal === true;
    const scope = internal && PROPOSAL_SCOPES.includes(String(input.scope || '')) ? String(input.scope) : 'personal';
    const activationMode = internal && ACTIVATION_MODES.includes(String(input.activationMode || input.activation_mode || '')) ? String(input.activationMode || input.activation_mode) : 'user_confirmed';
    const status = internal && PROPOSAL_STATUSES.includes(String(input.status || '')) ? String(input.status) : 'pending';
    const sourceType = internal ? String(input.sourceType || input.source_type || 'learning').slice(0, 32) : 'manual';
    const artifactType = internal ? String(input.artifactType || input.artifact_type || '').slice(0, 32) : '';
    const artifactId = internal ? String(input.artifactId || input.artifact_id || '').slice(0, 160) : '';
    const artifactVersionId = internal ? String(input.artifactVersionId || input.artifact_version_id || '').slice(0, 160) : '';
    const releaseId = internal ? String(input.releaseId || input.release_id || '').slice(0, 160) : '';
    const confidence = internal ? Math.max(0, Math.min(Number(input.confidence || 0), 1)) : 0;
    const evidenceSummary = internal ? redactSensitive(input.evidenceSummary || input.evidence_summary || {}) : {};
    const benefitMetrics = internal ? redactSensitive(input.benefitMetrics || input.benefit_metrics || {}) : {};
    const reviewReason = internal ? String(input.reviewReason || input.review_reason || '').slice(0, 2000) : '';
    await execute(`
        INSERT INTO agent_evolution_proposals (
            id, user_id, tenant_id, kind, title, description, proposed_change, source_run_id, status, version,
            risk_level, permission_diff, test_plan, rollback_plan, idempotency_key, source_type, evidence_summary,
            artifact_type, artifact_id, artifact_version_id, release_id, scope, activation_mode, confidence,
            benefit_metrics, review_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, user.id, tenantId, normalized.kind, normalized.title, normalized.description, JSON.stringify(normalized.proposedChange), normalized.sourceRunId, status, normalized.riskLevel, JSON.stringify(normalized.permissionDiff), JSON.stringify(normalized.testPlan), JSON.stringify(normalized.rollbackPlan), normalized.idempotencyKey || null, sourceType, JSON.stringify(evidenceSummary), artifactType, artifactId, artifactVersionId, releaseId, scope, activationMode, confidence, JSON.stringify(benefitMetrics), reviewReason, now, now]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [id, user.id]));
}

async function updateEvolutionArtifact(id, user, patch = {}) {
    const row = await getProposalForActor(user, id);
    if (!row) return null;
    const status = patch.status && PROPOSAL_STATUSES.includes(String(patch.status)) ? String(patch.status) : row.status;
    const activationMode = patch.activationMode && ACTIVATION_MODES.includes(String(patch.activationMode)) ? String(patch.activationMode) : row.activation_mode || 'user_confirmed';
    const evidenceSummary = patch.evidenceSummary === undefined ? row.evidence_summary : JSON.stringify(redactSensitive(patch.evidenceSummary || {}));
    const benefitMetrics = patch.benefitMetrics === undefined ? row.benefit_metrics : JSON.stringify(redactSensitive(patch.benefitMetrics || {}));
    await execute(`UPDATE agent_evolution_proposals SET status = ?, artifact_type = ?, artifact_id = ?, artifact_version_id = ?, release_id = ?, activation_mode = ?, evidence_summary = ?, benefit_metrics = ?, review_reason = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [status, patch.artifactType === undefined ? row.artifact_type || '' : String(patch.artifactType || '').slice(0, 32), patch.artifactId === undefined ? row.artifact_id || '' : String(patch.artifactId || '').slice(0, 160), patch.artifactVersionId === undefined ? row.artifact_version_id || '' : String(patch.artifactVersionId || '').slice(0, 160), patch.releaseId === undefined ? row.release_id || '' : String(patch.releaseId || '').slice(0, 160), activationMode, evidenceSummary || '{}', benefitMetrics || '{}', patch.reviewReason === undefined ? row.review_reason || '' : String(patch.reviewReason || '').slice(0, 2000), getBeijingTimestamp(), row.id, row.user_id]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id]));
}

async function listEvolutionProposals(user, options = {}) {
    const status = String(options.status || '').trim();
    const tenantId = await resolveProposalTenantId(user);
    const params = [user.id];
    const where = ['user_id = ?'];
    if (['admin', 'root'].includes(String(user.role || '').toLowerCase()) && tenantId && options.includeOrganization !== false) {
        params.push(tenantId);
        where[0] = '(user_id = ? OR (tenant_id = ? AND scope IN (\'organization_candidate\', \'organization\')))';
    }
    if (PROPOSAL_STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
    const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 50, 200));
    params.push(limit);
    const rows = await query(`SELECT * FROM agent_evolution_proposals WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, created_at DESC LIMIT ?`, params);
    return rows.map(serializeProposal);
}

async function decideEvolutionProposal(user, id, decision, note = '') {
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!['approve', 'reject'].includes(normalizedDecision)) throw proposalError('审批决定只能是 approve 或 reject。');
    const row = await getProposalForActor(user, id, { review: true });
    if (!row) return null;
    const organizationCandidate = row.scope === 'organization_candidate';
    if (organizationCandidate && !(await canReviewOrganizationProposal(user, row))) {
        throw proposalError('组织候选只能由同租户管理员审批。', 403);
    }
    const eligibleStatuses = organizationCandidate
        ? ['pending_review']
        : ['pending', 'draft', 'waiting_user_review', 'candidate_created'];
    if (!eligibleStatuses.includes(row.status)) throw proposalError('当前提议不能执行审批。', 409);
    const now = getBeijingTimestamp();
    const status = normalizedDecision === 'approve'
        ? (organizationCandidate || row.kind === 'preference' ? 'approved' : 'pending_review')
        : 'rejected';
    await execute('UPDATE agent_evolution_proposals SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = ?', [status, user.id, String(note || '').slice(0, 4000), now, now, row.id, row.user_id, row.status]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id]));
}

async function applyEvolutionProposal(user, id) {
    const row = await getProposalForActor(user, id);
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
    const row = await getProposalForActor(user, id, { review: true });
    if (!row) return null;
    if (row.scope === 'organization_candidate' && !(await canReviewOrganizationProposal(user, row))) {
        throw proposalError('组织候选只能由同租户管理员验证。', 403);
    }
    const validationStatuses = row.scope === 'organization_candidate'
        ? ['approved', 'validation_failed', 'sandbox_validate']
        : ['pending_review', 'approved', 'validation_failed', 'sandbox_validate', 'candidate_created', 'waiting_user_review'];
    if (!validationStatuses.includes(row.status)) throw proposalError('当前提议状态不能启动验证。', 409);
    const change = parseJson(row.proposed_change, {});
    const errors = inspectEvolutionChange(change);
    const staticResult = { passed: errors.length === 0, errors, checked: ['schema', 'forbidden_keys', 'size'] };
    const isPreference = row.kind === 'preference';
    if (row.kind === 'skill') {
        const manifest = change.manifest || change;
        if (!row.artifact_version_id) {
            if (!manifest.name || !manifest.version || !manifest.instructions && !change.instructions) errors.push('Skill Manifest 必须包含 name、version 和 instructions。');
            if (manifest.permissions && !Array.isArray(manifest.permissions)) errors.push('Skill permissions 必须是数组。');
        }
    }
    if (row.kind === 'workflow') {
        const nodes = change.nodes || change.dagSpec?.nodes || change.dag_spec?.nodes;
        if (row.artifact_id) {
            const workflow = await queryOne('SELECT id, current_version_id, deleted_at FROM agent_workflows WHERE id = ?', [row.artifact_id]);
            if (!workflow || workflow.deleted_at || !workflow.current_version_id) errors.push('工作流真实草稿不存在或不可用。');
        } else if (!Array.isArray(nodes) || !nodes.length) errors.push('工作流草稿必须包含至少一个 DAG 节点。');
        if (change.published === true || change.status === 'published') errors.push('提议不能直接声明已发布状态。');
    }
    let sandboxResult = { passed: errors.length === 0, mode: isPreference ? 'profile-dry-run' : 'isolated-preview', sideEffects: false, cases: Number(options.cases || 1) };
    let evaluationResult = { passed: errors.length === 0, score: errors.length ? 0 : 1, regressionSuite: options.suiteId || null };
    if (!errors.length && row.kind === 'skill' && row.artifact_version_id) {
        const { validateSkillVersion } = require('./agent-releases');
        const validation = await validateSkillVersion(row.artifact_version_id, user, { strictSpec: true, requireSignature: false, evaluationRunId: options.evaluationRunId || null });
        sandboxResult = validation?.sandbox || sandboxResult;
        evaluationResult = validation?.evaluation || evaluationResult;
        if (!validation?.passed) errors.push(validation?.manifest?.errors?.[0] || validation?.declarative?.errors?.[0] || validation?.sandbox?.result?.stderr || 'Skill 真实验证未通过。');
    }
    staticResult.passed = errors.length === 0;
    const status = errors.length ? 'validation_failed' : 'versioned_draft';
    const now = getBeijingTimestamp();
    await execute(`INSERT INTO agent_evolution_validations (proposal_id, user_id, stage, status, static_result, sandbox_result, evaluation_result, risk_level, permission_diff, test_plan, rollback_plan, version, error_code, error_message, validated_at, created_at, updated_at) VALUES (?, ?, 'sandbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, user.id, status === 'versioned_draft' ? 'passed' : 'failed', JSON.stringify(staticResult), JSON.stringify(sandboxResult), JSON.stringify(evaluationResult), row.risk_level || 'medium', row.permission_diff || '{}', row.test_plan || '{}', row.rollback_plan || '{}', Number(row.version || 1), errors.length ? 'VALIDATION_FAILED' : '', errors.join('; ').slice(0, 2000), now, now, now]);
    await execute('UPDATE agent_evolution_proposals SET status = ?, version = CASE WHEN ? = \'versioned_draft\' THEN version + 1 ELSE version END, updated_at = ? WHERE id = ? AND user_id = ?', [status, status, now, row.id, row.user_id]);
    return { proposal: serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id])), validation: { static: staticResult, sandbox: sandboxResult, evaluation: evaluationResult, passed: !errors.length } };
}

async function listEvolutionValidations(user, proposalId) {
    const proposal = await getProposalForActor(user, proposalId, { review: true });
    if (!proposal) return [];
    const rows = await query(`SELECT v.* FROM agent_evolution_validations v WHERE v.proposal_id = ? ORDER BY v.created_at DESC`, [proposal.id]);
    return rows.map(row => ({ id: row.id, proposalId: row.proposal_id, stage: row.stage, status: row.status, staticResult: parseJson(row.static_result, {}), sandboxResult: parseJson(row.sandbox_result, {}), evaluationResult: parseJson(row.evaluation_result, {}), riskLevel: row.risk_level, permissionDiff: parseJson(row.permission_diff, {}), errorCode: row.error_code || '', errorMessage: row.error_message || '', version: Number(row.version || 1), validatedAt: row.validated_at || null, createdAt: row.created_at || null }));
}

async function publishEvolutionProposal(user, id) {
    const row = await getProposalForActor(user, id, { review: true });
    if (!row) return null;
    if (row.status !== 'versioned_draft') throw proposalError('只有通过沙箱验证的版本草稿可以发布。', 409);
    const validation = await queryOne('SELECT status FROM agent_evolution_validations WHERE proposal_id = ? ORDER BY version DESC, created_at DESC LIMIT 1', [row.id]);
    if (!validation || validation.status !== 'passed') throw proposalError('发布门禁未通过，不能发布。', 409);
    if (row.scope === 'organization_candidate' && !(await canReviewOrganizationProposal(user, row))) {
        throw proposalError('组织候选只能由同租户管理员发布。', 403);
    }
    let release = null;
    const releaseUser = row.scope === 'organization_candidate' ? { ...user, tenant_id: row.tenant_id } : user;
    if (row.kind === 'skill') {
        if (!row.artifact_version_id) throw proposalError('Skill 提议缺少真实版本，不能发布。', 409);
        const { publishSkillVersion } = require('./agent-releases');
        const shared = row.scope === 'organization_candidate';
        release = await publishSkillVersion(row.artifact_version_id, releaseUser, { scope: shared ? 'organization' : 'personal', rolloutScope: shared ? 'organization' : 'personal', rolloutPercent: shared ? 10 : 100 });
    } else if (row.kind === 'workflow') {
        if (!row.artifact_id) throw proposalError('工作流提议缺少真实草稿，不能发布。', 409);
        const { publishWorkflowRelease } = require('./agent-releases');
        const shared = row.scope === 'organization_candidate';
        release = await publishWorkflowRelease(row.artifact_id, releaseUser, { version: row.artifact_version_id || 'current', rolloutScope: shared ? 'organization' : 'personal', rolloutPercent: shared ? 10 : 100, allowTenantAdmin: shared, tenantId: row.tenant_id });
    }
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_evolution_proposals SET status = 'published', release_id = ?, published_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'versioned_draft'", [release?.id ? String(release.id) : row.release_id || '', now, now, row.id, row.user_id]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id]));
}

/** Activate a validated personal Skill. Workflow drafts intentionally remain preview-only. */
async function activatePersonalEvolutionProposal(user, id) {
    const row = await getProposalForActor(user, id);
    if (!row || row.scope !== 'personal') return null;
    if (row.kind === 'workflow') {
        return { proposal: serializeProposal(row), activated: false, requiresPreview: true, reason: '工作流草稿必须先在自动化中心预览、评测并发布。' };
    }
    if (row.kind !== 'skill') return { proposal: serializeProposal(row), activated: false, requiresVersionedAction: true };
    if (!['candidate_created', 'waiting_user_review', 'pending_review', 'versioned_draft'].includes(row.status)) {
        throw proposalError('当前个人经验不能启用。', 409);
    }
    if (!row.artifact_version_id) throw proposalError('个人经验缺少真实 Skill 版本，不能启用。', 409);
    const { validateSkillVersion, publishSkillVersion } = require('./agent-releases');
    const validation = await validateSkillVersion(row.artifact_version_id, user, { strictSpec: true, requireSignature: false });
    if (!validation?.passed) throw proposalError('个人经验验证未通过，不能启用。', 422);
    const release = await publishSkillVersion(row.artifact_version_id, user, { scope: 'personal', rolloutScope: 'personal', rolloutPercent: 100 });
    const now = getBeijingTimestamp();
    await execute("UPDATE agent_evolution_proposals SET status = 'personal_active', activation_mode = 'user_confirmed', release_id = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ? AND user_id = ?", [String(release.id), now, now, row.id, row.user_id]);
    return { proposal: serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id])), activated: true, release };
}

async function pauseEvolutionProposal(user, id) {
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row || !['personal_active', 'published'].includes(row.status)) return null;
    if (row.kind === 'skill' && row.release_id) {
        const { pauseSkillRelease } = require('./agent-releases');
        const release = await pauseSkillRelease(row.release_id, user, '用户暂停个人经验');
        if (!release) throw proposalError('个人 Skill 发布不可暂停。', 409);
    }
    await execute("UPDATE agent_evolution_proposals SET status = 'paused', updated_at = ? WHERE id = ? AND user_id = ?", [getBeijingTimestamp(), row.id, user.id]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id]));
}

async function restoreEvolutionProposal(user, id) {
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row || !['paused', 'archived'].includes(row.status)) return null;
    if (row.kind === 'skill' && row.release_id) {
        const { resumeSkillRelease } = require('./agent-releases');
        const release = await resumeSkillRelease(row.release_id, user);
        if (!release) throw proposalError('个人 Skill 发布不可恢复。', 409);
    }
    await execute("UPDATE agent_evolution_proposals SET status = 'personal_active', updated_at = ? WHERE id = ? AND user_id = ?", [getBeijingTimestamp(), row.id, user.id]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id]));
}

/** Revoke an active personal experience while retaining its immutable release and proposal audit history. */
async function revokePersonalEvolutionProposal(user, id) {
    const row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row || row.scope !== 'personal' || row.status !== 'personal_active') return null;
    if (row.kind === 'skill' && row.release_id) {
        const { rollbackSkillRelease } = require('./agent-releases');
        const release = await rollbackSkillRelease(row.release_id, user);
        if (!release) throw proposalError('个人经验当前不能撤销。', 409);
    }
    await execute("UPDATE agent_evolution_proposals SET status = 'rolled_back', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'personal_active'", [getBeijingTimestamp(), row.id, user.id]);
    return serializeProposal(await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ?', [row.id]));
}

async function createEvolutionShareRequest(user, id) {
    let row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    if (!row || !['skill', 'workflow'].includes(row.kind) || !row.artifact_version_id && !row.artifact_id) return null;
    // 工作流需要先经用户主动预览、固定评测和个人发布；发布完成后在此绑定真实 release。
    if (row.kind === 'workflow' && !['personal_active', 'published'].includes(row.status)) {
        const release = await queryOne("SELECT id FROM agent_workflow_releases WHERE workflow_id = ? AND rollout_scope = 'personal' AND published_by = ? AND status = 'published' ORDER BY published_at DESC, id DESC LIMIT 1", [row.artifact_id, user.id]);
        if (!release) throw proposalError('请先在自动化中心完成该工作流的预览、评测和个人发布，再申请共享。', 409);
        await execute("UPDATE agent_evolution_proposals SET status = 'personal_active', release_id = ?, updated_at = ? WHERE id = ? AND user_id = ?", [String(release.id), getBeijingTimestamp(), row.id, user.id]);
        row = await queryOne('SELECT * FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [row.id, user.id]);
    }
    if (!['personal_active', 'published'].includes(row.status)) return null;
    const existing = await queryOne('SELECT * FROM agent_evolution_proposals WHERE user_id = ? AND idempotency_key = ?', [user.id, `share:${row.id}`]);
    if (existing) return serializeProposal(existing);
    const artifact = await createOrganizationCandidateArtifact(user, row);
    return createEvolutionProposal(user, {
        _internal: true,
        kind: row.kind,
        title: row.kind === 'skill' ? '经验证的组织共享 Skill 候选' : '经验证的组织共享工作流候选',
        description: '来自个人已验证经验的组织共享申请，只保留脱敏证据和聚合效果。',
        proposedChange: { shareRequest: { source: 'personal_verified_experience', artifactType: artifact.artifactType } },
        sourceRunId: row.source_run_id,
        sourceType: 'share_request',
        evidenceSummary: { source: 'personal_verified_experience', confidence: Number(row.confidence || 0), sampleCount: Number(parseJson(row.benefit_metrics, {})?.sampleCount || 0) },
        artifactType: artifact.artifactType,
        artifactId: artifact.artifactId,
        artifactVersionId: artifact.artifactVersionId,
        scope: 'organization_candidate',
        activationMode: 'admin_approved',
        confidence: Number(row.confidence || 0),
        benefitMetrics: redactSensitive(parseJson(row.benefit_metrics, {})),
        status: 'pending_review',
        riskLevel: row.risk_level || 'medium',
        permissionDiff: parseJson(row.permission_diff, {}),
        testPlan: parseJson(row.test_plan, {}),
        rollbackPlan: parseJson(row.rollback_plan, {}),
        idempotencyKey: `share:${row.id}`
    });
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
    activatePersonalEvolutionProposal,
    createEvolutionShareRequest,
    createEvolutionProposal,
    decideEvolutionProposal,
    listEvolutionProposals,
    listEvolutionValidations,
    normalizeProposalInput,
    publishEvolutionProposal,
    pauseEvolutionProposal,
    revokePersonalEvolutionProposal,
    restoreEvolutionProposal,
    rollbackEvolutionProposal,
    serializeProposal,
    updateEvolutionArtifact,
    validateEvolutionProposal
};
