'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const { evaluateBreaker } = require('../server/services/agent-skill-rollout');
const { skillInstructionsForRuntime } = require('../server/services/agent-skill-import-provenance');
const { buildPlannerMessages } = require('../server/services/agent-runtime/planner');
const { searchSkillsForUser, describeSkillForUser } = require('../server/services/agent-skill-discovery');
const { findBestPersonalSkill, getAgentSkillExecutionContext } = require('../server/services/agent-skills');
const { assertTenantContext } = require('../server/services/agent-tenant-context');

test('技能尾部要求跨越旧的两处截断边界且超出模型容量时明确失败', () => {
    const instructions = '业务说明。'.repeat(4000) + '\n最后必须逐条列出未完成项。\n';
    const runtime = skillInstructionsForRuntime({}, instructions);
    const messages = buildPlannerMessages('完成任务', '', [], 'standard', { skillInstructions: runtime });
    assert.equal(messages.some(message => message.content.includes(instructions.trim())), true);
    assert.throws(() => buildPlannerMessages('完成任务', '', [], 'standard', { skillInstructions: runtime },
        { context_window_tokens: 1024, max_tokens: 800 }), error => error.code === 'CONTEXT_LENGTH_EXCEEDED');
    assert.throws(() => skillInstructionsForRuntime({}, '长'.repeat(90000)), error => error.code === 'SKILL_INSTRUCTIONS_LIMIT');
});

test('负反馈使用独立有效样本门槛，工具次数增长和缺少工具均不稀释用户反馈', () => {
    for (const samples of [0, 20, 400]) {
        const result = evaluateBreaker({}, { samples, feedbackSamples: 20, negativeFeedback: 20 });
        assert.equal(result.tripped, true); assert.equal(result.actual, 1); assert.equal(result.samples, 20);
    }
    assert.equal(evaluateBreaker({}, { samples: 400, feedbackSamples: 0, negativeFeedback: 0 }).tripped, false);
    assert.equal(evaluateBreaker({}, { samples: 400, feedbackSamples: 19, negativeFeedback: 19 }).tripped, false);
    assert.equal(evaluateBreaker({ minFeedbackSamples: 2 }, { feedbackSamples: 2, negativeFeedback: 2 }).tripped, true);
});

test('独立核验完整读取技能尾部要求，容量不足时拒绝声称核验通过', async () => {
    const instructions = '业务步骤。'.repeat(4000) + '\n最后必须列出例外。';
    const { verifyAutomaticTask } = require('../server/services/chat-task-verification');
    let calls = 0;
    const deps = { getModel: async () => ({ url: 'https://synthetic.invalid', name: '核验模型', max_input_tokens: 100000 }),
        resolveMemoryEvidence: async () => ({ current: true, memories: [] }), resolveObservations: async values => values,
        callModelJson: async (_model, messages) => {
            calls++; assert.equal(JSON.parse(messages[1].content).skillRequirements, instructions);
            return { passed: true, coveredDeliverables: [], missing: [] };
        } };
    const input = { run: { id: 'skill-verification', metadata: { skillInstructions: instructions } }, user: { id: 1 },
        contract: { acceptance: {}, deliverables: [] }, answer: '已列出例外', observations: [] };
    assert.equal((await verifyAutomaticTask(input, deps)).passed, true);
    const limited = await verifyAutomaticTask(input, { ...deps, getModel: async () => ({ name: '小模型', max_input_tokens: 1000 }) });
    assert.equal(limited.reason, 'verification_context_limit'); assert.equal(calls, 1);
});

test('反馈统计读取真实有效用户反馈与修订时间，不把运行时结果混入分母', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const releaseId = `audit-feedback-${crypto.randomUUID()}`;
    try {
        await execute(`INSERT INTO agent_runs(id,user_id,title,goal,status,metadata)
            SELECT ? || '-' || n::text,?,'反馈统计','反馈统计','completed',?::jsonb FROM generate_series(1,25) n`,
        [releaseId, user.id, JSON.stringify({ skillReleaseId: releaseId })]);
        await execute(`INSERT INTO agent_feedback(user_id,run_id,rating,outcome,source,created_at,updated_at)
            SELECT user_id,id,1,'failure',CASE WHEN right(id,2)::text IN ('21','22','23','24','25') THEN 'runtime' ELSE 'user' END,
                NOW()-INTERVAL '31 days',NOW() FROM agent_runs WHERE metadata->>'skillReleaseId'=?`, [releaseId]);
        await require('../server/services/agent-feedback').recordAgentRunOutcome(`${releaseId}-1`, 'completed');
        const metrics = await require('../server/services/agent-skill-breaker').collectReleaseMetrics(releaseId, new Date(Date.now() - 3600000).toISOString());
        assert.equal(metrics.samples, 0); assert.equal(metrics.feedbackSamples, 20); assert.equal(metrics.negativeFeedback, 20);
        assert.equal(evaluateBreaker({}, metrics).tripped, true);
    } finally { await execute("DELETE FROM agent_runs WHERE metadata->>'skillReleaseId'=?", [releaseId]); }
});

