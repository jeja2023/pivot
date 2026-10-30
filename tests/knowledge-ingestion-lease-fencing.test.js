'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { createKnowledgeIngestionQueue } = require('../server/services/knowledge-ingestion-jobs');
const { createKnowledgeIndexStage, swapKnowledgeIndexStage, discardKnowledgeIndexStage } = require('../server/services/rag-index-staging');
const { markKnowledgeDocumentError, markKnowledgeDocumentRebuildError } = require('../server/repositories/knowledge-index-status');

test('知识库索引租约被重新领取后，旧执行不能覆盖新任务状态和索引', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const user = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`index_lease_${suffix}`, 'hash']);
    const doc = await queryOne("INSERT INTO knowledge_docs (user_id, name, status) VALUES (?, ?, 'processing') RETURNING *", [user.id, `lease-${suffix}.txt`]);
    const queue = createKnowledgeIngestionQueue();
    let stage;
    try {
        await execute('INSERT INTO knowledge_chunks (doc_id, content) VALUES (?, ?)', [doc.id, '旧索引']);
        await queue.enqueue({ docId: doc.id, userId: user.id });
        const first = await queue.claimNext({ workerId: `lease-test-${suffix}` });
        assert.ok(first);
        await execute("UPDATE knowledge_ingestion_jobs SET locked_at = (NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '10 minutes' WHERE id = ?", [first.id]);
        assert.equal((await queue.recoverExpiredLeases({ leaseSeconds: 15 })).requeued, 1);
        await execute("UPDATE knowledge_ingestion_jobs SET next_retry_at = (NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '1 minute' WHERE id = ?", [first.id]);
        const second = await queue.claimNext({ workerId: `lease-test-${suffix}` });
        assert.equal(second.id, first.id);
        assert.equal(second.attempts, first.attempts + 1);
        const lease = job => ({ workerId: job.locked_by, attempts: job.attempts });
        assert.equal(await queue.renewLease(first.id, first.locked_by, first.attempts), false);
        assert.equal(await queue.updateStage(first.id, 'stale', lease(first)), false);
        assert.equal(await queue.complete(first.id, { ...lease(first) }), false);
        assert.equal((await queue.fail(first, new Error('旧任务失败'))).status, 'unchanged');
        const staleLease = { jobId: first.id, ...lease(first) };
        await assert.rejects(markKnowledgeDocumentError({ docId: doc.id, userId: user.id, error: '旧任务失败', lease: staleLease }), error => error.code === 'KNOWLEDGE_JOB_LEASE_LOST');
        await assert.rejects(markKnowledgeDocumentRebuildError({ docId: doc.id, userId: user.id, error: '旧任务失败', lease: staleLease }), error => error.code === 'KNOWLEDGE_JOB_LEASE_LOST');
        assert.equal((await queryOne('SELECT status FROM knowledge_docs WHERE id = ?', [doc.id])).status, 'processing');
        stage = await createKnowledgeIndexStage({ doc, userId: user.id });
        await execute('INSERT INTO knowledge_chunks (doc_id, content) VALUES (?, ?)', [stage.id, '新索引']);
        await assert.rejects(swapKnowledgeIndexStage({ docId: doc.id, stageId: stage.id, userId: user.id, chunkCount: 1, lease: { jobId: first.id, ...lease(first) } }), error => error.code === 'KNOWLEDGE_JOB_LEASE_LOST');
        assert.equal((await queryOne('SELECT content FROM knowledge_chunks WHERE doc_id = ?', [doc.id])).content, '旧索引');
        assert.equal(await queue.updateStage(second.id, 'indexing', lease(second)), true);
        assert.equal(await markKnowledgeDocumentRebuildError({ docId: doc.id, userId: user.id, error: '测试异常', lease: { jobId: second.id, ...lease(second) } }), true);
        await swapKnowledgeIndexStage({ docId: doc.id, stageId: stage.id, userId: user.id, chunkCount: 1, lease: { jobId: second.id, ...lease(second) } });
        assert.equal((await queryOne('SELECT content FROM knowledge_chunks WHERE doc_id = ?', [doc.id])).content, '新索引');
        stage = null;
        assert.equal(await queue.complete(second.id, { ...lease(second) }), true);
    } finally {
        if (stage?.id) await discardKnowledgeIndexStage(stage.id);
        await execute('DELETE FROM knowledge_ingestion_jobs WHERE doc_id = ?', [doc.id]);
        await execute('DELETE FROM knowledge_docs WHERE id = ?', [doc.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});
