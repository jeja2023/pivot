'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../../../db/client');
const repository = require('../../../repositories/analysis-model-consumers');
const models = require('../../../repositories/analysis-production-models');
const jobs = require('../../../repositories/analysis-model-jobs');
const { canAccessSharedResource, normalizeShareSettings } = require('../../unit-visibility');
const { filterExistingShareUserIds } = require('../../share-targets');
const { resolveAnalysisUser, analysisId } = require('../shared');
const { modelForUser } = require('./access');
const { normalizeModelQuery, requestKey } = require('./query-contract');
const service = require('./jobs');
const { canonicalHash } = require('./canonical');
const { biError } = require('./errors');
const { protect, inherit } = require('./delivery');
const finalAccess = require('../../../repositories/analysis-authorized-delivery');

function text(value, limit, label, required = false) { if (typeof value !== 'string' || value.length > limit || value.includes('\u0000') || required && !value.trim()) throw biError('ANALYSIS_MODEL_VIEW_INVALID', `${label}格式无效，请检查后重试。`); return value.trim(); }
function serialize(row, user) { return { id: row.id, sourceType: 'model', modelId: row.model_id, publishedVersion: Number(row.published_version), binding: { strategy: row.binding_strategy, ...(row.historical_manifest_id ? { manifestId: row.historical_manifest_id } : {}) },
    userId: Number(row.user_id), name: row.name, description: row.description, viewType: row.view_type, config: row.config_json, version: Number(row.version), scope: row.scope, allowedUnits: row.allowed_units, allowedUserIds: row.allowed_user_ids,
    isOwner: Number(row.user_id) === Number(user.id), createdAt: row.created_at, updatedAt: row.updated_at };
}

async function resolveView(user, row, { write = false } = {}) {
    const actor = await resolveAnalysisUser(Number(user?.id));
    if (!actor || actor.status !== 'active' || actor.deleted_at || !row || row.source_type !== 'model' || !canAccessSharedResource(row, actor, write)) throw biError('ANALYSIS_MODEL_VIEW_NOT_FOUND', '分析视图不存在或无权访问。', 404);
    await modelForUser(actor, row.model_id);
    const version = await models.version(row.model_id, row.published_version);
    if (!version) throw biError('ANALYSIS_MODEL_VERSION_NOT_FOUND', '视图固定的模型版本已不可用，请联系维护者。', 409);
    const ast = normalizeModelQuery({ ...row.config_json.query, publishedVersion: Number(row.published_version), binding: { strategy: 'latest' }, requestKey: crypto.randomUUID() }).query;
    await transaction(service.authorize(actor, row.model_id, version.definition_json, { query: ast }));
    const view = protect(serialize(row, actor), { userId: actor.id, modelId: row.model_id, definition: version.definition_json, required: require('./access').requiredFields(version.definition_json, ast).fields,
        beforeSend: (trx, current) => finalAccess.view(trx, current.user, row) });
    return { row, view, version, actor, query: ast };
}

async function getModelView(user, id, options) { return resolveView(user, await repository.view(id), options); }

