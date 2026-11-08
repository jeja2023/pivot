'use strict';

const { biError } = require('./errors');
const { validateMetricDefinitions, requiredMetricClosure } = require('./metrics');
const { planModelGraph } = require('./graph');

function requiredFields(definition, query = null, { relations = definition.relations } = {}) {
    const fields = new Map(definition.nodes.map(node => [node.id, new Set(node.grainKeys)]));
    const add = ref => { if (ref) fields.get(ref.nodeId)?.add(ref.fieldKey); };
    for (const relation of relations) for (const pair of relation.keyPairs) { add({ nodeId: relation.leftNodeId, fieldKey: pair.leftFieldKey }); add({ nodeId: relation.rightNodeId, fieldKey: pair.rightFieldKey }); }
    const dimensions = new Map(definition.dimensions.map(dimension => [dimension.id, dimension]));
    const addDimension = id => {
        const dimension = dimensions.get(id);
        if (!dimension) throw biError('ANALYSIS_MODEL_QUERY_INVALID', '查询引用了不存在的维度。');
        add(dimension);
        for (const fieldKey of dimension.memberKeyFields || []) add({ nodeId: dimension.nodeId, fieldKey });
    };
    const addFilters = filters => { for (const filter of filters || []) filter.dimensionId ? addDimension(filter.dimensionId) : add(filter.field); };
    if (query) {
        (query.dimensions || []).forEach(addDimension); addFilters(query.filters);
        const graph = planModelGraph(definition);
        // 授权始终遍历全部依赖；历史读取不因指标到期失效，新计算由编译器检查有效期。
        for (const metric of requiredMetricClosure(validateMetricDefinitions(definition.metrics, graph.factNodeId), query.metrics)) { add(metric.field); add(metric.currencyField); addFilters(metric.filters); }
    }
    return { fields, add, addDimension, addFilters };
}

function executionFields(definition, query, all = false, relations = definition.relations) {
    const result = requiredFields(definition, all ? null : query, { relations });
    if (all) {
        for (const dimension of definition.dimensions) result.addDimension(dimension.id);
        for (const metric of definition.metrics) { result.add(metric.field); result.add(metric.currencyField); result.addFilters(metric.filters); }
    }
    return result.fields;
}

module.exports = { requiredFields, executionFields };
