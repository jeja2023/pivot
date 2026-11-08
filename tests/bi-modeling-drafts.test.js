'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, query, execute } = require('../server/db/client');
const datasets = require('../server/services/data-analysis/datasets');
const legacy = require('../server/services/data-analysis/semantic-models');
const models = require('../server/services/data-analysis/bi/models');

async function fixture(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const suffix = crypto.randomBytes(6).toString('hex');
    const user = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,unit,status", [`bi_draft_${suffix}`]);
    const other = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,unit,status", [`bi_other_${suffix}`]);
    try {
        const fact = await datasets.createDatasetFromRows({ user, name: '订单明细', rows: [{ 订单: 'a', 行: '1', 金额: '10.25' }, { 订单: 'b', 行: '1', 金额: '20.50' }] });
        await run({ user, other, fact });
    } finally {
        await execute('DELETE FROM analysis_audit_events WHERE user_id IN (?,?)', [user.id, other.id]);
        await execute('DELETE FROM analysis_data_models WHERE user_id IN (?,?)', [user.id, other.id]);
        await execute('DELETE FROM users WHERE id IN (?,?)', [user.id, other.id]);
    }
}

test('正式模型空草稿可保存、整份草稿按修订号事务更新、并发保存只接受一个版本', { timeout: 60000 }, async () => fixture(async ({ user, fact }) => {
    const created = await legacy.saveDataModel({ user, body: { modelKind: 'production', name: '订单分析', factDatasetId: fact.id } });
    assert.equal(created.modelKind, 'production'); assert.equal(created.version, 1); assert.equal(created.lifecycle, 'draft');
    assert.ok(created.draftIssues.length >= 3);
    const definition = { ...created.definition, grainDescription: '一条订单商品明细', nodes: [{ ...created.definition.nodes[0], grainKeys: ['c_1', 'c_2'] }],
        dimensions: [{ id: 'order', nodeId: 'fact', fieldKey: 'c_1', name: '订单' }],
        metrics: [{ id: 'amount', name: '金额', description: '实付金额', type: 'sum', field: { nodeId: 'fact', fieldKey: 'c_3' }, currency: 'CNY', unit: '元' }] };
    const saved = await models.saveProductionDraft({ user, modelId: created.id, body: { expectedVersion: 1, definition } });
    assert.equal(saved.version, 2); assert.deepEqual(saved.draftIssues, []);
    assert.equal(saved.definition.metrics[0].maintainerId, Number(user.id));
    assert.equal((await queryOne('SELECT COUNT(*)::int AS n FROM analysis_data_model_nodes WHERE model_id=?', [created.id])).n, 1);
    assert.equal((await queryOne('SELECT COUNT(*)::int AS n FROM analysis_metric_definitions WHERE model_id=?', [created.id])).n, 1);
    const changes = await Promise.allSettled(['甲', '乙'].map(label => models.saveProductionDraft({ user, modelId: created.id, body: { expectedVersion: 2, definition: { ...saved.definition, grainDescription: label } } })));
    assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(['ANALYSIS_MODEL_VERSION_CONFLICT', 'ANALYSIS_SECURITY_CONFIRMATION_PENDING'].includes(changes.find(result => result.status === 'rejected').reason.code));
    // 并发提交可能先命中独立确认栅栏；确认同一事件后，旧修订仍必须拒绝，不能产生第二次保存。
    await require('../server/services/data-analysis/bi/security-journal').flush({ force: true });
    await assert.rejects(models.saveProductionDraft({ user, modelId: created.id, body: { expectedVersion: 2, definition: saved.definition } }), error => error.code === 'ANALYSIS_MODEL_VERSION_CONFLICT');
    assert.equal((await models.getProductionModel(user, created.id)).model.version, 3);
    await assert.rejects(models.saveProductionDraft({ user, modelId: created.id, body: { definition } }), error => error.code === 'ANALYSIS_MODEL_VERSION_REQUIRED');
    const bad = { ...definition, metrics: [{ ...definition.metrics[0], field: { nodeId: 'fact', fieldKey: 'deleted' } }] };
    await assert.rejects(models.saveProductionDraft({ user, modelId: created.id, body: { expectedVersion: 3, definition: bad } }), error => error.status === 403);
    assert.equal((await models.getProductionModel(user, created.id)).model.version, 3);
    assert.equal((await query('SELECT id FROM analysis_audit_events WHERE model_id=?', [created.id])).length, 3);
}));

test('正式模型与旧写入分支隔离，个人权限及当前账号状态均执行校验', { timeout: 60000 }, async () => fixture(async ({ user, other, fact }) => {
    const created = await legacy.saveDataModel({ user, body: { modelKind: 'production', name: '隔离模型', factDatasetId: fact.id } });
    await assert.rejects(models.getProductionModel(other, created.id), error => error.status === 404);
    await assert.rejects(legacy.addDataModelRelation({ user, modelId: created.id, body: {} }), error => error.code === 'ANALYSIS_MODEL_UPGRADE_REQUIRED');
    await assert.rejects(legacy.deleteDataModel({ user, modelId: created.id, expectedVersion: 1 }), error => error.code === 'ANALYSIS_MODEL_UPGRADE_REQUIRED');
    await assert.rejects(legacy.saveDataModel({ user, modelId: created.id, body: { name: '不隐式共享', expectedVersion: 1, scope: 'shared' } }), error => error.code === 'ANALYSIS_MODEL_REVIEW_REQUIRED');
    const archived = await models.archiveProductionModel({ user, modelId: created.id, body: { expectedVersion: 1, archived: true } });
    assert.equal(archived.lifecycle, 'archived');
    await assert.rejects(models.saveProductionDraft({ user, modelId: created.id, body: { expectedVersion: 2, definition: created.definition } }), error => error.code === 'ANALYSIS_MODEL_ARCHIVED');
    await models.archiveProductionModel({ user, modelId: created.id, body: { expectedVersion: 2, archived: false } });
    await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
    await assert.rejects(models.getProductionModel(user, created.id), error => error.status === 404);
}));
