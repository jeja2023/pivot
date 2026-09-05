'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    aggregateEmbeddingLatencyBuckets,
    getRagOperationsOverview,
    persistEmbeddingLatencyMetric
} = require('../server/services/rag-operations-observability');

test('embedding latency buckets aggregate duration, failures and request volume deterministically', () => {
    const rows = [
        { bucket_at: '2026-09-05 09:00:00', request_count: 2, error_count: 0, input_count: 4, input_tokens: 120, total_duration_ms: 600, max_duration_ms: 400 },
        { bucket_at: '2026-09-05 09:03:00', request_count: 1, error_count: 1, input_count: 1, input_tokens: 40, total_duration_ms: 900, max_duration_ms: 900 }
    ];
    const trend = aggregateEmbeddingLatencyBuckets(rows, 5);
    assert.equal(trend.length, 1);
    assert.equal(trend[0].requestCount, 3);
    assert.equal(trend[0].errorCount, 1);
    assert.equal(trend[0].inputTokens, 160);
    assert.equal(trend[0].averageDurationMs, 500);
    assert.equal(trend[0].maxDurationMs, 900);
    assert.equal(trend[0].errorRate, 1 / 3);
});

test('embedding metric persistence uses a bounded minute bucket upsert without storing input text', async () => {
    const calls = [];
    await persistEmbeddingLatencyMetric({
        model: 'bge-m3',
        source: 'rag_index',
        status: 'success',
        durationMs: 123,
        inputs: ['不应写入指标表的原文'],
        now: Date.parse('2026-09-05T01:02:59Z')
    }, {
        execute: async (sql, params) => calls.push({ sql, params })
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /ON CONFLICT/);
    assert.equal(calls[0].params.includes('不应写入指标表的原文'), false);
    assert.equal(calls[0].params[1], 'bge-m3');
    assert.equal(calls[0].params[2], 'rag_index');
});

test('RAG operations overview combines persisted embedding buckets and diagnostic aggregates for admins', async () => {
    const overview = await getRagOperationsOverview({ minutes: 60, cacheMs: 0 }, {
        query: async () => [{ bucket_at: '2026-09-05 09:00:00', request_count: 2, error_count: 0, input_count: 2, input_tokens: 80, total_duration_ms: 400, max_duration_ms: 250 }],
        queryOne: async () => ({ query_count: 3, average_elapsed_ms: 55, max_elapsed_ms: 99, average_candidates: 12, average_matches: 4 })
    });
    assert.equal(overview.embedding.summary.requestCount, 2);
    assert.equal(overview.embedding.summary.averageDurationMs, 200);
    assert.equal(overview.diagnostics.queryCount, 3);
    assert.equal(overview.diagnostics.averageMatches, 4);
});
