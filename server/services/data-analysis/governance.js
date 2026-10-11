'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, queryOne, execute, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { computeNextCronDate } = require('../cron-expression');
const { readTypedEnv } = require('../../config/env-registry');
const { canAccessSharedResource, normalizeShareScope, normalizeShareSettings } = require('../unit-visibility');
const { filterExistingShareUserIds } = require('../share-targets');
const {
    analysisId,
    datasetRoot,
    ensureAnalysisDirs,
    resolveInside,
    toProjectRelative,
    jsonParse,
    sqlIdent,
    sqlLiteral,
    getDatasetForUser,
    getDatasetPaths,
    serializeDataset,
    resolveAnalysisUser,
    createDuckConnection,
    withDuckTimeout,
    withAnalysisSlot,
    bestEffortRemove,
    normalizeDatasetName,
    MAX_PREVIEW_ROWS,
    DATA_ANALYSIS_QUERY_TIMEOUT_MS,
    getBeijingTimestamp: sharedTimestamp
} = require('./shared');
const { profileViaSql } = require('./profile');

const FIELD_TYPES = new Set(['auto', 'text', 'number', 'date', 'boolean']);
const SENSITIVITIES = new Set(['public', 'internal', 'confidential', 'restricted']);
const VIEW_TYPES = new Set(['query', 'pivot', 'chart']);
const DASHBOARD_ITEM_TYPES = new Set(['query', 'pivot', 'chart', 'metric']);
const ALERT_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']);
const MAX_VIEW_CONFIG_BYTES = 64 * 1024;
const MAX_DASHBOARD_ITEMS = 60;
const MAX_ALERTS_PER_USER = 100;
const MAX_SCHEDULES_PER_USER = 100;
const MIN_SCHEDULE_INTERVAL_MINUTES = 5;
const MAX_SCHEDULE_INTERVAL_MINUTES = 24 * 60;

function invalid(message, status = 400, code = 'ANALYSIS_GOVERNANCE_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function boundedText(value, max = 500) {
    return String(value ?? '').replace(/[\u0000\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, max);
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    return jsonParse(value, fallback);
}

function serializePosition(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const integer = (field, fallback, min, max) => {
        const current = Number.parseInt(source[field], 10);
        return Number.isFinite(current) ? Math.max(min, Math.min(max, current)) : fallback;
    };
    return {
        x: integer('x', 0, 0, 100),
        y: integer('y', 0, 0, 10000),
        width: integer('width', 6, 2, 12),
        height: integer('height', 4, 2, 12)
    };
}

function normalizeConfig(value, maxBytes = MAX_VIEW_CONFIG_BYTES) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!source) throw invalid('配置必须是对象。');
    const json = JSON.stringify(source);
    if (Buffer.byteLength(json, 'utf8') > maxBytes) throw invalid(`配置过大，最多允许 ${Math.floor(maxBytes / 1024)} KB。`);
    return source;
}

function normalizeFieldGovernance(input = {}) {
    const logicalType = FIELD_TYPES.has(String(input.logicalType ?? input.logical_type ?? 'auto').toLowerCase())
        ? String(input.logicalType ?? input.logical_type ?? 'auto').toLowerCase()
        : 'auto';
    const sensitivity = SENSITIVITIES.has(String(input.sensitivity || 'internal').toLowerCase())
        ? String(input.sensitivity || 'internal').toLowerCase()
        : 'internal';
    return {
        displayName: boundedText(input.displayName ?? input.display_name, 80),
        logicalType,
        unit: boundedText(input.unit, 40),
        dateFormat: boundedText(input.dateFormat ?? input.date_format, 60),
        sensitivity,
        businessDefinition: boundedText(input.businessDefinition ?? input.business_definition, 1000),
        isDimension: input.isDimension === true || input.is_dimension === true,
        isMetric: input.isMetric === true || input.is_metric === true,
        status: input.status === 'archived' ? 'archived' : 'active',
        metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}
    };
}

function fieldRecord(row = {}) {
    return {
        datasetId: row.dataset_id,
        fieldKey: row.field_key,
        displayName: row.display_name || '',
        logicalType: row.logical_type || 'auto',
        unit: row.unit || '',
        dateFormat: row.date_format || '',
        sensitivity: row.sensitivity || 'internal',
        businessDefinition: row.business_definition || '',
        isDimension: row.is_dimension === true,
        isMetric: row.is_metric === true,
        status: row.status || 'active',
        revision: Number(row.revision || 1),
        metadata: parseJson(row.metadata_json, {}),
        updatedAt: row.updated_at || null
    };
}

async function listFieldGovernance(user, datasetId) {
    const dataset = await getDatasetForUser(user, datasetId);
    const rows = await query(`
        SELECT * FROM analysis_field_governance
        WHERE dataset_id = ? AND user_id = ?
        ORDER BY field_key ASC
    `, [dataset.id, dataset.user_id]);
    const byKey = new Map(rows.map(row => [row.field_key, fieldRecord(row)]));
    const columns = parseJson(dataset.columns_json, []);
    return columns.map(column => ({
        fieldKey: column.key,
        sourceName: column.name,
        ...(byKey.get(column.key) || {
            datasetId: dataset.id,
            fieldKey: column.key,
            displayName: column.name,
            logicalType: 'auto',
            unit: '',
            dateFormat: '',
            sensitivity: 'internal',
            businessDefinition: '',
            isDimension: false,
            isMetric: false,
            status: 'active',
            revision: 0,
            metadata: {},
            updatedAt: null
        })
    }));
}

async function fieldGovernanceMap(datasetId) {
    const rows = await query(`
        SELECT field_key, display_name, sensitivity, logical_type, unit, date_format,
               business_definition, is_dimension, is_metric, status, revision
        FROM analysis_field_governance
        WHERE dataset_id = ? AND status = 'active'
    `, [datasetId]);
    return new Map(rows.map(row => [row.field_key, fieldRecord(row)]));
}

