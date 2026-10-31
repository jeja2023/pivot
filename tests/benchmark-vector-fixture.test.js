'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { run } = require('../scripts/benchmark_vector_fixture');

test('向量基准必须明确指定隔离数据库', async () => {
    await assert.rejects(run(), /TEST_DATABASE_URL/);
});

test('合成向量基准比较过滤召回及索引计划', { skip: !process.env.DATABASE_URL }, async () => {
    const result = await run({ connectionString: process.env.DATABASE_URL, rows: 1000, dimensions: 8, tenants: 4, trials: 2 });
    assert.equal(result.rows, 1000);
    assert.deepEqual(result.comparisons.map(item => item.name), ['default', 'iterative_200']);
    for (const item of result.comparisons) {
        assert.ok(item.meanRecallAt10 >= 0 && item.meanRecallAt10 <= 1);
        assert.match(JSON.stringify(item.plan), /pivot_vector_fixture_embedding_idx/);
    }
});
