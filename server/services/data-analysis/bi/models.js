'use strict';

const repository = require('../../../repositories/analysis-production-models');
const { analysisId, jsonParse, getDatasetForUser } = require('../shared');
const { normalizeModelDefinition } = require('./definition');
const { modelForUser, visibleDefinition } = require('./access');
const { biError } = require('./errors');
const { protect } = require('./delivery');
const authorization = require('../../../repositories/analysis-authorization');
const { allRequired } = require('./manifests');

function name(value, max, label) { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000')) throw biError('ANALYSIS_MODEL_INPUT_INVALID', `${label}不能为空且不能超过${max}字。`); return value.trim(); }
function header(row, user) {
    const owner = Number(row.user_id) === Number(user.id);
    return { id: row.id, name: row.name, description: row.description, modelKind: 'production', userId: Number(row.user_id), ownerName: row.owner_name || (owner ? (user.username || '当前用户') : `用户 ${row.user_id}`), isOwner: owner, scope: row.scope,
        allowedUnits: row.allowed_units, allowedUserIds: row.allowed_user_ids, version: Number(row.version), publishedVersion: row.published_version === null ? null : Number(row.published_version),
        lifecycle: row.archived_at ? 'archived' : row.published_version ? 'published' : 'draft', archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function getProductionModel(user, modelId, { write = false } = {}) {
    const row = await modelForUser(user, modelId, { write });
    const model = header(row, user);
    model.businessOwner = row.business_owner; model.maintenanceContact = row.maintenance_contact;
    const origin = model.isOwner && await require('../../../repositories/analysis-model-origins').get(modelId);
    if (origin) model.migrationOrigin = { sourceModelId: origin.source_model_id, sourceName: origin.snapshot_json.sourceName, snapshotHash: origin.snapshot_hash, createdAt: origin.created_at,
        metrics: origin.snapshot_json.metrics.map((metric, index) => ({ metricId: `legacy_metric_${index}`, sourceMetricId: metric.sourceId, sourceRevision: metric.sourceRevision })), views: Number(origin.user_id) === Number(user.id) ? origin.snapshot_json.views : [] };
    model.versionOptions = [];
    if (row.published_version) {
        model.versionOptions = (await repository.versionOptions(modelId)).map(item => ({ version: Number(item.version), publishedAt: item.created_at }));
        try { model.publishedDefinition = (await visibleDefinition(user, (await repository.version(modelId, row.published_version)).definition_json)).definition; }
        catch (error) { if (!error.code?.startsWith('ANALYSIS_')) throw error; model.publishedDefinition = null; }
    }
    let definition = jsonParse(row.definition_json, {});
    if (!model.isOwner && row.published_version) definition = (await repository.version(modelId, row.published_version)).definition_json;
    if (!model.isOwner && !row.published_version) throw biError('ANALYSIS_MODEL_NOT_FOUND', '数据模型不存在或无权访问。', 404);
    try {
        const visible = await visibleDefinition(user, definition);
        model.definition = visible.definition;
        model.sources = Object.entries(visible.sources).map(([nodeId, source]) => ({ nodeId, datasetId: source.dataset.id, name: source.dataset.name, columns: source.columns.map(column => ({ key: column.key, name: column.name })) }));
        model.availability = 'available';
        if (row.published_version) {
            const binding = await require('../../../repositories/analysis-model-publications').binding(modelId, row.published_version);
            const manifest = binding && await require('../../../repositories/analysis-manifests').get(binding.manifest_id);
            const members = manifest?.manifest_json?.members || [];
            const changed = members.some(member => String(visible.sources[member.nodeId]?.dataset.source_version) !== member.sourceRevision);
            model.dataBinding = binding && { manifestId: binding.manifest_id, revision: Number(binding.revision), checkId: binding.check_id, dataState: binding.data_state, lastRefreshError: binding.last_refresh_error };
            model.dataTimes = members.map(member => ({ nodeId: member.nodeId, ...member.watermark }));
            model.availability = binding?.data_state === 'source_unavailable' ? 'source_unavailable' : binding?.data_state === 'refresh_failed' ? 'refresh_failed' : binding?.data_state === 'pending' || changed ? 'pending' : 'available';
            if (binding?.data_state === 'source_unavailable') model.message = '来源完整性异常，已停止新分析；请联系维护者恢复或重新检查来源。';
        }
        if (model.isOwner) {
            const latest = await require('../../../repositories/analysis-model-jobs').latestCheck(user.id, modelId, Number(row.version));
            if (latest) {
                try { model.latestCheck = await require('./jobs').getModelCheck(user, modelId, latest.id); }
                catch (error) { if (!error.code?.startsWith('ANALYSIS_')) throw error; }
            }
        }
        model.draftIssues = model.isOwner ? normalizeModelDefinition(definition, { complete: false }).issues : [];
    } catch (error) {
        if (!['ANALYSIS_MODEL_SOURCE_UNAVAILABLE', 'ANALYSIS_MODEL_FIELD_UNAVAILABLE'].includes(error.code)) throw error;
        model.availability = 'source_unavailable'; model.definition = null; model.sources = []; model.draftIssues = [];
        model.message = '模型来源不可用，请联系模型维护者检查来源和字段权限。';
    }
    const layout = model.definition ? await repository.canvasLayouts(modelId) : {};
    model.canvasLayout = Object.fromEntries((model.definition?.nodes || []).filter(node => layout[node.id]).map(node => [node.id, layout[node.id]]));
    model.flowGraph = model.definition && model.isOwner ? await repository.flowGraph(modelId) : { nodes: [], edges: [] };
    for (const exposed of [model.definition || { nodes: [] }, model.publishedDefinition].filter(Boolean)) {
        const required = exposed.dimensions ? allRequired(exposed) : new Map();
        for (const source of model.sources || []) for (const column of source.columns) required.get(source.nodeId)?.add(column.key);
        protect(model, { userId: user.id, modelId, definition: exposed, required,
            beforeSend: (_trx, current) => {
                if (Number(current.model.user_id) !== Number(row.user_id) || Number(current.model.version) !== Number(row.version)) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '模型信息已变化，请重新加载。', 409);
            } });
    }
    return { row, model };
}

async function createProductionModel({ user, body }) {
    const dataset = await getDatasetForUser(user, name(body.factDatasetId, 120, '事实数据集'));
    const initial = body.definition || { nodes: [{ id: 'fact', datasetId: dataset.id, role: 'fact', name: dataset.name, grainKeys: [] }], metrics: [] };
    const normalized = normalizeModelDefinition(initial, { complete: false });
    if (normalized.definition.nodes.filter(node => node.role === 'fact').length !== 1 || normalized.definition.nodes.find(node => node.role === 'fact').datasetId !== dataset.id) throw biError('ANALYSIS_MODEL_INPUT_INVALID', '新模型需要选择唯一的事实数据集。');
    await repository.create({ id: analysisId('model'), userId: user.id, name: name(body.name, 120, '模型名称'), description: body.description || '', businessOwner: body.businessOwner ? name(body.businessOwner, 120, '业务负责人') : '', maintenanceContact: body.maintenanceContact ? name(body.maintenanceContact, 240, '维护联系人') : '', ...normalized,
        authorize: trx => authorization.authorize(trx, { userId: user.id, definition: normalized.definition, required: allRequired(normalized.definition) }) }).then(row => { normalized.id = row.id; });
    return (await getProductionModel(user, normalized.id)).model;
}

async function saveProductionDraft({ user, modelId, body }) {
    await modelForUser(user, modelId, { write: true });
    const normalized = normalizeModelDefinition(body.definition, { complete: false });
    for (const metric of normalized.definition.metrics) metric.maintainerId = Number(user.id);
    const final = normalizeModelDefinition(normalized.definition, { complete: false });
    const canvasLayout = require('./canvas-layout').normalizeCanvasLayout(body.canvasLayout, final.definition);
    const flowGraph = require('./flow-pipeline').normalizeFlowGraph(body.flowGraph, {
        definitionNodeIds: new Set(final.definition.nodes.map(node => node.id)),
        strict: false
    });
    await repository.saveDraft({ userId: user.id, modelId, expectedVersion: body.expectedVersion, ...final, canvasLayout, flowGraph, authorize: trx => authorization.authorize(trx, { userId: user.id, modelId, definition: final.definition, required: allRequired(final.definition), write: true }) });
    return (await getProductionModel(user, modelId)).model;
}

async function updateProductionModel({ user, modelId, body }) {
    await modelForUser(user, modelId, { write: true });
    if (['scope', 'allowedUnits', 'allowedUserIds'].some(key => Object.hasOwn(body, key))) throw biError('ANALYSIS_MODEL_REVIEW_REQUIRED', '正式模型共享需要在发布与复核页面中设置。', 409);
    const description = body.description ?? '';
    if (typeof description !== 'string' || description.length > 1000) throw biError('ANALYSIS_MODEL_INPUT_INVALID', '模型用途说明不能超过一千字。');
    await repository.update({ userId: user.id, modelId, expectedVersion: body.expectedVersion, name: name(body.name, 120, '模型名称'), description,
        businessOwner: body.businessOwner === undefined ? undefined : name(body.businessOwner, 120, '业务负责人'), maintenanceContact: body.maintenanceContact === undefined ? undefined : name(body.maintenanceContact, 240, '维护联系人') });
    return (await getProductionModel(user, modelId)).model;
}

async function archiveProductionModel({ user, modelId, body }) {
    await modelForUser(user, modelId, { write: true });
    if (typeof body.archived !== 'boolean') throw biError('ANALYSIS_MODEL_INPUT_INVALID', '请选择归档或恢复模型。');
    await repository.archive({ userId: user.id, modelId, expectedVersion: body.expectedVersion, archived: body.archived });
    return (await getProductionModel(user, modelId)).model;
}

async function deleteProductionModel({ user, modelId, expectedVersion }) {
    await modelForUser(user, modelId, { write: true });
    await repository.archive({ userId: user.id, modelId, expectedVersion, archived: false, deleted: true });
    return { deleted: true };
}

module.exports = { getProductionModel, createProductionModel, saveProductionDraft, updateProductionModel, archiveProductionModel, deleteProductionModel };
