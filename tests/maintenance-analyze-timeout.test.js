const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnalyzeProgress, runAnalyzeTables } = require('../server/services/analyze-maintenance');

test('ANALYZE 总时限会保存进度游标并从下一张表恢复', async () => {
    const tables = ['a', 'b', 'c'].map(tablename => ({ schemaname: 'public', tablename }));
    const progress = createAnalyzeProgress();
    const invoked = [];
    let now = 0;
    const analyze = async (table, remainingBudgetMs) => {
        invoked.push(table.tablename);
        assert.ok(remainingBudgetMs >= 1_000);
        now += 600;
    };

    const first = await runAnalyzeTables(tables, {
        analyzeTable: analyze,
        now: () => now,
        progress,
        totalTimeoutMs: 2_000
    });
    assert.equal(first.completed, false);
    assert.equal(first.timedOut, true);
    assert.deepEqual(invoked, ['a', 'b']);
    assert.equal(progress.cursor, 2);
    assert.equal(progress.nextTable, 'public.c');

    now = 0;
    const second = await runAnalyzeTables(tables, {
        analyzeTable: analyze,
        now: () => now,
        progress,
        totalTimeoutMs: 2_000
    });
    assert.equal(second.completed, true);
    assert.deepEqual(invoked, ['a', 'b', 'c']);
    assert.equal(progress.cursor, 0);
    assert.equal(progress.nextTable, '');
});

test('ANALYZE 继续收集单表失败而不阻塞后续表', async () => {
    const progress = createAnalyzeProgress();
    const visited = [];
    const result = await runAnalyzeTables([
        { schemaname: 'public', tablename: 'ok' },
        { schemaname: 'public', tablename: 'broken' },
        { schemaname: 'public', tablename: 'later' }
    ], {
        analyzeTable: async (table, remainingBudgetMs) => {
            visited.push(table.tablename);
            assert.ok(remainingBudgetMs >= 1_000);
            if (table.tablename === 'broken') throw new Error('模拟统计信息采集失败');
        },
        progress,
        totalTimeoutMs: 10_000
    });
    assert.equal(result.completed, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.failures.length, 1);
    assert.deepEqual(visited, ['ok', 'broken', 'later']);
});
