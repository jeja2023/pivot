'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInitialCandidates } = require('../server/services/rag-index/initial-candidates');

test('图谱失败不阻断词法召回，词法失败仍允许后续向量路径', async () => {
    const graphFailed = await loadInitialCandidates({ graph: async () => { throw new Error('图谱离线'); }, lexical: async () => [{ chunkId: 1 }], accessible: async () => true });
    assert.deepEqual(graphFailed.graphContext.chunkIds, []);
    assert.equal(graphFailed.lexicalCandidates.length, 1);
    assert.deepEqual(graphFailed.degradedPaths, ['graph']);
    const lexicalFailed = await loadInitialCandidates({ graph: async () => ({ chunkIds: [], context: '' }), lexical: async () => { throw new Error('词法离线'); }, accessible: async () => true });
    assert.deepEqual(lexicalFailed.degradedPaths, ['lexical']);
    await assert.rejects(loadInitialCandidates({ graph: async () => ({}), lexical: async () => [{ chunkId: 1 }], accessible: async () => { throw new Error('权限读取失败'); } }), /权限读取失败/);
});