async function saveModelView({ user, modelId, viewId = null, body }) {
    const actor = await resolveAnalysisUser(Number(user?.id));
    if (!actor || actor.deleted_at || actor.status !== 'active') throw biError('ANALYSIS_MODEL_VIEW_NOT_FOUND', '当前身份不可用，请重新登录。', 404);
    const run = await service.getModelJob(actor, body.sourceRunId);
    const source = await jobs.get(actor.id, run.id);
    if (source.execution_kind !== 'model_query' || source.model_id !== modelId || source.status !== 'succeeded') throw biError('ANALYSIS_MODEL_VIEW_INVALID', '分析视图必须绑定已经完成的正式模型运行，草稿试算不能保存。', 409);
    const version = await models.version(modelId, source.published_version);
    if ((await modelForUser(actor, modelId)).archived_at) throw biError('ANALYSIS_MODEL_ARCHIVED', '模型已归档，不能新建分析资产。', 409);
    const viewType = body.viewType || 'query';
    if (!['query', 'chart', 'pivot'].includes(viewType)) throw biError('ANALYSIS_MODEL_VIEW_INVALID', '请选择表格、图表或透视视图。');
    const display = body.display || {};
    if (!display || typeof display !== 'object' || Array.isArray(display) || Object.keys(display).some(key => !['chartType', 'metricId', 'rowDimensionId', 'columnDimensionId', 'title'].includes(key))) throw biError('ANALYSIS_MODEL_VIEW_INVALID', '显示配置包含未支持的字段。');
    if (display.chartType && !['bar', 'line', 'pie'].includes(display.chartType) || display.metricId && !source.query_ast_json.metrics.includes(display.metricId) || display.rowDimensionId && !source.query_ast_json.dimensions.includes(display.rowDimensionId) || display.columnDimensionId && !source.query_ast_json.dimensions.includes(display.columnDimensionId)) throw biError('ANALYSIS_MODEL_VIEW_INVALID', '显示配置必须引用该运行中的维度和指标。');
    if (display.title !== undefined) text(display.title, 120, '图表标题');
    let existing = null, migration = false;
    if (viewId) {
        const row = await repository.view(viewId);
        if (row && row.source_type !== 'model') {
            const origin = await require('../../../repositories/analysis-model-origins').get(modelId);
            if (Number(row.user_id) !== Number(actor.id) || !origin?.snapshot_json.views.some(item => item.id === viewId)) throw biError('ANALYSIS_MODEL_VIEW_NOT_FOUND', '此视图不属于迁移来源清单或无权修改。', 404);
            await require('../shared').getDatasetForUser(actor, row.dataset_id);
            if (body.confirmMigration !== true) throw biError('ANALYSIS_MODEL_VIEW_UPGRADE_REQUIRED', '请明确确认将所选旧分析视图切换至正式模型；其余历史资产保持原有绑定。', 409);
            existing = { row }; migration = true;
        } else existing = await getModelView(actor, viewId, { write: true });
    }
    if (existing && !migration && Number(existing.row.published_version) !== Number(source.published_version) && body.confirmUpgrade !== true) throw biError('ANALYSIS_MODEL_VIEW_UPGRADE_REQUIRED', '模型版本不同，请先核对版本差异并明确确认升级分析视图。', 409);
    const share = migration ? { scope: 'personal', allowedUnits: '', allowedUserIds: '' } : normalizeShareSettings(body, actor, existing?.row || {});
    share.allowedUserIds = await filterExistingShareUserIds(share.allowedUserIds, { excludeUserId: actor.id });
    const binding = body.binding?.strategy === 'historical' ? { strategy: 'historical', manifestId: source.manifest_id } : { strategy: 'latest_checked' };
    if (body.binding && !['historical', 'latest_checked'].includes(body.binding.strategy)) throw biError('ANALYSIS_MODEL_VIEW_INVALID', '请选择最新已检查或固定历史清单。');
    const row = await repository.saveView({ id: viewId || analysisId('view'), userId: actor.id, modelId, publishedVersion: Number(source.published_version), name: text(body.name, 120, '视图名称', true), description: text(body.description || '', 1000, '视图说明'),
        viewType, config: { query: source.query_ast_json, display }, binding, sourceRunId: source.id, share, migration, expectedVersion: viewId ? body.expectedVersion : undefined, authorize: service.authorize(actor, modelId, version.definition_json, { query: source.query_ast_json }) });
    return serialize(row, actor);
}

async function runModelView(user, id) {
    const resolved = await getModelView(user, id);
    const binding = resolved.view.binding.strategy === 'historical' ? resolved.view.binding : { strategy: 'latest' };
    return { sourceType: 'model', view: resolved.view, job: await service.createModelQuery({ user: resolved.actor, modelId: resolved.row.model_id, body: { ...resolved.query, publishedVersion: Number(resolved.row.published_version), binding, execution: 'async', requestKey: crypto.randomUUID() } }) };
}

async function deleteModelView(user, id) {
    const resolved = await getModelView(user, id, { write: true });
    await repository.removeView({ userId: resolved.actor.id, id, modelId: resolved.row.model_id, authorize: service.authorize(resolved.actor, resolved.row.model_id, resolved.version.definition_json, { query: resolved.query }) });
    return { id };
}

async function createModelPivot({ user, jobId, body }) {
    const run = await service.getModelJob(user, jobId), row = await jobs.get(user.id, jobId);
    if (row.execution_kind !== 'model_query' || run.status !== 'succeeded' || row.query_ast_json.dimensions.length < 1 || row.query_ast_json.dimensions.length > 2) throw biError('ANALYSIS_MODEL_PIVOT_INVALID', '正式分析选择一至两个维度后可生成透视，行列总计将按同一清单重新计算。', 409);
    const key = requestKey(body.requestKey), original = row.query_ast_json;
    const create = (dimensions, kind) => service.createModelQuery({ user, modelId: row.model_id, body: { ...original, dimensions, orderBy: [], limit: 5000, publishedVersion: Number(row.published_version), binding: { strategy: 'historical', manifestId: row.manifest_id }, execution: 'async', requestKey: canonicalHash({ key, kind }) } });
    const cell = await create(original.dimensions, 'cells');
    const rowTotals = original.dimensions.length === 2 ? await create([original.dimensions[0]], 'rows') : cell;
    const columnTotals = original.dimensions.length === 2 ? await create([original.dimensions[1]], 'columns') : null;
    return { sourceRunId: jobId, manifestId: row.manifest_id, publishedVersion: Number(row.published_version), cell, rowTotals, columnTotals };
}

