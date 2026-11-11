'use strict';

const fs = require('node:fs/promises');
const repository = require('../../repositories/analysis-query-jobs');
const { readTypedEnv } = require('../../config/env-registry');
const { analysisId, exportRoot, resolveInside, toProjectRelative, jsonParse, sqlLiteral, getDatasetForUser, getDatasetPaths, resolveAnalysisUser, createDuckConnection, withDuckTimeout, withAnalysisSlot, parquetToRows } = require('./shared');

const MAX_ROWS = readTypedEnv('DATA_ANALYSIS_ASYNC_QUERY_MAX_ROWS');
const TIMEOUT_MS = readTypedEnv('DATA_ANALYSIS_ASYNC_QUERY_TIMEOUT_MS');
const LEASE_MS = Math.max(30_000, Math.min(TIMEOUT_MS, 60_000));
const error = (message, status = 400, code = 'ANALYSIS_ASYNC_QUERY_INVALID') => Object.assign(new Error(message), { status, code });

function record(row) {
    return { id: row.id, datasetId: row.dataset_id, status: row.status, progress: Number(row.progress || 0), attempts: Number(row.attempts || 0), maxAttempts: Number(row.max_attempts || 0),
        requestedLimit: Number(row.requested_limit || 0), columns: jsonParse(row.result_columns_json, []), previewRows: jsonParse(row.result_preview_json, []),
        rowCount: Number(row.result_row_count || 0), truncated: Boolean(row.result_truncated), hasFile: Boolean(row.result_file_path),
        lastError: row.last_error || '', createdAt: row.created_at, startedAt: row.started_at || null, completedAt: row.completed_at || null };
}

async function readable(user, row, datasets = new Map()) {
    const result = record(row);
    try {
        if (!datasets.has(row.dataset_id)) datasets.set(row.dataset_id, await getDatasetForUser(user, row.dataset_id));
        const dataset = datasets.get(row.dataset_id);
        if (!Number(row.source_version) || Number(row.source_version) !== Number(dataset.source_version || 1)) throw error('来源数据或字段权限已变化，请重新运行查询。');
    } catch (_) {
        result.columns = []; result.previewRows = []; result.hasFile = false; result.rowCount = 0;
        result.resultUnavailable = true; result.resultUnavailableReason = '来源数据或字段权限已变化，或旧任务缺少来源版本，请重新运行查询。';
    }
    return result;
}

async function createAsyncQueryJob({ user, datasetId, sql, limit = 50_000 }) {
    const dataset = await getDatasetForUser(user, datasetId);
    const safeSql = require('./query-pivot').validateUserSql(sql);
    const parsed = Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw error('查询行数上限必须为正整数。');
    const row = await repository.create({ id: analysisId('query_job'), userId: user.id, datasetId: dataset.id, sql: safeSql, limit: Math.min(parsed, MAX_ROWS), sourceVersion: Number(dataset.source_version || 1) });
    return record(row);
}

async function getAsyncQueryJob(user, jobId) {
    const row = await repository.get(user.id, jobId);
    if (!row) throw error('异步查询任务不存在或无权访问。', 404);
    if (row.execution_kind && row.execution_kind !== 'dataset_sql') return require('./bi/jobs').getModelJob(user, jobId);
    return readable(user, row);
}

async function listAsyncQueryJobs(user, { datasetId = '', limit = 30 } = {}) {
    if (datasetId) await getDatasetForUser(user, datasetId);
    const rows = await repository.list(user.id, datasetId, Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100));
    const datasets = new Map();
    const results = [];
    for (const row of rows) results.push(await readable(user, row, datasets));
    return results;
}

async function cancelAsyncQueryJob(user, jobId) {
    const existing = await repository.get(user.id, jobId);
    if (existing?.execution_kind && existing.execution_kind !== 'dataset_sql') {
        const result = await require('./bi/jobs').cancelModelJob(user, jobId);
        await require('./bi/runner').cancelActiveModelJob(jobId);
        return result;
    }
    if (!await repository.cancel(user.id, jobId)) throw error('异步查询任务不存在或无权操作。', 404);
    return getAsyncQueryJob(user, jobId);
}

async function executeJob(job) {
    return withAnalysisSlot(() => executeClaimedJob(job), { userId: Number(job.user_id), job });
}

