'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runBenchmark } = require('../scripts/benchmark_knowledge');
const { validateTargets } = require('../scripts/knowledge_restore_check');

test('压测只统计真实可引用结果并报告失败，不输出黄金集正文', async () => {
    const report = await runBenchmark({ baseUrl: 'http://127.0.0.1:3000', authorization: 'Bearer fixture', concurrency: 2,
        cases: [{ query: '敏感问题', expectedDocumentIds: [2] }, { query: '第二个问题', expectedDocumentIds: [9] }],
        fetchFn: async (_url, options) => {
            const request = JSON.parse(options.body);
            if (request.query === '第二个问题') throw new Error('测试失败');
            return { ok: true, json: async () => ({ results: [{ documentId: 2, selected: false }], citations: [{ document: { id: 3 } }] }) };
        } });
    assert.equal(report.succeeded, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.hitRate, 0);
    assert.doesNotMatch(JSON.stringify(report), /敏感问题|fixture/);
});

test('恢复对账拒绝源库与目标库为同一数据库', () => {
    assert.throws(() => validateTargets('postgres://u:p@localhost:5432/pivot', 'postgres://x:y@LOCALHOST/pivot'), /不同名称/);
    assert.doesNotThrow(() => validateTargets('postgres://u:p@localhost/pivot', 'postgres://u:p@localhost/pivot_restore'));
});
