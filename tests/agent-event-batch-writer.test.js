const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentEventBatchWriter } = require('../server/services/agent-event-batch-writer');

test('流式审计事件按有界批次顺序写入并在结束时冲刷尾批', async () => {
    const batches = [];
    const writer = createAgentEventBatchWriter({ maxBatchSize: 2, intervalMs: 10000,
        recordBatch: async items => { batches.push(items.map(item => item.index)); } });
    for (let index = 0; index < 5; index += 1) writer.push({ index });
    await writer.finish();
    writer.push({ index: 99 });
    await writer.flush();
    assert.deepEqual(batches, [[0, 1], [2, 3], [4]]);
});

test('批次失败后逐条尝试，不让单条错误阻断后续事件', async () => {
    const attempts = [];
    const failures = [];
    const writer = createAgentEventBatchWriter({ intervalMs: 10000,
        recordBatch: async () => { throw new Error('模拟批量写入失败'); },
        recordOne: async item => { attempts.push(item.index); if (item.index === 1) throw new Error('模拟单条写入失败'); },
        onFailure: details => failures.push(details) });
    writer.push({ index: 1 }); writer.push({ index: 2 });
    await writer.finish();
    assert.deepEqual(attempts, [1, 2]);
    assert.deepEqual(failures, [{ failed: 1, attempted: 2 }]);
});

test('批次失败但逐条重试成功时不报告丢失', async () => {
    const failures = [];
    const writer = createAgentEventBatchWriter({ recordBatch: async () => { throw new Error('模拟批量写入失败'); },
        recordOne: async () => {}, onFailure: value => failures.push(value) });
    writer.push({ index: 1 });
    await writer.finish();
    assert.deepEqual(failures, []);
});

test('未满批次的事件按时刷新，不必等待模型结束', async () => {
    const written = [];
    const writer = createAgentEventBatchWriter({ intervalMs: 50, recordBatch: async items => { written.push(...items); } });
    writer.push({ index: 1 });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(written, [{ index: 1 }]);
    await writer.finish();
});
