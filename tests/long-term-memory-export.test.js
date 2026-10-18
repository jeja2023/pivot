'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemoryExporter } = require('../server/services/long-term-memory/memory-export');

function createFixture(size) {
    const rows = Array.from({ length: size }, (_, index) => ({ id: index + 1 }));
    const calls = [];
    const exportMemories = createMemoryExporter({
        listMemories: async (userId, options) => {
            calls.push({ userId, ...options });
            return { total: rows.length, enabled: true, memories: rows.slice(options.offset, options.offset + options.limit) };
        },
        getMemorySummary: async () => ({ active: rows.length }),
        getTimestamp: () => '2026-10-18 00:00:00'
    });
    return { exportMemories, calls };
}

test('导出严格遵守上限，从非零偏移抵达末尾后不再提供重复偏移', async () => {
    const { exportMemories, calls } = createFixture(7);
    const first = await exportMemories(42, { pageSize: 2, maxRecords: 3 });
    assert.deepEqual(first.memories.map(item => item.id), [1, 2, 3]);
    assert.equal(first.complete, false);
    assert.equal(first.nextOffset, 3);
    assert.equal(first.startOffset, 0);
    assert.equal(first.consistency, 'best_effort');
    const middle = await exportMemories(42, { pageSize: 2, maxRecords: 3, offset: first.nextOffset });
    assert.deepEqual(middle.memories.map(item => item.id), [4, 5, 6]);
    assert.equal(middle.nextOffset, 6);
    const last = await exportMemories(42, { pageSize: 2, maxRecords: 3, offset: middle.nextOffset });
    assert.deepEqual(last.memories.map(item => item.id), [7]);
    assert.equal(last.complete, true);
    assert.equal(last.nextOffset, null);
    assert.ok(calls.every(call => call.userId === 42 && call.limit <= 2));
    const pastEnd = await exportMemories(42, { offset: 99 });
    assert.equal(pastEnd.complete, true);
    assert.equal(pastEnd.nextOffset, null);
});

test('总数变化、重复记录或非空总数却无进展时拒绝导出', async () => {
    for (const pages of [
        [{ total: 3, memories: [{ id: 1 }] }, { total: 4, memories: [{ id: 2 }] }],
        [{ total: 3, memories: [{ id: 1 }] }, { total: 3, memories: [{ id: 1 }] }],
        [{ total: 3, memories: [] }],
        [{ total: 0, memories: [{ id: 1 }] }]
    ]) {
        const exporter = createMemoryExporter({
            listMemories: async () => pages.shift(), getMemorySummary: async () => ({}), getTimestamp: () => ''
        });
        await assert.rejects(() => exporter(1, { pageSize: 1, maxRecords: 3 }), error => error.code === 'MEMORY_EXPORT_INCONSISTENT');
    }
});

test('导出拒绝负数、非整数和超出安全整数的偏移', async () => {
    const { exportMemories, calls } = createFixture(1);
    for (const offset of [-1, 1.5, '1x', Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(() => exportMemories(1, { offset }), error => error.code === 'MEMORY_EXPORT_OFFSET_INVALID' && error.statusCode === 400);
    }
    assert.equal(calls.length, 0);
});
