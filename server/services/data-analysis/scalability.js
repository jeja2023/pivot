'use strict';

// 开发环境的数据规模化基础。所有文件均驻留在受控的数据集目录中，
// 版本、分区和物化结果由 PostgreSQL 元数据审计；不接受裸路径或用户 SQL。
const fs = require('fs');
const path = require('path');
const { query, queryOne, execute, transaction } = require('../../db/client');
const {
    analysisId,
    datasetRoot,
    resolveInside,
    toProjectRelative,
    jsonParse,
    sqlIdent,
    sqlLiteral,
    getDatasetForUser,
    getDatasetPaths,
    resolveAnalysisUser,
    createDuckConnection,
    withAnalysisSlot,
    parquetToRows,
    getBeijingTimestamp
} = require('./shared');
const { assertDatasetFieldsAccessible } = require('./governance');
const { numericValueSql } = require('./numeric-values');

const AGGREGATIONS = new Set(['count', 'sum', 'avg', 'min', 'max']);
const MAX_GROUP_FIELDS = 4;
const MAX_METRICS = 12;

function invalid(message, status = 400, code = 'ANALYSIS_SCALABILITY_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function text(value, max = 100) {
    return String(value ?? '').replace(/[\u0000\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, max);
}

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    return jsonParse(value, fallback);
}

function datasetDirectory(dataset) {
    return resolveInside(datasetRoot, String(dataset.user_id), String(dataset.id));
}

function parseColumns(dataset) {
    return parseJson(dataset.columns_json, []);
}

function serializeVersion(row) {
    return {
        id: row.id,
        datasetId: row.dataset_id,
        version: Number(row.version || 1),
        operation: row.operation || 'import',
        rowCount: Number(row.row_count || 0),
        columnCount: Number(row.column_count || 0),
        manifest: parseJson(row.manifest_json, {}),
        createdAt: row.created_at || null
    };
}