async function executeClaimedJob(job) {
    const owner = await resolveAnalysisUser(job.user_id);
    if (!owner) throw error('查询所属账号已失效，请重新登录后检查。', 401);
    const dataset = await getDatasetForUser(owner, job.dataset_id);
    const sourceVersion = Number(dataset.source_version || 1);
    if (!Number(job.source_version) || Number(job.source_version) !== sourceVersion) throw error('来源数据或字段权限已变化，请重新创建查询。', 409, 'ANALYSIS_SOURCE_CHANGED');
    const allowedColumns = await require('./governance').getAccessibleDatasetColumns(owner, dataset);
    if (!allowedColumns.length) throw error('当前共享权限没有可查询字段，请联系数据集所有者。', 403);
    const outputDir = resolveInside(exportRoot, String(owner.id));
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = resolveInside(outputDir, `${job.id}-${job.attempts}-${analysisId('result')}.parquet`);
    let committed = false;
    try {
        const result = await withAnalysisSlot(async () => {
            if (!await repository.renew(job)) return null;
            const { instance, connection, spillDirectory, cleanupSpill } = await createDuckConnection({ privateSpill: true });
            let cleanupSandbox;
            let lost = false; let heartbeat = null;
            const timer = setInterval(() => {
                if (heartbeat) return;
                heartbeat = repository.renew(job).then(owned => {
                    if (!owned) { lost = true; connection.interrupt?.(); }
                }).catch(() => { lost = true; connection.interrupt?.(); }).finally(() => { heartbeat = null; });
            }, 2000);
            timer.unref?.();
            try {
                const run = sql => withDuckTimeout(connection, () => connection.run(sql), TIMEOUT_MS);
                await run(`CREATE TABLE data AS SELECT ${require('./query-pivot').buildQuerySelectList(dataset, allowedColumns)} FROM read_parquet(${sqlLiteral(getDatasetPaths(dataset).parquetPath)})`);
                cleanupSandbox = await require('./duckdb-sandbox').lockDuckExternalAccess(connection, { allowedPaths: [outputPath], spillDirectory });
                await run(`CREATE TABLE result AS SELECT * FROM (${job.sql_text}) AS _q LIMIT ${Number(job.requested_limit) + 1}`);
                const reader = await withDuckTimeout(connection, () => connection.runAndReadAll('SELECT * FROM result LIMIT 0'), TIMEOUT_MS);
                const size = (await withDuckTimeout(connection, () => connection.runAndReadAll('SELECT COUNT(*) AS n FROM result'), TIMEOUT_MS)).getRowObjectsJson()[0];
                await run(`COPY (SELECT * FROM result LIMIT ${Number(job.requested_limit)}) TO ${sqlLiteral(outputPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
                if (lost) return null;
                return { columns: reader.columnNames(), rowCount: Math.min(Number(size.n), Number(job.requested_limit)), truncated: Number(size.n) > Number(job.requested_limit) };
            } finally {
                clearInterval(timer); if (heartbeat) await heartbeat;
                connection.closeSync(); instance.closeSync();
                await cleanupSandbox?.();
                await cleanupSpill();
            }
        }, { userId: job.user_id });
        if (!result) return;
        const previewRows = await withAnalysisSlot(() => parquetToRows(outputPath, { limit: 100 }), { userId: job.user_id });
        const current = await getDatasetForUser(owner, dataset.id);
        if (Number(current.source_version || 1) !== sourceVersion) throw error('来源数据或字段权限已变化，请重新创建查询。', 409, 'ANALYSIS_SOURCE_CHANGED');
        committed = await repository.finish(job, { ...result, previewRows, filePath: toProjectRelative(outputPath) }, {
            id: analysisId('art'), title: job.sql_text.slice(0, 120), metadata: { jobId: job.id, sourceVersion, requestedLimit: Number(job.requested_limit), rowCount: result.rowCount, truncated: result.truncated }
        });
    } finally { if (!committed) await fs.unlink(outputPath).catch(() => {}); }
}

let running = false;
let runner = null;
async function processAsyncQueryJobs({ limit = 2 } = {}) {
    if (running) return { skipped: true, processed: 0 };
    running = true; let processed = 0;
    try {
        await require('./runtime-budget').recoverStoppedAnalysis();
        for (let index = 0; index < Math.min(Math.max(Number(limit) || 2, 1), 8); index += 1) {
            const job = await repository.claim(LEASE_MS);
            if (!job) break;
            if (!job.exhausted) {
                try { await executeJob(job); }
                catch (failure) {
                    const retryable = failure.code === 'ANALYSIS_QUERY_TIMEOUT' || Number(failure.status) >= 500 || /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|57P01|08006)$/.test(failure.code || '');
                    const retry = retryable && Number(job.attempts) < Number(job.max_attempts);
                    const message = failure.code === 'ANALYSIS_SOURCE_CHANGED' ? '来源数据或字段权限已变化，请重新创建查询。'
                        : failure.code === 'ANALYSIS_QUERY_TIMEOUT' ? '后台查询超时，请增加筛选条件或缩小结果范围。'
                            : [401, 403, 404].includes(failure.status) ? '来源数据不存在或当前账号无权读取，请检查数据集及共享权限。'
                                : '后台查询执行失败，请检查字段和查询语句后重试。';
                    await repository.fail(job, { retry, message, backoffMs: Math.min(60_000, 5000 * 2 ** Math.max(0, Number(job.attempts) - 1)) });
                }
            }
            processed += 1;
        }
        const modelJobs = await require('./bi/runner').dispatchModelJobs();
        return { skipped: false, processed: processed + modelJobs.processed };
    } finally { running = false; }
}

function startAsyncQueryRunner({ intervalMs = readTypedEnv('DATA_ANALYSIS_ASYNC_QUERY_POLL_INTERVAL_MS'), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, processJobs = processAsyncQueryJobs } = {}) {
    if (runner) return runner;
    const interval = Math.max(1000, Math.min(Number(intervalMs) || 3000, 60_000));
    let timer; let stopped = false; let inFlight = null;
    const tick = () => {
        if (stopped || inFlight) return inFlight;
        inFlight = Promise.resolve().then(processJobs).catch(() => {}).finally(() => {
            inFlight = null;
            if (!stopped) { timer = setTimeoutFn(tick, interval); timer?.unref?.(); }
        });
        return inFlight;
    };
    timer = setTimeoutFn(tick, Math.min(interval, 2000)); timer?.unref?.();
    const instance = { async stop() { stopped = true; clearTimeoutFn(timer); await require('./bi/runner').stopModelJobs(); if (inFlight) await inFlight; if (runner === instance) runner = null; } };
    runner = instance;
    return instance;
}

module.exports = { createAsyncQueryJob, getAsyncQueryJob, listAsyncQueryJobs, cancelAsyncQueryJob, processAsyncQueryJobs, startAsyncQueryRunner };
