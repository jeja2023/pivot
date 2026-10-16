const assert = require('node:assert/strict');
const test = require('node:test');
const {
    applyRerankResults,
    buildRerankPayload,
    clearRerankCircuit,
    normalizeRerankResults,
    rerankCandidates,
    resolveRerankUrl,
    testRerankConnection
} = require('../server/services/rerank-client');

const config = {
    enabled: true,
    http: {
        url: 'http://reranker.internal:8081',
        apiKey: 'test-key',
        model: 'BAAI/bge-reranker-v2-m3',
        candidateLimit: 3,
        timeoutMs: 1800
    }
};

test('外部重排序遵循返回索引重排有限候选并保留其余候选', async () => {
    clearRerankCircuit(config);
    const calls = [];
    const result = await rerankCandidates('劳动合同试用期', [
        { chunkId: 1, text: '候选甲' },
        { chunkId: 2, text: '候选乙' },
        { chunkId: 3, text: '候选丙' },
        { chunkId: 4, text: '候选四' }
    ], {
        config,
        source: 'test',
        request: async (url, body, options) => {
            calls.push({ url, body, options });
            return { data: [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }, { index: 2, score: 0.4 }] };
        }
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.candidates.map(item => item.chunkId), [2, 3, 1, 4]);
    assert.equal(result.candidates[0].externalRerankScore, 0.9);
    assert.equal(calls[0].url, 'http://reranker.internal:8081/rerank');
    assert.equal(calls[0].body.texts.length, 3);
    assert.equal(calls[0].options.timeout, 1800);
});

test('重排序服务失败会熔断并保持原有排序，不会阻断检索', async () => {
    const priorThreshold = process.env.RERANK_CIRCUIT_FAILURE_THRESHOLD;
    try {
        process.env.RERANK_CIRCUIT_FAILURE_THRESHOLD = '1';
        clearRerankCircuit(config);
        const candidates = [{ chunkId: 1, text: '原排序甲' }, { chunkId: 2, text: '原排序乙' }];
        const failed = await rerankCandidates('问题', candidates, {
            config,
            request: async () => { throw new Error('服务暂不可用'); }
        });
        assert.equal(failed.applied, false);
        assert.equal(failed.reason, 'request_failed');
        assert.deepEqual(failed.candidates.map(item => item.chunkId), [1, 2]);
        const skipped = await rerankCandidates('问题', candidates, {
            config,
            request: async () => { throw new Error('不应再被调用'); }
        });
        assert.equal(skipped.reason, 'circuit_open');
        assert.deepEqual(skipped.candidates.map(item => item.chunkId), [1, 2]);
    } finally {
        process.env.RERANK_CIRCUIT_FAILURE_THRESHOLD = priorThreshold;
        clearRerankCircuit(config);
    }
});

test('TEI 路由与原始分数归一化兼容', () => {
    assert.equal(resolveRerankUrl('http://host:8081/v1'), 'http://host:8081/rerank');
    assert.equal(resolveRerankUrl('http://host:8081/rerank'), 'http://host:8081/rerank');
    assert.deepEqual(normalizeRerankResults({ results: [{ index: 1, score: 2 }, { index: 0, score: -2 }] }), [
        { index: 1, score: 1 / (1 + Math.exp(-2)) },
        { index: 0, score: 1 / (1 + Math.exp(2)) }
    ]);
    assert.deepEqual(applyRerankResults([{ id: 'a' }, { id: 'b' }], [{ index: 1, score: 0.8 }]).map(item => item.id), ['b', 'a']);
    assert.deepEqual(buildRerankPayload('问题', ['甲'], config), {
        query: '问题', model: 'BAAI/bge-reranker-v2-m3', texts: ['甲'], raw_scores: false
    });
    assert.deepEqual(buildRerankPayload('问题', ['甲'], { ...config, http: { ...config.http, protocol: 'llama_cpp' } }), {
        query: '问题', model: 'BAAI/bge-reranker-v2-m3', documents: ['甲'], top_n: 1
    });
});

test('外部重排序低分不会清零明确词面命中的法规片段', () => {
    const ranked = applyRerankResults([
        { chunkId: 1, text: '盗窃公私财物', phraseMatch: 1, ftsRank: 15, rerankScore: 0.8 }
    ], [{ index: 0, score: 0.01 }]);
    assert.equal(ranked[0].externalRerankScore, 0.01);
    assert.ok(ranked[0].rerankScore >= 0.55);
});

test('重排序连接测试将可配置服务转换为受限测试候选', async () => {
    const result = await testRerankConnection({ apiUrl: '' });
    assert.deepEqual(result, { success: false, error: '请填写重排序服务地址。' });
});
