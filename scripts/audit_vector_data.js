'use strict';

// 只读检查历史向量元数据，不输出向量、文本、账号或连接信息。
const { Client } = require('pg');

const TARGETS = Object.freeze({
    knowledge: { table: 'knowledge_chunks', dimensions: 'embedding_dimensions', profile: 'embedding_profile' },
    memory: { table: 'memories', dimensions: 'embedding_dimensions', profile: null },
    regulations: { table: 'regulation_articles', dimensions: null, profile: 'embedding_profile' }
});
const MAX_ID = 9223372036854775807n;
const MAX_TEXT_BYTES = 64 * 1024;
const BATCH_SIZE = 100;

function normalizeCursor(value = '0') {
    const text = String(value);
    if (!/^\d{1,19}$/.test(text)) throw new Error('起始游标必须是非负 PostgreSQL bigint。');
    const id = BigInt(text);
    if (id > MAX_ID) throw new Error('起始游标超过 PostgreSQL bigint 范围。');
    return id.toString();
}

function classifyVector(row, target) {
    const declared = target.dimensions ? Number(row.declared_dimensions) : null;
    const metadata = {
        legacyDimensions: target.dimensions ? declared === 0 || row.declared_dimensions === null : false,
        dimensionsMismatch: target.dimensions ? !Number.isSafeInteger(declared) || declared < 0 : false,
        missingProfile: target.profile ? !String(row.profile || '').trim() : false
    };
    if (row.vector_text === null) return { kind: 'oversized', ...metadata };
    let values;
    try { values = JSON.parse(row.vector_text); } catch (_) { return { kind: 'not_json_array', ...metadata }; }
    if (!Array.isArray(values)) return { kind: 'not_json_array', ...metadata };
    if (values.length < 1 || values.length > 16000) return { kind: 'invalid_length', ...metadata };
    if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) {
        return { kind: 'invalid_number', ...metadata };
    }
    return {
        kind: 'valid_json_vector',
        dimensions: values.length,
        ...metadata,
        dimensionsMismatch: metadata.dimensionsMismatch || Boolean(target.dimensions && declared !== 0 && declared !== values.length),
        zeroVector: values.every(value => Math.fround(value) === 0),
        exceedsHnswDimensions: values.length > 2000
    };
}

async function auditVectorData({ client, schema, targetName, after = '0', limit = 2000, maxDurationMs = 30000 }) {
    if (!client || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(String(schema || ''))) throw new Error('必须提供有效的数据库 schema。');
    if (!Object.hasOwn(TARGETS, targetName)) throw new Error('检查目标必须是 knowledge、memory 或 regulations。');
    const target = TARGETS[targetName];
    let cursor = normalizeCursor(after);
    const requestedLimit = Number(limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 20000) throw new Error('检查条数必须在 1 至 20000 之间。');
    const duration = Math.min(30000, Math.max(1000, Number(maxDurationMs) || 30000));
    const counts = { scanned: 0, validJsonVectors: 0, oversized: 0, notJsonArray: 0, invalidLength: 0, invalidNumber: 0,
        legacyDimensions: 0, dimensionsMismatch: 0, missingProfile: 0, zeroVector: 0, exceedsHnswDimensions: 0 };
    const dimensionExpr = target.dimensions ? `source."${target.dimensions}"` : 'NULL::bigint';
    const profileExpr = target.profile ? `source."${target.profile}"` : 'NULL::text';
    const sql = `SELECT source.id::text AS id, ${dimensionExpr} AS declared_dimensions, ${profileExpr} AS profile,
        CASE WHEN octet_length(source.embedding::text) <= ${MAX_TEXT_BYTES} THEN source.embedding::text ELSE NULL END AS vector_text
        FROM "${schema}"."${target.table}" AS source WHERE source.id > $1::bigint AND source.embedding IS NOT NULL ORDER BY source.id ASC LIMIT $2`;
    let hasMore = false;
    let timeLimitReached = false;
    const startedAt = Date.now();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
        await client.query("SET LOCAL statement_timeout = '5s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '35s'");
        while (counts.scanned < requestedLimit) {
            if (Date.now() - startedAt >= duration) { timeLimitReached = true; hasMore = true; break; }
            const remaining = requestedLimit - counts.scanned;
            const result = await client.query(sql, [cursor, Math.min(BATCH_SIZE, remaining + 1)]);
            const rows = result.rows || [];
            if (!rows.length) break;
            for (const row of rows.slice(0, remaining)) {
                const category = classifyVector(row, target);
                counts.scanned += 1;
                cursor = normalizeCursor(row.id);
                if (category.kind === 'valid_json_vector') counts.validJsonVectors += 1;
                if (category.kind === 'oversized') counts.oversized += 1;
                if (category.kind === 'not_json_array') counts.notJsonArray += 1;
                if (category.kind === 'invalid_length') counts.invalidLength += 1;
                if (category.kind === 'invalid_number') counts.invalidNumber += 1;
                for (const key of ['legacyDimensions', 'dimensionsMismatch', 'missingProfile', 'zeroVector', 'exceedsHnswDimensions']) {
                    if (category[key]) counts[key] += 1;
                }
            }
            if (rows.length > remaining) { hasMore = true; break; }
            if (rows.length < Math.min(BATCH_SIZE, remaining + 1)) break;
            if (counts.scanned === requestedLimit) {
                const probe = await client.query(sql, [cursor, 1]);
                hasMore = Boolean(probe.rows?.length);
            }
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    }
    return { schema, target: targetName, after: normalizeCursor(after), nextCursor: hasMore ? cursor : null, hasMore, timeLimitReached, ...counts,
        note: '仅检查 JSON 形状、数值范围与元数据；非 JSON 格式不等同于 PostgreSQL 向量无效，分页之间不是同一数据库快照。' };
}

async function main() {
    const args = Object.fromEntries(process.argv.slice(2).map(arg => {
        const match = /^--(schema|target|after|limit)=(.+)$/.exec(arg);
        if (!match) throw new Error('参数格式：--schema=名称 --target=knowledge|memory|regulations [--after=游标] [--limit=条数]');
        return [match[1], match[2]];
    }));
    if (process.env.PIVOT_VECTOR_AUDIT_CONFIRM !== 'YES' || !process.env.VECTOR_AUDIT_DATABASE_URL) {
        throw new Error('请显式设置 VECTOR_AUDIT_DATABASE_URL 和 PIVOT_VECTOR_AUDIT_CONFIRM=YES。');
    }
    const client = new Client({ connectionString: process.env.VECTOR_AUDIT_DATABASE_URL, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
        const result = await auditVectorData({ client, schema: args.schema, targetName: args.target, after: args.after || '0', limit: Number(args.limit || 2000) });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally { await client.end(); }
}

if (require.main === module) main().catch(error => {
    // 数据库错误可能包含连接参数或业务值，只输出稳定的类别。
    process.stderr.write(`向量检查失败（${String(error.code || 'AUDIT_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 40)}）。\n`);
    process.exitCode = 1;
});

module.exports = { TARGETS, auditVectorData, classifyVector, normalizeCursor };
