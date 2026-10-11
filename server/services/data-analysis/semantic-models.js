'use strict';

const fs = require('fs');
const path = require('path');
const { query, queryOne, execute, transaction } = require('../../db/client');
const { computeNextCronDate } = require('../cron-expression');
const { canAccessSharedResource, normalizeShareScope, normalizeShareSettings } = require('../unit-visibility');
const { filterExistingShareUserIds } = require('../share-targets');
const { readTypedEnv } = require('../../config/env-registry');
const {
    analysisId,
    exportRoot,
    ensureAnalysisDirs,
    resolveInside,
    toProjectRelative,
    fromProjectRelative,
    jsonParse,
    sqlIdent,
    sqlLiteral,
    getDatasetForUser,
    getDatasetPaths,
    getColumn,
    resolveAnalysisUser,
    createDuckConnection,
    withDuckTimeout,
    withAnalysisSlot,
    parquetToRows,
    recordArtifact,
    getBeijingTimestamp
} = require('./shared');

const METRIC_AGGREGATIONS = new Set(['count', 'sum', 'avg', 'min', 'max']);
const JOIN_TYPES = new Set(['inner', 'left']);
const CARDINALITIES = new Set(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']);
const MAX_ASYNC_QUERY_ROWS = readTypedEnv('DATA_ANALYSIS_ASYNC_QUERY_MAX_ROWS');
const ASYNC_QUERY_TIMEOUT_MS = readTypedEnv('DATA_ANALYSIS_ASYNC_QUERY_TIMEOUT_MS');

function failure(message, status = 400, code = 'ANALYSIS_SEMANTIC_MODEL_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function text(value, max = 500) {
    return String(value ?? '').replace(/[\u0000\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, max);
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    return jsonParse(value, fallback);
}

function metricRecord(row) {
    return {
        id: row.id, datasetId: row.dataset_id, userId: Number(row.user_id), name: row.name,
        description: row.description || '', metricConfig: parseJson(row.metric_config_json, {}), unit: row.unit || '',
        scope: normalizeShareScope(row.scope), allowedUnits: row.allowed_units || '', allowedUserIds: row.allowed_user_ids || '',
        validFrom: row.valid_from || null, validTo: row.valid_to || null, version: Number(row.version || 1),
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function modelRecord(row) {
    return {
        id: row.id, userId: Number(row.user_id), name: row.name, description: row.description || '',
        scope: normalizeShareScope(row.scope), allowedUnits: row.allowed_units || '', allowedUserIds: row.allowed_user_ids || '',
        version: Number(row.version || 1), createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function relationRecord(row) {
    return {
        id: row.id, modelId: row.model_id, leftDatasetId: row.left_dataset_id, leftFieldKey: row.left_field_key,
        rightDatasetId: row.right_dataset_id, rightFieldKey: row.right_field_key, joinType: row.join_type,
        cardinality: row.cardinality, status: row.status, quality: parseJson(row.quality_json, {}),
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function normalizeMetricConfig(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const aggregation = METRIC_AGGREGATIONS.has(String(source.aggregation || '').toLowerCase()) ? String(source.aggregation).toLowerCase() : 'count';
    const fieldKey = text(source.fieldKey ?? source.field_key, 80);
    if (aggregation !== 'count' && !fieldKey) throw failure('求和、平均、最小、最大指标需要指定字段。');
    return { fieldKey, aggregation };
}

async function listMetricDefinitions(user, { datasetId = '', limit = 100 } = {}) {
    const rows = await query(`
        SELECT * FROM analysis_metric_definitions
        WHERE deleted_at IS NULL ${datasetId ? 'AND dataset_id = ?' : ''}
        ORDER BY updated_at DESC LIMIT ?
    `, datasetId ? [datasetId, Math.min(Math.max(Number(limit) || 100, 1), 200)] : [Math.min(Math.max(Number(limit) || 100, 1), 200)]);
    return rows.filter(row => canAccessSharedResource(row, user, false)).map(row => ({ ...metricRecord(row), isOwner: Number(row.user_id) === Number(user.id) }));
}

async function saveMetricDefinition({ user, datasetId, body = {}, metricId = '' }) {
    const dataset = await getDatasetForUser(user, datasetId, { write: true });
    const name = text(body.name, 120);
    if (!name) throw failure('指标名称不能为空。');
    const metricConfig = normalizeMetricConfig(body.metricConfig ?? body.metric_config ?? {});
    if (metricConfig.fieldKey) await require('./governance').assertDatasetFieldsAccessible(user, dataset, [metricConfig.fieldKey]);
    const fallback = metricId ? (await queryOne('SELECT * FROM analysis_metric_definitions WHERE id = ?', [metricId])) || {} : {};
    if (metricId && Number(fallback.user_id) !== Number(user.id)) throw failure('指标不存在或无权编辑。', 404);
    const share = normalizeShareSettings(body, user, fallback);
    const allowedUserIds = await filterExistingShareUserIds(share.allowedUserIds, { excludeUserId: user.id });
    const validFrom = body.validFrom || body.valid_from || null;
    const validTo = body.validTo || body.valid_to || null;
    const now = getBeijingTimestamp();
    if (metricId) {
        await execute(`
            UPDATE analysis_metric_definitions
            SET name = ?, description = ?, metric_config_json = ?::jsonb, unit = ?, scope = ?, allowed_units = ?, allowed_user_ids = ?,
                valid_from = ?, valid_to = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND user_id = ? AND dataset_id = ? AND deleted_at IS NULL
        `, [name, text(body.description, 1000), JSON.stringify(metricConfig), text(body.unit, 40), share.scope, share.allowedUnits, allowedUserIds, validFrom, validTo, now, metricId, user.id, dataset.id]);
        return metricRecord(await queryOne('SELECT * FROM analysis_metric_definitions WHERE id = ?', [metricId]));
    }
    const id = analysisId('metric');
    await execute(`
        INSERT INTO analysis_metric_definitions (id, dataset_id, user_id, name, description, metric_config_json, unit, scope, allowed_units, allowed_user_ids, valid_from, valid_to, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `, [id, dataset.id, user.id, name, text(body.description, 1000), JSON.stringify(metricConfig), text(body.unit, 40), share.scope, share.allowedUnits, allowedUserIds, validFrom, validTo, now, now]);
    return metricRecord(await queryOne('SELECT * FROM analysis_metric_definitions WHERE id = ?', [id]));
}

async function evaluateMetricDefinition(user, metricId) {
    const row = await queryOne('SELECT * FROM analysis_metric_definitions WHERE id = ? AND deleted_at IS NULL', [metricId]);
    if (!row || !canAccessSharedResource(row, user, false)) throw failure('指标不存在或无权访问。', 404);
    const now = Date.now();
    if (row.valid_from && Date.parse(row.valid_from) > now) throw failure('当前指标尚未生效。', 409, 'ANALYSIS_METRIC_NOT_ACTIVE');
    if (row.valid_to && Date.parse(row.valid_to) <= now) throw failure('当前指标已过期，请选择有效口径。', 409, 'ANALYSIS_METRIC_EXPIRED');
    const result = await require('./governance').evaluateMetric(user, row.dataset_id, parseJson(row.metric_config_json, {}));
    return { metric: metricRecord(row), result };
}

async function getDataModel(user, modelId, { write = false, includeRelations = true } = {}) {
    const row = await queryOne('SELECT * FROM analysis_data_models WHERE id = ? AND deleted_at IS NULL', [modelId]);
    if (!row || !canAccessSharedResource(row, user, write)) throw failure('数据模型不存在或无权访问。', 404);
    const model = { ...modelRecord(row), isOwner: Number(row.user_id) === Number(user.id) };
    if (includeRelations) {
        const relations = await query('SELECT * FROM analysis_data_model_relations WHERE model_id = ? ORDER BY created_at ASC', [row.id]);
        model.relations = relations.map(relationRecord);
    }
    return { row, model };
}

async function listDataModels(user, { limit = 100 } = {}) {
    const rows = await query('SELECT * FROM analysis_data_models WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?', [Math.min(Math.max(Number(limit) || 100, 1), 200)]);
    return rows.filter(row => canAccessSharedResource(row, user, false)).map(row => ({ ...modelRecord(row), isOwner: Number(row.user_id) === Number(user.id) }));
}

async function saveDataModel({ user, body = {}, modelId = '' }) {
    const name = text(body.name, 120);
    if (!name) throw failure('数据模型名称不能为空。');
    const fallback = modelId ? (await queryOne('SELECT * FROM analysis_data_models WHERE id = ?', [modelId])) || {} : {};
    if (modelId && Number(fallback.user_id) !== Number(user.id)) throw failure('数据模型不存在或无权编辑。', 404);
    const share = normalizeShareSettings(body, user, fallback);
    const allowedUserIds = await filterExistingShareUserIds(share.allowedUserIds, { excludeUserId: user.id });
    const now = getBeijingTimestamp();
    if (modelId) {
        await execute(`UPDATE analysis_data_models SET name = ?, description = ?, scope = ?, allowed_units = ?, allowed_user_ids = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?`, [name, text(body.description, 1000), share.scope, share.allowedUnits, allowedUserIds, now, modelId, user.id]);
        return (await getDataModel(user, modelId)).model;
    }
    const id = analysisId('model');
    await execute(`INSERT INTO analysis_data_models (id, user_id, name, description, scope, allowed_units, allowed_user_ids, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, user.id, name, text(body.description, 1000), share.scope, share.allowedUnits, allowedUserIds, now, now]);
    return (await getDataModel(user, id)).model;
}

async function relationQuality(left, right, input) {
    const { parquetPath: leftPath } = getDatasetPaths(left);
    const { parquetPath: rightPath } = getDatasetPaths(right);
    return await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const reader = await withDuckTimeout(connection, () => connection.runAndReadAll(`
                SELECT
                    (SELECT COUNT(*) FROM read_parquet(${sqlLiteral(leftPath)})) AS left_rows,
                    (SELECT COUNT(*) FROM read_parquet(${sqlLiteral(rightPath)})) AS right_rows,
                    (SELECT COUNT(DISTINCT ${sqlIdent(input.leftFieldKey)}) FROM read_parquet(${sqlLiteral(leftPath)})) AS left_distinct,
                    (SELECT COUNT(DISTINCT ${sqlIdent(input.rightFieldKey)}) FROM read_parquet(${sqlLiteral(rightPath)})) AS right_distinct
            `));
            const row = reader.getRowObjectsJson()[0] || {};
            return {
                leftRows: Number(row.left_rows) || 0,
                rightRows: Number(row.right_rows) || 0,
                leftDistinct: Number(row.left_distinct) || 0,
                rightDistinct: Number(row.right_distinct) || 0
            };
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });
}

async function addDataModelRelation({ user, modelId, body = {}, relationId = '' }) {
    const { row: model } = await getDataModel(user, modelId, { write: true, includeRelations: false });
    const leftDatasetId = text(body.leftDatasetId ?? body.left_dataset_id, 120);
    const rightDatasetId = text(body.rightDatasetId ?? body.right_dataset_id, 120);
    const leftFieldKey = text(body.leftFieldKey ?? body.left_field_key, 80);
    const rightFieldKey = text(body.rightFieldKey ?? body.right_field_key, 80);
    if (!leftDatasetId || !rightDatasetId || leftDatasetId === rightDatasetId || !leftFieldKey || !rightFieldKey) throw failure('请分别选择两个不同的数据集及其关联字段。');
    const [left, right] = await Promise.all([getDatasetForUser(user, leftDatasetId), getDatasetForUser(user, rightDatasetId)]);
    getColumn(left, leftFieldKey);
    getColumn(right, rightFieldKey);
    await Promise.all([require('./governance').assertDatasetFieldsAccessible(user, left, [leftFieldKey]), require('./governance').assertDatasetFieldsAccessible(user, right, [rightFieldKey])]);
    const requestedJoinType = String((body.joinType ?? body.join_type) || '').toLowerCase();
    const joinType = JOIN_TYPES.has(requestedJoinType) ? requestedJoinType : 'left';
    const cardinality = CARDINALITIES.has(String(body.cardinality || '').toLowerCase()) ? String(body.cardinality).toLowerCase() : 'many_to_one';
    const quality = await relationQuality(left, right, { leftFieldKey, rightFieldKey });
    const now = getBeijingTimestamp();
    if (relationId) {
        const existing = await queryOne('SELECT * FROM analysis_data_model_relations WHERE id = ? AND model_id = ? AND user_id = ?', [relationId, model.id, user.id]);
        if (!existing) throw failure('数据模型关联不存在或无权编辑。', 404);
        await execute(`UPDATE analysis_data_model_relations SET left_dataset_id = ?, left_field_key = ?, right_dataset_id = ?, right_field_key = ?, join_type = ?, cardinality = ?, quality_json = ?::jsonb, updated_at = ? WHERE id = ? AND model_id = ?`, [left.id, leftFieldKey, right.id, rightFieldKey, joinType, cardinality, JSON.stringify(quality), now, relationId, model.id]);
        await execute('UPDATE analysis_data_models SET version = version + 1, updated_at = ? WHERE id = ?', [now, model.id]);
        return relationRecord(await queryOne('SELECT * FROM analysis_data_model_relations WHERE id = ?', [relationId]));
    }
    const id = analysisId('relation');
    await transaction(async trx => {
        await trx.execute(`INSERT INTO analysis_data_model_relations (id, model_id, user_id, left_dataset_id, left_field_key, right_dataset_id, right_field_key, join_type, cardinality, status, quality_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?::jsonb, ?, ?)`, [id, model.id, user.id, left.id, leftFieldKey, right.id, rightFieldKey, joinType, cardinality, JSON.stringify(quality), now, now]);
        await trx.execute('UPDATE analysis_data_models SET version = version + 1, updated_at = ? WHERE id = ?', [now, model.id]);
    });
    return relationRecord(await queryOne('SELECT * FROM analysis_data_model_relations WHERE id = ?', [id]));
}

async function runDataModelJoin({ user, modelId, relationId = '', limit = 100 } = {}) {
    const { model } = await getDataModel(user, modelId);
    const relation = (model.relations || []).find(item => item.id === relationId || (!relationId && item.status === 'active'));
    if (!relation || relation.status !== 'active') throw failure('未找到可运行的数据模型关联。', 404);
    const [left, right] = await Promise.all([getDatasetForUser(user, relation.leftDatasetId), getDatasetForUser(user, relation.rightDatasetId)]);
    const [leftColumns, rightColumns] = await Promise.all([require('./governance').getAccessibleDatasetColumns(user, left), require('./governance').getAccessibleDatasetColumns(user, right)]);
    await Promise.all([require('./governance').assertDatasetFieldsAccessible(user, left, [relation.leftFieldKey]), require('./governance').assertDatasetFieldsAccessible(user, right, [relation.rightFieldKey])]);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 5000);
    const select = [
        ...leftColumns.slice(0, 40).map(column => `l.${sqlIdent(column.key)} AS ${sqlIdent(`左_${column.name}`)}`),
        ...rightColumns.slice(0, 40).map(column => `r.${sqlIdent(column.key)} AS ${sqlIdent(`右_${column.name}`)}`)
    ].join(', ');
    const rows = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const reader = await withDuckTimeout(connection, () => connection.runAndReadAll(`
                SELECT ${select}
                FROM read_parquet(${sqlLiteral(getDatasetPaths(left).parquetPath)}) l
                ${relation.joinType.toUpperCase()} JOIN read_parquet(${sqlLiteral(getDatasetPaths(right).parquetPath)}) r
                ON CAST(l.${sqlIdent(relation.leftFieldKey)} AS VARCHAR) = CAST(r.${sqlIdent(relation.rightFieldKey)} AS VARCHAR)
                LIMIT ${safeLimit + 1}
            `));
            return reader.getRowObjectsJson();
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });
    const truncated = rows.length > safeLimit;
    const result = truncated ? rows.slice(0, safeLimit) : rows;
    return { model, relation, columns: result.length ? Object.keys(result[0]) : [], rows: result, rowCount: result.length, truncated };
}

function queryJobRecord(row) {
    return {
        id: row.id, datasetId: row.dataset_id, status: row.status, progress: Number(row.progress || 0), attempts: Number(row.attempts || 0), maxAttempts: Number(row.max_attempts || 0),
        requestedLimit: Number(row.requested_limit || 0), columns: parseJson(row.result_columns_json, []), previewRows: parseJson(row.result_preview_json, []), hasFile: Boolean(row.result_file_path),
        lastError: row.last_error || '', createdAt: row.created_at, startedAt: row.started_at || null, completedAt: row.completed_at || null
    };
}

async function createAsyncQueryJob({ user, datasetId, sql, limit = 50_000 }) {
    const dataset = await getDatasetForUser(user, datasetId);
    const { validateUserSql } = require('./query-pivot');
    const safeSql = validateUserSql(sql);
    const safeLimit = Math.min(Math.max(Number(limit) || 50_000, 1), MAX_ASYNC_QUERY_ROWS);
    const id = analysisId('query_job');
    const now = getBeijingTimestamp();
    await execute(`INSERT INTO analysis_query_jobs (id, user_id, dataset_id, sql_text, requested_limit, status, progress, attempts, max_attempts, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, 3, ?, ?, ?)`, [id, user.id, dataset.id, safeSql, safeLimit, now, now, now]);
    return queryJobRecord(await queryOne('SELECT * FROM analysis_query_jobs WHERE id = ?', [id]));
}

async function getAsyncQueryJob(user, jobId) {
    const row = await queryOne('SELECT * FROM analysis_query_jobs WHERE id = ? AND user_id = ?', [jobId, user.id]);
    if (!row) throw failure('异步查询任务不存在或无权访问。', 404);
    return queryJobRecord(row);
}

async function listAsyncQueryJobs(user, { datasetId = '', limit = 30 } = {}) {
    const rows = await query(`SELECT * FROM analysis_query_jobs WHERE user_id = ? ${datasetId ? 'AND dataset_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`, datasetId ? [user.id, datasetId, Math.min(Math.max(Number(limit) || 30, 1), 100)] : [user.id, Math.min(Math.max(Number(limit) || 30, 1), 100)]);
    return rows.map(queryJobRecord);
}

async function cancelAsyncQueryJob(user, jobId) {
    const row = await queryOne('SELECT * FROM analysis_query_jobs WHERE id = ? AND user_id = ?', [jobId, user.id]);
    if (!row) throw failure('异步查询任务不存在或无权操作。', 404);
    if (['succeeded', 'failed', 'cancelled'].includes(row.status)) return queryJobRecord(row);
    const now = getBeijingTimestamp();
    await execute(`UPDATE analysis_query_jobs SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [now, now, jobId, user.id]);
    return await getAsyncQueryJob(user, jobId);
}

async function claimAsyncQueryJob() {
    return await transaction(async trx => {
        const row = await trx.queryOne(`SELECT * FROM analysis_query_jobs WHERE status IN ('queued', 'retry_wait') AND next_run_at <= ? ORDER BY next_run_at ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [getBeijingTimestamp()]);
        if (!row) return null;
        const now = getBeijingTimestamp();
        await trx.execute(`UPDATE analysis_query_jobs SET status = 'running', progress = 5, attempts = attempts + 1, locked_at = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`, [now, now, now, row.id]);
        return { ...row, attempts: Number(row.attempts || 0) + 1 };
    });
}

async function executeAsyncQueryJob(job) {
    const owner = await resolveAnalysisUser(job.user_id);
    if (!owner) throw new Error('异步查询任务所属账号已失效。');
    const dataset = await getDatasetForUser(owner, job.dataset_id);
    const allowedColumns = await require('./governance').getAccessibleDatasetColumns(owner, dataset);
    const { buildQuerySelectList } = require('./query-pivot');
    const outputDir = resolveInside(exportRoot, String(owner.id));
    await fs.promises.mkdir(outputDir, { recursive: true });
    const outputPath = resolveInside(outputDir, `${job.id}.parquet`);
    const { instance, connection } = await createDuckConnection();
    try {
        await withDuckTimeout(connection, () => connection.run(`CREATE TABLE data AS SELECT ${buildQuerySelectList(dataset, allowedColumns)} FROM read_parquet(${sqlLiteral(getDatasetPaths(dataset).parquetPath)})`), ASYNC_QUERY_TIMEOUT_MS);
        // sql_text 已由 validateUserSql 拒绝外部读取、写入与多语句；用户查询只引用受控 data 临时表。
        // DuckDB 的 external access 是实例启动项，不能在运行中重新开启，因此把受控 COPY 与用户 SQL 分离为 result 内表。
        await withDuckTimeout(connection, () => connection.run(`CREATE TABLE result AS SELECT * FROM (${job.sql_text}) AS _q LIMIT ${Number(job.requested_limit) + 1}`), ASYNC_QUERY_TIMEOUT_MS);
        await withDuckTimeout(connection, () => connection.run(`COPY result TO ${sqlLiteral(outputPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`), ASYNC_QUERY_TIMEOUT_MS);
    } finally {
        connection.closeSync();
        instance.closeSync();
    }
    const previewRows = await withAnalysisSlot(() => parquetToRows(outputPath, { limit: 100 }));
    const columns = previewRows.length ? Object.keys(previewRows[0]) : [];
    const now = getBeijingTimestamp();
    await execute(`UPDATE analysis_query_jobs SET status = 'succeeded', progress = 100, result_columns_json = ?::jsonb, result_preview_json = ?::jsonb, result_file_path = ?, completed_at = ?, locked_at = NULL, last_error = '', updated_at = ? WHERE id = ? AND status = 'running'`, [JSON.stringify(columns), JSON.stringify(previewRows), toProjectRelative(outputPath), now, now, job.id]);
    await recordArtifact({ userId: owner.id, datasetId: dataset.id, type: 'async_query', title: job.sql_text.slice(0, 120), filePath: outputPath, metadata: { jobId: job.id, requestedLimit: Number(job.requested_limit), previewRows: previewRows.length } });
    return { columns, previewRows, filePath: outputPath };
}

let asyncQueryRunning = false;
let asyncQueryRunner = null;

async function processAsyncQueryJobs({ limit = 2 } = {}) {
    if (asyncQueryRunning) return { skipped: true, processed: 0 };
    asyncQueryRunning = true;
    let processed = 0;
    try {
        for (let index = 0; index < Math.min(Math.max(Number(limit) || 2, 1), 8); index += 1) {
            const job = await claimAsyncQueryJob();
            if (!job) break;
            try {
                await executeAsyncQueryJob(job);
            } catch (error) {
                const now = getBeijingTimestamp();
                const retry = Number(job.attempts || 0) < Number(job.max_attempts || 3);
                const backoffMs = Math.min(60_000, 5_000 * (2 ** Math.max(0, Number(job.attempts || 1) - 1)));
                const retryAt = getBeijingTimestamp(new Date(Date.now() + backoffMs));
                await execute(`UPDATE analysis_query_jobs SET status = ?, progress = 0, last_error = ?, next_run_at = ?, locked_at = NULL, completed_at = CASE WHEN ? THEN NULL ELSE ?::timestamptz END, updated_at = ? WHERE id = ?`, [retry ? 'retry_wait' : 'failed', String(error?.message || '异步查询失败').slice(0, 1000), retry ? retryAt : now, retry, now, now, job.id]);
            }
            processed += 1;
        }
        return { skipped: false, processed };
    } finally {
        asyncQueryRunning = false;
    }
}

function startAsyncQueryRunner({ intervalMs = readTypedEnv('DATA_ANALYSIS_ASYNC_QUERY_POLL_INTERVAL_MS'), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    if (asyncQueryRunner) return asyncQueryRunner;
    const safeInterval = Math.max(1_000, Math.min(Number(intervalMs) || 3_000, 60_000));
    let timer = null;
    let stopped = false;
    const tick = async () => {
        await processAsyncQueryJobs().catch(() => {});
        if (!stopped) { timer = setTimeoutFn(tick, safeInterval); timer?.unref?.(); }
    };
    timer = setTimeoutFn(tick, Math.min(safeInterval, 2_000));
    timer?.unref?.();
    asyncQueryRunner = { stop() { stopped = true; if (timer) clearTimeoutFn(timer); asyncQueryRunner = null; } };
    return asyncQueryRunner;
}

module.exports = {
    listMetricDefinitions,
    saveMetricDefinition,
    evaluateMetricDefinition,
    getDataModel,
    listDataModels,
    saveDataModel,
    addDataModelRelation,
    runDataModelJoin,
    createAsyncQueryJob,
    getAsyncQueryJob,
    listAsyncQueryJobs,
    cancelAsyncQueryJob,
    processAsyncQueryJobs,
    startAsyncQueryRunner
};
