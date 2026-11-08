'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { DuckDBInstance } = require('@duckdb/node-api');
const { fixture } = require('./bi_modeling');
const { queryOne, execute } = require('../../server/db/client');
const models = require('../../server/services/data-analysis/bi/models');
const semantic = require('../../server/services/data-analysis/semantic-models');
const jobs = require('../../server/services/data-analysis/bi/jobs');
const runner = require('../../server/services/data-analysis/bi/runner');
const ingestion = require('../../server/services/data-analysis/bi/ingestions');
const delivery = require('../../server/services/data-analysis/bi/delivery');

const PROFILES = Object.freeze({ contract: { name: 'P-Contract', factRows: 3000, dimensionRows: 300 }, standard: { name: 'P-Standard', factRows: 200000, dimensionRows: 2500 }, large: { name: 'P-Large', factRows: 1000000, dimensionRows: 250000 } });
const literal = value => `'${String(value).replaceAll("'", "''").replaceAll('\\', '/')}'`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const duration = started => Math.round(performance.now() - started);
const headers = Array.from({ length: 120 }, (_, i) => `字段${i + 1}`);

async function generateCsv(file, profile, dimension) {
    const instance = await DuckDBInstance.create(':memory:', { threads: '2', memory_limit: '256MiB' });
    const connection = await instance.connect();
    try {
        const cols = new Map();
        if (dimension === null) {
            cols.set(1, 'CAST(i//3 AS VARCHAR)'); cols.set(2, 'CAST(i%3 AS VARCHAR)');
            cols.set(3, "CASE WHEN i%5=0 THEN '0.01' ELSE '100.25' END"); cols.set(4, 'CAST(i%5+1 AS VARCHAR)');
            cols.set(5, "'客户'||CAST(i%150001 AS VARCHAR)"); cols.set(6, "repeat('w',384)||CAST(i AS VARCHAR)");
            for (let d = 0; d < 8; d++) {
                const key = `CASE WHEN i%97=0 THEN ${profile.dimensionRows + 1} WHEN i%10<9 THEN (i+${d})%25 ELSE (i+${d})%${profile.dimensionRows} END`;
                cols.set(7 + d * 2, `CAST((${key})%4 AS VARCHAR)`); cols.set(8 + d * 2, `CAST((${key}) AS VARCHAR)`);
            }
            cols.set(23, "'月份'||CAST(i%12 AS VARCHAR)"); cols.set(24, "'区域'||CAST(i%10 AS VARCHAR)");
        } else {
            cols.set(1, 'CAST(i%4 AS VARCHAR)'); cols.set(2, 'CAST(i AS VARCHAR)'); cols.set(3, "'分组'||CAST(i%10 AS VARCHAR)"); cols.set(4, "repeat('d',384)||CAST(i AS VARCHAR)");
        }
        const fields = headers.map((name, i) => `${cols.get(i + 1) || 'NULL::VARCHAR'} AS "${name}"`);
        await connection.run(`COPY (SELECT ${fields.join(',')} FROM range(${dimension === null ? profile.factRows : profile.dimensionRows}) t(i)) TO ${literal(file)} (FORMAT CSV,HEADER,DELIMITER ',')`);
    } finally { connection.closeSync(); instance.closeSync(); }
}

async function ingestFile(user, file, rows, role, progress) {
    const started = performance.now(), stat = await fs.stat(file), hash = crypto.createHash('sha256');
    const session = await ingestion.createIngestion(user, { name: path.basename(file), originalName: path.basename(file), headers, expectedBytes: stat.size, expectedRows: rows, role, requestKey: crypto.randomUUID() });
    const handle = await fs.open(file, 'r');
    try {
        for (let i = 0; i < session.expectedChunks; i++) {
            const bytes = Buffer.alloc(Math.min(session.chunkBytes, stat.size - i * session.chunkBytes));
            const read = await handle.read(bytes, 0, bytes.length, i * session.chunkBytes); assert.equal(read.bytesRead, bytes.length); hash.update(bytes);
            await ingestion.putIngestionChunk(user, session.id, i, bytes, digest(bytes));
        }
    } finally { await handle.close(); }
    const queued = await ingestion.submitIngestion(user, session.id);
    let complete, retryReported = false;
    do {
        await runner.processModelJobs(); complete = await ingestion.getIngestion(user, session.id);
        if (complete.status === 'retry_wait' && !retryReported) { progress({ phase: '隔离任务按持久退避重试', role }); retryReported = true; }
        if (['queued', 'retry_wait', 'running', 'cancelling'].includes(complete.status)) await new Promise(resolve => setTimeout(resolve, 1000));
    } while (['queued', 'retry_wait', 'running', 'cancelling'].includes(complete.status) && performance.now() - started < 480000);
    const execution = await queryOne('SELECT execution_metrics_json FROM analysis_query_jobs WHERE id=?', [queued.jobId]);
    assert.equal(complete.status, 'succeeded', JSON.stringify({ error: complete.lastError, executionMetrics: execution.execution_metrics_json }));
    const dataset = await queryOne('SELECT id,row_count,column_count FROM analysis_datasets WHERE id=?', [complete.datasetId]);
    assert.equal(Number(dataset.row_count), rows); assert.equal(Number(dataset.column_count), 120);
    return { dataset, input: { rows, columns: 120, bytes: stat.size, sha256: hash.digest('hex'), ingestionMs: duration(started), executionMetrics: execution.execution_metrics_json } };
}