async function getAccessibleDatasetColumns(user, dataset) {
    const actor = await resolveAnalysisUser(user);
    const columns = parseJson(dataset?.columns_json, []);
    if (!actor || Number(actor.id) === Number(dataset?.user_id)) return columns;
    const governance = await fieldGovernanceMap(dataset.id);
    return columns.filter(column => {
        const sensitivity = governance.get(column.key)?.sensitivity || 'internal';
        return !['confidential', 'restricted'].includes(sensitivity);
    });
}

async function assertDatasetFieldsAccessible(user, dataset, fieldKeys = []) {
    const requested = [...new Set((Array.isArray(fieldKeys) ? fieldKeys : [fieldKeys]).map(value => String(value || '').trim()).filter(Boolean))];
    if (!requested.length) return;
    const allowed = new Set((await getAccessibleDatasetColumns(user, dataset)).map(column => column.key));
    const blocked = requested.find(key => !allowed.has(key));
    if (blocked) throw invalid(`字段“${blocked}”包含受限数据，当前共享权限不能访问或导出。`, 403, 'ANALYSIS_FIELD_ACCESS_DENIED');
}

async function updateFieldGovernance({ user, datasetId, fields = [] }) {
    const dataset = await getDatasetForUser(user, datasetId, { write: true });
    const columns = parseJson(dataset.columns_json, []);
    const profile = parseJson(dataset.profile_json, []);
    const byKey = new Map(columns.map(column => [column.key, column]));
    const requested = Array.isArray(fields) ? fields.slice(0, columns.length) : [];
    if (!requested.length) throw invalid('请至少提交一个字段治理配置。');
    const seen = new Set();
    const now = sharedTimestamp();
    const nextColumns = columns.map(column => ({ ...column }));
    const nextProfile = profile.map(column => ({ ...column }));
    await transaction(async trx => {
        for (const raw of requested) {
            const fieldKey = boundedText(raw?.fieldKey ?? raw?.field_key, 80);
            if (!fieldKey || !byKey.has(fieldKey) || seen.has(fieldKey)) throw invalid(`字段不存在或重复：${fieldKey || '未填写'}`);
            seen.add(fieldKey);
            const normalized = normalizeFieldGovernance(raw);
            const column = nextColumns.find(item => item.key === fieldKey);
            const profileColumn = nextProfile.find(item => item.key === fieldKey);
            const displayName = normalized.displayName || column.name;
            column.name = displayName;
            if (profileColumn) profileColumn.name = displayName;
            await trx.execute(`
                INSERT INTO analysis_field_governance (
                    dataset_id, user_id, field_key, display_name, logical_type, unit, date_format,
                    sensitivity, business_definition, is_dimension, is_metric, status, revision,
                    metadata_json, updated_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?::jsonb, ?, ?, ?)
                ON CONFLICT (dataset_id, field_key) DO UPDATE SET
                    display_name = EXCLUDED.display_name, logical_type = EXCLUDED.logical_type,
                    unit = EXCLUDED.unit, date_format = EXCLUDED.date_format,
                    sensitivity = EXCLUDED.sensitivity, business_definition = EXCLUDED.business_definition,
                    is_dimension = EXCLUDED.is_dimension, is_metric = EXCLUDED.is_metric,
                    status = EXCLUDED.status, metadata_json = EXCLUDED.metadata_json,
                    updated_by = EXCLUDED.updated_by, revision = analysis_field_governance.revision + 1,
                    updated_at = EXCLUDED.updated_at
            `, [
                dataset.id, dataset.user_id, fieldKey, displayName, normalized.logicalType,
                normalized.unit, normalized.dateFormat, normalized.sensitivity, normalized.businessDefinition,
                normalized.isDimension, normalized.isMetric, normalized.status, JSON.stringify(normalized.metadata),
                user.id, now, now
            ]);
        }
        await trx.execute(`
            UPDATE analysis_datasets
            SET columns_json = ?, profile_json = ?, source_version = source_version + 1, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [JSON.stringify(nextColumns), JSON.stringify(nextProfile), now, dataset.id, dataset.user_id]);
    });
    return { dataset: serializeDataset(await getDatasetForUser(user, datasetId)), fields: await listFieldGovernance(user, datasetId) };
}

function normalizeFormula(input = {}, columns = []) {
    const name = boundedText(input.name ?? input.displayName ?? input.display_name, 80);
    const expression = String(input.expression || '').trim().slice(0, 1000);
    if (!name || !expression) throw invalid('请填写计算字段名称和表达式。');
    if (/[;"'`\\]|--|\/\*/.test(expression)) throw invalid('计算表达式只能使用字段占位符、数字、括号、四则运算和允许的函数。');
    const allowedKeys = new Set(columns.map(column => String(column.key)));
    const dependencies = [];
    const sqlExpression = expression.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, fieldKey) => {
        if (!allowedKeys.has(fieldKey)) throw invalid(`计算表达式引用了不存在的字段：${fieldKey}`);
        if (!dependencies.includes(fieldKey)) dependencies.push(fieldKey);
        return `TRY_CAST(${sqlIdent(fieldKey)} AS DOUBLE)`;
    });
    if (!dependencies.length) throw invalid('计算表达式至少需要引用一个字段，占位符格式为 {{c_1}}。');
    if (/\{\{|\}\}/.test(sqlExpression)) throw invalid('计算字段占位符格式无效。');
    if (!/^[\s0-9A-Za-z_+\-*/().,"]+$/.test(sqlExpression)) throw invalid('计算表达式包含不允许的字符。');
    const words = sqlExpression.replace(/"c_[0-9]+"/g, '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    const allowedWords = new Set(['TRY_CAST', 'AS', 'DOUBLE', 'ABS', 'ROUND', 'COALESCE', 'NULLIF']);
    const unknown = words.find(word => !allowedWords.has(word.toUpperCase()));
    if (unknown) throw invalid(`计算表达式包含不允许的标识符：${unknown}`);
    return {
        name,
        expression,
        sqlExpression,
        dependencies,
        unit: boundedText(input.unit, 40),
        sensitivity: SENSITIVITIES.has(String(input.sensitivity || 'internal').toLowerCase()) ? String(input.sensitivity).toLowerCase() : 'internal'
    };
}

async function previewCalculatedField({ user, datasetId, input = {} }) {
    const dataset = await getDatasetForUser(user, datasetId, { write: true });
    const columns = parseJson(dataset.columns_json, []);
    const formula = normalizeFormula(input, columns);
    const { parquetPath } = getDatasetPaths(dataset);
    const rows = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const reader = await withDuckTimeout(connection, () => connection.runAndReadAll(`
                SELECT ${columns.slice(0, 8).map(column => sqlIdent(column.key)).join(', ')},
                       (${formula.sqlExpression}) AS calculated_value
                FROM read_parquet(${sqlLiteral(parquetPath)})
                LIMIT 20
            `));
            return reader.getRowObjectsJson();
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });
    return { formula: { name: formula.name, expression: formula.expression, dependencies: formula.dependencies }, rows };
}

