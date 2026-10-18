'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { attestDomainAcceptanceCommitteeEvidence, listDomainAcceptanceEvidence, normalizeEvidenceManifest, saveDomainAcceptanceCommitteeMember, submitDomainAcceptanceEvidence, verifyDomainAcceptanceEvidence } = require('../server/services/agent-domain-acceptance-evidence');
const EVIDENCE_SHA256 = 'a'.repeat(64);

function automatedManifest() {
    return {
        schemaVersion: 1,
        artifact: { id: 'ci-run-acceptance-1', kind: 'ci_run', generatedAt: '2026-10-18T00:00:00.000Z', sha256: EVIDENCE_SHA256 },
        suite: 'test:agent:quality', runId: 'ci-run-acceptance-1', total: 143, passed: 143, failed: 0,
        completedAt: '2026-10-18T00:10:00.000Z', resultRef: 'ci://runs/acceptance-1'
    };
}

function observabilityMetrics() {
    return [
        { key: 'trace_correlation_rate', value: 1, threshold: 0.99, comparator: '>=', passed: true },
        { key: 'alert_delivery_rate', value: 1, threshold: 0.99, comparator: '>=', passed: true },
        { key: 'slo_breach_detection_time', value: 4, threshold: 5, comparator: '<=', passed: true }
    ];
}