function serializeMaterialization(row) {
    return {
        id: row.id,
        datasetId: row.dataset_id,
        name: row.name,
        config: parseJson(row.config_json, {}),
        sourceVersion: Number(row.source_version || 1),
        status: row.status || 'ready',
        rowCount: Number(row.row_count || 0),
        columns: parseJson(row.columns_json, []),
        previewRows: parseJson(row.preview_json, []),
        lastError: row.last_error || '',
        version: Number(row.version || 1),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

async function requireWritableDataset(user, datasetId) {
    const actor = await resolveAnalysisUser(user);
    if (!actor) throw invalid('当前账号不可用。', 401, 'ANALYSIS_ACCOUNT_UNAVAILABLE');
    return { actor, dataset: await getDatasetForUser(actor, datasetId, { write: true }) };
}

async function appendIncrementalDataset(options) {
    return withAnalysisSlot(() => require('./bi/increments').appendDatasetVersion(options), { userId: options.user.id });
}

async function createDatasetPartitions(options) {
    return withAnalysisSlot(() => createDatasetPartitionsInSlot(options), { userId: options.user.id });
}

async function createDatasetPartitionsInSlot({ user, datasetId, fieldKey }) {
    const { actor, dataset } = await requireWritableDataset(user, datasetId);
    const column = parseColumns(dataset).find(item => item.key === String(fieldKey || '').trim());
    if (!column) throw invalid('请选择有效的分区字段。');
    await assertDatasetFieldsAccessible(actor, dataset, [column.key]);
    const version = Number(dataset.source_version || 1);
    const root = resolveInside(datasetDirectory(dataset), 'partitions', `v${version}`, column.key);
    const { parquetPath } = getDatasetPaths(dataset);
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const groups = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            await connection.run(`COPY (SELECT * FROM read_parquet(${sqlLiteral(parquetPath)})) TO ${sqlLiteral(root)} (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (${sqlIdent(column.key)}))`);
            const result = await connection.runAndReadAll(`
                SELECT COALESCE(CAST(${sqlIdent(column.key)} AS VARCHAR), '__NULL__') AS field_value,
                       COUNT(*) AS row_count
                FROM read_parquet(${sqlLiteral(parquetPath)})
                GROUP BY field_value
                ORDER BY field_value
            `);
            return result.getRowObjectsJson();
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    }, { userId: user.id });
    const now = getBeijingTimestamp();
    await transaction(async trx => {
        await trx.execute('DELETE FROM analysis_dataset_partitions WHERE dataset_id = ?', [dataset.id]);
        for (const group of groups) {
            await trx.execute(`
                INSERT INTO analysis_dataset_partitions (
                    dataset_id, user_id, dataset_version, field_key, field_value, row_count, partition_root_path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [dataset.id, actor.id, version, column.key, text(group.field_value, 500) || '__NULL__', Number(group.row_count || 0), toProjectRelative(root), now]);
        }
        await trx.execute(`
            UPDATE analysis_datasets
            SET storage_mode = 'managed_fs_partitioned', partition_root_path = ?, partition_field_key = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [toProjectRelative(root), column.key, now, dataset.id, actor.id]);
    });
    return { datasetId: dataset.id, sourceVersion: version, fieldKey: column.key, partitionCount: groups.length, partitions: groups.map(group => ({ value: String(group.field_value), rowCount: Number(group.row_count || 0) })) };
}

function normalizeMaterializationConfig(input, columns) {
    const source = input && typeof input === 'object' ? input : {};
    const byKey = new Map(columns.map(column => [column.key, column]));
    const groupBy = [...new Set((Array.isArray(source.groupBy) ? source.groupBy : []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, MAX_GROUP_FIELDS);
    if (groupBy.some(key => !byKey.has(key))) throw invalid('物化聚合包含不存在的分组字段。');
    const metrics = (Array.isArray(source.metrics) ? source.metrics : []).slice(0, MAX_METRICS).map((item, index) => {
        const aggregation = String(item?.aggregation || 'count').toLowerCase();
        const fieldKey = String(item?.fieldKey || '').trim();
        if (!AGGREGATIONS.has(aggregation)) throw invalid('物化聚合方式不受支持。');
        if (aggregation !== 'count' && !byKey.has(fieldKey)) throw invalid('求和、均值、最小值和最大值需要有效字段。');
        return { key: `m_${index + 1}`, name: text(item?.name, 80) || `${aggregation}_${fieldKey || 'rows'}`, aggregation, fieldKey };
    });
    if (!metrics.length) metrics.push({ key: 'm_1', name: '记录数', aggregation: 'count', fieldKey: '' });
    return { groupBy, metrics };
}

function materializationSql(config) {
    const groups = config.groupBy.map(key => sqlIdent(key));
    const metrics = config.metrics.map(metric => {
        if (metric.aggregation === 'count') return `COUNT(*) AS ${sqlIdent(metric.key)}`;
        return `${metric.aggregation.toUpperCase()}(${numericValueSql(sqlIdent(metric.fieldKey))}) AS ${sqlIdent(metric.key)}`;
    });
    const select = [...groups, ...metrics].join(', ');
    return { select, groupBy: groups.length ? ` GROUP BY ${groups.join(', ')}` : '' };
}

async function saveMaterialization(options) {
    return withAnalysisSlot(() => saveMaterializationInSlot(options), { userId: options.user.id });
}

async function saveMaterializationInSlot({ user, datasetId, materializationId = '', body = {} }) {
    const { actor, dataset } = await requireWritableDataset(user, datasetId);
    const columns = parseColumns(dataset);
    const name = text(body.name, 120);
    if (!name) throw invalid('请填写物化聚合名称。');
    const config = normalizeMaterializationConfig(body, columns);
    const accessFields = [...config.groupBy, ...config.metrics.map(metric => metric.fieldKey).filter(Boolean)];
    await assertDatasetFieldsAccessible(actor, dataset, accessFields);
    const existing = materializationId
        ? await queryOne('SELECT * FROM analysis_materializations WHERE id = ? AND dataset_id = ? AND user_id = ? AND deleted_at IS NULL', [materializationId, dataset.id, actor.id])
        : null;
    if (materializationId && !existing) throw invalid('物化聚合不存在或无权修改。', 404, 'ANALYSIS_MATERIALIZATION_NOT_FOUND');
    const id = existing?.id || analysisId('mat');
    const resultPath = resolveInside(datasetDirectory(dataset), 'materializations', `${id}.parquet`);
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true, mode: 0o700 });
    const { parquetPath } = getDatasetPaths(dataset);
    const sql = materializationSql(config);
    let resultColumns = [];
    let rowCount = 0;
    await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const source = `SELECT ${sql.select} FROM read_parquet(${sqlLiteral(parquetPath)})${sql.groupBy}`;
            await connection.run(`COPY (${source}) TO ${sqlLiteral(resultPath)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
            const summary = await connection.runAndReadAll(`SELECT COUNT(*) AS row_count FROM read_parquet(${sqlLiteral(resultPath)})`);
            rowCount = Number(summary.getRowObjectsJson()[0]?.row_count || 0);
            resultColumns = [
                ...config.groupBy.map(key => ({ key, name: columns.find(column => column.key === key)?.name || key })),
                ...config.metrics.map(metric => ({ key: metric.key, name: metric.name }))
            ];
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    }, { userId: user.id });
    const previewRows = await parquetToRows(resultPath, { limit: 100 });
    const now = getBeijingTimestamp();
    if (existing) {
        await execute(`
            UPDATE analysis_materializations
            SET name = ?, config_json = ?::jsonb, source_version = ?, status = 'ready', result_file_path = ?,
                row_count = ?, columns_json = ?::jsonb, preview_json = ?::jsonb, last_error = '',
                version = version + 1, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [name, JSON.stringify(config), Number(dataset.source_version || 1), toProjectRelative(resultPath), rowCount, JSON.stringify(resultColumns), JSON.stringify(previewRows), now, id, actor.id]);
    } else {
        await execute(`
            INSERT INTO analysis_materializations (
                id, dataset_id, user_id, name, config_json, source_version, status, result_file_path,
                row_count, columns_json, preview_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?::jsonb, ?, 'ready', ?, ?, ?::jsonb, ?::jsonb, ?, ?)
        `, [id, dataset.id, actor.id, name, JSON.stringify(config), Number(dataset.source_version || 1), toProjectRelative(resultPath), rowCount, JSON.stringify(resultColumns), JSON.stringify(previewRows), now, now]);
    }
    return serializeMaterialization(await queryOne('SELECT * FROM analysis_materializations WHERE id = ?', [id]));
}

