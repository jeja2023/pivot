'use strict';
const crypto = require('node:crypto');
const repository = require('../../repositories/analysis-transactions');
const shared = require('./shared');
const { normalize, invalid } = require('./transaction-config');
let running = false; let interval;
const revision = dataset => crypto.createHash('sha256').update(JSON.stringify([dataset.parquet_path, dataset.row_count, dataset.source_version, dataset.updated_at])).digest('hex');
const configOf = job => typeof job.config === 'string' ? JSON.parse(job.config) : job.config;
function publicJob(row) { return { id: row.id, datasetId: row.dataset_id, sourceRevision: row.source_revision, status: row.status, error: row.error, createdAt: row.created_at, expiresAt: row.expires_at, ...(row.result ? { result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result } : {}), config: configOf(row) }; }
async function authorize(user, datasetId, config) { const actor = await shared.resolveAnalysisUser(user?.id); const dataset = await shared.getDatasetForUser(actor, datasetId); await require('./governance').assertDatasetFieldsAccessible(actor, dataset, Object.values(config.mapping)); return dataset; }
async function create(user, datasetId, input = {}) {
    const config = normalize(input); const dataset = await authorize(user, datasetId, config);
    const requestKey = String(input.requestKey || ''); if (!/^[\w:.-]{8,160}$/.test(requestKey)) throw invalid('创建分析需要有效的请求标识。');
    const sourceRevision = revision(dataset); const inputHash = crypto.createHash('sha256').update(JSON.stringify({ config, datasetId, sourceRevision })).digest('hex');
    const row = await repository.create({ userId: user.id, datasetId, revision: sourceRevision, requestKey, inputHash, config }); schedule(); return publicJob(row);
}
async function get(user, id) { const row = await repository.get(user.id, String(id)); await authorize(user, row.dataset_id, configOf(row)); return publicJob(row); }
async function list(user, datasetId) { await shared.getDatasetForUser(user, datasetId); return repository.list(user.id, datasetId); }
async function remove(user, id) { return repository.remove(user.id, String(id)); }
async function calculate(user, datasetId, input) {
    const config = normalize(input);
    return require('./row-source').withDatasetColumns(user, datasetId, Object.values(config.mapping), async ({ dataset, connection }) => {
        const select = Object.entries(config.mapping).map(([alias, key]) => `CAST(${shared.sqlIdent(key)} AS VARCHAR) AS ${shared.sqlIdent(alias)}`).join(',');
        const rows = (await connection.runAndReadAll(`SELECT ROW_NUMBER() OVER() AS source_row,${select} FROM source LIMIT 200001`)).getRowObjectsJson();
        if (rows.length > 200000) throw invalid('交易分析最多处理 200000 行，请先限定数据范围。');
        const result = await require('./transaction-compute').compute(rows, config);
        result.source = { datasetId: dataset.id, revision: revision(dataset), rowCount: Number(dataset.row_count), truncated: Boolean(dataset.truncated), generatedAt: new Date().toISOString() };
        const latest = await authorize(user, datasetId, config);
        if (revision(latest) !== revision(dataset)) throw invalid('计算期间数据源已更新，请重新运行分析。', 409);
        return result;
    });
}
async function drain() {
    if (running) return; running = true;
    try {
        await repository.cleanup();
        for (let count = 0; count < 5; count++) {
            const job = await repository.claim(); if (!job) break;
            try {
                const user = await shared.resolveAnalysisUser(job.user_id); if (!user || user.status !== 'active' || user.deleted_at) throw invalid('分析账号已失效。', 403);
                const dataset = await authorize(user, job.dataset_id, configOf(job));
                if (revision(dataset) !== job.source_revision) throw invalid('排队期间数据源已更新，请确认口径后重新创建分析。', 409);
                const result = await calculate(user, job.dataset_id, configOf(job));
                if (result.source.revision !== job.source_revision) throw invalid('计算期间数据源已更新，请重新分析。', 409);
                await repository.finish(job, result);
            } catch (error) { await repository.finish(job, null, error.expose ? error.message : '交易分析失败，请检查映射、源数据及运行环境。'); }
        }
        await require('./transaction-delivery').drain();
    } catch (error) { require('../../logger').logger.error({ code: error.code || 'TRANSACTION_JOB_FAILED' }, '资金交易分析队列处理失败'); }
    finally { running = false; }
}
function schedule() { setImmediate(() => { void drain(); }); }
function start() { if (!interval) { interval = setInterval(schedule, 15000).unref(); schedule(); } }
function stop() { clearInterval(interval); interval = null; }
module.exports = { create, get, list, remove, calculate, drain, start, stop };