function calculatedFieldKey() {
    return `calc_${crypto.randomBytes(6).toString('hex')}`;
}

async function materializeCalculatedField({ user, datasetId, input = {} }) {
    const source = await getDatasetForUser(user, datasetId, { write: true });
    const columns = parseJson(source.columns_json, []);
    const formula = normalizeFormula(input, columns);
    await ensureAnalysisDirs();
    const outputDatasetId = analysisId('ds');
    const calculationId = analysisId('calc');
    const fieldKey = calculatedFieldKey();
    const outputDir = resolveInside(datasetRoot, String(user.id), outputDatasetId);
    const outputPath = resolveInside(outputDir, 'data.parquet');
    const outputName = normalizeDatasetName('', input.datasetName || input.dataset_name || `${source.name}（${formula.name}）`);
    const outputColumns = [...columns.map(column => ({ ...column })), { key: fieldKey, name: formula.name, index: columns.length }];
    let committed = false;
    await fs.promises.mkdir(outputDir, { recursive: true });
    try {
        await withAnalysisSlot(async () => {
            const { instance, connection } = await createDuckConnection();
            try {
                await withDuckTimeout(connection, () => connection.run(`
                    COPY (
                        SELECT *, CAST((${formula.sqlExpression}) AS VARCHAR) AS ${sqlIdent(fieldKey)}
                        FROM read_parquet(${sqlLiteral(getDatasetPaths(source).parquetPath)})
                    ) TO ${sqlLiteral(outputPath)} (FORMAT PARQUET, COMPRESSION ZSTD)
                `));
            } finally {
                connection.closeSync();
                instance.closeSync();
            }
        });
        const profile = await profileViaSql(outputPath, outputColumns, Number(source.row_count) || 0);
        const now = sharedTimestamp();
        await transaction(async trx => {
            await trx.execute(`
                INSERT INTO analysis_datasets (
                    id, user_id, name, original_name, file_type, file_size, source_path, parquet_path,
                    row_count, column_count, source_row_count, source_column_count, truncated, truncation_reason,
                    columns_json, profile_json, preview_json, sheet_name, status, scope, allowed_units,
                    allowed_user_ids, parent_dataset_id, source_version, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'calculated', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '', 'ready', ?, ?, ?, ?, 1, ?, ?)
            `, [
                outputDatasetId, user.id, outputName, `${source.name}-${formula.name}.parquet`,
                (await fs.promises.stat(outputPath)).size, toProjectRelative(outputPath), Number(source.row_count) || 0,
                outputColumns.length, Number(source.source_row_count || source.row_count) || 0, outputColumns.length,
                source.truncated ? 1 : 0, source.truncation_reason || '', JSON.stringify(outputColumns), JSON.stringify(profile),
                'personal', '', '', source.id, now, now
            ]);
            await trx.execute(`
                INSERT INTO analysis_calculated_fields (
                    id, dataset_id, output_dataset_id, user_id, field_key, name, expression,
                    dependencies_json, logical_type, unit, sensitivity, status, version, preview_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'number', ?, ?, 'active', 1, '[]'::jsonb, ?, ?)
            `, [calculationId, source.id, outputDatasetId, user.id, fieldKey, formula.name, formula.expression,
                JSON.stringify(formula.dependencies), formula.unit, formula.sensitivity, now, now]);
        });
        committed = true;
        return {
            calculation: {
                id: calculationId, datasetId: source.id, outputDatasetId, fieldKey, name: formula.name,
                expression: formula.expression, dependencies: formula.dependencies, version: 1
            },
            dataset: serializeDataset(await getDatasetForUser(user, outputDatasetId))
        };
    } finally {
        if (!committed) bestEffortRemove(outputDir, { recursive: true });
    }
}

async function listCalculatedFields(user, datasetId) {
    const dataset = await getDatasetForUser(user, datasetId);
    const rows = await query(`
        SELECT * FROM analysis_calculated_fields
        WHERE dataset_id = ? AND user_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
    `, [dataset.id, dataset.user_id]);
    return rows.map(row => ({
        id: row.id, datasetId: row.dataset_id, outputDatasetId: row.output_dataset_id || '', fieldKey: row.field_key,
        name: row.name, expression: row.expression, dependencies: parseJson(row.dependencies_json, []),
        logicalType: row.logical_type, unit: row.unit || '', sensitivity: row.sensitivity || 'internal',
        status: row.status, version: Number(row.version || 1), createdAt: row.created_at, updatedAt: row.updated_at
    }));
}

function savedViewRecord(row) {
    return {
        id: row.id, datasetId: row.dataset_id, userId: Number(row.user_id), name: row.name,
        description: row.description || '', viewType: row.view_type, config: parseJson(row.config_json, {}),
        sourceVersion: Number(row.source_version || 1), scope: normalizeShareScope(row.scope),
        allowedUnits: row.allowed_units || '', allowedUserIds: row.allowed_user_ids || '', version: Number(row.version || 1),
        createdAt: row.created_at, updatedAt: row.updated_at, isOwner: false
    };
}

async function listSavedViews(user, { datasetId = '', limit = 100 } = {}) {
    const userRecord = await resolveAnalysisUser(user);
    if (!userRecord) return [];
    const rows = await query(`
        SELECT * FROM analysis_saved_views
        WHERE deleted_at IS NULL ${datasetId ? 'AND dataset_id = ?' : ''}
        ORDER BY updated_at DESC LIMIT ?
    `, datasetId ? [datasetId, Math.min(Math.max(Number(limit) || 100, 1), 200)] : [Math.min(Math.max(Number(limit) || 100, 1), 200)]);
    return rows.filter(row => canAccessSharedResource(row, userRecord, false)).map(row => ({ ...savedViewRecord(row), isOwner: Number(row.user_id) === Number(userRecord.id) }));
}

