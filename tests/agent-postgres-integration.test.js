const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPgSchemaStatements } = require('../server/db/schema');
const productionMigrations = require('../server/db/migrations/agent-production-control-plane');
const { createWorkspaceJail } = require('../server/services/agent-sandbox');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalJson } = require('../server/services/agent-skills');
const { createSkillVersion, publishSkillVersion, resolvePublishedSkill, validateSkillVersion } = require('../server/services/agent-releases');
const { deliverWebhook } = require('../server/services/agent-channel-adapters');
const { getAgentProfile, updateAgentProfile } = require('../server/services/agent-profile');
const { createAgentWorkflow } = require('../server/services/agent-workflows');
const { publishWorkflowRelease } = require('../server/services/agent-releases');
const { archiveStalePersonalExperiences, learnAgentRun, getAgentLearningOverview } = require('../server/services/agent-learning');
const { findBestPersonalSkill } = require('../server/services/agent-skills');
const { activatePersonalEvolutionProposal, createEvolutionShareRequest, decideEvolutionProposal, publishEvolutionProposal, restoreEvolutionProposal, revokePersonalEvolutionProposal, validateEvolutionProposal } = require('../server/services/agent-evolution');
const { generateManagedOrganizationSigningKey, disableManagedOrganizationSigning } = require('../server/services/agent-skill-signing-configuration');
const { createWorkflowCredential } = require('../server/services/workflow-credentials');
const {
    configureAgentChannelGateway,
    createChannelPairing,
    deliverChannelGatewayRunResult,
    receiveChannelMessage,
    revokeChannelPairing
} = require('../server/services/agent-channel-gateway');

test('production control-plane migration is PostgreSQL-only and declares release/delivery/inbox tables', () => {
    const text = String(productionMigrations[0].upPg);
    for (const table of ['agent_skill_versions', 'agent_skill_validations', 'agent_skill_releases', 'agent_workflow_releases', 'agent_channel_deliveries', 'agent_inbox_events']) assert.match(text, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.doesNotMatch(text, /PRAGMA|better-sqlite|sqlite_master/);
});

test('generated PostgreSQL schema remains the application bootstrap source', () => {
    const plan = buildPgSchemaStatements();
    assert.ok(Array.isArray(plan.tables));
    assert.ok(plan.tables.length > 70);
});

test('strict sandbox creates a task jail inside the configured root', () => {
    const jail = createWorkspaceJail(process.env.TEMP || require('os').tmpdir(), `integration-${Date.now()}`);
    assert.ok(jail.workspace.startsWith(jail.root));
});

test('real PostgreSQL integration is explicit when DATABASE_URL is available', { skip: !process.env.DATABASE_URL }, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const result = await pool.query('SELECT 1 AS ok');
    assert.equal(result.rows[0].ok, 1);
});

