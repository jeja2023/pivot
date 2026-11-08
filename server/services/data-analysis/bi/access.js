'use strict';

const repository = require('../../../repositories/analysis-production-models');
const { canAccessSharedResource } = require('../../unit-visibility');
const { getDatasetForUser, jsonParse, resolveAnalysisUser } = require('../shared');
const { biError } = require('./errors');
const { requiredFields } = require('./field-requirements');

async function modelForUser(user, modelId, { write = false } = {}) {
    const actor = await resolveAnalysisUser(Number(user?.id));
    const row = await repository.get(modelId);
    if (!actor || actor.deleted_at || actor.status !== 'active' || !row || row.model_kind !== 'production' || !canAccessSharedResource(row, actor, write)) throw biError('ANALYSIS_MODEL_NOT_FOUND', '数据模型不存在或无权访问。', 404);
    return row;
}

async function authorizeDefinition(user, definition, { query = null, allFields = false } = {}) {
    const actor = await resolveAnalysisUser(Number(user?.id));
    if (!actor || actor.deleted_at || actor.status !== 'active') throw biError('ANALYSIS_MODEL_NOT_FOUND', '当前身份不可用，请重新登录。', 404);
    const { fields, add, addDimension, addFilters } = requiredFields(definition, query);
    if (allFields) {
        definition.dimensions.forEach(dimension => addDimension(dimension.id));
        for (const metric of definition.metrics) { add(metric.field); add(metric.currencyField); addFilters(metric.filters); }
    }
    const sources = Object.create(null);
    for (const node of definition.nodes) {
        let dataset;
        try { dataset = await getDatasetForUser(actor, node.datasetId); }
        catch (_) { throw biError('ANALYSIS_MODEL_SOURCE_UNAVAILABLE', '模型来源不可用，请联系模型维护者检查来源权限。', 404); }
        const columns = await require('../governance').getAccessibleDatasetColumns(actor, dataset);
        if ([...fields.get(node.id)].some(key => !columns.some(column => column.key === key))) throw biError('ANALYSIS_MODEL_FIELD_UNAVAILABLE', '模型所需字段不可用，请联系模型维护者检查字段权限。', 403);
        sources[node.id] = { dataset, columns };
    }
    return sources;
}

async function visibleDefinition(user, definition) {
    const sources = await authorizeDefinition(user, definition);
    const accessible = reference => !reference || sources[reference.nodeId]?.columns.some(column => column.key === reference.fieldKey);
    const result = jsonParse(JSON.stringify(definition), {});
    result.dimensions = result.dimensions.filter(dimension => accessible(dimension) && (dimension.memberKeyFields || []).every(fieldKey => accessible({ nodeId: dimension.nodeId, fieldKey })));
    const dimensionIds = new Set(result.dimensions.map(dimension => dimension.id));
    const allowedFilters = filters => (filters || []).every(filter => filter.dimensionId ? dimensionIds.has(filter.dimensionId) : accessible(filter.field));
    const unavailable = new Set(result.metrics.filter(metric => !accessible(metric.field) || !accessible(metric.currencyField) || !allowedFilters(metric.filters)).map(metric => metric.id));
    const refs = expression => expression?.metricId ? [expression.metricId] : (expression?.args || []).flatMap(refs);
    let changed = true;
    while (changed) { changed = false; for (const metric of result.metrics) if (!unavailable.has(metric.id) && refs(metric.expression).some(id => unavailable.has(id))) { unavailable.add(metric.id); changed = true; } }
    result.metrics = result.metrics.filter(metric => !unavailable.has(metric.id)).map(metric => ({ ...metric, allowedDimensionIds: metric.allowedDimensionIds.filter(id => dimensionIds.has(id)) }));
    return { definition: result, sources };
}

module.exports = { modelForUser, requiredFields, visibleDefinition };
