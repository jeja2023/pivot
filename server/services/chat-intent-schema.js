'use strict';

const { listAgentCapabilities } = require('./agent-capability-registry');

const text = { type: 'string' };
const strings = { type: 'array', items: text };
const nullableText = { type: ['string', 'null'] };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const capabilityIds = listAgentCapabilities().map(capability => capability.id).filter(id => !['agent.execute', 'system.observe', 'artifact.deliver'].includes(id));
const caps = { $ref: '#/$defs/capabilities' };
const readCaps = { type: 'array', items: { type: 'string', enum: capabilityIds.filter(id => !/^(?:filesystem\.write|code\.|document\.render|viz\.render|media\.|desktop\.|workflow\.)/.test(id)) } };
const routing = tools => object({ knowledge: { type: 'string', enum: ['required', 'none', 'auto'] },
    tools: { type: 'string', enum: tools }, retrievalQuery: text, toolNames: strings });
const common = action => ({ action: { type: 'string', enum: [action] }, objective: text, constraints: strings,
    confidence: { type: 'number', minimum: 0, maximum: 1 } });
const task = action => ({ ...common(action), requiredCapabilities: caps, deliverables: strings,
    acceptance: object({ requireEvidence: { type: 'boolean' }, artifactRequired: { type: 'boolean' } }), routing: routing(['task']) });

// 动作分支仅要求本分支需要的字段，避免每次直答都生成续接、交付与澄清的空值。
// 根节点仍为对象，anyOf 放在 decision 内，兼容严格结构化输出协议。
const CHAT_INTENT_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: { name: 'chat_intent_v6', strict: true, schema: {
        ...object({ decision: { anyOf: [
            object({ ...common('direct_answer'), requiredCapabilities: readCaps, routing: routing(['none', 'read_only']) }),
            object(common('plan_only')),
            object(task('agent_run')),
            object({ ...task('continue_run'), continuationOf: text, removedCapabilities: caps,
                businessScope: object({ timeRange: nullableText, region: nullableText, audience: nullableText, format: nullableText }) }),
            object({ ...common('clarify'), question: text, missingFacts: strings })
        ] } }),
        $defs: { capabilities: { type: 'array', items: { type: 'string', enum: capabilityIds } } }
    } }
};

function decodeChatIntentPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'decision')) return value;
    if (Object.keys(value).length !== 1 || !value.decision || typeof value.decision !== 'object' || Array.isArray(value.decision)) {
        throw Object.assign(new Error('意图响应的动作分支格式无效'), { code: 'CHAT_INTENT_INVALID_CONTRACT' });
    }
    const decision = value.decision;
    return ['plan_only', 'clarify'].includes(decision.action)
        ? { ...decision, requiredCapabilities: [], routing: { knowledge: 'none', tools: 'none' } } : decision;
}

module.exports = { CHAT_INTENT_RESPONSE_FORMAT, decodeChatIntentPayload };
