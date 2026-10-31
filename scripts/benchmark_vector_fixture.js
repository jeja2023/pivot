'use strict';

// 合成数据仅用于比较计划和召回；不读取生产数据，也不创建持久表或索引。
const { Client } = require('pg');
const { performance } = require('node:perf_hooks');

function bounded(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

async function run({ connectionString, rows = 100000, dimensions = 64, tenants = 10, trials = 10 } = {}) {
    if (!connectionString) throw new Error('必须显式提供 TEST_DATABASE_URL，基准只使用隔离测试数据库。');
    rows = bounded(rows, 100000, 1000, 200000);
    dimensions = bounded(dimensions, 64, 2, 512);
    tenants = bounded(tenants, 10, 1, 100);
    trials = bounded(trials, 10, 1, 100);
    const client = new Client({ connectionString });
    await client.connect();
    try {
        await client.query("SET statement_timeout = '5min'");
        const vector = await client.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
        if (!vector.rows.length) throw new Error('隔离测试数据库未安装 pgvector。');
        await client.query(`CREATE TEMP TABLE pivot_vector_fixture (id bigint PRIMARY KEY, tenant integer NOT NULL, embedding vector(${dimensions}) NOT NULL)`);
        const started = performance.now();
        await client.query(`INSERT INTO pivot_vector_fixture
            SELECT i, (i % $2)::integer,
                ARRAY(SELECT sin((i * 0.013 + j * 0.11)) + cos((i * j * 0.00017)) FROM generate_series(1, $3) j)::vector
            FROM generate_series(1, $1) i`, [rows, tenants, dimensions]);
        await client.query('ANALYZE pivot_vector_fixture');
        const insertMs = Math.round(performance.now() - started);
        const indexStart = performance.now();
        await client.query('CREATE INDEX ON pivot_vector_fixture USING hnsw (embedding vector_cosine_ops)');
        await client.query('ANALYZE pivot_vector_fixture');
        const indexMs = Math.round(performance.now() - indexStart);
        const samples = [];
        const scenarios = [
            { name: 'default', settings: ['SET hnsw.ef_search = 40', 'SET hnsw.iterative_scan = off'] },
            { name: 'iterative_200', settings: ['SET hnsw.ef_search = 200', 'SET hnsw.iterative_scan = strict_order'] }
        ];
        const plans = {};
        for (let i = 0; i < trials; i += 1) {
            const seed = 1 + Math.floor((i + 0.5) * rows / trials);
            const queryVector = (await client.query('SELECT embedding::text AS embedding, tenant FROM pivot_vector_fixture WHERE id = $1', [seed])).rows[0];
            const sql = 'SELECT id::text AS id FROM pivot_vector_fixture WHERE tenant = $1 ORDER BY embedding <=> $2::vector LIMIT 10';
            await client.query('SET enable_indexscan = off');
            await client.query('SET enable_bitmapscan = off');
            const exactStart = performance.now();
            const exact = await client.query(sql, [queryVector.tenant, queryVector.embedding]);
            const exactMs = performance.now() - exactStart;
            await client.query('SET enable_indexscan = on');
            await client.query('SET enable_bitmapscan = on');
            await client.query('SET enable_seqscan = off');
            const expected = new Set(exact.rows.map(row => row.id));
            for (const scenario of scenarios) {
                for (const setting of scenario.settings) await client.query(setting);
                const annStart = performance.now();
                const ann = await client.query(sql, [queryVector.tenant, queryVector.embedding]);
                const annMs = performance.now() - annStart;
                if (!plans[scenario.name]) plans[scenario.name] = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [queryVector.tenant, queryVector.embedding])).rows[0]['QUERY PLAN'][0];
                samples.push({ scenario: scenario.name, exactMs, annMs, recall: expected.size ? ann.rows.filter(row => expected.has(row.id)).length / expected.size : 1, returned: ann.rowCount });
            }
            await client.query('RESET enable_seqscan');
        }
        const percentile = (items, field, p) => {
            const values = items.map(item => item[field]).sort((a, b) => a - b);
            return Math.round(values[Math.ceil(values.length * p) - 1] * 100) / 100;
        };
        const comparisons = scenarios.map(scenario => {
            const items = samples.filter(item => item.scenario === scenario.name);
            return { name: scenario.name, annP50Ms: percentile(items, 'annMs', 0.5), annP95Ms: percentile(items, 'annMs', 0.95),
                meanRecallAt10: items.reduce((sum, item) => sum + item.recall, 0) / items.length,
                minReturned: Math.min(...items.map(item => item.returned)), plan: plans[scenario.name] };
        });
        return { pgvector: vector.rows[0].extversion, rows, dimensions, tenants, trials, insertMs, indexMs,
            exactP50Ms: percentile(samples, 'exactMs', 0.5), exactP95Ms: percentile(samples, 'exactMs', 0.95), comparisons,
            note: '合成数据、强制索引计划及单次运行不代表生产工作负载；必须使用脱敏生产分布与黄金集另行验收。' };
    } finally { await client.end(); }
}

if (require.main === module) {
    run({ connectionString: process.env.TEST_DATABASE_URL, rows: process.env.PIVOT_VECTOR_BENCH_ROWS,
        dimensions: process.env.PIVOT_VECTOR_BENCH_DIMENSIONS, tenants: process.env.PIVOT_VECTOR_BENCH_TENANTS,
        trials: process.env.PIVOT_VECTOR_BENCH_TRIALS })
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(`向量基准失败：${error.message}`); process.exitCode = 1; });
}

module.exports = { run };