test('大目录、他人私有发布与历史灰度版本不挤掉合法技能，匹配只使用当前执行版本', async () => {
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id,role,username", [`audit_owner_${crypto.randomUUID()}`]);
    user.tenant_id = 1;
    const tenant = await assertTenantContext(user);
    const name = `audit-skill-${crypto.randomUUID()}`;
    const owner = `user:${user.id}`;
    const other = await queryOne("INSERT INTO users(username,password_hash,role,status) VALUES (?,'hash','user','active') RETURNING id", [`audit_${crypto.randomUUID()}`]);
    const versionIds = [];
    const addVersion = async (version, title, instructions) => {
        const manifest = { schemaVersion: 1, id: name, name, version, title, description: title, tags: [title], capabilities: [], tools: [], inputs: {}, outputs: {} };
        const row = await queryOne(`INSERT INTO agent_skill_versions(skill_id,owner_key,name,version,digest,content_digest,manifest_yaml,manifest_json,instructions_md,tenant_id,status,created_by)
            VALUES (?,?,?,?,?,?,?,?::jsonb,?,?,'published',?) RETURNING id`, [name, owner, name, version, `sha256:${version}`, version,
        JSON.stringify(manifest), JSON.stringify(manifest), instructions, tenant.tenantId, user.id]);
        versionIds.push(row.id); return row;
    };
    try {
        const old = await addVersion('1.0.0', '风险报告', '只生成风险报告');
        const current = await addVersion('2.0.0', '发票校对', '只校对发票');
        const first = await queryOne(`INSERT INTO agent_skill_releases(skill_version_id,owner_key,name,tenant_id,rollout_scope,status,published_by,published_at)
            VALUES (?,?,?,?,'personal','published',?,NOW()-INTERVAL '2 days') RETURNING id`, [old.id, owner, name, tenant.tenantId, user.id]);
        const latest = await queryOne(`INSERT INTO agent_skill_releases(skill_version_id,owner_key,name,tenant_id,rollout_scope,status,published_by,published_at)
            VALUES (?,?,?,?,'personal','published',?,NOW()-INTERVAL '1 day') RETURNING id`, [current.id, owner, name, tenant.tenantId, user.id]);
        // 同租户私有记录与不命中灰度的历史发布均须越过，不可先截取后宣称无结果。
        await execute(`INSERT INTO agent_skill_releases(skill_version_id,owner_key,name,tenant_id,rollout_scope,status,published_by)
            SELECT ?,?,?,?,'personal','published',? FROM generate_series(1,210)`, [current.id, `user:${other.id}`, name, tenant.tenantId, other.id]);
        await execute(`INSERT INTO agent_skill_releases(skill_version_id,owner_key,name,tenant_id,rollout_scope,status,published_by,rollout_percent)
            SELECT ?,?,?,?,'personal','published',?,0 FROM generate_series(1,210)`, [current.id, owner, name, tenant.tenantId, user.id]);
        const found = await searchSkillsForUser(user, { query: name });
        assert.equal(found.total, 1); assert.equal(found.candidates[0].reference.releaseId, String(latest.id));
        assert.equal((await describeSkillForUser(user, found.candidates[0].reference)).title, '发票校对');
        assert.equal(await findBestPersonalSkill(user, '风险报告'), null);
        const match = await findBestPersonalSkill(user, '发票校对');
        assert.equal(String(match.id), String(latest.id));
        const reference = { releaseId: String(match.id), version: match.version, digest: match.digest };
        const context = await getAgentSkillExecutionContext(user, match.name, reference);
        assert.equal(String(context.releaseId), String(match.id)); assert.equal(context.skillDigest, match.digest);
        await execute('UPDATE agent_skill_releases SET rollout_percent=0 WHERE id=?', [latest.id]);
        await assert.rejects(() => getAgentSkillExecutionContext(user, match.name, reference), error => error.code === 'SKILL_REFERENCE_STALE');
        assert.equal(String((await findBestPersonalSkill(user, '风险报告')).id), String(first.id));
    } finally {
        await execute('DELETE FROM agent_skill_releases WHERE name=?', [name]);
        for (const id of versionIds) await execute('DELETE FROM agent_skill_versions WHERE id=?', [id]);
        await execute('DELETE FROM users WHERE id=?', [other.id]);
        await execute('DELETE FROM users WHERE id=?', [user.id]);
    }
});
