'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { queryOne, execute } = require('../server/db/client');
const { getModelQualityProfiles, recordModelQualityOutcome, modelQualityIdentity } = require('../server/services/agent-model-quality');

test('质量路由按唯一任务的最新验收计数，旧任务重验不能刷新三十天窗口', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const model = await queryOne("INSERT INTO models(user_id,name,url,model_name,status) VALUES (?,?,'http://127.0.0.1:1','fixture','active') RETURNING id", [user.id, suffix]);
    const id = `quality-${suffix}`, old = `${id}-old`;
    try {
        for (const runId of [id, old]) {
            await execute("INSERT INTO agent_runs(id,user_id,model_id,goal,status) VALUES (?,?,?,'统计数据','completed')", [runId, user.id, model.id]);
            await execute("INSERT INTO agent_verifications(id,run_id,user_id,outcome_status,created_at,updated_at,report) VALUES (?,?,?,'needs_input',NOW(),NOW(),?::jsonb)", [runId, runId, user.id, JSON.stringify({ semanticVerification: { modelIdentity: modelQualityIdentity({ url: 'http://127.0.0.1:1', model_name: 'fixture' }) } })]);
        }
        await execute("UPDATE agent_verifications SET created_at=NOW()-INTERVAL '31 days', outcome_status='verified' WHERE run_id=?", [old]);
        const run = { id, model_id: model.id, goal: '统计数据' };
        await recordModelQualityOutcome({ run, user }); await recordModelQualityOutcome({ run, user });
        let profile = (await getModelQualityProfiles(user, 'analysis')).find(item => item.modelId === Number(model.id));
        assert.equal(profile.samples, 1); assert.equal(profile.failed, 1);
        await execute("UPDATE agent_verifications SET outcome_status='verified',updated_at=NOW() WHERE run_id=?", [id]);
        profile = (await getModelQualityProfiles(user, 'analysis')).find(item => item.modelId === Number(model.id));
        assert.equal(profile.samples, 1); assert.equal(profile.verified, 1); assert.equal(profile.failed, 0);
        assert.deepEqual(await getModelQualityProfiles({ id: user.id + 100000 }, 'analysis'), []);
        await execute("UPDATE models SET model_name='changed' WHERE id=?", [model.id]);
        assert.equal((await getModelQualityProfiles(user, 'analysis')).some(item => item.modelId === Number(model.id)), false);
        await execute("UPDATE models SET model_name='fixture' WHERE id=?", [model.id]);
        await require('../server/services/agent-verification').verifyAndRecordTaskOutcome({ runId: id,
            run: { ...run, user_id: user.id, executionModelIdentity: modelQualityIdentity({ url: 'http://127.0.0.1:1', model_name: 'fixture' }) },
            user, answer: '仅完成部分任务', observations: [], partial: true });
        await execute("UPDATE agent_runs SET status='completed_with_errors' WHERE id=?", [id]);
        profile = (await getModelQualityProfiles(user, 'analysis')).find(item => item.modelId === Number(model.id));
        assert.equal(profile.samples, 1); assert.equal(profile.partial, 1); assert.equal(profile.verified, 0);
        await execute("UPDATE agent_runs SET status='planning' WHERE id=?", [id]);
        assert.equal((await getModelQualityProfiles(user, 'analysis')).some(item => item.modelId === Number(model.id)), false);
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?,?)', [id, old]);
        await execute('DELETE FROM models WHERE id=?', [model.id]);
    }
});


test('核验拒绝、内部缺口和无效响应同样保留质量身份，不把失败从样本中丢掉', async () => {
    const { verifyAutomaticTask } = require('../server/services/chat-task-verification');
    const model = { url: 'http://127.0.0.1:1', model_name: 'fixture', max_input_tokens: 16000 };
    const input = { run: { id: 'quality-failure', model_id: 1 }, user: { id: 1 }, contract: { acceptance: {}, deliverables: [] }, answer: '完成', observations: [] };
    const deps = { getModel: async () => model, resolveMemoryEvidence: async () => ({ current: true, memories: [] }), resolveObservations: async value => value };
    for (const output of ['invalid-json', { passed: false, coveredDeliverables: [], missing: ['缺少交付'] }]) {
        const result = await verifyAutomaticTask(input, { ...deps, callModelJson: async () => output });
        assert.equal(result.passed, false);
        assert.equal(result.modelIdentity, modelQualityIdentity(model));
    }
    const missing = await verifyAutomaticTask({ ...input, contract: { acceptance: { artifactRequired: true } } }, { ...deps, readyRunArtifacts: async () => [] });
    assert.equal(missing.reason, 'artifact_not_materialized');
    assert.equal(missing.modelIdentity, modelQualityIdentity(model));
});
