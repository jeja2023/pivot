'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemorySnapshotExporter } = require('../server/services/long-term-memory/memory-export-snapshot');

function createExporter({ total = 2, rows = [{ id: 2, updated_at: '2026-10-18T00:00:00Z' }, { id: 1, updated_at: '2026-10-17T00:00:00Z' }] } = {}) {
    const calls = [];
    const exporter = createMemorySnapshotExporter({
        transaction: async fn => await fn({
            query: async (sql, params) => { calls.push(['query', sql, params]); return rows; },
            queryOne: async (sql, params) => { calls.push(['queryOne', sql, params]); return { count: total }; }
        }),
        serializeMemory: row => ({ id: row.id, content: `memory-${row.id}` }),
        normalizeMemoryType: value => String(value),
        normalizeMemoryContent: value => String(value),
        memoryStatus: { active: 'active' },
        isLongTermMemoryEnabled: async () => true,
        getTimestamp: () => '2026-10-18 12:00:00'
    });
    return { exporter, calls };
}

test('一致性记忆导出在重复读只读事务中返回完整单次快照', async () => {
    const { exporter, calls } = createExporter();
    const result = await exporter(7, { status: 'all', type: 'fact', search: '项目', maxRecords: 10 });
    assert.equal(result.consistency, 'repeatable_read_snapshot');
    assert.equal(result.complete, true);
    assert.equal(result.total, 2);
    assert.deepEqual(result.memories.map(item => item.id), [2, 1]);
    assert.match(calls[0][1], /REPEATABLE READ READ ONLY/);
    assert.match(calls[1][1], /COUNT\(\*\)/);
    assert.match(calls[2][1], /FROM memories m/);
    assert.equal(calls[1][2][0], 7);
    assert.equal(calls[2][2][0], 7);
});

test('一致性记忆导出超过受控上限时拒绝而非返回截断备份', async () => {
    const { exporter } = createExporter({ total: 100001, rows: [] });
    await assert.rejects(() => exporter(7, { maxRecords: 100000 }), error => error.code === 'MEMORY_EXPORT_SNAPSHOT_TOO_LARGE' && error.statusCode === 413);
});

test('一致性记忆导出拒绝总数与快照行数不一致', async () => {
    const { exporter } = createExporter({ total: 3, rows: [{ id: 1 }] });
    await assert.rejects(() => exporter(7, {}), error => error.code === 'MEMORY_EXPORT_SNAPSHOT_UNAVAILABLE');
});
