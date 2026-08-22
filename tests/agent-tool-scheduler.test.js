'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeToolContract } = require('../server/services/agent-contracts');
const { executeToolCallsInOrder, getToolConcurrency } = require('../server/services/agent-tool-scheduler');

test('tool contracts derive explicit concurrency and cancellation semantics', () => {
    assert.equal(normalizeToolContract({ name: 'db.query' }).concurrency, 'read');
    assert.equal(normalizeToolContract({ name: 'reports.export' }).concurrency, 'write');
    assert.equal(normalizeToolContract({ name: 'reports.export' }).cancellable, false);
    assert.equal(normalizeToolContract({ name: 'admin.lock', concurrency: 'exclusive' }).concurrency, 'exclusive');
    assert.equal(getToolConcurrency({ concurrency: 'invalid', side_effect: true }), 'write');
});

test('streaming tool scheduler runs adjacent reads concurrently and returns model order', async () => {
    const timeline = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    const entries = [
        { id: 'read-slow', tool: { concurrency: 'read' } },
        { id: 'read-fast', tool: { concurrency: 'read' } },
        { id: 'write', tool: { concurrency: 'write' } },
        { id: 'read-after-write', tool: { concurrency: 'read' } },
        { id: 'exclusive', tool: { concurrency: 'exclusive' } }
    ];
    const results = await executeToolCallsInOrder(entries, async entry => {
        timeline.push(`start:${entry.id}`);
        const isRead = entry.tool.concurrency === 'read';
        if (isRead) {
            activeReads += 1;
            maxActiveReads = Math.max(maxActiveReads, activeReads);
        }
        await new Promise(resolve => setTimeout(resolve, entry.id === 'read-slow' ? 35 : 5));
        if (isRead) activeReads -= 1;
        timeline.push(`end:${entry.id}`);
        return entry.id;
    }, { maxReadConcurrency: 2 });

    assert.deepEqual(results, entries.map(entry => entry.id));
    assert.equal(maxActiveReads, 2);
    assert.ok(timeline.indexOf('start:write') > timeline.indexOf('end:read-slow'));
    assert.ok(timeline.indexOf('start:read-after-write') > timeline.indexOf('end:write'));
    assert.ok(timeline.indexOf('start:exclusive') > timeline.indexOf('end:read-after-write'));
});
