'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { analyze } = require('../server/services/data-analysis/transaction-engine');
const { parse, format } = require('../server/services/data-analysis/transaction-money');
const mapping = { account: 'c_1', counterpartyAccount: 'c_2', counterpartyName: 'c_3', time: 'c_4', amount: 'c_5', currency: 'c_6', transactionId: 'c_7', memo: 'c_8' };
test('交易金额精确到八位，币种和账户不合并，重复、撤销及无效行单独计数', () => {
    assert.equal(format(parse('0.1') + parse('0.2')), '0.30'); assert.equal(format(parse('9007199254740993.12345678')), '9007199254740993.12345678'); assert.throws(() => parse('1e6')); assert.throws(() => parse('1.000000001'));
    const rows = [
        { source_row: 1, account: '001', counterpartyAccount: '002', time: '2026-02-01 01:00:00', amount: '0.1', currency: 'CNY', transactionId: '01' },
        { source_row: 2, account: '001', counterpartyAccount: '002', time: '2026-02-01 02:00:00', amount: '0.2', currency: 'CNY', transactionId: '02' },
        { source_row: 3, account: '001', counterpartyAccount: '002', time: '2026-02-01 02:00:00', amount: '0.2', currency: 'CNY', transactionId: '02' },
        { source_row: 4, account: '001', counterpartyName: '同名', time: '2026-02-02', amount: '10', currency: 'USD' },
        { source_row: 5, account: '001', counterpartyName: '同名', time: '2026-02-03', amount: '20', currency: 'USD' },
        { source_row: 6, account: '001', time: '2026-02-30', amount: '1', currency: 'CNY' }
    ];
    const result = analyze(rows, { mapping });
    assert.equal(result.currencies.find(row => row.currency === 'CNY').income, '0.30'); assert.equal(result.currencies.find(row => row.currency === 'USD').income, '30.00'); assert.equal(result.counterpartyCount, 3); assert.equal(result.counts.duplicates, 1); assert.equal(result.counts.invalid, 1); assert.equal(result.window.timezoneOffsetMinutes, 480);
    assert.equal(result.counterparties.filter(row => !row.identified).length, 2); assert.ok(!JSON.stringify(result.counterparties).includes('同名')); assert.ok(!JSON.stringify(result).includes('"001"'));
});
test('方向、退款冲正、账户范围、分类修正及时间窗规则都有来源行证据', () => {
    const rows = [
        { source_row: 1, account: '001', counterpartyAccount: '003', time: '2026-10-01 01:00:00', amount: '10000', direction: '入', memo: '工资' },
        { source_row: 2, account: '001', counterpartyAccount: '004', time: '2026-10-01 01:10:00', amount: '9500', direction: '出' },
        { source_row: 3, account: '001', counterpartyAccount: '004', time: '2026-10-01 03:00:00', amount: '-100', direction: '出', status: '冲正' },
        { source_row: 4, account: '001', counterpartyAccount: '002', time: '2026-10-01 03:01:00', amount: '10', direction: '出' },
        { source_row: 5, account: '001', counterpartyAccount: '004', time: '2026-10-01 03:01:00', amount: '100', direction: '入', status: '已取消' }
    ];
    const config = { mapping: { ...mapping, direction: 'c_9', status: 'c_10', currency: '' }, amountMode: 'direction', incomeValues: ['入'], expenseValues: ['出'], accounts: ['001', '002'], internalTransfer: 'exclude-both-in-scope', rules: { thresholds: { CNY: '9000' }, frequency: 2, windowMinutes: 60 }, categories: [{ id: 'salary', field: 'memo', operator: 'contains', value: '工资', label: '工资收入' }], corrections: { 2: '人工修正' } };
    const result = analyze(rows, config);
    assert.equal(result.currencies[0].income, '10100.00'); assert.equal(result.currencies[0].expense, '9500.00'); assert.equal(result.counts.reversals, 1); assert.equal(result.counts.internalTransfers, 1); assert.equal(result.counts.cancelled, 1);
    assert.ok(result.categories.some(row => row.category === '人工修正')); const quick = result.evidence.find(row => row.rule === 'quickInOut'); assert.deepEqual(quick.rows, [2, 1]); assert.equal(result.hitCounts.frequency, 1); assert.ok(result.ruleVersion.length === 64);
});
test('真实数据集交易任务可恢复且幂等，跨账号拒绝、过期及源数据删除清理结果', { timeout: 30000 }, async () => {
    const { queryOne, execute } = require('../server/db/client'); const datasets = require('../server/services/data-analysis/datasets'); const service = require('../server/services/data-analysis/transactions'); const repository = require('../server/repositories/analysis-transactions');
    const user = await queryOne("INSERT INTO users(username,password_hash,role,status,created_at) VALUES(?,?,'user','active',NOW()) RETURNING id", [`finance_${crypto.randomUUID()}`, 'test-hash']); let dataset;
    try {
        dataset = await datasets.createDatasetFromRows({ user, name: '交易流水', rows: [{ account: '000123', peer: '000456', time: '2026-10-01 10:00:00', amount: '0.1' }, { account: '000123', peer: '000456', time: '2026-10-01 11:00:00', amount: '0.2' }] });
        const key = name => dataset.columns.find(column => column.name === name).key;
        const config = { mapping: { account: key('account'), counterpartyAccount: key('peer'), time: key('time'), amount: key('amount') }, requestKey: crypto.randomUUID() };
        const job = await service.create(user, dataset.id, config); assert.equal(job.status, 'queued'); assert.equal((await service.create(user, dataset.id, config)).id, job.id);
        await service.drain(); let result; for (let i = 0; i < 100; i++) { result = await service.get(user, job.id); if (!['queued','running'].includes(result.status)) break; await new Promise(resolve => setTimeout(resolve, 30)); }
        assert.equal(result.status, 'succeeded', result.error); assert.equal(result.result.currencies[0].income, '0.30'); assert.equal(result.result.counts.accepted, 2);
        await assert.rejects(service.get({ id: Number(user.id) + 10000 }, job.id), error => error.status === 404);
        const retained = await repository.get(user.id, job.id); assert.equal(retained.lease, null);
        const report = require('../server/services/data-analysis/transaction-report'); assert.equal(require('../server/services/document-ir').validateDocumentIr(report.ir(result)).valid, true);
        const prepared = await report.prepareAi(user, job.id); await assert.rejects(prepared.verifyTransactionExplanation('{"observations":[{"factId":"unknown","comment":"无法引用"}]}'), /引用/);
        const explained = await prepared.verifyTransactionExplanation('{"observations":[{"factId":"total-0","comment":"请核对原始交易记录并确认统计范围。"}]}'); assert.equal(explained.observations.length, 1);
        const delivery = require('../server/services/data-analysis/transaction-delivery');
        for (const format of ['mindmap','docx','pdf']) await delivery.create(user, job.id, format);
        await service.drain(); let outputs;
        for (let i = 0; i < 150; i++) { outputs = await delivery.list(user, job.id); if (outputs.length === 3 && outputs.every(output => !['queued','running'].includes(output.status))) break; await new Promise(resolve => setTimeout(resolve, 100)); }
        assert.ok(outputs.every(output => output.status === 'succeeded'), JSON.stringify(outputs));
        assert.equal((await require('../server/services/mindmaps/documents').get(user, outputs.find(output => output.format === 'mindmap').artifact_id)).document.tree.text, '资金交易分析');
        const pdf = outputs.find(output => output.format === 'pdf'); assert.ok(await require('../server/services/agent-artifact-renditions').issueDownloadToken(user, pdf.rendition_id));
        const tool = require('../server/services/agent-tools-offline-office'); const summary = await tool.executeOfflineOffice('finance.transactionSummary', { analysisId: job.id }, user, {}); assert.equal(summary.result.currencies[0].income, '0.30');
        await execute("UPDATE analysis_transaction_runs SET expires_at=NOW()-INTERVAL '1 second' WHERE id=?", [job.id]); await repository.cleanup();
        for (const output of outputs) { const artifact = await queryOne('SELECT status,content FROM agent_artifacts WHERE id=?', [output.artifact_id]); assert.equal(artifact.status, 'deleted'); assert.equal(artifact.content, ''); }
        await assert.rejects(require('../server/services/agent-artifact-renditions').issueDownloadToken(user, pdf.rendition_id), error => error.status === 409);
    } finally {
        if (dataset) await datasets.softDeleteDataset(user.id, dataset.id).catch(() => {});
        await execute('DELETE FROM analysis_transaction_outputs WHERE analysis_id IN (SELECT id FROM analysis_transaction_runs WHERE user_id=?)', [user.id]).catch(() => {});
        await execute('DELETE FROM agent_artifact_renditions WHERE artifact_id IN (SELECT id FROM agent_artifacts WHERE user_id=?)', [user.id]).catch(() => {});
        await execute('DELETE FROM agent_artifact_versions WHERE artifact_id IN (SELECT id FROM agent_artifacts WHERE user_id=?)', [user.id]).catch(() => {});
        await execute('DELETE FROM agent_artifacts WHERE user_id=?', [user.id]).catch(() => {});
        await execute('DELETE FROM analysis_transaction_runs WHERE user_id=?', [user.id]).catch(() => {});
        await execute('DELETE FROM users WHERE id=?', [user.id]).catch(() => {});
    }
});