function serializeItem(row) { return { id: row.id, dashboardId: row.dashboard_id, sourceType: 'model', modelId: row.model_id, publishedVersion: Number(row.published_version), savedViewId: row.saved_view_id, title: row.title, itemType: row.item_type,
    config: row.config_json, binding: { strategy: row.binding_strategy, ...(row.historical_manifest_id ? { manifestId: row.historical_manifest_id } : {}) }, position: row.position_json, version: Number(row.version) }; }

async function resolveModelItem(user, row) {
    const actor = await resolveAnalysisUser(Number(user?.id));
    const dashboard = row && await repository.dashboard(row.dashboard_id);
    if (!actor || actor.status !== 'active' || actor.deleted_at || !dashboard || !canAccessSharedResource(dashboard, actor)) throw biError('ANALYSIS_MODEL_DASHBOARD_NOT_FOUND', '仪表盘不存在或无权访问。', 404);
    await modelForUser(actor, row.model_id);
    const version = await models.version(row.model_id, row.published_version);
    if (!version) throw biError('ANALYSIS_MODEL_VERSION_NOT_FOUND', '组件固定的模型版本已不可用。', 409);
    await transaction(service.authorize(actor, row.model_id, version.definition_json, { query: row.config_json.query }));
    const item = protect(serializeItem(row), { userId: actor.id, modelId: row.model_id, definition: version.definition_json, required: require('./access').requiredFields(version.definition_json, row.config_json.query).fields,
        beforeSend: (trx, current) => finalAccess.item(trx, current.user, row) });
    return { actor, version, dashboard, row, item };
}

async function saveModelDashboardItem({ user, dashboardId, itemId = null, body }) {
    const source = await getModelView(user, body.savedViewId);
    const position = body.position || {};
    if (!position || typeof position !== 'object' || Array.isArray(position) || Object.keys(position).some(key => !['x', 'y', 'w', 'h'].includes(key)) || Object.values(position).some(value => !Number.isSafeInteger(value) || value < 0 || value > 10000)) throw biError('ANALYSIS_MODEL_VIEW_INVALID', '组件位置必须为有效的非负整数。');
    const id = itemId || analysisId('widget');
    const saved = await repository.saveItem({ id, dashboardId, userId: source.actor.id, view: source.view, title: text(body.title || source.view.name, 120, '组件标题', true), position,
        expectedVersion: itemId ? body.expectedVersion : undefined, authorize: service.authorize(source.actor, source.row.model_id, source.version.definition_json, { query: source.query }) });
    return serializeItem(saved);
}

async function runModelDashboardItem({ user, dashboardId, itemId }) {
    const source = await resolveModelItem(user, await repository.item(itemId, dashboardId));
    const job = await service.createModelQuery({ user: source.actor, modelId: source.row.model_id, body: { ...source.row.config_json.query, publishedVersion: Number(source.row.published_version),
        binding: source.row.binding_strategy === 'historical' ? { strategy: 'historical', manifestId: source.row.historical_manifest_id } : { strategy: 'latest' }, execution: 'async', requestKey: crypto.randomUUID() } });
    if (Number(source.dashboard.user_id) === Number(source.actor.id)) await repository.recordItemRun({ itemId, userId: source.actor.id, expectedVersion: Number(source.row.version), jobId: job.id });
    return { item: source.item, job };
}

async function modelItemSnapshot(user, row) {
    const source = await resolveModelItem(user, row);
    if (Number(row.user_id) !== Number(source.actor.id)) return { itemId: row.id, sourceType: 'model', status: 'requires_run', message: '请按当前身份运行此组件；不会复用其他用户的结果。' };
    if (!row.last_run_id) return { itemId: row.id, sourceType: 'model', status: 'not_run' };
    const job = await service.getModelJob(source.actor, row.last_run_id);
    return inherit(inherit({ itemId: row.id, title: row.title, sourceType: 'model', status: job.status, runId: job.id, modelId: row.model_id, publishedVersion: job.publishedVersion, manifestId: job.manifestId,
        result: job.status === 'succeeded' ? job.result : null, error: job.lastError || '', previousRunId: job.status === 'failed' && row.last_successful_run_id && row.last_successful_run_id !== job.id ? row.last_successful_run_id : null }, job), source.item);
}

module.exports = { resolveView, saveModelView, runModelView, deleteModelView, createModelPivot, saveModelDashboardItem, resolveModelItem, runModelDashboardItem, modelItemSnapshot };
