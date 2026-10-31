'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('多节点指标渲染使用共享快照且保留原指标接口', { skip: !/^pivot_test_[a-z0-9_]+$/.test(process.env.PG_TEST_SCHEMA || '') }, async () => {
    const previous = process.env.PIVOT_DEPLOYMENT_MODE;
    process.env.PIVOT_DEPLOYMENT_MODE = 'multi_node';
    const database = require('../server/db/client');
    const { renderPrometheusMetrics } = require('../server/metrics');
    try {
        await database.execute('DELETE FROM token_metrics_snapshot WHERE id = 1');
        const output = await renderPrometheusMetrics();
        assert.match(output, /pivot_metrics_collection_error\{collector="token_usage"\} 0/);
        const snapshot = await database.queryOne('SELECT all_rows, today_rows FROM token_metrics_snapshot WHERE id = 1');
        assert.ok(Array.isArray(snapshot?.all_rows));
        assert.ok(Array.isArray(snapshot?.today_rows));
        assert.match(output, /# TYPE pivot_tokens_total counter/);
        assert.match(output, /# TYPE pivot_tokens_today gauge/);
    } finally {
        await database.execute('DELETE FROM token_metrics_snapshot WHERE id = 1');
        if (previous === undefined) delete process.env.PIVOT_DEPLOYMENT_MODE;
        else process.env.PIVOT_DEPLOYMENT_MODE = previous;
        await require('../server/db/pg-connection').closePgPool();
    }
});
