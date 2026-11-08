'use strict';

const { canonicalHash } = require('./canonical');
const { requiredFields } = require('./access');

// 展示名称与说明留在发布快照；影响计算的治理属性必须阻断自动换数。
function sourceContract(definition, nodeId, source) {
    const required = requiredFields(definition);
    definition.dimensions.forEach(dimension => required.addDimension(dimension.id));
    for (const metric of definition.metrics) { required.add(metric.field); required.add(metric.currencyField); required.addFilters(metric.filters); }
    const keys = [...required.fields.get(nodeId)].sort();
    const keyFields = new Set(definition.nodes.find(node => node.id === nodeId).grainKeys);
    for (const relation of definition.relations) for (const pair of relation.keyPairs) {
        if (relation.leftNodeId === nodeId) keyFields.add(pair.leftFieldKey);
        if (relation.rightNodeId === nodeId) keyFields.add(pair.rightFieldKey);
    }
    return keys.map(key => {
        const field = source.governance.find(item => item.field_key === key && item.status === 'active');
        const metadata = typeof field?.metadata_json === 'string' ? JSON.parse(field.metadata_json) : field?.metadata_json || {};
        return { key, logicalType: field?.logical_type || 'auto', unit: field?.unit || '', dateFormat: field?.date_format || '',
            currency: metadata.currency || '', keyMeaning: keyFields.has(key) ? field?.business_definition || '' : '' };
    });
}

function contractHash(definition, nodeId, source) { return canonicalHash(sourceContract(definition, nodeId, source)); }

module.exports = { contractHash };