function acceptanceManifest(type, suffix) {
    const artifact = { id: `${type}-${suffix}`, kind: `${type}_report`, generatedAt: '2026-10-18T00:00:00.000Z', sha256: EVIDENCE_SHA256 };
    if (type === 'implementation_review') return { schemaVersion: 1, artifact, reviewScope: 'Observability acceptance scope and permission review.', changeRefs: ['change://observability/1'], commit: 'abcdef123', reviewedAt: '2026-10-18T00:10:00.000Z' };
    if (type === 'automated') return { schemaVersion: 1, artifact, suite: 'test:agent:quality', runId: `ci-${suffix}`, total: 143, passed: 143, failed: 0, completedAt: '2026-10-18T00:10:00.000Z', resultRef: `ci://runs/${suffix}` };
    if (type === 'nonfunctional') return { schemaVersion: 1, artifact, window: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-18T00:00:00.000Z' }, sampleSize: 30, metrics: observabilityMetrics(), dashboardRef: `dashboard://observability/${suffix}` };
    if (type === 'canary') return { schemaVersion: 1, artifact, environment: 'canary', window: { start: '2026-10-16T00:00:00.000Z', end: '2026-10-18T00:00:00.000Z' }, cohort: 'canary-orgs-a', sampleSize: 30, fullCycle: true, p0Count: 0, p1Count: 0, metrics: observabilityMetrics(), rollbackDrillRef: `drill://observability/${suffix}`, operator: 'SRE on-call' };
    return { schemaVersion: 1, artifact, meetingAt: '2026-10-18T00:00:00.000Z', minutesRef: `minutes://architecture/${suffix}`, recommendation: 'approve_for_score', signatories: [
        { role: 'platform_security', signer: 'Security reviewer', signedAt: '2026-10-18T00:00:00.000Z' },
        { role: 'runtime', signer: 'Runtime reviewer', signedAt: '2026-10-18T00:01:00.000Z' },
        { role: 'qa_sre', signer: 'QA reviewer', signedAt: '2026-10-18T00:02:00.000Z' },
        { role: 'product', signer: 'Product reviewer', signedAt: '2026-10-18T00:03:00.000Z' }
    ] };
}

test('domain acceptance evidence requires independent admin verification and never auto-scores five points', async () => {
    const submitter = await queryOne("SELECT * FROM users WHERE username = 'admin' ORDER BY id LIMIT 1");
    assert.ok(submitter?.id);
    const suffix = `${process.pid}-${Date.now()}`;
    const row = await queryOne(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', 'Acceptance reviewer', 'QA', 'admin', 'active', NOW()) RETURNING *`, [`acceptance_reviewer_${suffix}`]);
    try {
        const evidence = await submitDomainAcceptanceEvidence(submitter, {
            domainKey: 'observability', evidenceType: 'automated',
            evidenceSummary: '运行 SLO 阈值、低样本拦截和告警监视器回归均已在受控测试环境通过。', evidenceRef: 'test:agent:quality', evidenceManifest: automatedManifest()
        });
        assert.equal(evidence.evidenceManifestValid, true);
        await assert.rejects(() => verifyDomainAcceptanceEvidence(submitter, evidence.id, { status: 'verified', verificationNote: '提交人与核验人必须不同，提交人不能自行完成验收核验。' }), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_SELF_REVIEW_FORBIDDEN');
        const verified = await verifyDomainAcceptanceEvidence(row, evidence.id, { status: 'verified', verificationNote: '已复核自动化输出与变更范围，证据可用于后续委员会评分。' });
        assert.equal(verified.status, 'verified');
        const domain = (await listDomainAcceptanceEvidence(row, { domainKey: 'observability' }))[0];
        assert.equal(domain.readiness, 'incomplete');
        assert.ok(domain.missingEvidenceTypes.includes('canary'));
    } finally {
        await execute('DELETE FROM agent_domain_acceptance_evidence WHERE evidence_ref = ?', ['test:agent:quality']);
        await execute('DELETE FROM users WHERE id = ?', [row.id]);
    }
});

test('structured acceptance manifests reject incomplete domain metrics and false canary claims', () => {
    assert.throws(() => normalizeEvidenceManifest({ ...automatedManifest(), artifact: { ...automatedManifest().artifact, sha256: 'not-a-digest' } }, 'observability', 'automated'), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_ARTIFACT_DIGEST_INVALID');
    assert.throws(() => normalizeEvidenceManifest({
        schemaVersion: 1, artifact: { id: 'metrics-1', kind: 'dashboard', generatedAt: '2026-10-18T00:00:00.000Z', sha256: EVIDENCE_SHA256 },
        window: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-18T00:00:00.000Z' }, sampleSize: 30,
        metrics: [{ key: 'trace_correlation_rate', value: 1, threshold: 0.99, comparator: '>=', passed: true }], dashboardRef: 'dashboard://observability'
    }, 'observability', 'nonfunctional'), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_REQUIRED_METRICS_MISSING');
    assert.throws(() => normalizeEvidenceManifest({
        schemaVersion: 1, artifact: { id: 'canary-1', kind: 'canary_report', generatedAt: '2026-10-18T00:00:00.000Z', sha256: EVIDENCE_SHA256 },
        environment: 'canary', window: { start: '2026-10-17T00:00:00.000Z', end: '2026-10-17T01:00:00.000Z' }, cohort: 'cohort-a', sampleSize: 30,
        fullCycle: false, p0Count: 0, p1Count: 0, metrics: [], rollbackDrillRef: 'drill://rollback', operator: 'SRE'
    }, 'observability', 'canary'), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_CANARY_NOT_CLEAN');
    assert.throws(() => normalizeEvidenceManifest({
        schemaVersion: 1, artifact: { id: 'metrics-2', kind: 'dashboard', generatedAt: '2026-10-18T00:00:00.000Z', sha256: EVIDENCE_SHA256 },
        window: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-18T00:00:00.000Z' }, sampleSize: 30,
        metrics: [{ key: 'trace_correlation_rate', value: 0.9, threshold: 0.99, comparator: '>=', passed: true }, { key: 'alert_delivery_rate', value: 1, threshold: 0.99, comparator: '>=', passed: true }, { key: 'slo_breach_detection_time', value: 4, threshold: 5, comparator: '<=', passed: true }], dashboardRef: 'dashboard://observability'
    }, 'observability', 'nonfunctional'), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_METRIC_NOT_PASSED');
    assert.throws(() => normalizeEvidenceManifest({
        schemaVersion: 1, artifact: { id: 'metrics-3', kind: 'dashboard', generatedAt: '2026-10-18T00:00:00.000Z', sha256: EVIDENCE_SHA256 },
        window: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-18T00:00:00.000Z' }, sampleSize: 30,
        metrics: [{ key: 'trace_correlation_rate', value: 1, threshold: 0.5, comparator: '>=', passed: true }, { key: 'alert_delivery_rate', value: 1, threshold: 0.99, comparator: '>=', passed: true }, { key: 'slo_breach_detection_time', value: 4, threshold: 5, comparator: '<=', passed: true }], dashboardRef: 'dashboard://observability'
    }, 'observability', 'nonfunctional'), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_METRIC_POLICY_NOT_MET');
});

test('five structured and independently verified evidence types are required before an adjudication-ready domain appears', async () => {
    const submitter = await queryOne("SELECT * FROM users WHERE username = 'admin' ORDER BY id LIMIT 1");
    const suffix = `${process.pid}-${Date.now()}`;
    const reviewer = await queryOne(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', 'Five point reviewer', 'QA', 'admin', 'active', NOW()) RETURNING *`, [`five_point_reviewer_${suffix}`]);
    const committeeReviewer = await queryOne(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', 'Committee verifier', 'QA', 'admin', 'active', NOW()) RETURNING *`, [`committee_verifier_${suffix}`]);
    const committeeSigners = [];
    for (const role of ['platform_security', 'runtime', 'qa_sre', 'product']) committeeSigners.push(await queryOne(`INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, 'Committee', 'admin', 'active', NOW()) RETURNING *`, [`committee_${role}_${suffix}`, role]));
    for (const [index, role] of ['platform_security', 'runtime', 'qa_sre', 'product'].entries()) await saveDomainAcceptanceCommitteeMember(submitter, { role, userId: committeeSigners[index].id });
    const refs = [];
    try {
        await assert.rejects(() => submitDomainAcceptanceEvidence(submitter, {
            domainKey: 'observability', evidenceType: 'committee', evidenceSummary: '委员会记录不能绕过前置独立核验的四类验收证据。', evidenceRef: `test:committee-early-${suffix}`, evidenceManifest: acceptanceManifest('committee', suffix)
        }), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_PREREQUISITES_MISSING');
        for (const evidenceType of ['implementation_review', 'automated', 'nonfunctional', 'canary']) {
            const evidenceRef = `test:five-point-${evidenceType}-${suffix}`;
            refs.push(evidenceRef);
            const evidence = await submitDomainAcceptanceEvidence(submitter, { domainKey: 'observability', evidenceType, evidenceSummary: `受控 ${evidenceType} 验收证据，含可复核的结构化清单与受权限控制的报告引用。`, evidenceRef, evidenceManifest: acceptanceManifest(evidenceType, suffix) });
            await verifyDomainAcceptanceEvidence(reviewer, evidence.id, { status: 'verified', verificationNote: '独立复核了结构化字段、受控报告引用和验收结论。' });
        }
        const committeeRef = `test:five-point-committee-${suffix}`;
        refs.push(committeeRef);
        const committee = await submitDomainAcceptanceEvidence(submitter, { domainKey: 'observability', evidenceType: 'committee', evidenceSummary: '委员会已在前四类独立核验完成后提交四方签署的评分建议记录。', evidenceRef: committeeRef, evidenceManifest: acceptanceManifest('committee', suffix) });
        await assert.rejects(() => verifyDomainAcceptanceEvidence(committeeReviewer, committee.id, { status: 'verified', verificationNote: '缺少四方独立登录态签署时不能核验委员会记录。' }), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_SIGNATURES_MISSING');
        for (const [index, role] of ['platform_security', 'runtime', 'qa_sre', 'product'].entries()) await attestDomainAcceptanceCommitteeEvidence(committeeSigners[index], committee.id, { role });
        await assert.rejects(() => verifyDomainAcceptanceEvidence(committeeSigners[0], committee.id, { status: 'verified', verificationNote: '签署人不能兼任同一委员会记录的独立核验人。' }), error => error.code === 'AGENT_DOMAIN_ACCEPTANCE_COMMITTEE_REVIEWER_CONFLICT');
        await verifyDomainAcceptanceEvidence(committeeReviewer, committee.id, { status: 'verified', verificationNote: '独立复核委员会记录、四方身份签署和前置证据均已齐备。' });
        const domain = (await listDomainAcceptanceEvidence(committeeReviewer, { domainKey: 'observability' }))[0];
        assert.equal(domain.readiness, 'ready_for_committee_score');
        assert.equal(domain.evidence.filter(item => item.status === 'verified' && item.evidenceManifestValid).length, 5);
    } finally {
        for (const evidenceRef of refs) await execute('DELETE FROM agent_domain_acceptance_evidence WHERE evidence_ref = ?', [evidenceRef]);
        await execute('DELETE FROM agent_domain_acceptance_committee_members WHERE assigned_by_user_id = ? OR user_id IN (?, ?, ?, ?)', [submitter.id, ...committeeSigners.map(signer => signer.id)]);
        await execute('DELETE FROM users WHERE id = ?', [reviewer.id]);
        await execute('DELETE FROM users WHERE id = ?', [committeeReviewer.id]);
        for (const signer of committeeSigners) await execute('DELETE FROM users WHERE id = ?', [signer.id]);
    }
});
