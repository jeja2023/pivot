'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { queryOne, execute } = require('../server/db/client');
const datasets = require('../server/services/data-analysis/datasets');
const governance = require('../server/services/data-analysis/governance');
const source = require('../server/services/mindmaps/data-source');
const documents = require('../server/services/mindmaps/documents');
test('数据层级映射保留精确汇总、来源、共享字段权限并可刷新为新版本', async () => {
    const account = async () => queryOne("INSERT INTO users(username,password_hash,role,status,unit,created_at) VALUES(?,?,'user','active','QA',NOW()) RETURNING id,username,role,unit", [`mapping_${crypto.randomUUID()}`, 'test-hash']);
    const owner = await account(); const recipient = await account(); let dataset; let saved;
    try {
        dataset = await datasets.createDatasetFromRows({ user: owner, name: '分层金额', rows: [{ region: '华东', department: '甲', amount: '0.1', secret: '内部' }, { region: '华东', department: '甲', amount: '0.2', secret: '内部' }, { region: '华南', department: '乙', amount: '2.5', secret: '内部' }] });
        const key = name => dataset.columns.find(column => column.name === name).key;
        const input = { datasetId: dataset.id, mapping: { dimensions: [key('region'), key('department')], metric: key('amount'), aggregation: 'sum', limit: 100 }, refreshMode: 'auto' };
        const preview = await source.fromDataset(owner, input);
        assert.equal(preview.tree.children[0].children[0].text, '甲：0.30000000'); assert.equal(preview.source.refreshMode, 'auto'); assert.deepEqual(preview.source.mapping, input.mapping);
        await assert.rejects(source.fromDataset(recipient, input), error => error.status === 404);
        await datasets.updateDataset(owner, dataset.id, { scope: 'shared', allowedUserIds: [recipient.id] });
        assert.equal((await source.fromDataset(recipient, input)).tree.children.length, 2);
        await governance.updateFieldGovernance({ user: owner, datasetId: dataset.id, fields: [{ fieldKey: key('secret'), sensitivity: 'restricted', displayName: '受限字段' }] });
        assert.ok(!(await source.datasets(recipient)).find(row => row.id === dataset.id).columns.some(column => column.key === key('secret')));
        await assert.rejects(source.fromDataset(recipient, { ...input, mapping: { ...input.mapping, dimensions: [key('secret')] } }), error => error.status === 403);
        saved = await documents.save(recipient, { document: await source.fromDataset(recipient, input), requestKey: crypto.randomUUID() });
        assert.equal((await source.refresh(recipient, saved.id, { expectedVersionId: saved.versionId, requestKey: crypto.randomUUID() })).unchanged, true);
        await datasets.updateDataset(owner, dataset.id, { scope: 'private' });
        await assert.rejects(source.refresh(recipient, saved.id, { expectedVersionId: saved.versionId, requestKey: crypto.randomUUID() }), error => error.status === 404);
        assert.equal((await documents.get(recipient, saved.id)).document.tree.children.length, 2, '已显式复制的个人快照仍可读取，来源撤权阻止后续刷新');
    } finally { if (saved) await execute('DELETE FROM agent_artifacts WHERE id=?', [saved.id]); if (dataset) await datasets.softDeleteDataset(owner.id, dataset.id); for (const user of [owner, recipient]) await execute('DELETE FROM users WHERE id=?', [user.id]); }
});
