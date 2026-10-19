const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { queryOne, execute } = require('../server/db/client');
const { getTaskQueueSnapshot } = require('../server/repositories/system-monitor');
const { getSystemMonitorRuntime } = require('../server/services/system-monitor-runtime');

test('监控任务聚合按当前状态和完成时间计数，并排除软删除任务', { skip: !process.env.DATABASE_URL }, async () => {
    const user = await queryOne("SELECT id FROM users WHERE username = 'admin'");
    const before = await getTaskQueueSnapshot();
    const prefix = `monitor-${crypto.randomUUID()}`;
    const samples = [
        ['queued', 120, null, false], ['running', 60, null, false], ['awaiting_approval', 30, null, false],
        ['failed', 200000, 10, false], ['error', 300000, 200000, false], ['queued', 500000, null, true]
    ];
    try {
        for (const [index, [status, age, completionAge, deleted]] of samples.entries()) {
            await execute(`INSERT INTO agent_runs (id, user_id, title, goal, status, created_at, updated_at, completed_at, deleted_at)
                VALUES (?, ?, '监控测试', '聚合边界', ?, CURRENT_TIMESTAMP - (? * INTERVAL '1 second'), CURRENT_TIMESTAMP,
                    CASE WHEN ?::integer IS NULL THEN NULL ELSE CURRENT_TIMESTAMP - (? * INTERVAL '1 second') END,
                    CASE WHEN ?::boolean THEN CURRENT_TIMESTAMP ELSE NULL END)`,
            [`${prefix}-${index}`, user.id, status, age, completionAge, completionAge, deleted]);
        }
        const after = await getTaskQueueSnapshot();
        assert.equal(after.queued, before.queued + 1);
        assert.equal(after.running, before.running + 1);
        assert.equal(after.awaitingApproval, before.awaitingApproval + 1);
        assert.equal(after.failures24h, before.failures24h + 1);
        assert.ok(after.oldestQueuedSeconds >= 119);
        assert.ok(after.oldestQueuedSeconds < 500000, '软删除任务不能污染最早排队时长');
        assert.equal(after.scope, 'organization');
    } finally {
        for (let index = 0; index < samples.length; index++) await execute('DELETE FROM agent_runs WHERE id = ?', [`${prefix}-${index}`]);
    }
});

test('运行监控复用现有探针，并保留实例与全局统计范围', async () => {
    const result = await getSystemMonitorRuntime();
    assert.equal(result.scope, 'instance');
    assert.equal(typeof result.taskQueue.available, 'boolean');
    if (process.env.DATABASE_URL) {
        assert.equal(result.taskQueue.available, true);
    }
    assert.equal(typeof result.pgPool.available, 'boolean');
    assert.equal(typeof result.heap.heapLimit, 'number');
    assert.equal(typeof result.eventLoop.sampled, 'boolean');
    assert.equal(typeof result.writeQueue.pending, 'number');
    assert.equal(typeof result.writeQueue.dropped, 'number');
    assert.equal('lastError' in result.writeQueue, false);
});

test('任务聚合失败返回不可用，连接池与写入队列指标仍可读取', async () => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/services/system-monitor-runtime.js'), 'utf8'), {
        module, require(name) {
            if (name.includes('runtime-diagnostics')) return { getRuntimeDiagnostics: () => ({ pgPool: { available: false } }) };
            if (name.includes('db-write-queue')) return { getQueueDiagnostics: () => ({ logs: { pending: 3, dropped: 2, max: 10, lastError: '敏感错误正文' } }) };
            return { getTaskQueueSnapshot: async () => { throw Error('连接串等错误详情'); } };
        }
    });
    const result = await module.exports.getSystemMonitorRuntime();
    assert.equal(result.taskQueue.available, false);
    assert.equal(result.taskQueue.queued, undefined);
    assert.equal(result.pgPool.available, false);
    assert.equal(result.writeQueue.pending, 3);
    assert.equal(result.writeQueue.failedQueues, 1);
    assert.doesNotMatch(JSON.stringify(result), /敏感错误|连接串/);
});