async function saveAnalysisView({ user, datasetId, body = {}, viewId = '' }) {
    const dataset = await getDatasetForUser(user, datasetId, { write: true });
    const name = boundedText(body.name, 120);
    const viewType = String((body.viewType ?? body.view_type) || '').toLowerCase();
    if (!name || !VIEW_TYPES.has(viewType)) throw invalid('请填写视图名称，并选择查询、透视或图表类型。');
    const config = normalizeConfig(body.config);
    const share = normalizeShareSettings(body, user, viewId ? (await queryOne('SELECT * FROM analysis_saved_views WHERE id = ?', [viewId])) || {} : {});
    const allowedUserIds = await filterExistingShareUserIds(share.allowedUserIds, { excludeUserId: user.id });
    const now = sharedTimestamp();
    if (viewId) {
        const existing = await queryOne('SELECT * FROM analysis_saved_views WHERE id = ? AND deleted_at IS NULL', [viewId]);
        if (!existing || Number(existing.user_id) !== Number(user.id) || existing.dataset_id !== dataset.id) throw invalid('分析视图不存在或无权编辑。', 404);
        await execute(`
            UPDATE analysis_saved_views
            SET name = ?, description = ?, view_type = ?, config_json = ?::jsonb, source_version = ?,
                scope = ?, allowed_units = ?, allowed_user_ids = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [name, boundedText(body.description, 500), viewType, JSON.stringify(config), Number(dataset.source_version || 1),
            share.scope, share.allowedUnits, allowedUserIds, now, viewId, user.id]);
        return savedViewRecord(await queryOne('SELECT * FROM analysis_saved_views WHERE id = ?', [viewId]));
    }
    const id = analysisId('view');
    await execute(`
        INSERT INTO analysis_saved_views (
            id, dataset_id, user_id, name, description, view_type, config_json, source_version,
            scope, allowed_units, allowed_user_ids, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, 1, ?, ?)
    `, [id, dataset.id, user.id, name, boundedText(body.description, 500), viewType, JSON.stringify(config),
        Number(dataset.source_version || 1), share.scope, share.allowedUnits, allowedUserIds, now, now]);
    return savedViewRecord(await queryOne('SELECT * FROM analysis_saved_views WHERE id = ?', [id]));
}

async function getSavedView(user, viewId, { write = false } = {}) {
    const row = await queryOne('SELECT * FROM analysis_saved_views WHERE id = ? AND deleted_at IS NULL', [viewId]);
    if (!row || !canAccessSharedResource(row, user, write)) throw invalid('分析视图不存在或无权访问。', 404);
    return { row, view: { ...savedViewRecord(row), isOwner: Number(row.user_id) === Number(user.id) } };
}

async function runSavedView(user, viewId) {
    const { row, view } = await getSavedView(user, viewId);
    // 视图自身可共享不代表数据自动可共享；运行前再次验证调用者对源数据集的读取权。
    await getDatasetForUser(user, row.dataset_id);
    const owner = await resolveAnalysisUser(row.user_id);
    if (!owner) throw invalid('分析视图所属账号已失效。', 409);
    const config = view.config || {};
    if (view.viewType === 'query') return { view, result: await require('./query-pivot').runUserQuery(owner.id, row.dataset_id, config) };
    if (view.viewType === 'pivot') return { view, result: await require('./query-pivot').runPivot(owner.id, row.dataset_id, config) };
    return { view, result: await require('./chart-summary').buildChart(owner.id, row.dataset_id, config) };
}

async function deleteSavedView(user, viewId) {
    const { row } = await getSavedView(user, viewId, { write: true });
    await execute('UPDATE analysis_saved_views SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?', [sharedTimestamp(), sharedTimestamp(), row.id, user.id]);
    return { id: row.id };
}

function dashboardRecord(row) {
    return {
        id: row.id, userId: Number(row.user_id), name: row.name, description: row.description || '',
        scope: normalizeShareScope(row.scope), allowedUnits: row.allowed_units || '', allowedUserIds: row.allowed_user_ids || '',
        version: Number(row.version || 1), lastSnapshot: parseJson(row.last_snapshot_json, {}),
        lastRefreshedAt: row.last_refreshed_at || null, createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function dashboardItemRecord(row) {
    return {
        id: row.id, dashboardId: row.dashboard_id, datasetId: row.dataset_id, savedViewId: row.saved_view_id || '',
        title: row.title || '', itemType: row.item_type, position: parseJson(row.position_json, {}),
        config: parseJson(row.config_json, {}), version: Number(row.version || 1), createdAt: row.created_at, updatedAt: row.updated_at
    };
}

async function listDashboards(user, { limit = 100 } = {}) {
    const rows = await query('SELECT * FROM analysis_dashboards WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?', [Math.min(Math.max(Number(limit) || 100, 1), 200)]);
    return rows.filter(row => canAccessSharedResource(row, user, false)).map(row => ({ ...dashboardRecord(row), isOwner: Number(row.user_id) === Number(user.id) }));
}

async function getDashboard(user, dashboardId, { write = false, includeItems = true } = {}) {
    const row = await queryOne('SELECT * FROM analysis_dashboards WHERE id = ? AND deleted_at IS NULL', [dashboardId]);
    if (!row || !canAccessSharedResource(row, user, write)) throw invalid('仪表盘不存在或无权访问。', 404);
    const dashboard = { ...dashboardRecord(row), isOwner: Number(row.user_id) === Number(user.id) };
    if (includeItems) {
        const items = await query('SELECT * FROM analysis_dashboard_items WHERE dashboard_id = ? ORDER BY (position_json->>\'y\')::int ASC, created_at ASC', [row.id]);
        const visibleItems = [];
        for (const item of items) {
            try {
                await getDatasetForUser(user, item.dataset_id);
                visibleItems.push(dashboardItemRecord(item));
            } catch (_error) {
                // 旧数据中的仪表盘若尚未同步共享数据集，不能通过快照绕过数据集权限。
                visibleItems.push({ ...dashboardItemRecord(item), itemType: 'restricted', config: {}, accessDenied: true });
            }
        }
        dashboard.items = visibleItems;
        if (!dashboard.isOwner && Array.isArray(dashboard.lastSnapshot?.items)) {
            const hidden = new Set(visibleItems.filter(item => item.accessDenied).map(item => item.id));
            dashboard.lastSnapshot = { ...dashboard.lastSnapshot, items: dashboard.lastSnapshot.items.map(item => hidden.has(item.itemId) ? { itemId: item.itemId, status: 'access_denied', error: '当前共享权限不允许查看该项目数据。' } : item) };
        }
    }
    return { row, dashboard };
}

async function saveDashboard({ user, body = {}, dashboardId = '' }) {
    const name = boundedText(body.name, 120);
    if (!name) throw invalid('仪表盘名称不能为空。');
    const fallback = dashboardId ? (await queryOne('SELECT * FROM analysis_dashboards WHERE id = ?', [dashboardId])) || {} : {};
    if (dashboardId && Number(fallback.user_id) !== Number(user.id)) throw invalid('仪表盘不存在或无权编辑。', 404);
    const share = normalizeShareSettings(body, user, fallback);
    const allowedUserIds = await filterExistingShareUserIds(share.allowedUserIds, { excludeUserId: user.id });
    const now = sharedTimestamp();
    if (dashboardId) {
        await execute(`
            UPDATE analysis_dashboards
            SET name = ?, description = ?, scope = ?, allowed_units = ?, allowed_user_ids = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        `, [name, boundedText(body.description, 1000), share.scope, share.allowedUnits, allowedUserIds, now, dashboardId, user.id]);
        return (await getDashboard(user, dashboardId)).dashboard;
    }
    const id = analysisId('dash');
    await execute(`
        INSERT INTO analysis_dashboards (id, user_id, name, description, scope, allowed_units, allowed_user_ids, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `, [id, user.id, name, boundedText(body.description, 1000), share.scope, share.allowedUnits, allowedUserIds, now, now]);
    return (await getDashboard(user, id)).dashboard;
}

async function saveDashboardItem({ user, dashboardId, body = {}, itemId = '' }) {
    const { row: dashboard } = await getDashboard(user, dashboardId, { write: true, includeItems: false });
    const itemType = String((body.itemType ?? body.item_type) || 'chart').toLowerCase();
    if (!DASHBOARD_ITEM_TYPES.has(itemType)) throw invalid('仪表盘项目类型无效。');
    const datasetId = String((body.datasetId ?? body.dataset_id) || '').trim();
    if (!datasetId) throw invalid('请选择仪表盘项目的数据集。');
    const dataset = await getDatasetForUser(user, datasetId);
    if (normalizeShareScope(dashboard.scope) === 'shared'
        && (Number(dataset.user_id) !== Number(user.id) || normalizeShareScope(dataset.scope) !== 'shared')) {
        throw invalid('共享仪表盘只能引用当前所有者已共享的数据集；请先在数据集治理中配置共享范围。', 409, 'ANALYSIS_DASHBOARD_SOURCE_NOT_SHARED');
    }
    const config = normalizeConfig(body.config);
    const savedViewId = String((body.savedViewId ?? body.saved_view_id) || '').trim();
    if (savedViewId) await getSavedView(user, savedViewId);
    const count = await queryOne('SELECT COUNT(*) AS count FROM analysis_dashboard_items WHERE dashboard_id = ?', [dashboard.id]);
    if (!itemId && Number(count?.count || 0) >= MAX_DASHBOARD_ITEMS) throw invalid(`单个仪表盘最多包含 ${MAX_DASHBOARD_ITEMS} 个项目。`, 409);
    const now = sharedTimestamp();
    const position = serializePosition(body.position);
    if (itemId) {
        const existing = await queryOne('SELECT * FROM analysis_dashboard_items WHERE id = ? AND dashboard_id = ?', [itemId, dashboard.id]);
        if (!existing || Number(existing.user_id) !== Number(user.id)) throw invalid('仪表盘项目不存在或无权编辑。', 404);
        await execute(`
            UPDATE analysis_dashboard_items
            SET dataset_id = ?, saved_view_id = ?, title = ?, item_type = ?, position_json = ?::jsonb,
                config_json = ?::jsonb, version = version + 1, updated_at = ?
            WHERE id = ? AND dashboard_id = ? AND user_id = ?
        `, [datasetId, savedViewId || null, boundedText(body.title, 120), itemType, JSON.stringify(position), JSON.stringify(config), now, itemId, dashboard.id, user.id]);
        await execute('UPDATE analysis_dashboards SET version = version + 1, updated_at = ? WHERE id = ?', [now, dashboard.id]);
        return dashboardItemRecord(await queryOne('SELECT * FROM analysis_dashboard_items WHERE id = ?', [itemId]));
    }
    const id = analysisId('widget');
    await transaction(async trx => {
        await trx.execute(`
            INSERT INTO analysis_dashboard_items (id, dashboard_id, dataset_id, saved_view_id, user_id, title, item_type, position_json, config_json, version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, 1, ?, ?)
        `, [id, dashboard.id, datasetId, savedViewId || null, user.id, boundedText(body.title, 120), itemType, JSON.stringify(position), JSON.stringify(config), now, now]);
        await trx.execute('UPDATE analysis_dashboards SET version = version + 1, updated_at = ? WHERE id = ?', [now, dashboard.id]);
    });
    return dashboardItemRecord(await queryOne('SELECT * FROM analysis_dashboard_items WHERE id = ?', [id]));
}

async function deleteDashboardItem({ user, dashboardId, itemId }) {
    const { row: dashboard } = await getDashboard(user, dashboardId, { write: true, includeItems: false });
    const changed = await execute('DELETE FROM analysis_dashboard_items WHERE id = ? AND dashboard_id = ? AND user_id = ?', [itemId, dashboard.id, user.id]);
    if (!changed) throw invalid('仪表盘项目不存在或无权删除。', 404);
    await execute('UPDATE analysis_dashboards SET version = version + 1, updated_at = ? WHERE id = ?', [sharedTimestamp(), dashboard.id]);
    return { id: itemId };
}

async function executeDashboardItem(owner, item) {
    const config = item.config || {};
    if (item.savedViewId) return (await runSavedView(owner, item.savedViewId)).result;
    if (item.itemType === 'query') return await require('./query-pivot').runUserQuery(owner.id, item.datasetId, config);
    if (item.itemType === 'pivot') return await require('./query-pivot').runPivot(owner.id, item.datasetId, config);
    if (item.itemType === 'metric') return await evaluateMetric(owner, item.datasetId, config);
    return await require('./chart-summary').buildChart(owner.id, item.datasetId, config);
}

async function refreshDashboard({ user, dashboardId, scheduleId = null }) {
    const { row, dashboard } = await getDashboard(user, dashboardId, { write: true });
    const owner = await resolveAnalysisUser(row.user_id);
    if (!owner) throw invalid('仪表盘所属账号已失效。', 409);
    const runId = analysisId('refresh');
    const now = sharedTimestamp();
    await execute(`
        INSERT INTO analysis_refresh_runs (id, schedule_id, dashboard_id, user_id, status, created_at, updated_at, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
    `, [runId, scheduleId, row.id, owner.id, now, now, now]);
    try {
        const results = [];
        for (const item of dashboard.items || []) {
            try {
                results.push({ itemId: item.id, title: item.title, status: 'succeeded', result: await executeDashboardItem(owner, item) });
            } catch (error) {
                results.push({ itemId: item.id, title: item.title, status: 'failed', error: String(error?.message || '项目刷新失败').slice(0, 500) });
            }
        }
        const snapshot = { refreshedAt: now, version: dashboard.version, items: results };
        await transaction(async trx => {
            await trx.execute('UPDATE analysis_dashboards SET last_snapshot_json = ?::jsonb, last_refreshed_at = ?, updated_at = ? WHERE id = ?', [JSON.stringify(snapshot), now, now, row.id]);
            await trx.execute(`UPDATE analysis_refresh_runs SET status = 'succeeded', result_json = ?::jsonb, completed_at = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(snapshot), now, now, runId]);
        });
        return { runId, dashboardId: row.id, snapshot };
    } catch (error) {
        await execute(`UPDATE analysis_refresh_runs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [String(error?.message || '仪表盘刷新失败').slice(0, 1000), sharedTimestamp(), sharedTimestamp(), runId]);
        throw error;
    }
}

function nextScheduleTime(frequency, cronExpression, intervalMinutes, from = new Date()) {
    if (frequency === 'manual') return null;
    if (frequency === 'cron') {
        const next = computeNextCronDate(cronExpression, from);
        return next ? getBeijingTimestamp(next) : null;
    }
    const minutes = Math.min(Math.max(Number(intervalMinutes) || 60, MIN_SCHEDULE_INTERVAL_MINUTES), MAX_SCHEDULE_INTERVAL_MINUTES);
    return getBeijingTimestamp(new Date(from.getTime() + minutes * 60 * 1000));
}

function normalizeSchedule(input = {}) {
    const frequency = ['manual', 'interval', 'cron'].includes(String(input.frequency || 'manual')) ? String(input.frequency || 'manual') : 'manual';
    const intervalMinutes = Math.min(Math.max(Number.parseInt(input.intervalMinutes ?? input.interval_minutes, 10) || 60, MIN_SCHEDULE_INTERVAL_MINUTES), MAX_SCHEDULE_INTERVAL_MINUTES);
    const cronExpression = boundedText(input.cronExpression ?? input.cron_expression, 100);
    if (frequency === 'cron' && !computeNextCronDate(cronExpression, new Date())) throw invalid('刷新 Cron 表达式无效。');
    return { frequency, intervalMinutes, cronExpression, status: input.status === 'paused' ? 'paused' : 'active' };
}

async function listRefreshSchedules(user, { dashboardId = '' } = {}) {
    const rows = await query(`
        SELECT * FROM analysis_refresh_schedules
        WHERE user_id = ? ${dashboardId ? 'AND dashboard_id = ?' : ''}
        ORDER BY status ASC, next_run_at ASC NULLS LAST, updated_at DESC
    `, dashboardId ? [user.id, dashboardId] : [user.id]);
    return rows.map(row => ({
        id: row.id, dashboardId: row.dashboard_id || '', datasetId: row.dataset_id || '', name: row.name,
        frequency: row.frequency, cronExpression: row.cron_expression || '', intervalMinutes: Number(row.interval_minutes || 0),
        status: row.status, nextRunAt: row.next_run_at || null, lastRunAt: row.last_run_at || null,
        lastStatus: row.last_status, lastError: row.last_error || '', failureCount: Number(row.failure_count || 0)
    }));
}

async function saveRefreshSchedule({ user, body = {}, scheduleId = '' }) {
    const dashboardId = String((body.dashboardId ?? body.dashboard_id) || '').trim();
    const datasetId = String((body.datasetId ?? body.dataset_id) || '').trim();
    if (!dashboardId && !datasetId) throw invalid('请关联仪表盘或数据集。');
    if (dashboardId) await getDashboard(user, dashboardId, { write: true, includeItems: false });
    if (datasetId) await getDatasetForUser(user, datasetId, { write: true });
    const name = boundedText(body.name, 120);
    if (!name) throw invalid('刷新计划名称不能为空。');
    const config = normalizeSchedule(body);
    const now = new Date();
    const nextRunAt = config.status === 'active' ? nextScheduleTime(config.frequency, config.cronExpression, config.intervalMinutes, now) : null;
    const timestamp = sharedTimestamp();
    if (scheduleId) {
        const existing = await queryOne('SELECT * FROM analysis_refresh_schedules WHERE id = ? AND user_id = ?', [scheduleId, user.id]);
        if (!existing) throw invalid('刷新计划不存在或无权编辑。', 404);
        await execute(`
            UPDATE analysis_refresh_schedules
            SET dashboard_id = ?, dataset_id = ?, name = ?, frequency = ?, cron_expression = ?, interval_minutes = ?,
                status = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND user_id = ?
        `, [dashboardId || null, datasetId || null, name, config.frequency, config.cronExpression, config.intervalMinutes, config.status, nextRunAt, timestamp, scheduleId, user.id]);
        return (await listRefreshSchedules(user)).find(item => item.id === scheduleId);
    }
    const id = analysisId('refresh_schedule');
    await execute(`
        INSERT INTO analysis_refresh_schedules (id, user_id, dashboard_id, dataset_id, name, frequency, cron_expression, interval_minutes, status, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, user.id, dashboardId || null, datasetId || null, name, config.frequency, config.cronExpression, config.intervalMinutes, config.status, nextRunAt, timestamp, timestamp]);
    return (await listRefreshSchedules(user)).find(item => item.id === id);
}

