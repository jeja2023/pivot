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
    const user = await ensureTestUser(pool, 'integration_workflow_admin');
    const suffix = Date.now();
    const workflow = await createAgentWorkflow(user, { name: `integration-gate-${suffix}`, description: 'gate', dagSpec: { nodes: [{ id: 'output', tool: 'workflow.output', input: { name: 'answer', value: 'ok' } }] } });
    try {
        await assert.rejects(() => publishWorkflowRelease(workflow.id, user, { version: 'current' }), error => error.code === 'WORKFLOW_EVALUATION_GATE_FAILED');
        const suite = await pool.query(`INSERT INTO agent_eval_suites (user_id, name, target_type, workflow_id, workflow_version, run_config, status, created_at, updated_at) VALUES ($1, $2, 'workflow', $3, 'current', '{}', 'active', NOW(), NOW()) RETURNING id`, [user.id, `gate-suite-${suffix}`, workflow.id]);
        const evalCase = await pool.query(`INSERT INTO agent_eval_cases (suite_id, name, input, input_variables, expected_output, assertions, sort_order, created_at, updated_at) VALUES ($1, 'gate', 'gate', '{}', '', '{}', 0, NOW(), NOW()) RETURNING id`, [suite.rows[0].id]);
        await pool.query(`INSERT INTO agent_eval_runs (id, suite_id, user_id, status, target_snapshot, summary, started_at, completed_at, created_at) VALUES ($1, $2, $3, 'completed', '{}', $4, NOW(), NOW(), NOW())`, [`gate-run-${suffix}`, suite.rows[0].id, user.id, JSON.stringify({ passRate: 100, averageScore: 100 })]);
        await pool.query(`INSERT INTO agent_eval_results (eval_run_id, case_id, status, score, passed, grader_results, created_at, completed_at) VALUES ($1, $2, 'passed', 100, 1, '{}', NOW(), NOW())`, [`gate-run-${suffix}`, evalCase.rows[0].id]);
        const release = await publishWorkflowRelease(workflow.id, user, { version: 'current', evaluationRunId: `gate-run-${suffix}` });
        assert.equal(release.status, 'published');
    } finally {
        await pool.query('DELETE FROM agent_workflow_releases WHERE workflow_id = $1', [workflow.id]);
        await pool.query('DELETE FROM agent_eval_runs WHERE id LIKE $1', [`gate-run-${suffix}%`]);
        await pool.query('DELETE FROM agent_eval_suites WHERE name = $1', [`gate-suite-${suffix}`]);
        await pool.query('UPDATE agent_workflows SET deleted_at = NOW(), published_version_id = NULL WHERE id = $1', [workflow.id]);
    }
});
