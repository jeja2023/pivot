'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, checked } = require('../scripts/test_support/bi_modeling');
const { queryOne, execute } = require('../server/db/client');
const models = require('../server/services/data-analysis/bi/models');
const repository = require('../server/repositories/analysis-production-models');
const jobs = require('../server/services/data-analysis/bi/jobs');
const runner = require('../server/services/data-analysis/bi/runner');

test('画布布局保存和重开保持语义定义及原发布哈希，兼容保存保留位置并继续执行固定结果', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    const report = await checked(user, model);
    await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: report.id, requestKey: crypto.randomUUID() } });
    const before = await repository.get(model.id), published = await repository.version(model.id, 1), canvasLayout = { fact: { x: 194, y: 287 } };
    const saved = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: model.definition, canvasLayout } });
    assert.deepEqual(saved.canvasLayout, canvasLayout);
    const after = await repository.get(model.id);
    assert.deepEqual(after.definition_json, before.definition_json); assert.equal(after.semantic_hash, before.semantic_hash);
    assert.deepEqual(await repository.version(model.id, 1), published);
    assert.deepEqual((await models.getProductionModel(user, model.id)).model.canvasLayout, canvasLayout);
    const next = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: saved.version, definition: saved.definition } });
    assert.deepEqual(next.canvasLayout, canvasLayout);
    const run = await jobs.createModelQuery({ user, modelId: model.id, body: { publishedVersion: 1, dimensions: [], metrics: ['amount'], requestKey: crypto.randomUUID() } });
    await runner.processModelJobs(); assert.equal((await jobs.getModelJob(user, run.id)).result.total.values.amount.value, '250.00');
}));

test('布局拒绝越权、未知节点、非法坐标和额外字段，并与草稿共用修订竞争保护', { timeout: 90000 }, async () => fixture(async ({ user, model }) => {
    const body = { expectedVersion: model.version, definition: model.definition };
    for (const canvasLayout of [{ unknown: { x: 1, y: 2 } }, { fact: { x: 100001, y: 2 } }, { fact: { x: 1, y: 2, sql: '不允许额外字段' } }, { fact: { x: null, y: 2 } }]) {
        await assert.rejects(models.saveProductionDraft({ user, modelId: model.id, body: { ...body, canvasLayout } }), error => error.code === 'ANALYSIS_MODEL_LAYOUT_INVALID');
    }
    const admin = await queryOne("SELECT * FROM users WHERE username='admin'");
    await assert.rejects(models.saveProductionDraft({ user: admin, modelId: model.id, body: { ...body, canvasLayout: { fact: { x: 10, y: 20 } } } }), error => [403, 404].includes(error.status));
    const raced = await Promise.allSettled([100, 300].map(x => models.saveProductionDraft({ user, modelId: model.id, body: { ...body, canvasLayout: { fact: { x, y: 200 } } } })));
    assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
    assert.ok(['ANALYSIS_MODEL_VERSION_CONFLICT', 'ANALYSIS_SECURITY_CONFIRMATION_PENDING'].includes(raced.find(item => item.status === 'rejected').reason.code));
    await require('../server/services/data-analysis/bi/security-journal').flush({ force: true });
    await assert.rejects(models.saveProductionDraft({ user, modelId: model.id, body: { ...body, canvasLayout: { fact: { x: 500, y: 500 } } } }), error => error.code === 'ANALYSIS_MODEL_VERSION_CONFLICT');
    const saved = raced.find(item => item.status === 'fulfilled').value;
    await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
    await assert.rejects(models.saveProductionDraft({ user, modelId: model.id, body: { ...body, expectedVersion: saved.version, canvasLayout: { fact: { x: 80, y: 80 } } } }), error => [403, 404].includes(error.status));
    assert.deepEqual(await repository.canvasLayouts(model.id), saved.canvasLayout);
}));