async function evaluateMetric(user, datasetId, config = {}) {
    const dataset = await getDatasetForUser(user, datasetId);
    const columns = parseJson(dataset.columns_json, []);
    const fieldKey = boundedText(config.fieldKey ?? config.field_key, 80);
    const aggregation = ['count', 'sum', 'avg', 'min', 'max'].includes(String(config.aggregation || '').toLowerCase())
        ? String(config.aggregation).toLowerCase()
        : 'count';
    if (aggregation !== 'count' && !columns.some(column => column.key === fieldKey)) throw invalid('指标字段不存在。');
    const expression = aggregation === 'count' ? 'COUNT(*)' : `${aggregation.toUpperCase()}(TRY_CAST(${sqlIdent(fieldKey)} AS DOUBLE))`;
    const { parquetPath } = getDatasetPaths(dataset);
    const rows = await withAnalysisSlot(async () => {
        const { instance, connection } = await createDuckConnection();
        try {
            const reader = await withDuckTimeout(connection, () => connection.runAndReadAll(`SELECT ${expression} AS value FROM read_parquet(${sqlLiteral(parquetPath)})`));
            return reader.getRowObjectsJson();
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    });
    return { datasetId: dataset.id, fieldKey: aggregation === 'count' ? '' : fieldKey, aggregation, value: Number(rows[0]?.value || 0), sourceVersion: Number(dataset.source_version || 1) };
}

async function saveAlertRule({ user, body = {}, alertId = '' }) {
    const datasetId = String((body.datasetId ?? body.dataset_id) || '').trim();
    if (!datasetId) throw invalid('请选择告警数据集。');
    await getDatasetForUser(user, datasetId, { write: true });
    const name = boundedText(body.name, 120);
    if (!name) throw invalid('告警名称不能为空。');
    const operator = ALERT_OPERATORS.has(String(body.operator || 'gt')) ? String(body.operator || 'gt') : 'gt';
    const threshold = Number(body.threshold);
    if (!Number.isFinite(threshold)) throw invalid('告警阈值必须是数值。');
    const metricConfig = normalizeConfig(body.metricConfig ?? body.metric_config ?? {});
    const cooldownMinutes = Math.min(Math.max(Number.parseInt(body.cooldownMinutes ?? body.cooldown_minutes, 10) || 60, 1), 7 * 24 * 60);
    const dashboardId = String((body.dashboardId ?? body.dashboard_id) || '').trim();
    if (dashboardId) await getDashboard(user, dashboardId, { write: true, includeItems: false });
    const now = sharedTimestamp();
    const count = await queryOne('SELECT COUNT(*) AS count FROM analysis_alert_rules WHERE user_id = ?', [user.id]);
    if (!alertId && Number(count?.count || 0) >= MAX_ALERTS_PER_USER) throw invalid(`每个账号最多创建 ${MAX_ALERTS_PER_USER} 条数据告警。`, 409);
    if (alertId) {
        const existing = await queryOne('SELECT * FROM analysis_alert_rules WHERE id = ? AND user_id = ?', [alertId, user.id]);
        if (!existing) throw invalid('数据告警不存在或无权编辑。', 404);
        await execute(`
            UPDATE analysis_alert_rules SET dashboard_id = ?, dataset_id = ?, name = ?, metric_config_json = ?::jsonb,
                operator = ?, threshold = ?, status = ?, cooldown_minutes = ?, updated_at = ? WHERE id = ? AND user_id = ?
        `, [dashboardId || null, datasetId, name, JSON.stringify(metricConfig), operator, threshold, body.status === 'paused' ? 'paused' : 'active', cooldownMinutes, now, alertId, user.id]);
        return await getAlertRule(user, alertId);
    }
    const id = analysisId('alert');
    await execute(`
        INSERT INTO analysis_alert_rules (id, user_id, dashboard_id, dataset_id, name, metric_config_json, operator, threshold, status, cooldown_minutes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?)
    `, [id, user.id, dashboardId || null, datasetId, name, JSON.stringify(metricConfig), operator, threshold, body.status === 'paused' ? 'paused' : 'active', cooldownMinutes, now, now]);
    return await getAlertRule(user, id);
}

function alertRecord(row) {
    return {
        id: row.id, dashboardId: row.dashboard_id || '', datasetId: row.dataset_id, name: row.name,
        metricConfig: parseJson(row.metric_config_json, {}), operator: row.operator, threshold: Number(row.threshold),
        status: row.status, cooldownMinutes: Number(row.cooldown_minutes || 60), lastTriggeredAt: row.last_triggered_at || null,
        lastValue: row.last_value === null || row.last_value === undefined ? null : Number(row.last_value)
    };
}

async function getAlertRule(user, alertId) {
    const row = await queryOne('SELECT * FROM analysis_alert_rules WHERE id = ? AND user_id = ?', [alertId, user.id]);
    if (!row) throw invalid('数据告警不存在或无权访问。', 404);
    return alertRecord(row);
}

async function listAlertRules(user, { datasetId = '' } = {}) {
    const rows = await query(`SELECT * FROM analysis_alert_rules WHERE user_id = ? ${datasetId ? 'AND dataset_id = ?' : ''} ORDER BY updated_at DESC`, datasetId ? [user.id, datasetId] : [user.id]);
    return rows.map(alertRecord);
}

function compareAlert(value, operator, threshold) {
    if (operator === 'gte') return value >= threshold;
    if (operator === 'lt') return value < threshold;
    if (operator === 'lte') return value <= threshold;
    if (operator === 'eq') return value === threshold;
    if (operator === 'neq') return value !== threshold;
    return value > threshold;
}

async function evaluateAlertRulesForDataset(user, datasetId) {
    const rows = await query('SELECT * FROM analysis_alert_rules WHERE user_id = ? AND dataset_id = ? AND status = \'active\' ORDER BY updated_at ASC', [user.id, datasetId]);
    const now = Date.now();
    const triggered = [];
    for (const row of rows) {
        const alert = alertRecord(row);
        const value = Number((await evaluateMetric(user, datasetId, alert.metricConfig)).value);
        const lastTime = row.last_triggered_at ? Date.parse(row.last_triggered_at) : 0;
        const eligible = !lastTime || now - lastTime >= alert.cooldownMinutes * 60 * 1000;
        const fired = Number.isFinite(value) && compareAlert(value, alert.operator, alert.threshold) && eligible;
        const timestamp = sharedTimestamp();
        await execute(`UPDATE analysis_alert_rules SET last_value = ?, last_triggered_at = CASE WHEN ? THEN ? ELSE last_triggered_at END, updated_at = ? WHERE id = ?`, [value, fired, timestamp, timestamp, alert.id]);
        if (fired) triggered.push({ ...alert, value, triggeredAt: timestamp });
    }
    return triggered;
}

async function refreshSchedule(schedule) {
    const owner = await resolveAnalysisUser(schedule.user_id);
    if (!owner) throw new Error('刷新计划所属账号已失效。');
    const now = new Date();
    const next = nextScheduleTime(schedule.frequency, schedule.cron_expression, schedule.interval_minutes, now);
    try {
        const result = schedule.dashboard_id
            ? await refreshDashboard({ user: owner, dashboardId: schedule.dashboard_id, scheduleId: schedule.id })
            : { datasetId: schedule.dataset_id, alerts: await evaluateAlertRulesForDataset(owner, schedule.dataset_id) };
        await execute(`
            UPDATE analysis_refresh_schedules
            SET next_run_at = ?, last_run_at = ?, last_status = 'succeeded', last_error = '', failure_count = 0, updated_at = ?
            WHERE id = ?
        `, [next, sharedTimestamp(), sharedTimestamp(), schedule.id]);
        return { id: schedule.id, status: 'succeeded', result };
    } catch (error) {
        await execute(`
            UPDATE analysis_refresh_schedules
            SET next_run_at = ?, last_run_at = ?, last_status = 'failed', last_error = ?, failure_count = failure_count + 1, updated_at = ?
            WHERE id = ?
        `, [next, sharedTimestamp(), String(error?.message || '刷新失败').slice(0, 1000), sharedTimestamp(), schedule.id]);
        return { id: schedule.id, status: 'failed', error: String(error?.message || '刷新失败') };
    }
}

let refreshRunner = null;
let refreshRunning = false;

async function runDueAnalysisRefreshSchedules({ limit = 10 } = {}) {
    if (refreshRunning) return { skipped: true, schedules: [] };
    refreshRunning = true;
    try {
        const schedules = await query(`
            SELECT * FROM analysis_refresh_schedules
            WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
            ORDER BY next_run_at ASC LIMIT ?
        `, [sharedTimestamp(), Math.min(Math.max(Number(limit) || 10, 1), 50)]);
        const results = [];
        for (const schedule of schedules) results.push(await refreshSchedule(schedule));
        return { skipped: false, schedules: results };
    } finally {
        refreshRunning = false;
    }
}

function startAnalysisRefreshRunner({ intervalMs = readTypedEnv('DATA_ANALYSIS_REFRESH_INTERVAL_MS'), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    if (refreshRunner) return refreshRunner;
    const safeInterval = Math.max(10_000, Math.min(Number(intervalMs) || 60_000, 15 * 60_000));
    let stopped = false;
    let timer = null;
    const tick = async () => {
        await runDueAnalysisRefreshSchedules().catch(() => {});
        if (!stopped) {
            timer = setTimeoutFn(tick, safeInterval);
            timer?.unref?.();
        }
    };
    timer = setTimeoutFn(tick, Math.min(safeInterval, 5_000));
    timer?.unref?.();
    refreshRunner = {
        stop() {
            stopped = true;
            if (timer) clearTimeoutFn(timer);
            refreshRunner = null;
        }
    };
    return refreshRunner;
}

async function getDatasetSourceState(user, datasetId) {
    const dataset = await getDatasetForUser(user, datasetId);
    const { sourcePath } = getDatasetPaths(dataset);
    if (!sourcePath) return { datasetId: dataset.id, refreshable: false, state: 'managed', message: '当前数据集由清洗、计算字段或数据库结果生成，不直接监控源文件。' };
    try {
        const stat = await fs.promises.stat(sourcePath);
        return {
            datasetId: dataset.id, refreshable: true, state: 'available',
            sourcePath: path.basename(sourcePath), sourceModifiedAt: new Date(stat.mtimeMs).toISOString(), sourceBytes: stat.size,
            datasetVersion: Number(dataset.source_version || 1)
        };
    } catch (_error) {
        return { datasetId: dataset.id, refreshable: false, state: 'missing', message: '原始文件已不存在，无法执行源变更检测或刷新。' };
    }
}

module.exports = {
    listFieldGovernance,
    getAccessibleDatasetColumns,
    assertDatasetFieldsAccessible,
    updateFieldGovernance,
    previewCalculatedField,
    materializeCalculatedField,
    listCalculatedFields,
    listSavedViews,
    saveAnalysisView,
    getSavedView,
    runSavedView,
    deleteSavedView,
    listDashboards,
    getDashboard,
    saveDashboard,
    saveDashboardItem,
    deleteDashboardItem,
    refreshDashboard,
    listRefreshSchedules,
    saveRefreshSchedule,
    startAnalysisRefreshRunner,
    saveAlertRule,
    getAlertRule,
    listAlertRules,
    evaluateAlertRulesForDataset,
    getDatasetSourceState,
    evaluateMetric
};