function definition(datasets) {
    const nodes = [{ id: 'fact', datasetId: datasets[0].id, role: 'fact', grainKeys: ['c_1', 'c_2'] }, ...datasets.slice(1).map((item, i) => ({ id: `dim${i}`, datasetId: item.id, role: 'dimension', grainKeys: ['c_1', 'c_2'] }))];
    const dimensions = [...datasets.slice(1).map((_, i) => ({ id: `label${i}`, name: `业务维度${i}`, nodeId: `dim${i}`, fieldKey: 'c_3', memberKeyFields: ['c_1', 'c_2'] })),
        { id: 'highKey', nodeId: 'dim0', fieldKey: 'c_2', memberKeyFields: ['c_1', 'c_2'] }, { id: 'month', nodeId: 'fact', fieldKey: 'c_23' }, { id: 'region', nodeId: 'fact', fieldKey: 'c_24' }];
    const field = key => ({ nodeId: 'fact', fieldKey: key });
    const ratio = (id, numerator, denominator) => ({ id, type: 'derived', expression: { op: 'divide', args: [{ metricId: numerator }, { metricId: denominator }] } });
    return { grainDescription: '每条订单内的一条商品明细，订单与明细组合唯一', nodes, dimensions,
        relations: datasets.slice(1).map((_, i) => ({ id: `r${i}`, leftNodeId: 'fact', rightNodeId: `dim${i}`, cardinality: 'many_to_one', joinType: 'left', keyPairs: [{ leftFieldKey: `c_${7 + i * 2}`, rightFieldKey: 'c_1' }, { leftFieldKey: `c_${8 + i * 2}`, rightFieldKey: 'c_2' }] })),
        metrics: [{ id: 'amount', type: 'sum', field: field('c_3'), currency: 'CNY' }, { id: 'rows', type: 'count' }, { id: 'quantity', type: 'sum', field: field('c_4'), scale: 0, numeric: { scale: 0 } },
            { id: 'orders', type: 'count_distinct', field: field('c_1') }, { id: 'customers', type: 'count_distinct', field: field('c_5') }, { id: 'minimum', type: 'min', field: field('c_3') },
            { id: 'maximum', type: 'max', field: field('c_3') }, { id: 'mean', type: 'avg', field: field('c_3') }, ratio('perOrder', 'amount', 'orders'), ratio('perRow', 'quantity', 'rows')] };
}

function format(value, scale = 2) {
    const text = value.toString().padStart(scale + 1, '0'); return scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text;
}
function expected(rows) {
    const count = BigInt(rows), cents = count * 10025n - BigInt(Math.ceil(rows / 5)) * 10024n;
    const remainder = count % 5n, quantity = (count / 5n) * 15n + remainder * (remainder + 1n) / 2n;
    const orders = BigInt(Math.ceil(rows / 3));
    return { rows: String(rows), amount: format(cents), quantity: format(quantity, 0), orders: String(orders), customers: String(Math.min(rows, 150001)), minimum: '0.01', maximum: '100.25', mean: format((cents + count / 2n) / count),
        perOrder: format((cents + orders / 2n) / orders), perRow: format((quantity * 100n + count / 2n) / count) };
}

