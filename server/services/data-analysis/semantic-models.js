'use strict';

const { query, queryOne, execute } = require('../../db/client');
const { canAccessSharedResource, normalizeShareScope, normalizeShareSettings } = require('../unit-visibility');
const { filterExistingShareUserIds } = require('../share-targets');
const modelRepository = require('../../repositories/analysis-models');
const { listVisible } = require('../../repositories/analysis-assets');
const { relationQuality } = require('./relation-quality');
const {
    analysisId,
    jsonParse,
    sqlIdent,
    sqlLiteral,
    getDatasetForUser,
    getDatasetPaths,
    getColumn,
    createDuckConnection,
    withDuckTimeout,
    withAnalysisSlot,
    getBeijingTimestamp
} = require('./shared');

const METRIC_AGGREGATIONS = new Set(['count', 'sum', 'avg', 'min', 'max']);
const JOIN_TYPES = new Set(['inner', 'left']);
const CARDINALITIES = new Set(['one_to_one', 'one_to_many', 'many_to_one', 'many_to_many']);

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
        id: row.id, userId: Number(row.user_id), name: row.name, description: row.description || '', modelKind: row.model_kind || 'exploration',
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
    if (datasetId) await getDatasetForUser(user, datasetId);
    const rows = await listVisible('analysis_metric_definitions', user, { datasetId, limit });
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
    if (fallback.model_id) throw failure('正式模型指标请在数据建模草稿中维护。', 409, 'ANALYSIS_MODEL_UPGRADE_REQUIRED');
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
    if (row.model_id) throw failure('正式模型指标请通过发布版本的统一分析接口计算。', 409, 'ANALYSIS_MODEL_UPGRADE_REQUIRED');
    const now = Date.now();
    if (row.valid_from && Date.parse(row.valid_from) > now) throw failure('当前指标尚未生效。', 409, 'ANALYSIS_METRIC_NOT_ACTIVE');
    if (row.valid_to && Date.parse(row.valid_to) <= now) throw failure('当前指标已过期，请选择有效口径。', 409, 'ANALYSIS_METRIC_EXPIRED');
    const result = await require('./governance').evaluateMetric(user, row.dataset_id, parseJson(row.metric_config_json, {}));
    return { metric: metricRecord(row), result };
}

async function getDataModel(user, modelId, { write = false, includeRelations = true } = {}) {
    const row = await queryOne('SELECT m.*, u.username AS owner_name FROM analysis_data_models m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.deleted_at IS NULL', [modelId]);
    if (!row || !canAccessSharedResource(row, user, write)) throw failure('数据模型不存在或无权访问。', 404);
    if (row.model_kind === 'production') return require('./bi/models').getProductionModel(user, modelId, { write });
    const owner = Number(row.user_id) === Number(user.id);
    const ownerName = row.owner_name || (owner ? (user.username || '当前用户') : `用户 ${row.user_id}`);
    const model = { ...modelRecord(row), ownerName, isOwner: owner };
    if (includeRelations) {
        const relations = await query('SELECT * FROM analysis_data_model_relations WHERE model_id = ? ORDER BY created_at ASC, id ASC', [row.id]);
        model.relations = relations.map(relationRecord);
    }
    return { row, model };
}

async function listDataModels(user, { limit = 100 } = {}) {
    return require('./bi/catalog').list(user, { limit });
}

