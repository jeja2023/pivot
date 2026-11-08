'use strict';

const { STAGES, RELATIONS, OPERATIONS } = require('./presentation-semantics');
const text = maxLength => ({ type: 'string', maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const sourceRefs = { type: 'array', maxItems: 20, items: text(96) };
const intent = object({ purpose: text(600), takeaway: text(400), bridgeToNext: text(400), stage: { type: 'string', enum: STAGES },
    relation: { type: 'string', enum: RELATIONS }, durationSeconds: { type: 'number', minimum: 0, maximum: 1800 } });
const claims = { type: 'array', maxItems: 30, items: object({ id: text(96), text: text(1200),
    type: { type: 'string', enum: ['fact', 'calculation', 'assumption', 'recommendation'] }, sourceRefs,
    evidence: { type: 'array', maxItems: 10, items: object({ sourceId: text(96), quote: text(1000), locator: text(500) }, ['sourceId', 'quote']) },
    calculation: object({ operation: { type: 'string', enum: OPERATIONS }, values: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'number' } }, result: { type: 'number' }, unit: text(40) }, ['operation', 'values', 'result'])
}, ['text']) };
const diagram = object({ type: { type: 'string', enum: ['process', 'cycle', 'hierarchy', 'relationship'] },
    items: { type: 'array', minItems: 2, maxItems: 12, items: text(240) },
    graph: object({ nodes: { type: 'array', minItems: 2, maxItems: 30, items: object({ id: text(96), label: text(240) }, ['id', 'label']) },
        edges: { type: 'array', maxItems: 60, items: object({ id: text(96), from: text(96), to: text(96), label: text(120), directed: { type: 'boolean' } }, ['from', 'to']) } }, ['nodes', 'edges'])
}, ['type']);
const productionProfile = object({ audience: text(240), purpose: text(600), consumptionMode: { type: 'string', enum: ['presentation', 'reading'] },
    targetDurationSeconds: { type: 'number', minimum: 0, maximum: 43200 }, minimumBodyFontPt: { type: 'number', minimum: 9, maximum: 36 },
    requireCitations: { type: 'boolean' }, requireVisualReview: { type: 'boolean' }, requireOfficeReview: { type: 'boolean' } });

module.exports = { sourceRefs, intent, claims, diagram, productionProfile };