async function ensureTestUser(pool, username = 'integration_admin') {
    const existing = await pool.query('SELECT id, role, unit FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return { id: Number(existing.rows[0].id), username, role: existing.rows[0].role, unit: existing.rows[0].unit || '' };
    const res = await pool.query(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES ($1, 'hash', 'Integration Admin', 'QA', 'admin', 'active', NOW())
        RETURNING id, role, unit
    `, [username]);
    return { id: Number(res.rows[0].id), username, role: res.rows[0].role, unit: res.rows[0].unit || '' };
}

test('PostgreSQL Skill release path enforces signature, sandbox regression and runtime resolution', { skip: !process.env.DATABASE_URL }, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const user = await ensureTestUser(pool, 'integration_skill_admin');
    const id = `integration.skill.${Date.now()}`;
    const name = `integration-skill-${Date.now()}`;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    // 落地方案 v1.2 阶段 0.9 与 §5.1：manifest.tests 中的可执行脚本已被禁止，
    // 作用域不再由 manifest 自填（由发布动作决定），验证改跑平台声明式测试。
    const manifest = {
        schemaVersion: 1,
        id,
        name,
        version: '1.0.0',
        title: 'Integration Skill',
        capabilities: ['knowledge.search'],
        tools: ['rag.search'],
        inputs: {},
        outputs: {}
    };
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonicalJson(manifest));
    signer.end();
    manifest.signature = signer.sign(privateKey).toString('base64');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-skill-'));
    let version;
    let release;
    try {
        version = await createSkillVersion(user, { manifest, packageRoot: root, publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }), requireSignature: true });
        const validation = await validateSkillVersion(version.id, user, { publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }), testTimeoutMs: 10000 });
        assert.equal(validation.passed, true);
        assert.equal(validation.declarative.scriptsExecuted, false);
        assert.equal(validation.supplyChain.scope, 'actual-entries');
        release = await publishSkillVersion(version.id, user, { scope: 'personal' });
        assert.equal(release.status, 'published');
        const resolved = await resolvePublishedSkill(name, user);
        assert.equal(resolved.name, name);
    } finally {
        await pool.query('DELETE FROM agent_skill_releases WHERE name = $1', [name]);
        await pool.query('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name = $1)', [name]);
        await pool.query('DELETE FROM agent_skills WHERE name = $1', [name]);
        await pool.query('DELETE FROM agent_skill_versions WHERE name = $1', [name]);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Webhook Channel Adapter performs bounded chunked delivery over a real local HTTP server', async () => {
    const http = require('node:http');
    const received = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(202, { 'content-type': 'application/json' }); res.end('{}'); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const previousSensitiveOutbound = process.env.ALLOW_SENSITIVE_OUTBOUND_URLS;
    process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = 'true';
    try {
        await deliverWebhook({ config: JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, chunkSize: 8 }) }, { event_type: 'test', subject: 'subject', body: 'a'.repeat(25), idempotency_key: 'integration-delivery', attachments: '[]', interaction: '{}' }, { id: 1, role: 'admin' });
        assert.equal(received.length, 4);
        assert.equal(received[0].chunkTotal, 4);
        assert.equal(received[3].idempotencyKey, 'integration-delivery:3');
    } finally { process.env.ALLOW_SENSITIVE_OUTBOUND_URLS = previousSensitiveOutbound; await new Promise(resolve => server.close(resolve)); }
});

test('paired channel gateway rejects untrusted identities, deduplicates inbound messages, and maps one external conversation to one Agent session', { skip: !process.env.DATABASE_URL }, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const suffix = `${process.pid}-${Date.now()}`;
    const user = await ensureTestUser(pool, `integration_channel_${suffix}`);
    const credentialSlug = `CHANNEL_GATEWAY_${String(Date.now()).slice(-10)}`;
    const secret = `gateway-secret-${suffix}`;
    const bindingId = `channel-gateway-${suffix}`;
    const modelName = `gateway-model-${suffix}`;
    const runId = `channel-gateway-run-${suffix}`;
    let modelId = null;
    let sessionId = null;
    let pairingId = null;
    try {
        await createWorkflowCredential(user, { name: 'Gateway signing key', slug: credentialSlug, secretValue: secret });
        const model = await pool.query(`INSERT INTO models (user_id, name, url, api_key, model_name, status, created_at) VALUES ($1, $2, 'http://127.0.0.1:1/v1', '', $3, 'active', NOW()) RETURNING id`, [user.id, modelName, modelName]);
        modelId = Number(model.rows[0].id);
        await pool.query(`
            INSERT INTO agent_channel_bindings (id, user_id, channel_type, channel_key, credential_ref, config, notification_policy, status, created_at, updated_at)
            VALUES ($1, $2, 'webhook', 'gateway-target', $3, $4, '{}', 'active', NOW(), NOW())
        `, [bindingId, user.id, credentialSlug, JSON.stringify({ url: 'https://gateway.example.test/outbound', gateway: { enabled: true, modelId } })]);
        configureAgentChannelGateway({
            createAgentRun: async input => {
                sessionId = input.sessionId;
                await pool.query(`INSERT INTO agent_runs (id, user_id, session_id, model_id, title, goal, status, metadata, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, NOW(), NOW())`, [runId, input.user.id, input.sessionId, modelId, input.title, input.goal, JSON.stringify(input.metadata)]);
                return { id: runId };
            }
        });
        const pairing = await createChannelPairing(bindingId, user);
        pairingId = pairing.pairing.id;
        assert.ok(pairing.code);
        const timestamp = String(Date.now());
        const payload = { senderId: 'external-user-1', conversationId: 'external-chat-1', text: '请汇总今天的项目风险', eventId: `gateway-event-${suffix}`, pairingCode: pairing.code };
        const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(payload)}`).digest('hex');
        const accepted = await receiveChannelMessage(bindingId, payload, { 'x-agent-event-timestamp': timestamp, 'x-agent-signature': signature });
        assert.equal(accepted.accepted, true);
        assert.equal(accepted.paired, true);
        assert.equal(accepted.runId, runId);
        assert.ok(accepted.sessionId);
        assert.equal(sessionId, accepted.sessionId);
        const duplicate = await receiveChannelMessage(bindingId, payload, { 'x-agent-event-timestamp': timestamp, 'x-agent-signature': signature });
        assert.equal(duplicate.deduped, true);
        assert.equal(duplicate.runId, runId);
        const events = await pool.query('SELECT status, run_id FROM agent_channel_inbound_events WHERE binding_id = $1', [bindingId]);
        assert.equal(events.rows.length, 1);
        assert.equal(events.rows[0].status, 'accepted');
        assert.equal(events.rows[0].run_id, runId);
        const mappedSessions = await pool.query('SELECT session_id FROM agent_channel_sessions WHERE binding_id = $1', [bindingId]);
        assert.equal(mappedSessions.rows.length, 1);
        assert.equal(mappedSessions.rows[0].session_id, sessionId);
        const protectedSession = await pool.query('SELECT outbound_target_encrypted FROM agent_channel_sessions WHERE binding_id = $1', [bindingId]);
        assert.equal(protectedSession.rows.length, 1);
        assert.doesNotMatch(String(protectedSession.rows[0].outbound_target_encrypted || ''), /external-chat-1/);
        const delivery = await deliverChannelGatewayRunResult(runId, 'completed');
        assert.ok(delivery?.id);
        const queuedDelivery = await pool.query('SELECT interaction FROM agent_channel_deliveries WHERE id = $1', [delivery.id]);
        assert.equal(queuedDelivery.rows.length, 1);
        const deliveryInteraction = typeof queuedDelivery.rows[0].interaction === 'string'
            ? queuedDelivery.rows[0].interaction
            : JSON.stringify(queuedDelivery.rows[0].interaction || {});
        assert.match(deliveryInteraction, /outboundTargetEncrypted/);
        assert.doesNotMatch(deliveryInteraction, /external-chat-1/);

        await revokeChannelPairing(bindingId, pairingId, user);
        const revokedPayload = { ...payload, eventId: `gateway-event-revoked-${suffix}` };
        const revokedTimestamp = String(Date.now());
        const revokedSignature = crypto.createHmac('sha256', secret).update(`${revokedTimestamp}.${canonicalJson(revokedPayload)}`).digest('hex');
        await assert.rejects(
            () => receiveChannelMessage(bindingId, revokedPayload, { 'x-agent-event-timestamp': revokedTimestamp, 'x-agent-signature': revokedSignature }),
            error => ['AGENT_CHANNEL_GATEWAY_PAIRING_INVALID', 'AGENT_CHANNEL_GATEWAY_PAIRING_REQUIRED'].includes(error.code)
        );
    } finally {
        await pool.query('DELETE FROM agent_channel_deliveries WHERE binding_id = $1', [bindingId]);
        await pool.query('DELETE FROM agent_channel_inbound_events WHERE binding_id = $1', [bindingId]);
        await pool.query('DELETE FROM agent_channel_sessions WHERE binding_id = $1', [bindingId]);
        await pool.query('DELETE FROM agent_channel_pairings WHERE binding_id = $1', [bindingId]);
        await pool.query('DELETE FROM messages WHERE session_id = $1', [sessionId || '']);
        await pool.query('DELETE FROM agent_runs WHERE id = $1', [runId]);
        await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId || '']);
        await pool.query('DELETE FROM agent_channel_bindings WHERE id = $1', [bindingId]);
        await pool.query('DELETE FROM workflow_credentials WHERE user_id = $1 AND slug = $2', [user.id, credentialSlug]);
        if (modelId) await pool.query('DELETE FROM models WHERE id = $1', [modelId]);
    }
});

