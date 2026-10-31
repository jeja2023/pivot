'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hydrateCandidateEmbeddings, retainAuthorizedDenseCandidates } = require('../server/services/rag-index/candidate-embeddings');

test('仅批量加载缺失的词法候选向量并保留排名与权限过滤结果', async () => {
    const dense = { id: 2, __entry: { vec: [1, 0] }, __denseRank: 0 };
    const candidates = [{ id: 1, __ftsRank: 0 }, dense, { id: 3, embedding: null }, { id: 4, __ftsRank: 1 }];
    let requested;
    const hydrated = await hydrateCandidateEmbeddings(candidates, async ids => {
        requested = ids;
        // 模拟第二次授权读取时 id=4 已不再可见。
        return [{ id: 1, embedding: '[1,0]' }];
    });
    assert.deepEqual(requested, [1, 4]);
    assert.deepEqual(hydrated[0], { id: 1, __ftsRank: 0, embedding: '[1,0]' });
    assert.equal(hydrated[1], dense);
    assert.equal(hydrated[2].embedding, null);
    assert.equal(hydrated.length, 3, '补取时权限已撤销的候选不能继续参与排序');
});

test('稠密候选二次授权后丢弃已撤权文档并保留有效向量', async () => {
    const candidates = [{ id: 1, __denseScore: 0.9 }, { id: 2, __denseScore: 0.8 }];
    const result = await retainAuthorizedDenseCandidates(candidates, async ids => {
        assert.deepEqual(ids, [1, 2]);
        return [{ id: 2, embedding: '[1,0]' }];
    }, (id, embedding) => ({ id, embedding }));
    assert.deepEqual(result, [{ id: 2, __denseScore: 0.8, __entry: { id: 2, embedding: '[1,0]' } }]);
});

test('候选已有向量时不会发起额外读取', async () => {
    const candidates = [{ id: 1, embedding: null }, { id: 2, __entry: {} }];
    const result = await hydrateCandidateEmbeddings(candidates, () => { throw new Error('不应读取'); });
    assert.equal(result, candidates);
});
