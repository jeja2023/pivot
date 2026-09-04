const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assertEmbeddingResponseOk,
    normalizeEmbeddingVectors
} = require('../server/services/rag-index/embedding-client');

test('DashScope 原生 embeddings 响应可被解析为按 text_index 排序的向量', () => {
    const vectors = normalizeEmbeddingVectors({
        output: {
            embeddings: [
                { text_index: 1, embedding: [3, 4] },
                { text_index: 0, embedding: [1, 2] }
            ]
        }
    });
    assert.deepEqual(vectors, [[1, 2], [3, 4]]);
});

test('Embedding 上游 HTTP 错误保留状态与错误码，而非伪装成向量格式错误', () => {
    assert.throws(
        () => assertEmbeddingResponseOk({
            status: 400,
            data: { error: { code: 'Arrearage', message: 'Access denied because the account is in arrears.' } }
        }),
        error => error.code === 'EMBEDDING_UPSTREAM_Arrearage'
            && error.status === 400
            && /HTTP 400/.test(error.message)
            && /Arrearage/.test(error.message)
    );
});