async function httpQueries(user, model, profile, samples) {
    const app = express(); app.use(express.json());
    app.post('/query', delivery.handler(async (req, res) => res.status(202).json(await jobs.createModelQuery({ user, modelId: model.id, body: req.body }))));
    app.get('/result/:id', delivery.handler(async (req, res) => res.json(await jobs.getModelJob(user, req.params.id))));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ code: err.code, message: err.message }));
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${server.address().port}`, results = [], golden = expected(profile.factRows);
    try {
        for (const kind of ['common', 'complex']) for (let i = 0; i < samples; i++) {
            // 冷结果样本显式移除本隔离夹具的缓存键；不把后续命中结果混入冷查询p95。
            await execute("UPDATE analysis_query_jobs SET result_metadata_json=result_metadata_json#-'{cache,key}' WHERE user_id=? AND model_id=? AND execution_kind='model_query'", [user.id, model.id]);
            const started = performance.now(), body = { publishedVersion: 1, execution: 'async', requestKey: crypto.randomUUID(), dimensions: kind === 'common' ? ['label0', 'month'] : ['highKey', 'label1', 'label2', 'month', 'region'], metrics: kind === 'common' ? ['amount', 'rows', 'quantity'] : Object.keys(golden), limit: 100 };
            const response = await fetch(`${root}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const queued = await response.json(); assert.equal(response.status, 202, JSON.stringify(queued));
            // 使用真实持久领取及隔离执行，耗时包含提交、排队、解析、授权、计算和结果登记。
            await runner.processModelJobs();
            const read = await fetch(`${root}/result/${queued.id}`), result = await read.json();
            assert.equal(read.status, 200, JSON.stringify(result)); assert.equal(result.status, 'succeeded', result.lastError);
            assert.equal(result.result.cache.hit, false);
            for (const metricId of body.metrics) assert.equal(result.result.total.values[metricId].value, golden[metricId], metricId);
            assert.ok(result.executionMetrics.maxRssBytes > 0); assert.ok(result.executionMetrics.userCpuMs >= 0);
            results.push({ kind, sequence: i + 1, elapsedMs: duration(started), groups: result.result.groupCount, truncated: result.result.truncated, executionMetrics: result.executionMetrics, cache: { engine: 'fresh_process', filesystem: 'uncontrolled', result: 'miss_no_result_cache' } });
            const hotStart = performance.now(), cached = await fetch(`${root}/result/${queued.id}`);
            assert.equal(cached.status, 200); await cached.json(); results.at(-1).storedResultReadMs = duration(hotStart);
            const hitStarted = performance.now(), hitResponse = await fetch(`${root}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, requestKey: crypto.randomUUID() }) });
            const hitQueued = await hitResponse.json(); assert.equal(hitResponse.status, 202, JSON.stringify(hitQueued)); assert.notEqual(hitQueued.id, queued.id);
            await runner.processModelJobs();
            const hitRead = await fetch(`${root}/result/${hitQueued.id}`), hitResult = await hitRead.json(); assert.equal(hitRead.status, 200); assert.equal(hitResult.status, 'succeeded', hitResult.lastError);
            assert.equal(hitResult.result.cache.hit, true);
            for (const metricId of body.metrics) assert.equal(hitResult.result.total.values[metricId].value, golden[metricId], metricId);
            results.at(-1).cacheHitQuery = { elapsedMs: duration(hitStarted), independentRequest: true, sourceRunId: hitResult.result.cache.sourceRunId, executionMetrics: hitResult.executionMetrics, filesystem: 'uncontrolled', result: 'hit_same_user_version_manifest_query_authorization' };
        }
        for (const body of [{ publishedVersion: 1, dimensions: [], metrics: Array(11).fill('rows'), requestKey: crypto.randomUUID() }, { publishedVersion: 1, dimensions: Array(6).fill('month'), metrics: ['rows'], requestKey: crypto.randomUUID() }]) {
            const response = await fetch(`${root}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 400);
        }
    } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
    return results;
}

async function withCapacityJournal(run, progress) {
    const journal = require('../../server/services/data-analysis/bi/security-journal');
    const stats = { intervalMs: 1000, completedFlushes: 0, failures: [] };
    let pending = null, failure = null, runFailure = null;
    const refresh = () => {
        if (pending || failure) return;
        pending = journal.flush().then(() => { stats.completedFlushes++; }).catch(error => {
            failure = error; stats.failures.push(error.code || 'JOURNAL_REFRESH_FAILED');
            progress({ phase: '独立安全日志后台确认失败', code: error.code || 'JOURNAL_REFRESH_FAILED' });
        }).finally(() => { pending = null; });
    };
    refresh(); await pending;
    if (failure) throw failure;
    // 与正式维护服务一致，每秒运行真实日志确认；长时间生成/导入期间仍检查60/90秒完整性合同。
    const timer = setInterval(refresh, 1000); timer.unref();
    try {
        const result = await run(stats); await pending;
        if (failure) throw failure;
        return result;
    } catch (error) { runFailure = error; throw error; }
    finally { clearInterval(timer); await pending; if (!runFailure && failure) throw failure; }
}

