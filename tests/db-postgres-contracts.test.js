const assert = require('node:assert/strict');
const test = require('node:test');

const dialect = require('../server/db/dialect');
const pgSchema = require('../server/db/schema/pg');
const { toPostgresParams } = require('../server/db/client');
const { normalizePgTimestamp } = require('../server/db/pg-connection');
const { parseJsonArray } = require('../server/services/long-term-memory/memory-utils');
const { serializeMemoryJob } = require('../server/services/long-term-memory/memory-serialization');
const { mapRagDebugRow } = require('../server/services/rag-debug-history');

test('PostgreSQL placeholder conversion skips quoted text and comments', () => {
    const sql = [
        `SELECT ?, '?', "?", $$?$$, $body$?$body$`,
        `FROM example -- ignored ?`,
        `WHERE value = ? /* outer ? /* nested ? */ still ignored ? */ AND note = E'escaped \\'? text'`
    ].join('\n');

    assert.strictEqual(
        toPostgresParams(sql),
        [
            `SELECT $1, '?', "?", $$?$$, $body$?$body$`,
            `FROM example -- ignored ?`,
            `WHERE value = $2 /* outer ? /* nested ? */ still ignored ? */ AND note = E'escaped \\'? text'`
        ].join('\n')
    );
});

test('dialect helpers produce valid PostgreSQL SQL expressions', () => {
    assert.strictEqual(dialect.nowExpr(), "now() AT TIME ZONE 'Asia/Shanghai'");
    assert.strictEqual(
        dialect.nowOffsetExpr('-180 days'),
        "((now() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '180 days')"
    );
    assert.strictEqual(dialect.jsonExtract('context_config', '$.model'), "pivot_json_extract(context_config::text, '{model}')");
    assert.strictEqual(
        dialect.jsonExtract('metadata', '$.workflow.steps[0].name'),
        "pivot_json_extract(metadata::text, '{workflow,steps,0,name}')"
    );
    assert.strictEqual(dialect.jsonValid('context_config'), 'TRUE');
    assert.strictEqual(dialect.orderNocase('t.tag'), 'lower(t.tag)');
    assert.strictEqual(dialect.likeOperator(), 'ILIKE');
    assert.strictEqual(
        dialect.fullTextMatch('messages_fts'),
        "to_tsvector('simple', messages_fts) @@ plainto_tsquery('simple', ?)"
    );
    assert.strictEqual(
        dialect.upsertConflict(['user_id', 'key'], ['value', 'updated_at']),
        'ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    );
});

test('PG type normalizers properly format timestamp values', () => {
    // Timestamp normalizer
    assert.strictEqual(normalizePgTimestamp(null), null);
    assert.strictEqual(normalizePgTimestamp(''), null);
    // Standard ISO string with timezone
    const normalizedIso = normalizePgTimestamp('2026-08-18T05:30:00.000Z');
    assert.ok(typeof normalizedIso === 'string');
    assert.match(normalizedIso, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // Plain date-time string
    const normalizedPlain = normalizePgTimestamp('2026-08-18 13:30:00');
    assert.strictEqual(normalizedPlain, '2026-08-18 13:30:00');

    // Date-only string
    const normalizedDate = normalizePgTimestamp('2026-08-18');
    assert.strictEqual(normalizedDate, '2026-08-18');
});

test('JSONB readers accept native node-postgres arrays and objects', () => {
    assert.deepEqual(parseJsonArray([101, 102]), [101, 102]);
    assert.deepEqual(parseJsonArray('[101, 102]'), [101, 102]);

    const job = serializeMemoryJob({
        id: 1,
        message_ids: [101, 102],
        result: { inserted: 2, extractor: 'heuristic' }
    });
    assert.deepEqual(job.messageIds, [101, 102]);
    assert.deepEqual(job.result, { inserted: 2, extractor: 'heuristic' });

    const debugRow = mapRagDebugRow({
        id: 2,
        scope_json: { collectionId: 3 },
        selected_chunk_ids: [7, 8],
        scores_json: [{ chunkId: 7, score: 0.9 }],
        queue_json: { pending: 1 }
    });
    assert.deepEqual(debugRow.scope, { collectionId: 3 });
    assert.deepEqual(debugRow.selectedChunkIds, [7, 8]);
    assert.deepEqual(debugRow.queue, { pending: 1 });
});

test('dynamic PostgreSQL schema generator produces complete 81-table DDL matching SQLite base schema', () => {
    const plan = pgSchema.buildPgSchemaStatements();
    assert.ok(plan);
    assert.strictEqual(plan.tables.length, 81, 'Generated PG schema must contain 81 CREATE TABLE statements');
    assert.ok(plan.indexes.length > 50, 'Generated PG schema must contain index statements');

    // Check regulation_documents columns do not contain deprecated dropped columns
    const regDocDdl = plan.tables.find(t => t.includes('regulation_documents'));
    assert.ok(regDocDdl, 'regulation_documents table DDL must exist');
    assert.strictEqual(regDocDdl.includes('effective_date_normalized'), false);
    assert.strictEqual(regDocDdl.includes('expire_date'), false);

    // 已迁移的生产表使用 pgvector；测试库的 DDL 也必须保持同一物理类型。
    for (const tableName of ['knowledge_chunks', 'memories', 'regulation_articles']) {
        const ddl = plan.tables.find(t => t.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`));
        assert.ok(ddl, `${tableName} table DDL must exist`);
        assert.match(ddl, /embedding\s+vector/i, `${tableName}.embedding must use pgvector`);
        assert.doesNotMatch(ddl, /embedding\s+TEXT/i, `${tableName}.embedding must not fall back to TEXT`);
    }

    const jsonbColumns = {
        agent_runs: ['context_config', 'metadata'],
        knowledge_entities: ['aliases'],
        memories: ['source_message_ids'],
        memory_extraction_jobs: ['message_ids', 'result'],
        rag_debug_queries: ['scope_json', 'selected_chunk_ids', 'scores_json', 'queue_json']
    };
    for (const [tableName, columns] of Object.entries(jsonbColumns)) {
        const ddl = plan.tables.find(t => t.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`));
        assert.ok(ddl, `${tableName} table DDL must exist`);
        for (const column of columns) {
            assert.match(ddl, new RegExp(`${column}\\s+JSONB`, 'i'), `${tableName}.${column} must use JSONB`);
        }
    }
    assert.match(
        plan.residualColumns.find(sql => sql.includes('analysis_datasets')) || '',
        /active_version.*BIGINT DEFAULT 1/i
    );

    // Check table and column comments
    assert.ok(Array.isArray(plan.comments), 'comments must be an array');
    assert.ok(plan.comments.length >= 79, 'Must generate comments for all 79 tables');
    assert.ok(plan.comments.some(c => c.includes('COMMENT ON TABLE "users"')), 'Must generate users table comment');
    assert.ok(plan.comments.some(c => c.includes('COMMENT ON COLUMN "messages"."content"')), 'Must generate messages.content column comment');
});

test('db-write-queue exports PostgreSQL write queue methods', async () => {
    const {
        enqueueAuditLog,
        enqueueApiCallLog,
        enqueueMcpCallLog,
        enqueueModelUsageEvent,
        flushAllWrites,
        flushWriteQueue,
        getQueueStatus
    } = require('../server/services/db-write-queue');
    assert.strictEqual(typeof enqueueAuditLog, 'function');
    assert.strictEqual(typeof enqueueApiCallLog, 'function');
    assert.strictEqual(typeof enqueueMcpCallLog, 'function');
    assert.strictEqual(typeof enqueueModelUsageEvent, 'function');
    assert.strictEqual(typeof flushAllWrites, 'function');
    assert.strictEqual(typeof flushWriteQueue, 'function');
    assert.strictEqual(typeof getQueueStatus, 'function');
});