async function listMaterializations(user, datasetId) {
    const actor = await resolveAnalysisUser(user);
    const dataset = await getDatasetForUser(actor, datasetId);
    const rows = await query(`
        SELECT * FROM analysis_materializations
        WHERE dataset_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
    `, [dataset.id]);
    const accessible = await require('./governance').getAccessibleDatasetColumns(actor, dataset);
    const allowed = new Set(accessible.map(column => column.key));
    return rows.filter(row => {
        const config = parseJson(row.config_json, {});
        const fields = [...(config.groupBy || []), ...(config.metrics || []).map(metric => metric.fieldKey).filter(Boolean)];
        return Number(row.user_id) === Number(dataset.user_id) && fields.every(key => allowed.has(key));
    }).map(row => {
        const item = serializeMaterialization(row);
        if (Number(item.sourceVersion) !== Number(dataset.source_version || 1)) return { ...item, status: 'stale', previewRows: [], lastError: '来源数据或字段规则已变化，请刷新物化结果。' };
        return item;
    });
}

async function getScalabilityState(user, datasetId) {
    const actor = await resolveAnalysisUser(user);
    const dataset = await getDatasetForUser(actor, datasetId);
    const allowedFields = new Set((await require('./governance').getAccessibleDatasetColumns(actor, dataset)).map(column => column.key));
    const [versions, partitions, materializations] = await Promise.all([
        query('SELECT * FROM analysis_dataset_versions WHERE dataset_id = ? ORDER BY version DESC', [dataset.id]),
        query('SELECT field_key, field_value, row_count, dataset_version FROM analysis_dataset_partitions WHERE dataset_id = ? ORDER BY field_key, field_value', [dataset.id]),
        listMaterializations(actor, dataset.id)
    ]);
    return {
        storageMode: dataset.storage_mode || 'managed_fs',
        sourceVersion: Number(dataset.source_version || 1),
        partitionFieldKey: dataset.partition_field_key || '',
        versions: versions.map(serializeVersion),
        partitions: partitions.filter(row => allowedFields.has(row.field_key)).map(row => ({ fieldKey: row.field_key, value: row.field_value, rowCount: Number(row.row_count || 0), sourceVersion: Number(row.dataset_version || 1) })),
        materializations
    };
}

module.exports = {
    appendIncrementalDataset,
    createDatasetPartitions,
    saveMaterialization,
    listMaterializations,
    getScalabilityState
};