test('PostgreSQL profile field versions reject stale concurrent updates', { skip: !process.env.DATABASE_URL }, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const user = await ensureTestUser(pool, 'integration_profile_admin');
    const userId = user.id;
    const before = await getAgentProfile(userId);
    const next = await updateAgentProfile(userId, { displayName: `field-test-${Date.now()}`, fieldVersions: { displayName: Number(before.fieldVersions?.displayName || 0) } }, { source: 'integration-test' });
    assert.equal(Number(next.fieldVersions.displayName), Number(before.fieldVersions?.displayName || 0) + 1);
    await assert.rejects(() => updateAgentProfile(userId, { displayName: 'stale', fieldVersions: { displayName: Number(before.fieldVersions?.displayName || 0) } }), error => error.code === 'PROFILE_FIELD_VERSION_CONFLICT');
    await updateAgentProfile(userId, { profile: before }, { expectedVersion: next.version, source: 'integration-restore' });
});

test('workflow release gate requires a completed fixed evaluation batch', { skip: !process.env.DATABASE_URL }, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const user = await ensureTestUser(pool, 'admin');
    const suffix = Date.now();
    const workflow = await createAgentWorkflow(user, { name: `integration-gate-${suffix}`, description: 'gate', dagSpec: { nodes: [{ id: 'output', tool: 'workflow.output', input: { name: 'answer', value: 'ok' } }] } });
    try {
        await assert.rejects(() => publishWorkflowRelease(workflow.id, user, { version: 'current' }), error => error.code === 'WORKFLOW_EVALUATION_GATE_FAILED');
        const suite = await pool.query(`INSERT INTO agent_eval_suites (user_id, name, target_type, workflow_id, workflow_version, run_config, status, created_at, updated_at) VALUES ($1, $2, 'workflow', $3, 'current', '{}', 'active', NOW(), NOW()) RETURNING id`, [user.id, `gate-suite-${suffix}`, workflow.id]);
        const evalCase = await pool.query(`INSERT INTO agent_eval_cases (suite_id, name, input, input_variables, expected_output, assertions, sort_order, created_at, updated_at) VALUES ($1, 'gate', 'gate', '{}', '', '{}', 0, NOW(), NOW()) RETURNING id`, [suite.rows[0].id]);
        await pool.query(`INSERT INTO agent_eval_runs (id, suite_id, user_id, status, target_snapshot, summary, started_at, completed_at, created_at) VALUES ($1, $2, $3, 'completed', $4, $5, NOW(), NOW(), NOW())`, [`gate-run-${suffix}`, suite.rows[0].id, user.id, JSON.stringify({ workflowVersion: workflow.current_version, workflowVersionId: workflow.current_version_id }), JSON.stringify({ passRate: 100, averageScore: 100 })]);
        await pool.query(`INSERT INTO agent_eval_results (eval_run_id, case_id, status, score, passed, grader_results, created_at, completed_at) VALUES ($1, $2, 'passed', 100, 1, '{}', NOW(), NOW())`, [`gate-run-${suffix}`, evalCase.rows[0].id]);
        const release = await publishWorkflowRelease(workflow.id, user, { version: 'current', evaluationRunId: `gate-run-${suffix}` });
        assert.equal(release.status, 'published');

        const breakGlassRelease = await publishWorkflowRelease(workflow.id, user, {
            version: 'current',
            fixedEvaluationRequired: false,
            breakGlassReason: 'E2E测试紧急跳过发布验证必须超过十个字符'
        });
        assert.equal(breakGlassRelease.status, 'published');
    } finally {
        await pool.query('DELETE FROM agent_workflow_releases WHERE workflow_id = $1', [workflow.id]);
        await pool.query('DELETE FROM agent_eval_runs WHERE id LIKE $1', [`gate-run-${suffix}%`]);
        await pool.query('DELETE FROM agent_eval_suites WHERE name = $1', [`gate-suite-${suffix}`]);
        await pool.query('UPDATE agent_workflows SET deleted_at = NOW(), published_version_id = NULL WHERE id = $1', [workflow.id]);
    }
});

