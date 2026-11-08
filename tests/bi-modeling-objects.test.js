'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { queryOne, execute, transaction } = require('../server/db/client');
const objects = require('../server/services/data-analysis/bi/objects');
const repository = require('../server/repositories/analysis-objects');
const { captureManifest, resolveManifest } = require('../server/services/data-analysis/bi/manifests');
const { normalizeModelDefinition } = require('../server/services/data-analysis/bi/definition');

async function fixture(run) {
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
    const id = `bi_objects_${crypto.randomBytes(8).toString('hex')}`;
    const user = await queryOne("INSERT INTO users(username,password_hash,unit) VALUES (?,'hash','QA') RETURNING id,username,status,unit", [id]);
    const root = path.join(process.env.DATA_DIR, id); await fs.mkdir(root, { recursive: true });
    const file = path.join(root, 'source.bin'); await fs.writeFile(file, '原始字节\r\n和精确数据 10.25');
    try { await run({ user, root, file }); }
    finally {
        await execute('DELETE FROM analysis_source_manifests WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_object_references WHERE object_id IN (SELECT id FROM analysis_data_objects WHERE user_id=?)', [user.id]);
        await execute('DELETE FROM analysis_data_objects WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_audit_events WHERE user_id=?', [user.id]);
        await execute('DELETE FROM analysis_data_models WHERE user_id=?', [user.id]);
        await execute('DELETE FROM users WHERE id=?', [user.id]);
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('对象流式提交保持原字节，领域目的独立，引用阻止 GC，释放后才可回收', async () => fixture(async ({ user, file }) => {
    const first = await objects.importFile({ file, userId: user.id, leaseId: 'reader_1' });
    const duplicate = await objects.importFile({ file, userId: user.id, leaseId: 'reader_2' });
    const exported = await objects.importFile({ file, userId: user.id, purpose: 'export', leaseId: 'export_1' });
    assert.equal(first.id, duplicate.id); assert.notEqual(first.storage_key, exported.storage_key);
    assert.deepEqual(await fs.readFile(await objects.verify(first)), await fs.readFile(file));
    await execute("UPDATE analysis_data_objects SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=?", [first.id]);
    assert.equal((await objects.garbageCollect()).deleted, 0);
    await repository.release('lease', 'reader_1'); await repository.release('lease', 'reader_2');
    assert.ok(new Date((await repository.get(first.id)).expires_at).getTime() > Date.now() + 29 * 86400000);
    await execute("UPDATE analysis_data_objects SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=?", [first.id]);
    await objects.garbageCollect();
    assert.equal((await repository.get(first.id)).state, 'expired');
    assert.equal((await repository.get(exported.id)).state, 'ready');
    await objects.verify(exported);
    const recovered = await objects.importFile({ file, userId: user.id });
    assert.equal(recovered.state, 'ready'); assert.equal(recovered.id, first.id);
}));

test('内容摘要损坏会隔离对象；提升后进程故障不产生就绪假象，删除代次拒绝新引用', async () => fixture(async ({ user, file }) => {
    const row = await objects.importFile({ file, userId: user.id });
    await fs.writeFile(objects.store.resolveStoragePath(row.storage_key), '篡改后的字节');
    await assert.rejects(objects.verify(row), error => error.code === 'ANALYSIS_OBJECT_CORRUPTED');
    assert.equal((await repository.get(row.id)).state, 'quarantined');
    await fs.writeFile(file, '不同的受控对象');
    await assert.rejects(objects.importFile({ file, userId: user.id, fault: phase => { if (phase === 'file_promoted') throw new Error('提升后强制中断'); } }), /强制中断/);
    const interrupted = await queryOne("SELECT * FROM analysis_data_objects WHERE user_id=? AND state='staging'", [user.id]);
    assert.ok(interrupted);
    await execute("UPDATE analysis_data_objects SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=?", [interrupted.id]);
    const deleting = await repository.claimDeletion(interrupted.id);
    assert.equal(deleting.state, 'deleting');
    await assert.rejects(transaction(trx => repository.pin([deleting.id], { kind: 'lease', referenceId: 'late_reader' }, trx)), error => error.code === 'ANALYSIS_OBJECT_NOT_READY');
    await objects.garbageCollect();
    assert.equal((await repository.get(deleting.id)).state, 'expired');
}));

test('不可变来源清单保存真实数据版本、完整性及摘要，当前权限收紧立即拒绝历史来源读取', { timeout: 60000 }, async () => fixture(async ({ user }) => {
    const dataset = await require('../server/services/data-analysis/datasets').createDatasetFromRows({ user, name: '清单测试', rows: [{ 编号: 'a', 金额: '10.25' }] });
    const model = await require('../server/services/data-analysis/semantic-models').saveDataModel({ user, body: { modelKind: 'production', name: '清单模型', factDatasetId: dataset.id } });
    const definition = normalizeModelDefinition({ ...model.definition, grainDescription: '一条业务记录', nodes: [{ ...model.definition.nodes[0], grainKeys: ['c_1'] }], metrics: [{ id: 'amount', type: 'sum', field: { nodeId: 'fact', fieldKey: 'c_2' } }] }).definition;
    const manifest = await captureManifest({ user, modelId: model.id, definition });
    const second = await captureManifest({ user, modelId: model.id, definition });
    assert.equal(manifest.id, second.id);
    const resolved = await resolveManifest({ user, modelId: model.id, definition, manifestId: manifest.id, query: { metrics: ['amount'], dimensions: [] } });
    assert.equal(resolved.sources.fact.tableName, 'bi_input_0');
    assert.match(resolved.snapshot.members[0].digest, /^[a-f0-9]{64}$/);
    assert.ok(resolved.snapshot.members[0].datasetVersionId);
    await repository.release('lease', resolved.leaseId);
    await assert.rejects(require('../server/services/data-analysis/datasets').softDeleteDataset(user, dataset.id), error => error.code === 'ANALYSIS_SOURCE_IN_USE');
    await execute("UPDATE users SET status='disabled' WHERE id=?", [user.id]);
    await assert.rejects(resolveManifest({ user, modelId: model.id, definition, manifestId: manifest.id }), error => error.status === 404);
}));