async function saveDataModel({ user, body = {}, modelId = '' }) {
    if ((body.modelKind !== undefined || body.model_kind !== undefined) && !['production', 'exploration'].includes(body.modelKind ?? body.model_kind)) throw failure('模型类型无效。');
    if (!modelId && (body.modelKind === 'production' || body.model_kind === 'production')) return require('./bi/models').createProductionModel({ user, body });
    const name = text(body.name, 120);
    if (!name) throw failure('数据模型名称不能为空。');
    const fallback = modelId ? (await queryOne('SELECT * FROM analysis_data_models WHERE id = ?', [modelId])) || {} : {};
    if (modelId && Number(fallback.user_id) !== Number(user.id)) throw failure('数据模型不存在或无权编辑。', 404);
    if (fallback.model_kind === 'production') return require('./bi/models').updateProductionModel({ user, modelId, body });
    const share = normalizeShareSettings(body, user, fallback);
    const allowedUserIds = await filterExistingShareUserIds(share.allowedUserIds, { excludeUserId: user.id });
    const now = getBeijingTimestamp();
    if (modelId) {
        await modelRepository.updateModel({ userId: user.id, modelId, expectedVersion: body.expectedVersion, name, description: text(body.description, 1000), share: { ...share, allowedUserIds } });
        return (await getDataModel(user, modelId)).model;
    }
    const id = analysisId('model');
    await execute(`INSERT INTO analysis_data_models (id, user_id, name, description, scope, allowed_units, allowed_user_ids, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, user.id, name, text(body.description, 1000), share.scope, share.allowedUnits, allowedUserIds, now, now]);
    return (await getDataModel(user, id)).model;
}

async function prepareRelation(user, body) {
    const leftDatasetId = text(body.leftDatasetId ?? body.left_dataset_id, 120);
    const rightDatasetId = text(body.rightDatasetId ?? body.right_dataset_id, 120);
    let leftFieldKey = text(body.leftFieldKey ?? body.left_field_key, 80);
    let rightFieldKey = text(body.rightFieldKey ?? body.right_field_key, 80);
    if (!leftDatasetId || !rightDatasetId || leftDatasetId === rightDatasetId || !leftFieldKey || !rightFieldKey) throw failure('请分别选择两个不同的数据集及其关联字段。');
    const [left, right] = await Promise.all([getDatasetForUser(user, leftDatasetId), getDatasetForUser(user, rightDatasetId)]);
    leftFieldKey = getColumn(left, leftFieldKey).key;
    rightFieldKey = getColumn(right, rightFieldKey).key;
    await Promise.all([require('./governance').assertDatasetFieldsAccessible(user, left, [leftFieldKey]), require('./governance').assertDatasetFieldsAccessible(user, right, [rightFieldKey])]);
    const requestedJoinType = String((body.joinType ?? body.join_type) || '').toLowerCase();
    if (requestedJoinType && !JOIN_TYPES.has(requestedJoinType)) throw failure('当前仅支持左关联或内关联，请重新选择。');
    const joinType = JOIN_TYPES.has(requestedJoinType) ? requestedJoinType : 'left';
    const requestedCardinality = String(body.cardinality || '').toLowerCase();
    if (requestedCardinality && !CARDINALITIES.has(requestedCardinality)) throw failure('关联对应基数无效，请重新选择。');
    const cardinality = requestedCardinality || 'many_to_one';
    const quality = await relationQuality(left, right, { leftFieldKey, rightFieldKey, joinType, cardinality, userId: user.id });
    const current = await Promise.all([getDatasetForUser(user, leftDatasetId), getDatasetForUser(user, rightDatasetId)]);
    if (current.some((dataset, index) => Number(dataset.source_version || 1) !== Number([left, right][index].source_version || 1))) throw failure('检查期间数据或字段规则已变化，请重新检查关联质量。', 409);
    await Promise.all(current.map((dataset, index) => require('./governance').assertDatasetFieldsAccessible(user, dataset, [index ? rightFieldKey : leftFieldKey])));
    return { leftDatasetId, leftFieldKey, rightDatasetId, rightFieldKey, joinType, cardinality, quality };
}

async function previewDataModelRelation({ user, modelId, body = {} }) {
    const { row } = await getDataModel(user, modelId, { write: true, includeRelations: false });
    if (row.model_kind === 'production') throw failure('请在数据建模工作区编辑正式模型草稿。', 409, 'ANALYSIS_MODEL_UPGRADE_REQUIRED');
    const relation = await prepareRelation(user, body);
    return { quality: relation.quality, warnings: relation.quality.warnings };
}

async function addDataModelRelation({ user, modelId, body = {}, relationId = '' }) {
    const { row: model } = await getDataModel(user, modelId, { write: true, includeRelations: false });
    if (model.model_kind === 'production') throw failure('请在数据建模工作区编辑正式模型草稿。', 409, 'ANALYSIS_MODEL_UPGRADE_REQUIRED');
    const prepared = await prepareRelation(user, body);
    const id = relationId || analysisId('relation');
    const values = { ...prepared, editing: Boolean(relationId) };
    const saved = await modelRepository.saveRelation({ userId: user.id, modelId: model.id, expectedVersion: body.expectedVersion, relationId: id, values,
        validate: (rows, existing) => {
            const candidate = { id, status: 'active', ...values };
            const relations = rows.map(row => row.id === existing?.id ? candidate : relationRecord(row));
            if (!existing) relations.push(candidate);
            require('./model-analysis').planRelations(relations);
        }
    });
    return relationRecord(saved);
}

async function deleteDataModel({ user, modelId, expectedVersion }) {
    return modelRepository.removeModel({ userId: user.id, modelId, expectedVersion });
}

async function deleteDataModelRelation({ user, modelId, relationId, expectedVersion }) {
    return modelRepository.removeRelation({ userId: user.id, modelId, relationId, expectedVersion,
        validate: rows => { if (rows.length) require('./model-analysis').planRelations(rows.map(relationRecord)); }
    });
}

async function runDataModelJoin(options) {
    return withAnalysisSlot(() => runDataModelJoinInSlot(options), { userId: options.user.id });
}

async function runDataModelJoinInSlot({ user, modelId, relationId = '', limit = 100 } = {}) {
    const { model } = await getDataModel(user, modelId);
    if (model.modelKind === 'production') throw failure('正式模型请使用统一指标分析接口。', 409, 'ANALYSIS_MODEL_UPGRADE_REQUIRED');
    const relation = (model.relations || []).find(item => item.id === relationId || (!relationId && item.status === 'active'));
    if (!relation || relation.status !== 'active') throw failure('未找到可运行的数据模型关联。', 404);
    const [left, right] = await Promise.all([getDatasetForUser(user, relation.leftDatasetId), getDatasetForUser(user, relation.rightDatasetId)]);
    const [leftColumns, rightColumns] = await Promise.all([require('./governance').getAccessibleDatasetColumns(user, left), require('./governance').getAccessibleDatasetColumns(user, right)]);
    await Promise.all([require('./governance').assertDatasetFieldsAccessible(user, left, [relation.leftFieldKey]), require('./governance').assertDatasetFieldsAccessible(user, right, [relation.rightFieldKey])]);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 5000);
    const quality = await relationQuality(left, right, { ...relation, userId: user.id });
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
    }, { userId: user.id });
    const truncated = rows.length > safeLimit;
    const result = truncated ? rows.slice(0, safeLimit) : rows;
    return { model, relation: { ...relation, quality }, warnings: quality.warnings, columns: result.length ? Object.keys(result[0]) : [...leftColumns.slice(0, 40).map(column => `左_${column.name}`), ...rightColumns.slice(0, 40).map(column => `右_${column.name}`)], rows: result, rowCount: result.length, truncated };
}

module.exports = {
    listMetricDefinitions,
    saveMetricDefinition,
    evaluateMetricDefinition,
    getDataModel,
    listDataModels,
    saveDataModel,
    addDataModelRelation,
    previewDataModelRelation,
    deleteDataModel,
    deleteDataModelRelation,
    runDataModelJoin,
    ...require('./async-query-jobs')
};
