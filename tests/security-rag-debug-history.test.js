const assert = require('node:assert/strict');
const test = require('node:test');

const { db } = require('../server/db');
const {
    listRagDebugQueries,
    recordRagDebugQuery
} = require('../server/services/rag-debug-history');

test('RAG debug history records query diagnostics for the current user', () => {
    const username = `rag-debug-${Date.now()}`;
    const userId = db.prepare(`
        INSERT INTO users (username, password_hash, role, status)
        VALUES (?, 'hash', 'user', 'active')
    `).run(username).lastInsertRowid;

    const row = recordRagDebugQuery({
        userId,
        query: 'How does Pivot retrieve knowledge?',
        scope: { collectionId: 7, tag: 'ops' },
        topK: 3,
        candidateLimit: 20,
        scoreThreshold: 0.42,
        queue: { running: 1, pending: 2, maxConcurrent: 3 },
        elapsedMs: 123,
        result: {
            candidateCount: 9,
            threshold: 0.42,
            matches: [
                { chunkId: 11, source: 'doc-a', score: 0.9, matched: true, selected: true, scores: { fused: 0.8 } },
                { chunkId: 12, source: 'doc-b', score: 0.3, matched: false, selected: false }
            ]
        }
    });
    assert.ok(row.id);

    const history = listRagDebugQueries(userId, { limit: 5 });
    assert.equal(history.length, 1);
    assert.equal(history[0].matchedCount, 1);
    assert.equal(history[0].candidateCount, 9);
    assert.deepEqual(history[0].selectedChunkIds, [11]);
    assert.equal(history[0].scores[0].source, 'doc-a');
    assert.equal(history[0].queue.pending, 2);
});
