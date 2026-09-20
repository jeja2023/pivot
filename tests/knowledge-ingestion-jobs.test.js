'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createKnowledgeIngestionQueue,
    createKnowledgeIngestionWorker,
    retryDelayMs
} = require('../server/services/knowledge-ingestion-jobs');
const {
    buildHnswIndexSql,
    indexNameForProfile,
    normalizeDimensions
} = require('../server/services/knowledge-vector-index');
const { buildPostgresTsQuery } = require('../server/services/rag-index');

function createQueueHarness() {
    const rows = [];
    let nextId = 1;
    const now = () => '2026-09-20 12:00:00';
    const queryOne = async (sql, params = []) => {
        if (/FROM knowledge_ingestion_jobs[\s\S]*status IN \('queued', 'running', 'retry_wait'\)/.test(sql)) {
            const [docId, jobType] = params;
            return rows.find(row => Number(row.doc_id) === Number(docId) && row.job_type === jobType && ['queued', 'running', 'retry_wait'].includes(row.status)) || null;
        }
        if (/INSERT INTO knowledge_ingestion_jobs/.test(sql)) {
            const row = {
                id: nextId++,
                doc_id: params[0],
                user_id: params[1],
                source_id: params[2],
                document_id: params[3],
                version_id: params[4],
                job_type: params[5],
                stage: 'queued',
                status: 'queued',
                priority: params[6],
                attempts: 0,
                max_attempts: params[7],
                idempotency_key: params[8],
                payload_json: params[9],
                created_at: params[10],
                updated_at: params[11],
                error_code: '',
                error_message: ''
            };
            rows.push(row);
            return row;
        }
        return null;
    };
    const query = async sql => {
        if (/GROUP BY status/.test(sql)) {
            return Object.entries(rows.reduce((out, row) => {
                out[row.status] = (out[row.status] || 0) + 1;
                return out;
            }, {})).map(([status, count]) => ({ status, count }));
        }
        return [];
    };
    const execute = async (sql, params = []) => {
        if (/SET status = 'running'/.test(sql)) {
            const row = rows.find(item => Number(item.id) === Number(params[3]));
            if (!row || !['queued', 'retry_wait'].includes(row.status)) return 0;
            row.status = 'running';
            row.stage = row.stage === 'queued' ? 'claimed' : row.stage;
            row.attempts += 1;
            return 1;
        }
        if (/SET stage = \?/.test(sql) && /status = 'running'/.test(sql)) {
            const row = rows.find(item => Number(item.id) === Number(params[2]));
            if (!row || row.status !== 'running') return 0;
            row.stage = params[0];
            return 1;
        }
        if (/SET status = 'completed'/.test(sql)) {
            const row = rows.find(item => Number(item.id) === Number(params[4]));
            if (!row || row.status !== 'running') return 0;
            row.status = 'completed';
            row.stage = params[0];
            return 1;
        }
        if (/SET status = \?, stage = \?, next_retry_at/.test(sql)) {
            const row = rows.find(item => Number(item.id) === Number(params[6]));
            if (!row || row.status !== 'running') return 0;
            row.status = params[0];
            row.stage = params[1];
            row.next_retry_at = params[2];
            return 1;
        }
        return 0;
    };
    const transaction = async fn => fn({
        query: async () => rows.filter(row => ['queued', 'retry_wait'].includes(row.status)).slice(0, 1),
        queryOne: async () => rows.find(row => ['queued', 'retry_wait'].includes(row.status)) || null,
        execute
    });
    return { rows, queue: createKnowledgeIngestionQueue({ queryOne, query, execute, transaction, now, randomUUID: () => 'job-key' }) };
}

test('知识库持久化索引任务对重复入队保持幂等，并按状态返回队列概览', async () => {
    const { queue } = createQueueHarness();
    const first = await queue.enqueue({ docId: 11, userId: 7, payload: { source: 'upload' } });
    const duplicate = await queue.enqueue({ docId: 11, userId: 7 });
    assert.equal(first.started, true);
    assert.equal(first.job.payload.source, 'upload');
    assert.equal(duplicate.started, false);
    assert.equal(duplicate.reason, 'already_processing');
    assert.deepEqual(await queue.getStatus(7), {
        active: 1,
        running: 0,
        pending: 1,
        retryWaiting: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        statuses: { queued: 1 }
    });
});

test('知识库持久化 Worker 声明、执行并完成任务', async () => {
    const { queue, rows } = createQueueHarness();
    await queue.enqueue({ docId: 12, userId: 7 });
    const worker = createKnowledgeIngestionWorker({
        queue,
        processJob: async job => ({ docId: job.docId, stage: 'published' }),
        pollIntervalMs: 60_000,
        setIntervalFn: () => ({ unref() {} }),
        clearIntervalFn: () => {}
    });
    await worker.start();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    worker.stop();
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[0].stage, 'published');
});

test('知识库 Worker 在长任务期间持续刷新租约，停止后清理心跳', async () => {
    let renewals = 0;
    let cleared = 0;
    let claimed = false;
    const timers = [];
    const queue = {
        recoverExpiredLeases: async () => ({}),
        claimNext: async () => {
            if (claimed) return null;
            claimed = true;
            return { id: 9, docId: 9, userId: 7 };
        },
        updateStage: async () => true,
        complete: async () => true,
        fail: async () => ({}),
        renewLease: async () => { renewals += 1; return true; }
    };
    const worker = createKnowledgeIngestionWorker({
        queue,
        leaseSeconds: 15,
        pollIntervalMs: 60_000,
        processJob: async () => {
            await timers[1].callback();
            return { stage: 'published' };
        },
        logger: { warn() {} },
        setIntervalFn: callback => {
            const timer = { callback, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearIntervalFn: () => { cleared += 1; }
    });
    await worker.start();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    worker.stop();
    assert.equal(renewals, 1);
    assert.ok(cleared >= 2, '任务完成和 Worker 停止均应释放 timer');
});

test('知识库任务退避、HNSW 建索引和 PostgreSQL FTS 词元均有安全边界', () => {
    assert.equal(retryDelayMs(1), 1000);
    assert.equal(retryDelayMs(20), 15 * 60 * 1000);
    assert.equal(normalizeDimensions(1024), 1024);
    assert.equal(normalizeDimensions(4096), null);
    const hnswSql = buildHnswIndexSql(1024, 'lan:bge-m3-1024-v1');
    assert.match(hnswSql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/i);
    assert.match(hnswSql, /USING hnsw/i);
    assert.match(hnswSql, /embedding_dimensions = 1024/);
    assert.match(hnswSql, /embedding_profile = 'lan:bge-m3-1024-v1'/);
    assert.match(indexNameForProfile(1024, 'lan:bge-m3-1024-v1'), /_\w{12}$/);
    assert.equal(buildPostgresTsQuery(['采购', "x' OR true", 'P-2026/01']), "'采购' | 'xORtrue' | 'P202601'");
});
