const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isPersistedDagOutputPartial,
    persistDagOutput,
    resolvePersistedDagOutput
} = require('../server/services/agent-dag-output');

test('超大 DAG 输出在没有受控存储上下文时保持不可复用的预览标记', async () => {
    const source = { structuredContent: { rows: [{ id: 1, text: '甲'.repeat(8_100_000) }] } };
    const persisted = await persistDagOutput(source, { user: {} });
    assert.equal(isPersistedDagOutputPartial(persisted.value), true);
    assert.equal(persisted.complete, false);
    assert.equal(persisted.outputRef, null);
    assert.ok(String(persisted.fullSerialized || '').length > String(persisted.serialized || '').length);

    const resolved = await resolvePersistedDagOutput(persisted.value, { user: {} });
    assert.equal(resolved.complete, false);
    assert.equal(resolved.source, 'preview');
});

test('完整的 DAG 输出不引入额外产物引用', async () => {
    const source = { text: '正常结果', rows: [{ id: 1 }] };
    const persisted = await persistDagOutput(source, { user: {} });
    assert.equal(persisted.complete, true);
    assert.equal(persisted.outputRef, null);
    assert.deepEqual(persisted.value, source);

    const resolved = await resolvePersistedDagOutput(persisted.value, { user: {} });
    assert.equal(resolved.complete, true);
    assert.equal(resolved.source, 'inline');
    assert.deepEqual(resolved.value, source);
});