async function runCapacityTier(key, { samples = 3, runtime = 'development_process', progress = () => {} } = {}) {
    const profile = PROFILES[key]; if (!profile) throw new Error('容量档位无效。');
    process.env.DATA_ANALYSIS_MODEL_RUNTIME = runtime;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-bi-capacity-'));
    try {
        let report;
        await withCapacityJournal(journalStats => fixture(async ({ user }) => {
            const datasets = [], inputs = [];
            for (let i = 0; i < 9; i++) {
                progress({ phase: '受控导入', tier: profile.name, source: i + 1, sources: 9 });
                const file = path.join(root, i === 0 ? 'fact.csv' : `dimension${i}.csv`);
                await generateCsv(file, profile, i === 0 ? null : i - 1);
                const input = await ingestFile(user, file, i === 0 ? profile.factRows : profile.dimensionRows, i === 0 ? 'fact' : 'dimension', progress);
                datasets.push(input.dataset); inputs.push(input.input); await fs.unlink(file);
            }
            assert.ok(inputs.reduce((total, item) => total + item.bytes, 0) <= 2 * 1024 ** 3);
            let model = await semantic.saveDataModel({ user, body: { modelKind: 'production', name: `${profile.name} 容量模型`, factDatasetId: datasets[0].id, businessOwner: '容量验证业务负责人', maintenanceContact: '容量验证维护者' } });
            model = await models.saveProductionDraft({ user, modelId: model.id, body: { expectedVersion: model.version, definition: definition(datasets) } });
            progress({ phase: '全量质量检查', tier: profile.name });
            const start = performance.now(), created = await jobs.createModelCheck({ user, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
            await runner.processModelJobs();
            const check = await jobs.getModelCheck(user, model.id, created.check.id), checkMs = duration(start);
            assert.equal(check.status, 'passed', JSON.stringify(check)); assert.equal(check.complete, true); assert.equal(check.report.fullScan, true);
            assert.equal(check.report.grains.length, 9); assert.equal(check.report.relations.length, 8);
            for (const relation of check.report.relations) assert.equal(relation.unmatchedLeftRows, String(Math.ceil(profile.factRows / 97)));
            await jobs.publishModel({ user, modelId: model.id, body: { expectedVersion: model.version, checkId: check.id, requestKey: crypto.randomUUID(), warningAcceptance: check.report.warnings.map(item => ({ code: item.code, relationId: item.relationId, reason: '容量夹具刻意保留未匹配明细，左关联必须保持完整事实范围。' })) } });
            progress({ phase: '常用及复杂 HTTP 分析', tier: profile.name, samples });
            const queries = await httpQueries(user, model, profile, samples);
            const slo = {};
            for (const kind of ['common', 'complex']) {
                const values = queries.filter(item => item.kind === kind).map(item => item.elapsedMs).sort((a, b) => a - b), p95Ms = values[Math.ceil(values.length * 0.95) - 1];
                const targetMs = key === 'large' ? kind === 'common' ? 15000 : 30000 : kind === 'common' ? 5000 : null;
                slo[kind] = { samples: values.length, p50Ms: values[Math.ceil(values.length * 0.5) - 1], p95Ms, p99Ms: values[Math.ceil(values.length * 0.99) - 1], targetMs, passed: targetMs === null ? null : p95Ms <= targetMs };
            }
            const checkJob = await queryOne('SELECT execution_metrics_json FROM analysis_query_jobs WHERE id=?', [created.job.id]);
            const ready = await require('../../server/services/data-analysis/bi/readiness').ensureReady();
            report = { tier: profile.name, factRows: profile.factRows, dimensionRows: profile.dimensionRows * 8, columnsPerTable: 120, relations: 8, inputBytes: inputs.reduce((total, item) => total + item.bytes, 0), inputs,
                runtimeContract: { engine: ready.engine, compilerVersion: ready.compilerVersion, schema: ready.schema, isolationCheckedAt: ready.isolationCheckedAt, settings: { running: require('../../server/config/env-registry').readTypedEnv('DATA_ANALYSIS_MODEL_RUNNING_LIMIT'), userRunning: 1, queued: 16, userQueued: 3, duckMemoryBytes: 1024 ** 3, hardMemoryBytes: 2 * 1024 ** 3, threads: 2, spillBytes: 8 * 1024 ** 3 } },
                quality: { elapsedMs: checkMs, targetMs: key === 'large' ? 120000 : 60000, passed: checkMs <= (key === 'large' ? 120000 : 60000), fullScan: true, executionMetrics: checkJob.execution_metrics_json }, queries, slo,
                backgroundSecurityJournal: journalStats,
                certification: false, limitations: ['本机隔离工程验证，未替代目标生产硬件认证。', '文件系统缓存未受控；每次使用新的引擎进程，无查询结果缓存；另报持久结果读取耗时。', '非七十二小时稳定性与三十天运行历史。'] };
        }), progress);
        return report;
    } finally { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }
}

module.exports = { PROFILES, runCapacityTier };
