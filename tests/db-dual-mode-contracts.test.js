const assert = require('node:assert/strict');
const test = require('node:test');

// 1. Dialect Helper Contract Tests
const dialect = require('../server/db/dialect');
const pgSchema = require('../server/db/schema/pg');
const { normalizePgTimestamp } = require('../server/db/pg-connection');

test('dialect helpers produce valid SQLite SQL expressions', () => {
    // nowExpr
    assert.strictEqual(dialect.nowExpr(), "datetime('now', '+8 hours')");

    // nowOffsetExpr
    assert.strictEqual(dialect.nowOffsetExpr('-180 days'), "datetime('now', '+8 hours', '-180 days')");

    // jsonExtract
    assert.strictEqual(dialect.jsonExtract('context_config', '$.model'), "json_extract(context_config, '$.model')");

    // jsonValid
    assert.strictEqual(dialect.jsonValid('context_config'), "json_valid(context_config)");

    // orderNocase
    assert.strictEqual(dialect.orderNocase('t.tag'), 't.tag COLLATE NOCASE');

    // likeOperator
    assert.strictEqual(dialect.likeOperator(), 'LIKE');

    // fullTextMatch
    assert.strictEqual(dialect.fullTextMatch('messages_fts'), 'messages_fts MATCH ?');

    // upsertConflict
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

test('dynamic PostgreSQL schema generator produces complete 79-table DDL matching SQLite base schema', () => {
    const plan = pgSchema.buildPgSchemaStatements();
    assert.ok(plan);
    assert.strictEqual(plan.tables.length, 79, 'Generated PG schema must contain 79 CREATE TABLE statements');
    assert.ok(plan.indexes.length > 50, 'Generated PG schema must contain index statements');

    // Check regulation_documents columns do not contain deprecated dropped columns
    const regDocDdl = plan.tables.find(t => t.includes('regulation_documents'));
    assert.ok(regDocDdl, 'regulation_documents table DDL must exist');
    assert.strictEqual(regDocDdl.includes('effective_date_normalized'), false);
    assert.strictEqual(regDocDdl.includes('expire_date'), false);

    // Check table and column comments
    assert.ok(Array.isArray(plan.comments), 'comments must be an array');
    assert.ok(plan.comments.length >= 79, 'Must generate comments for all 79 tables');
    assert.ok(plan.comments.some(c => c.includes('COMMENT ON TABLE "users"')), 'Must generate users table comment');
    assert.ok(plan.comments.some(c => c.includes('COMMENT ON COLUMN "messages"."content"')), 'Must generate messages.content column comment');
});

test('db-write-queue exports correct dual-mode write queue methods', async () => {
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
