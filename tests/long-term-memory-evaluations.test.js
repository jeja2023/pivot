const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    compareMemoryRetrievalShadow,
    evaluateMemoryRetrievalCase,
    summarizeMemoryEvaluation
} = require('../server/services/long-term-memory/memory-evaluations');
const { buildMemoryHnswIndexSql, normalizeDimensions } = require('../server/services/long-term-memory/memory-vector-index');

test('长期记忆评测集至少包含 100 条脱敏多轮场景并覆盖强制风险类别', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'docs', 'agent-experience', 'long-term-memory-evaluation-cases.json'), 'utf8');
    const dataset = JSON.parse(source);
    assert.ok(Array.isArray(dataset.cases));
    assert.ok(dataset.cases.length >= 100);
    const categories = new Set(dataset.cases.map(item => item.category));
    for (const category of ['preference', 'fact', 'temporary', 'correction', 'conflict', 'no_memory', 'sensitive', 'source_revoke', 'injection', 'scope']) {
        assert.ok(categories.has(category), `missing ${category}`);
    }
    assert.ok(dataset.cases.every(item => Array.isArray(item.turns) && item.turns.length >= 2));
});

test('长期记忆评测按召回、无关注入和禁止命中计算，并支持影子对比', () => {
    const evaluationCase = { id: 'ME-001', category: 'fact', expectedMemoryIds: [9], forbiddenMemoryIds: [8] };
    const legacy = evaluateMemoryRetrievalCase(evaluationCase, [8, 1]);
    const candidate = evaluateMemoryRetrievalCase(evaluationCase, [9, 1]);
    const summary = summarizeMemoryEvaluation([
        { ...legacy, retrievalLatencyMs: 12, estimatedInjectedTokens: 80 },
        { ...candidate, retrievalLatencyMs: 28, estimatedInjectedTokens: 120 }
    ]);
    const shadow = compareMemoryRetrievalShadow(evaluationCase, [8, 1], [9, 1]);
    assert.equal(legacy.passed, false);
    assert.equal(candidate.passed, true);
    assert.equal(summary.forbiddenHitRate, 0.5);
    assert.equal(summary.retrievalLatencyMs.p50, 12);
    assert.equal(summary.retrievalLatencyMs.p95, 28);
    assert.equal(summary.estimatedInjectedTokens, 200);
    assert.equal(shadow.improved, true);
    assert.equal(shadow.forbiddenRegression, false);
});

test('长期记忆向量索引只接受受支持维度并按 active 记录建立局部索引', () => {
    assert.equal(normalizeDimensions(768), 768);
    assert.equal(normalizeDimensions(2001), null);
    assert.match(buildMemoryHnswIndexSql(768), /idx_memories_embedding_hnsw_768/);
    assert.match(buildMemoryHnswIndexSql(768), /embedding_dimensions = 768/);
    assert.match(buildMemoryHnswIndexSql(768), /status = 'active'/);
});
