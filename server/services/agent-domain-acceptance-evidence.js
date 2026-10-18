'use strict';

const crypto = require('crypto');
const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { isAdmin, isSuperAdmin } = require('../permissions');
const { canonicalJson } = require('./canonical-json');

const DOMAIN_KEYS = Object.freeze([
    'model_routing', 'tool_discovery', 'tool_concurrency', 'tool_policy', 'sandbox_execution', 'long_task_recovery',
    'multi_agent', 'dag_orchestration', 'lifecycle_extensions', 'context_governance', 'prompt_structured_output',
    'long_term_memory', 'skill_ecosystem', 'browser_automation', 'evaluation_release', 'observability', 'code_semantics_ide', 'voice_multimodal'
]);
const REQUIRED_EVIDENCE_TYPES = Object.freeze(['implementation_review', 'automated', 'nonfunctional', 'canary', 'committee']);
const COMMITTEE_ROLES = Object.freeze(['platform_security', 'runtime', 'qa_sre', 'product']);
const DOMAIN_METRIC_POLICIES = Object.freeze({
    model_routing: [{ key: 'quality_pass_lower_bound', comparator: '>=', threshold: 0.75 }, { key: 'unfinished_rate', comparator: '<=', threshold: 0.10 }, { key: 'cost_baseline', comparator: '<=', threshold: 1 }, { key: 'latency_slo', comparator: '<=', threshold: 300000 }],
    tool_discovery: [{ key: 'authorization_probe_block_rate', comparator: '=', threshold: 1 }, { key: 'cache_invalidation_rate', comparator: '=', threshold: 1 }],
    tool_concurrency: [{ key: 'duplicate_side_effect_count', comparator: '=', threshold: 0 }, { key: 'lease_conflict_handling', comparator: '=', threshold: 1 }, { key: 'capacity_slo', comparator: '>=', threshold: 0.95 }],
    tool_policy: [{ key: 'approval_reuse_rate', comparator: '=', threshold: 0 }, { key: 'revocation_effectiveness', comparator: '=', threshold: 1 }],
    sandbox_execution: [{ key: 'windows_escape_probe', comparator: '=', threshold: 1 }, { key: 'linux_escape_probe', comparator: '=', threshold: 1 }, { key: 'provider_fail_closed_rate', comparator: '=', threshold: 1 }],
    long_task_recovery: [{ key: 'recovery_success_rate', comparator: '>=', threshold: 0.95 }, { key: 'unresolved_effect_count', comparator: '=', threshold: 0 }, { key: 'compensation_completion_rate', comparator: '=', threshold: 1 }],
    multi_agent: [{ key: 'handoff_exactly_once_rate', comparator: '=', threshold: 1 }, { key: 'join_verification_rate', comparator: '=', threshold: 1 }, { key: 'resource_conflict_recovery_rate', comparator: '>=', threshold: 0.95 }],
    dag_orchestration: [{ key: 'replay_consistency_rate', comparator: '=', threshold: 1 }, { key: 'compensation_completion_rate', comparator: '=', threshold: 1 }, { key: 'cycle_rejection_rate', comparator: '=', threshold: 1 }],
    lifecycle_extensions: [{ key: 'pre_hook_fail_closed_rate', comparator: '=', threshold: 1 }, { key: 'hook_timeout_handling_rate', comparator: '=', threshold: 1 }, { key: 'audit_coverage_rate', comparator: '=', threshold: 1 }],
    context_governance: [{ key: 'constraint_retention_rate', comparator: '>=', threshold: 0.98 }, { key: 'blocking_item_loss_rate', comparator: '=', threshold: 0 }, { key: 'compression_cost_slo', comparator: '>=', threshold: 0.35 }],
    prompt_structured_output: [{ key: 'schema_valid_rate', comparator: '=', threshold: 1 }, { key: 'prompt_rollback_time', comparator: '<=', threshold: 600 }, { key: 'cache_observation_rate', comparator: '>=', threshold: 0.95 }],
    long_term_memory: [{ key: 'memory_helpful_rate', comparator: '>=', threshold: 0.75 }, { key: 'memory_conflict_rate', comparator: '<=', threshold: 0.10 }, { key: 'expired_hit_rate', comparator: '<=', threshold: 0.01 }, { key: 'revocation_residual_rate', comparator: '=', threshold: 0 }],
    skill_ecosystem: [{ key: 'signature_validation_rate', comparator: '=', threshold: 1 }, { key: 'rollout_rollback_time', comparator: '<=', threshold: 600 }, { key: 'sandbox_validation_rate', comparator: '=', threshold: 1 }],
    browser_automation: [{ key: 'session_success_rate', comparator: '>=', threshold: 0.99 }, { key: 'recovery_latency', comparator: '<=', threshold: 300000 }, { key: 'upload_download_boundary_rate', comparator: '=', threshold: 1 }],
    evaluation_release: [{ key: 'golden_judge_agreement_rate', comparator: '>=', threshold: 0.88 }, { key: 'release_gate_bypass_count', comparator: '=', threshold: 0 }, { key: 'automatic_rollback_time', comparator: '<=', threshold: 300 }],
    observability: [{ key: 'trace_correlation_rate', comparator: '>=', threshold: 0.99 }, { key: 'alert_delivery_rate', comparator: '>=', threshold: 0.99 }, { key: 'slo_breach_detection_time', comparator: '<=', threshold: 300 }],
    code_semantics_ide: [{ key: 'semantic_navigation_accuracy', comparator: '>=', threshold: 0.98 }, { key: 'shadow_workspace_verification_rate', comparator: '=', threshold: 1 }, { key: 'cross_platform_acceptance_rate', comparator: '=', threshold: 1 }],
    voice_multimodal: [{ key: 'voice_interrupt_p95_ms', comparator: '<=', threshold: 800 }, { key: 'accessibility_pass_rate', comparator: '=', threshold: 1 }, { key: 'privacy_drill_pass_rate', comparator: '=', threshold: 1 }]
});
const MANIFEST_VERSION = 1;
const MIN_CANARY_DURATION_MS = 24 * 60 * 60 * 1000;
const MIN_OBSERVATION_SAMPLES = 30;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function acceptanceError(message, code = 'AGENT_DOMAIN_ACCEPTANCE_INVALID', status = 400) {
    const error = new Error(message); error.code = code; error.status = status; error.statusCode = status; return error;
}
function text(value, max) { return String(value ?? '').trim().slice(0, max); }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function requireText(value, field, { min = 1, max = 1024 } = {}) {
    const normalized = text(value, max);
    if (normalized.length < min) throw acceptanceError(`${field}为必填项，且至少需要 ${min} 个字符。`, 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_REQUIRED');
    return normalized;
}
function requirePositiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) throw acceptanceError(`${field}必须是 ${min} 到 ${max} 之间的整数。`, 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    return normalized;
}
function requireTimestamp(value, field) {
    const raw = requireText(value, field, { min: 10, max: 64 });
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) throw acceptanceError(`${field}必须是有效 ISO 时间。`, 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    return date.toISOString();
}
function requireReference(value, field) { return requireText(value, field, { min: 3, max: 1024 }); }
function requireStringList(value, field, { min = 1, max = 20 } = {}) {
    if (!Array.isArray(value) || value.length < min || value.length > max) throw acceptanceError(`${field}必须包含 ${min} 到 ${max} 项。`, 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    return value.map((item, index) => requireReference(item, `${field}[${index}]`));
}
function requireObject(value, field) {
    if (!isPlainObject(value)) throw acceptanceError(`${field}必须是对象。`, 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    return value;
}
function parseManifest(value) {
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { throw acceptanceError('证据清单必须是有效 JSON 对象。', 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID'); }
    }
    return value;
}
function requireSuperAdmin(user) {
    if (!isSuperAdmin(user)) throw acceptanceError('只有系统管理员可以提交或核验领域验收证据。', 'AGENT_DOMAIN_ACCEPTANCE_ADMIN_REQUIRED', 403);
}
function requireReviewer(user) {
    if (!isAdmin(user)) throw acceptanceError('只有管理员可以核验领域验收证据。', 'AGENT_DOMAIN_ACCEPTANCE_REVIEWER_REQUIRED', 403);
}
function normalizeDomainKey(value) {
    const key = text(value, 64);
    if (!DOMAIN_KEYS.includes(key)) throw acceptanceError('领域标识不受支持。', 'AGENT_DOMAIN_ACCEPTANCE_DOMAIN_INVALID');
    return key;
}
function normalizeEvidenceType(value) {
    const type = text(value, 32);
    if (!REQUIRED_EVIDENCE_TYPES.includes(type)) throw acceptanceError('验收证据类型不受支持。', 'AGENT_DOMAIN_ACCEPTANCE_TYPE_INVALID');
    return type;
}
function normalizeCommitteeRole(value) {
    const role = text(value, 40);
    if (!COMMITTEE_ROLES.includes(role)) throw acceptanceError('委员会角色不受支持。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_ROLE_INVALID');
    return role;
}
function normalizeWindow(value, field, { minimumDurationMs = 0 } = {}) {
    const window = requireObject(value, field);
    const start = requireTimestamp(window.start, `${field}.start`);
    const end = requireTimestamp(window.end, `${field}.end`);
    if (Date.parse(end) <= Date.parse(start)) throw acceptanceError(`${field}.end必须晚于${field}.start。`, 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    if (Date.parse(end) - Date.parse(start) < minimumDurationMs) {
        throw acceptanceError(`${field}必须覆盖至少 ${Math.ceil(minimumDurationMs / 3_600_000)} 小时。`, 'AGENT_DOMAIN_ACCEPTANCE_WINDOW_TOO_SHORT');
    }
    return { start, end };
}
function normalizeMetric(item, index) {
    const metric = requireObject(item, `metrics[${index}]`);
    const key = requireText(metric.key, `metrics[${index}].key`, { min: 3, max: 80 });
    if (!/^[a-z0-9_]+$/.test(key)) throw acceptanceError('指标键只能使用小写字母、数字和下划线。', 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    const value = Number(metric.value);
    const threshold = Number(metric.threshold);
    if (!Number.isFinite(value) || !Number.isFinite(threshold)) throw acceptanceError(`metrics[${index}]必须包含有限数值 value 和 threshold。`, 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    const comparator = requireText(metric.comparator, `metrics[${index}].comparator`, { min: 1, max: 4 });
    if (!['>=', '<=', '='].includes(comparator)) throw acceptanceError('指标比较符只能为 >=、<= 或 =。', 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    const thresholdSatisfied = comparator === '>=' ? value >= threshold : comparator === '<=' ? value <= threshold : value === threshold;
    if (metric.passed !== true || !thresholdSatisfied) throw acceptanceError(`metrics[${index}]未达到声明阈值，不能进入五分验收。`, 'AGENT_DOMAIN_ACCEPTANCE_METRIC_NOT_PASSED');
    return { key, value, threshold, comparator, passed: true };
}
function meetsMetricPolicy(metric, policy) {
    if (!policy || metric.comparator !== policy.comparator) return false;
    if (policy.comparator === '>=') return metric.threshold >= policy.threshold && metric.value >= policy.threshold;
    if (policy.comparator === '<=') return metric.threshold <= policy.threshold && metric.value <= policy.threshold;
    return metric.threshold === policy.threshold && metric.value === policy.threshold;
}
function normalizeMetrics(value, domainKey) {
    if (!Array.isArray(value) || value.length > 40) throw acceptanceError('metrics必须是最多 40 项的数组。', 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    const metrics = value.map(normalizeMetric);
    const metricKeys = new Set(metrics.map(metric => metric.key));
    const policies = DOMAIN_METRIC_POLICIES[domainKey] || [];
    const missing = policies.map(policy => policy.key).filter(key => !metricKeys.has(key));
    if (missing.length) throw acceptanceError(`该领域缺少强制非功能指标：${missing.join('、')}。`, 'AGENT_DOMAIN_ACCEPTANCE_REQUIRED_METRICS_MISSING');
    if (metricKeys.size !== metrics.length) throw acceptanceError('metrics不能重复同一指标键。', 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID');
    for (const metric of metrics) {
        const policy = policies.find(item => item.key === metric.key);
        if (policy && !meetsMetricPolicy(metric, policy)) throw acceptanceError(`指标${metric.key}未达到冻结的五分阈值。`, 'AGENT_DOMAIN_ACCEPTANCE_METRIC_POLICY_NOT_MET');
    }
    return metrics;
}
function normalizeArtifact(value) {
    const artifact = requireObject(value, 'artifact');
    const sha256 = String(artifact.sha256 || '').trim().toLowerCase();
    if (!SHA256_PATTERN.test(sha256)) throw acceptanceError('artifact.sha256必须是受控产物的 64 位 SHA-256 摘要。', 'AGENT_DOMAIN_ACCEPTANCE_ARTIFACT_DIGEST_INVALID');
    return {
        id: requireReference(artifact.id, 'artifact.id'),
        kind: requireText(artifact.kind, 'artifact.kind', { min: 3, max: 80 }),
        generatedAt: requireTimestamp(artifact.generatedAt, 'artifact.generatedAt'), sha256
    };
}
function normalizeBaseManifest(value) {
    const manifest = requireObject(parseManifest(value), 'evidenceManifest');
    if (Number(manifest.schemaVersion) !== MANIFEST_VERSION) throw acceptanceError(`evidenceManifest.schemaVersion必须为 ${MANIFEST_VERSION}。`, 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_VERSION_INVALID');
    return { schemaVersion: MANIFEST_VERSION, artifact: normalizeArtifact(manifest.artifact), raw: manifest };
}
function normalizeImplementationManifest(base) {
    const manifest = base.raw;
    return { ...base, reviewScope: requireText(manifest.reviewScope, 'reviewScope', { min: 12, max: 1000 }), changeRefs: requireStringList(manifest.changeRefs, 'changeRefs'), commit: requireText(manifest.commit, 'commit', { min: 7, max: 128 }), reviewedAt: requireTimestamp(manifest.reviewedAt, 'reviewedAt') };
}
function normalizeAutomatedManifest(base) {
    const manifest = base.raw;
    const total = requirePositiveInteger(manifest.total, 'total', { min: 1, max: 1_000_000 });
    const passed = requirePositiveInteger(manifest.passed, 'passed', { min: 1, max: total });
    const failed = requirePositiveInteger(manifest.failed ?? 0, 'failed', { min: 0, max: total });
    if (passed !== total || failed !== 0) throw acceptanceError('自动化验收必须全量通过且失败数为 0。', 'AGENT_DOMAIN_ACCEPTANCE_AUTOMATED_NOT_GREEN');
    return { ...base, suite: requireReference(manifest.suite, 'suite'), runId: requireReference(manifest.runId, 'runId'), total, passed, failed, completedAt: requireTimestamp(manifest.completedAt, 'completedAt'), resultRef: requireReference(manifest.resultRef, 'resultRef') };
}
function normalizeNonfunctionalManifest(base, domainKey) {
    const manifest = base.raw;
    return { ...base, window: normalizeWindow(manifest.window, 'window'), sampleSize: requirePositiveInteger(manifest.sampleSize, 'sampleSize', { min: MIN_OBSERVATION_SAMPLES, max: 100_000_000 }), metrics: normalizeMetrics(manifest.metrics, domainKey), dashboardRef: requireReference(manifest.dashboardRef, 'dashboardRef') };
}
function normalizeCanaryManifest(base, domainKey) {
    const manifest = base.raw;
    const environment = requireText(manifest.environment, 'environment', { min: 6, max: 16 });
    if (!['canary', 'production'].includes(environment)) throw acceptanceError('灰度证据environment只能是canary或production。', 'AGENT_DOMAIN_ACCEPTANCE_CANARY_ENV_INVALID');
    const p0Count = requirePositiveInteger(manifest.p0Count ?? 0, 'p0Count', { min: 0, max: 100_000 });
    const p1Count = requirePositiveInteger(manifest.p1Count ?? 0, 'p1Count', { min: 0, max: 100_000 });
    if (p0Count !== 0 || p1Count !== 0 || manifest.fullCycle !== true) throw acceptanceError('完整灰度周期要求fullCycle=true且P0/P1事件均为0。', 'AGENT_DOMAIN_ACCEPTANCE_CANARY_NOT_CLEAN');
    return { ...base, environment, window: normalizeWindow(manifest.window, 'window', { minimumDurationMs: MIN_CANARY_DURATION_MS }), cohort: requireReference(manifest.cohort, 'cohort'), sampleSize: requirePositiveInteger(manifest.sampleSize, 'sampleSize', { min: MIN_OBSERVATION_SAMPLES, max: 100_000_000 }), p0Count, p1Count, fullCycle: true, metrics: normalizeMetrics(manifest.metrics, domainKey), rollbackDrillRef: requireReference(manifest.rollbackDrillRef, 'rollbackDrillRef'), operator: requireText(manifest.operator, 'operator', { min: 2, max: 160 }) };
}
function normalizeCommitteeManifest(base) {
    const manifest = base.raw;
    if (!Array.isArray(manifest.signatories) || manifest.signatories.length !== COMMITTEE_ROLES.length) throw acceptanceError('委员会证据必须包含四个指定角色的签署。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_SIGNERS_INVALID');
    const signatories = manifest.signatories.map((entry, index) => {
        const signer = requireObject(entry, `signatories[${index}]`);
        return { role: requireText(signer.role, `signatories[${index}].role`, { min: 3, max: 64 }), signer: requireText(signer.signer, `signatories[${index}].signer`, { min: 2, max: 160 }), signedAt: requireTimestamp(signer.signedAt, `signatories[${index}].signedAt`) };
    });
    const roles = signatories.map(item => item.role).sort();
    if (canonicalJson(roles) !== canonicalJson([...COMMITTEE_ROLES].sort())) throw acceptanceError('委员会签署必须且只能包含平台安全、Runtime、QA/SRE、产品四个角色。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_SIGNERS_INVALID');
    if (new Set(signatories.map(item => item.signer)).size !== signatories.length) throw acceptanceError('委员会四个角色必须由不同签署人确认。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_SIGNERS_INVALID');
    if (manifest.recommendation !== 'approve_for_score') throw acceptanceError('委员会建议必须明确为approve_for_score。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_DECISION_INVALID');
    return { ...base, meetingAt: requireTimestamp(manifest.meetingAt, 'meetingAt'), minutesRef: requireReference(manifest.minutesRef, 'minutesRef'), recommendation: 'approve_for_score', signatories };
}
function normalizeEvidenceManifest(value, domainKey, evidenceType) {
    const base = normalizeBaseManifest(value);
    let normalized;
    if (evidenceType === 'implementation_review') normalized = normalizeImplementationManifest(base);
    if (evidenceType === 'automated') normalized = normalizeAutomatedManifest(base);
    if (evidenceType === 'nonfunctional') normalized = normalizeNonfunctionalManifest(base, domainKey);
    if (evidenceType === 'canary') normalized = normalizeCanaryManifest(base, domainKey);
    if (evidenceType === 'committee') normalized = normalizeCommitteeManifest(base);
    const { raw, ...result } = normalized || {};
    return result;
}
function evidenceManifestValidation(row = {}) {
    try { return { valid: true, manifest: normalizeEvidenceManifest(row.evidence_json, String(row.domain_key || ''), String(row.evidence_type || '')) }; }
    catch (error) { return { valid: false, manifest: null, errorCode: error.code || 'AGENT_DOMAIN_ACCEPTANCE_MANIFEST_INVALID' }; }
}
function getDomainAcceptanceRequirements(domainKey) {
    const normalizedDomain = normalizeDomainKey(domainKey);
    return { schemaVersion: MANIFEST_VERSION, requiredEvidenceTypes: REQUIRED_EVIDENCE_TYPES, requiredMetrics: DOMAIN_METRIC_POLICIES[normalizedDomain] || [], minimumObservationSamples: MIN_OBSERVATION_SAMPLES, minimumCanaryDurationHours: MIN_CANARY_DURATION_MS / 3_600_000, committeeRoles: COMMITTEE_ROLES };
}
function serialize(row = {}) {
    const validation = evidenceManifestValidation(row);
    return {
        id: String(row.id || ''), domainKey: String(row.domain_key || ''), evidenceType: String(row.evidence_type || ''), status: String(row.status || ''),
        evidenceSummary: String(row.evidence_summary || ''), evidenceRef: String(row.evidence_ref || ''), evidenceDigest: String(row.evidence_digest || ''), evidenceManifest: validation.manifest, evidenceManifestValid: validation.valid, evidenceValidationErrorCode: validation.errorCode || '',
        submittedByUserId: Number(row.submitted_by_user_id || 0) || null, submittedAt: row.submitted_at || null,
        verifiedByUserId: Number(row.verified_by_user_id || 0) || null, verifiedAt: row.verified_at || null,
        verificationNote: String(row.verification_note || ''), updatedAt: row.updated_at || null
    };
}

async function requireVerifiedPrerequisiteEvidence(domainKey) {
    const rows = await query(`
        SELECT * FROM agent_domain_acceptance_evidence
        WHERE domain_key = ? AND evidence_type <> 'committee' AND status = 'verified'
    `, [domainKey]);
    const verifiedTypes = new Set(rows.filter(row => evidenceManifestValidation(row).valid).map(row => String(row.evidence_type || '')));
    const missing = REQUIRED_EVIDENCE_TYPES.filter(type => type !== 'committee' && !verifiedTypes.has(type));
    if (missing.length) throw acceptanceError(`提交委员会记录前必须已有独立核验的前置证据：${missing.join('、')}。`, 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_PREREQUISITES_MISSING', 409);
}

async function listDomainAcceptanceCommitteeMembers(user) {
    requireReviewer(user);
    const rows = await query(`
        SELECT m.committee_role, m.user_id, m.assigned_by_user_id, m.assigned_at, m.updated_at, u.username
        FROM agent_domain_acceptance_committee_members m JOIN users u ON u.id = m.user_id
        ORDER BY m.committee_role ASC
    `);
    const eligibleAdmins = await query("SELECT id, username FROM users WHERE role = 'admin' AND status = 'active' ORDER BY username ASC");
    return {
        members: rows.map(row => ({ role: String(row.committee_role || ''), userId: Number(row.user_id || 0) || null, username: String(row.username || ''), assignedByUserId: Number(row.assigned_by_user_id || 0) || null, assignedAt: row.assigned_at || null, updatedAt: row.updated_at || null })),
        eligibleAdmins: eligibleAdmins.map(row => ({ id: Number(row.id || 0) || null, username: String(row.username || '') }))
    };
}

async function saveDomainAcceptanceCommitteeMember(user, input = {}) {
    requireSuperAdmin(user);
    const role = normalizeCommitteeRole(input.role || input.committeeRole || input.committee_role);
    const userId = requirePositiveInteger(input.userId ?? input.user_id, 'userId', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const member = await queryOne('SELECT id, username, role, status FROM users WHERE id = ?', [userId]);
    if (!member || !isAdmin(member) || String(member.status || '') !== 'active') throw acceptanceError('委员会成员必须是活跃管理员。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_MEMBER_INVALID', 409);
    const now = getBeijingTimestamp();
    try {
        const row = await queryOne(`
            INSERT INTO agent_domain_acceptance_committee_members (committee_role, user_id, assigned_by_user_id, assigned_at, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT (committee_role) DO UPDATE SET user_id = EXCLUDED.user_id, assigned_by_user_id = EXCLUDED.assigned_by_user_id, assigned_at = EXCLUDED.assigned_at, updated_at = EXCLUDED.updated_at
            RETURNING *
        `, [role, userId, user.id, now, now]);
        return { role: String(row.committee_role || ''), userId: Number(row.user_id || 0) || null, assignedByUserId: Number(row.assigned_by_user_id || 0) || null, assignedAt: row.assigned_at || null, updatedAt: row.updated_at || null };
    } catch (error) {
        if (String(error?.code || '') === '23505') throw acceptanceError('同一管理员不能同时占用多个委员会角色。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_MEMBER_DUPLICATE', 409);
        throw error;
    }
}

async function requireCommitteeMembersConfigured() {
    const rows = await query('SELECT committee_role, user_id FROM agent_domain_acceptance_committee_members');
    const roles = new Set(rows.map(row => String(row.committee_role || '')));
    if (roles.size !== COMMITTEE_ROLES.length || COMMITTEE_ROLES.some(role => !roles.has(role))) throw acceptanceError('委员会四个角色尚未由系统管理员完成成员配置。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_MEMBERS_MISSING', 409);
}

async function listCommitteeAttestations(evidenceId) {
    const rows = await query(`
        SELECT a.committee_role, a.signer_user_id, a.attestation_digest, a.signed_at, u.username
        FROM agent_domain_acceptance_committee_attestations a
        JOIN users u ON u.id = a.signer_user_id
        WHERE a.evidence_id = ? ORDER BY a.signed_at ASC
    `, [String(evidenceId || '')]);
    return rows.map(row => ({ role: String(row.committee_role || ''), signerUserId: Number(row.signer_user_id || 0) || null, signer: String(row.username || ''), attestationDigest: String(row.attestation_digest || ''), signedAt: row.signed_at || null }));
}

async function attestDomainAcceptanceCommitteeEvidence(user, evidenceId, input = {}) {
    requireReviewer(user);
    const role = normalizeCommitteeRole(input.role || input.committeeRole || input.committee_role);
    const existing = await queryOne('SELECT * FROM agent_domain_acceptance_evidence WHERE id = ?', [String(evidenceId || '')]);
    if (!existing) throw acceptanceError('验收证据不存在。', 'AGENT_DOMAIN_ACCEPTANCE_NOT_FOUND', 404);
    if (String(existing.evidence_type || '') !== 'committee') throw acceptanceError('只有委员会证据可以进行委员会签署。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_EVIDENCE_REQUIRED', 409);
    if (String(existing.status || '') !== 'submitted') throw acceptanceError('委员会签署只能在待核验状态完成。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_STATE_INVALID', 409);
    if (Number(existing.submitted_by_user_id) === Number(user.id)) throw acceptanceError('委员会证据提交人不能签署该记录。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_SELF_SIGN_FORBIDDEN', 409);
    await requireVerifiedPrerequisiteEvidence(existing.domain_key);
    const member = await queryOne('SELECT user_id FROM agent_domain_acceptance_committee_members WHERE committee_role = ?', [role]);
    if (!member || Number(member.user_id) !== Number(user.id)) throw acceptanceError('当前登录管理员未被指定为该委员会角色成员。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_MEMBER_REQUIRED', 403);
    const digest = crypto.createHash('sha256').update(canonicalJson({ evidenceDigest: existing.evidence_digest, role, signerUserId: Number(user.id) })).digest('hex');
    let row;
    try {
        row = await queryOne(`
            INSERT INTO agent_domain_acceptance_committee_attestations (id, evidence_id, committee_role, signer_user_id, attestation_digest, signed_at)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING *
        `, [crypto.randomUUID(), String(existing.id), role, user.id, digest, getBeijingTimestamp()]);
    } catch (error) {
        if (String(error?.code || '') === '23505') throw acceptanceError('该委员会角色或当前用户已经签署过此记录。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_DUPLICATE_SIGNATURE', 409);
        throw error;
    }
    return { role: String(row.committee_role || ''), signerUserId: Number(row.signer_user_id || 0) || null, attestationDigest: String(row.attestation_digest || ''), signedAt: row.signed_at || null };
}

async function submitDomainAcceptanceEvidence(user, input = {}) {
    requireSuperAdmin(user);
    const domainKey = normalizeDomainKey(input.domainKey || input.domain_key);
    const evidenceType = normalizeEvidenceType(input.evidenceType || input.evidence_type);
    const evidenceSummary = text(input.evidenceSummary || input.evidence_summary, 4000);
    const evidenceRef = requireReference(input.evidenceRef || input.evidence_ref, 'evidenceRef');
    if (evidenceSummary.length < 20) throw acceptanceError('验收证据摘要至少需要 20 个字符。', 'AGENT_DOMAIN_ACCEPTANCE_SUMMARY_REQUIRED');
    const evidenceManifest = normalizeEvidenceManifest(input.evidenceManifest ?? input.evidence_manifest ?? input.evidence, domainKey, evidenceType);
    if (evidenceType === 'committee') { await requireVerifiedPrerequisiteEvidence(domainKey); await requireCommitteeMembersConfigured(); }
    const evidenceDigest = crypto.createHash('sha256').update(canonicalJson({ domainKey, evidenceType, evidenceSummary, evidenceRef, evidenceManifest })).digest('hex');
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        INSERT INTO agent_domain_acceptance_evidence (
            id, domain_key, evidence_type, status, evidence_summary, evidence_ref, evidence_json, evidence_digest,
            submitted_by_user_id, submitted_at, updated_at
        ) VALUES (?, ?, ?, 'submitted', ?, ?, ?::jsonb, ?, ?, ?, ?)
        ON CONFLICT (domain_key, evidence_type, evidence_digest) DO UPDATE SET updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [crypto.randomUUID(), domainKey, evidenceType, evidenceSummary, evidenceRef, JSON.stringify(evidenceManifest), evidenceDigest, user.id, now, now]);
    return serialize(row);
}

async function verifyDomainAcceptanceEvidence(user, evidenceId, input = {}) {
    requireReviewer(user);
    const status = text(input.status, 16);
    if (!['verified', 'rejected'].includes(status)) throw acceptanceError('核验状态只能为 verified 或 rejected。', 'AGENT_DOMAIN_ACCEPTANCE_STATUS_INVALID');
    const verificationNote = text(input.verificationNote || input.verification_note, 2000);
    if (verificationNote.length < 12) throw acceptanceError('核验说明至少需要 12 个字符。', 'AGENT_DOMAIN_ACCEPTANCE_NOTE_REQUIRED');
    const existing = await queryOne('SELECT * FROM agent_domain_acceptance_evidence WHERE id = ?', [String(evidenceId || '')]);
    if (!existing) throw acceptanceError('验收证据不存在。', 'AGENT_DOMAIN_ACCEPTANCE_NOT_FOUND', 404);
    if (Number(existing.submitted_by_user_id) === Number(user.id)) throw acceptanceError('提交人与核验人必须不同。', 'AGENT_DOMAIN_ACCEPTANCE_SELF_REVIEW_FORBIDDEN', 409);
    if (status === 'verified') {
        normalizeEvidenceManifest(existing.evidence_json, existing.domain_key, existing.evidence_type);
        if (String(existing.evidence_type || '') === 'committee') {
            const attestations = await listCommitteeAttestations(existing.id);
            if (attestations.length !== COMMITTEE_ROLES.length || new Set(attestations.map(item => item.role)).size !== COMMITTEE_ROLES.length) throw acceptanceError('委员会证据尚未取得四个角色的独立登录态签署。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_SIGNATURES_MISSING', 409);
            if (attestations.some(item => Number(item.signerUserId) === Number(user.id))) throw acceptanceError('委员会签署人不能核验同一委员会记录。', 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_REVIEWER_CONFLICT', 409);
        }
    }
    const now = getBeijingTimestamp();
    const row = await queryOne(`
        UPDATE agent_domain_acceptance_evidence
        SET status = ?, verified_by_user_id = ?, verified_at = ?, verification_note = ?, updated_at = ?
        WHERE id = ? RETURNING *
    `, [status, user.id, now, verificationNote, now, String(evidenceId)]);
    return serialize(row);
}

async function listDomainAcceptanceEvidence(user, options = {}) {
    requireReviewer(user);
    const domainKey = options.domainKey || options.domain_key ? normalizeDomainKey(options.domainKey || options.domain_key) : '';
    const rows = await query(`SELECT * FROM agent_domain_acceptance_evidence ${domainKey ? 'WHERE domain_key = ?' : ''} ORDER BY domain_key, evidence_type, updated_at DESC`, domainKey ? [domainKey] : []);
    const attestationRows = await query(`
        SELECT a.evidence_id, a.committee_role, a.signer_user_id, a.attestation_digest, a.signed_at, u.username
        FROM agent_domain_acceptance_committee_attestations a JOIN users u ON u.id = a.signer_user_id
        ORDER BY a.signed_at ASC
    `);
    const attestationsByEvidence = new Map();
    for (const row of attestationRows) {
        const key = String(row.evidence_id || '');
        const values = attestationsByEvidence.get(key) || [];
        values.push({ role: String(row.committee_role || ''), signerUserId: Number(row.signer_user_id || 0) || null, signer: String(row.username || ''), attestationDigest: String(row.attestation_digest || ''), signedAt: row.signed_at || null });
        attestationsByEvidence.set(key, values);
    }
    const items = rows.map(row => ({ ...serialize(row), committeeAttestations: attestationsByEvidence.get(String(row.id || '')) || [] }));
    return DOMAIN_KEYS.map(key => {
        const current = items.filter(item => item.domainKey === key && item.status === 'verified' && item.evidenceManifestValid);
        const verifiedTypes = new Set(current.map(item => item.evidenceType));
        const missingEvidenceTypes = REQUIRED_EVIDENCE_TYPES.filter(type => !verifiedTypes.has(type));
        return { domainKey: key, readiness: missingEvidenceTypes.length ? 'incomplete' : 'ready_for_committee_score', missingEvidenceTypes, requirements: getDomainAcceptanceRequirements(key), evidence: items.filter(item => item.domainKey === key) };
    }).filter(item => !domainKey || item.domainKey === domainKey);
}

module.exports = { attestDomainAcceptanceCommitteeEvidence, listDomainAcceptanceCommitteeMembers, listDomainAcceptanceEvidence, normalizeEvidenceManifest, saveDomainAcceptanceCommitteeMember, submitDomainAcceptanceEvidence, verifyDomainAcceptanceEvidence };
