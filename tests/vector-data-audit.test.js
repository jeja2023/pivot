'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('pg');
const { TARGETS, auditVectorData, classifyVector, normalizeCursor } = require('../scripts/audit_vector_data');

test('向量检查区分元数据异常、数值越界和非 JSON 形状', () => {
    assert.equal(normalizeCursor('0009007199254740993'), '9007199254740993');
    assert.throws(() => normalizeCursor('9223372036854775808'));
    const valid = classifyVector({ vector_text: '[1,2]', declared_dimensions: '0', profile: '' }, TARGETS.knowledge);
    assert.equal(valid.kind, 'valid_json_vector');
    assert.equal(valid.legacyDimensions, true);
    assert.equal(valid.missingProfile, true);
    assert.equal(classifyVector({ vector_text: '[1e9999]' }, TARGETS.memory).kind, 'invalid_number');
    const malformed = classifyVector({ vector_text: '[+1]', declared_dimensions: 0, profile: '' }, TARGETS.knowledge);
    assert.equal(malformed.legacyDimensions, true);
    assert.equal(malformed.missingProfile, true);
    assert.equal(classifyVector({ vector_text: '[+1]' }, TARGETS.regulations).kind, 'not_json_array');
    assert.equal(classifyVector({ vector_text: '[0,0]' }, TARGETS.regulations).zeroVector, true);
    assert.equal(classifyVector({ vector_text: null }, TARGETS.memory).kind, 'oversized');
});

test('历史向量检查只读、按 bigint 游标分页且不输出向量或配置值', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const schema = `pivot_vector_audit_${process.pid}_${Date.now().toString(36)}`;
    assert.match(schema, /^[a-z0-9_]+$/);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    let created = false;
    try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        created = true;
        await client.query(`CREATE TABLE "${schema}".knowledge_chunks (id bigint PRIMARY KEY, embedding text, embedding_dimensions bigint, embedding_profile text)`);
        await client.query(`INSERT INTO "${schema}".knowledge_chunks VALUES
            (9007199254740993, '[1,2]', 0, ''),
            (9007199254740994, '[1e9999,0]', 2, 'secret-profile-marker'),
            (9007199254740995, '[3,4]', 3, 'profile'),
            (9007199254740996, repeat('9', 65537), 1, 'profile'),
            (9007199254740997, '[+1]', 1, 'profile')`);
        let readOnlyVerified = false;
        const wrapped = { async query(sql, params) {
            if (sql.startsWith('SELECT source.id::text')) {
                const state = await client.query('SHOW transaction_read_only');
                assert.equal(state.rows[0].transaction_read_only, 'on');
                readOnlyVerified = true;
            }
            return await client.query(sql, params);
        } };
        const first = await auditVectorData({ client: wrapped, schema, targetName: 'knowledge', limit: 2 });
        assert.equal(readOnlyVerified, true);
        assert.equal(first.scanned, 2);
        assert.equal(first.nextCursor, '9007199254740994');
        assert.equal(first.legacyDimensions, 1);
        assert.equal(first.missingProfile, 1);
        assert.equal(first.invalidNumber, 1);
        assert.doesNotMatch(JSON.stringify(first), /secret-profile-marker|\[1,2\]/);
        const second = await auditVectorData({ client: wrapped, schema, targetName: 'knowledge', after: first.nextCursor, limit: 10 });
        assert.equal(second.scanned, 3);
        assert.equal(second.dimensionsMismatch, 1);
        assert.equal(second.oversized, 1);
        assert.equal(second.notJsonArray, 1);
        assert.equal(second.nextCursor, null);
        await client.query(`TRUNCATE TABLE "${schema}".knowledge_chunks`);
        await client.query(`INSERT INTO "${schema}".knowledge_chunks SELECT n, '[1,2]', 2, 'profile' FROM generate_series(1,250) n`);
        const multiPage = await auditVectorData({ client: wrapped, schema, targetName: 'knowledge', limit: 200 });
        assert.equal(multiPage.scanned, 200);
        assert.equal(multiPage.nextCursor, '200');
        const remainder = await auditVectorData({ client: wrapped, schema, targetName: 'knowledge', after: multiPage.nextCursor, limit: 200 });
        assert.equal(remainder.scanned, 50);
        assert.equal(remainder.nextCursor, null);
        await assert.rejects(auditVectorData({ client: wrapped, schema, targetName: 'toString' }), /检查目标/);
        await assert.rejects(auditVectorData({ client: wrapped, schema: 'public";DROP SCHEMA public', targetName: 'knowledge' }), /schema/);
    } finally {
        if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        await client.end();
    }
});

test('只读检查兼容迁移后的知识、记忆和法规实际表结构', { skip: !/^pivot_test_[a-z0-9_]+$/.test(process.env.PG_TEST_SCHEMA || '') }, async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        for (const targetName of ['knowledge', 'memory', 'regulations']) {
            const result = await auditVectorData({ client, schema: process.env.PG_TEST_SCHEMA, targetName, limit: 10 });
            assert.equal(result.target, targetName);
            assert.ok(Number.isInteger(result.scanned));
        }
    } finally { await client.end(); }
});