test('personal learning creates a real validated Skill release and makes it matchable', { skip: !process.env.DATABASE_URL }, async () => {
    const { getPgPool } = require('../server/db/pg-connection');
    const pool = getPgPool();
    const suffix = Date.now();
    const user = await ensureTestUser(pool, `integration_learning_${suffix}`);
    const runId = `learn-run-${suffix}`;
    const callIds = [`learn-call-a-${suffix}`, `learn-call-b-${suffix}`];
    let proposalId = null;
    let shareProposalId = null;
    let skillName = null;
    try {
        await pool.query(`INSERT INTO agent_runs (id, user_id, title, goal, status, run_mode, tool_policy, metadata, created_at, updated_at, completed_at) VALUES ($1, $2, '知识检索整理', '检索知识资料并生成项目风险摘要', 'completed', 'standard', 'all', '{}', NOW(), NOW(), NOW())`, [runId, user.id]);
        await pool.query(`
            INSERT INTO agent_tool_calls (id, run_id, step_id, tool_name, capability, risk_level, policy_decision, idempotent, input_payload, input_hash, output_hash, status, created_at)
            VALUES ($1, $2, 'step-a', 'rag.search', 'knowledge.search', 0, 'allow', TRUE, '{}', 'a', 'a', 'success', NOW()),
                   ($3, $2, 'step-b', 'knowledge.list', 'knowledge.read', 0, 'allow', TRUE, '{}', 'b', 'b', 'success', NOW())
        `, [callIds[0], runId, callIds[1]]);
        const learned = await learnAgentRun(user, runId, { runNow: true });
        assert.equal(learned.scheduled, true);
        assert.equal(learned.job.status, 'completed');
        proposalId = learned.job.proposalId;
        assert.ok(proposalId, JSON.stringify(learned.job));
        const proposal = (await pool.query('SELECT * FROM agent_evolution_proposals WHERE id = $1', [proposalId])).rows[0];
        assert.equal(proposal.status, 'waiting_user_review');
        assert.ok(proposal.artifact_version_id);
        assert.ok(!proposal.release_id);
        const activated = await activatePersonalEvolutionProposal(user, proposalId);
        assert.equal(activated.proposal.status, 'personal_active');
        const activeProposal = (await pool.query('SELECT * FROM agent_evolution_proposals WHERE id = $1', [proposalId])).rows[0];
        assert.ok(activeProposal.release_id);
        const release = (await pool.query('SELECT * FROM agent_skill_releases WHERE id = $1', [activeProposal.release_id])).rows[0];
        assert.equal(release.status, 'published');
        skillName = release.name;
        const selected = await findBestPersonalSkill(user, '请检索知识资料并生成风险摘要');
        assert.equal(selected.name, skillName);
        const overview = await getAgentLearningOverview(user);
        assert.ok(overview.experiences.some(item => String(item.id) === String(release.id)));
        const share = await createEvolutionShareRequest(user, proposalId);
        shareProposalId = share.id;
        assert.equal(share.scope, 'organization_candidate');
        assert.notEqual(String(share.artifactVersionId), String(proposal.artifact_version_id));
        assert.doesNotMatch(JSON.stringify(share.evidenceSummary), new RegExp(runId));
        await validateSkillVersion(share.artifactVersionId, user, { strictSpec: true, requireSignature: false });
        await assert.rejects(
            () => publishSkillVersion(share.artifactVersionId, user, { scope: 'organization', rolloutScope: 'organization' }),
            error => error.code === 'EVOLUTION_CANDIDATE_GATE_REQUIRED'
        );
        const approvedShare = await decideEvolutionProposal(user, shareProposalId, 'approve');
        assert.equal(approvedShare.status, 'approved');
        const sharedValidation = await validateEvolutionProposal(user, shareProposalId);
        assert.equal(sharedValidation.validation.passed, true);
        await generateManagedOrganizationSigningKey({ userId: user.id });
        const sharedRelease = await publishEvolutionProposal(user, shareProposalId);
        assert.equal(sharedRelease.status, 'published');
        assert.ok(sharedRelease.releaseId);
        await pool.query("UPDATE agent_evolution_proposals SET updated_at = NOW() - INTERVAL '91 days' WHERE id = $1", [proposalId]);
        const archived = await archiveStalePersonalExperiences({ days: 90 });
        assert.equal(archived.proposalIds.includes(proposalId), true);
        const archivedProposal = (await pool.query('SELECT status FROM agent_evolution_proposals WHERE id = $1', [proposalId])).rows[0];
        assert.equal(archivedProposal.status, 'archived');
        const restored = await restoreEvolutionProposal(user, proposalId);
        assert.equal(restored.status, 'personal_active');
        const revoked = await revokePersonalEvolutionProposal(user, proposalId);
        assert.equal(revoked.status, 'rolled_back');
    } finally {
        if (shareProposalId) await pool.query('DELETE FROM agent_evolution_proposals WHERE id = $1', [shareProposalId]);
        if (proposalId) await pool.query('DELETE FROM agent_evolution_proposals WHERE id = $1', [proposalId]);
        await pool.query('DELETE FROM agent_learning_jobs WHERE source_run_id = $1', [runId]);
        if (skillName) {
            await pool.query('DELETE FROM agent_skill_releases WHERE name = $1', [skillName]);
            await pool.query('DELETE FROM agent_skills WHERE name = $1', [skillName]);
            await pool.query('DELETE FROM agent_skill_validations WHERE skill_version_id IN (SELECT id FROM agent_skill_versions WHERE name = $1)', [skillName]);
            await pool.query('DELETE FROM agent_skill_versions WHERE name = $1', [skillName]);
        }
        await pool.query('DELETE FROM agent_tool_calls WHERE run_id = $1', [runId]);
        await pool.query('DELETE FROM agent_runs WHERE id = $1', [runId]);
        await disableManagedOrganizationSigning({ userId: user.id }).catch(() => {});
    }
});
