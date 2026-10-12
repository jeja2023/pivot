'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const [migration] = require('../server/db/migrations/knowledge-derived-quality');

async function migrationSql() {
    let sql;
    await migration.upPg({ query: async value => { sql = value; } });
    return sql;
}

function aliasParserSql(sql) {
    return sql.slice(0, sql.indexOf('CREATE TABLE IF NOT EXISTS knowledge_entity_aliases'));
}

function aliasBackfillSql(sql) {
    const start = sql.lastIndexOf('INSERT INTO knowledge_entity_aliases');
    const end = sql.indexOf('DROP FUNCTION IF EXISTS', start);
    return sql.slice(start, end);
}

test('别名回填安全处理历史 TEXT / JSONB、空值、非数组与无效 JSON', async () => {
    const sql = await migrationSql();
    assert.match(sql, /CREATE OR REPLACE FUNCTION pg_temp\.pivot_knowledge_aliases_to_jsonb\(input TEXT\)/);
    assert.match(sql, /parsed := input::jsonb/);
    assert.match(sql, /EXCEPTION WHEN invalid_text_representation/);
    assert.match(sql, /jsonb_typeof\(parsed\) <> 'array'/);
    assert.match(sql, /pivot_knowledge_aliases_to_jsonb\(entity\.aliases::text\)/);
    assert.match(sql, /DROP FUNCTION IF EXISTS pg_temp\.pivot_knowledge_aliases_to_jsonb\(TEXT\)/);
});

test('PostgreSQL 别名回填兼容 TEXT / JSONB 且重复执行不增加记录', {
    skip: process.env.PIVOT_TEST_PG_SYNC !== 'true'
}, async () => {
    const { getPgPool, closePgPool } = require('../server/db/pg-connection');
    const client = await getPgPool().connect();
    try {
        await client.query('BEGIN');
        await client.query(`
            CREATE TEMP TABLE knowledge_entities (
                id BIGINT, user_id BIGINT, aliases TEXT, confidence DOUBLE PRECISION,
                created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
                deleted_at TIMESTAMPTZ
            );
            CREATE TEMP TABLE knowledge_entity_aliases (
                user_id BIGINT, entity_id BIGINT, alias TEXT, normalized_alias TEXT,
                source_kind TEXT, confidence DOUBLE PRECISION,
                created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
                UNIQUE(user_id, normalized_alias)
            );
            INSERT INTO knowledge_entities (id, user_id, aliases, confidence, deleted_at) VALUES
                (1, 1, '["销售平台", " Sales Platform ", "销售平台", " "]', 0.8, NULL),
                (2, 1, NULL, 0.7, NULL),
                (3, 1, '[]', 0.7, NULL),
                (4, 1, '', 0.7, NULL),
                (5, 1, '  ', 0.7, NULL),
                (6, 1, '["已删除"]', 0.7, NOW()),
                (7, 1, 'not-json', 0.7, NULL),
                (8, 1, '"不是数组"', 0.7, NULL);
        `);
        const sql = await migrationSql();
        await client.query(aliasParserSql(sql));
        const backfillSql = aliasBackfillSql(sql);
        for (const type of ['text', 'jsonb']) {
            if (type === 'jsonb') {
                await client.query(`ALTER TABLE knowledge_entities ALTER COLUMN aliases TYPE JSONB
                    USING NULLIF(btrim(aliases), '')::jsonb`);
            }
            await client.query('TRUNCATE knowledge_entity_aliases');
            await client.query(backfillSql);
            await client.query(backfillSql);
            const { rows } = await client.query(`
                SELECT entity_id, alias, normalized_alias FROM knowledge_entity_aliases ORDER BY normalized_alias
            `);
            assert.deepEqual(rows, [
                { entity_id: 1, alias: 'Sales Platform', normalized_alias: 'salesplatform' },
                { entity_id: 1, alias: '销售平台', normalized_alias: '销售平台' }
            ], type);
            // 非法 JSON 和合法但非数组的 JSON 仅在 TEXT 历史库中可能存在；
            // 将其归零后再验证当前 JSONB 模式。
            if (type === 'text') {
                await client.query("UPDATE knowledge_entities SET aliases = '[]' WHERE id IN (7, 8)");
            }
        }
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        await closePgPool();
    }
});
