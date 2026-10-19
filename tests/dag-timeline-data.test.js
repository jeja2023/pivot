const assert = require('node:assert/strict');
const test = require('node:test');
const { computeTimelineData } = require('../client/chat/dag-timeline-waterfall');

test('甘特图按实际起止时间对齐，并行节点的墙钟耗时不重复相加', () => {
    const result = computeTimelineData([{ id: 'a' }, { id: 'b' }], {
        a: { status: 'completed', duration_ms: 2000, started_at: '2026-10-19 10:00:00' },
        b: { status: 'completed', duration_ms: 2000, started_at: '2026-10-19 10:00:01' }
    });
    assert.equal(result.totalDurationMs, 4000);
    assert.equal(result.elapsedDurationMs, 3000);
    assert.equal(result.items[1].offsetPercent, 33.3);
    assert.equal(result.items[1].widthPercent, 66.7);
});

test('运行中节点持续计时，缺少开始时间的历史完成节点按结束时间和耗时还原', () => {
    const start = Date.parse('2026-10-19T10:00:00+08:00');
    const result = computeTimelineData([{ id: 'a' }, { id: 'b' }], {
        a: { status: 'completed', duration_ms: 2000, completed_at: '2026-10-19 10:00:02' },
        b: { status: 'running', started_at: '2026-10-19 10:00:02' }
    }, { now: start + 5000 });
    assert.equal(result.elapsedDurationMs, 5000);
    assert.equal(result.items[1].durationMs, 3000);
    assert.equal(result.runningCount, 1);
    assert.equal(result.items[1].offsetPercent, 40);
});

test('尚未运行的节点没有假耗时或假进度，跳过与异常后继续保留真实状态', () => {
    const empty = computeTimelineData([{ id: 'pending' }], new Map(), { defaultStatus: 'not_started' });
    assert.equal(empty.items[0].status, 'not_started');
    assert.equal(empty.items[0].widthPercent, 0);
    assert.equal(empty.elapsedDurationMs, 0);
    const result = computeTimelineData([{ id: 'skip' }, { id: 'error' }], {
        skip: { status: 'skipped' }, error: { status: 'continued_error', durationMs: 50 }
    });
    assert.equal(result.items[0].status, 'skipped');
    assert.equal(result.errorCount, 1);
});
