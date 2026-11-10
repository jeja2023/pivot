'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseModel, pickFailoverModel, pickEscalationModel, isRecoverableModelProviderFailure } = require('../server/services/model-router');
const { resolveAutomaticModelFailover } = require('../server/services/agent-runtime/model-failover');
const candidates = [
    { id: 101, url: 'https://failed.example/v1/chat/completions', model_name: 'same-name', max_input_tokens: 10000, input_price_per_million: 1, supports_vision: true },
    { id: 102, url: 'https://failed.example/other', model_name: 'other-name', max_input_tokens: 12000, input_price_per_million: 2, supports_vision: true },
    { id: 103, url: 'https://healthy.example/v1/chat/completions', model_name: 'same-name', max_input_tokens: 16000, input_price_per_million: 3, supports_vision: true }
];
const status = blocked => [
    { key: 'https://failed.example', models: [{ id: 101 }, { id: 102 }], concurrency: { active: 0, max: 4, rejectingNewRequests: blocked === 'reject' }, circuitOpenMs: blocked === 'circuit' ? 30000 : 0 },
    { key: 'https://healthy.example', models: [{ id: 103 }], concurrency: { active: 1, max: 4 }, circuitOpenMs: 0 }
];
const common = { user: { id: 7 }, candidateModels: candidates, messages: [{ role: 'user', content: '总结材料' }] };

test('自动模型策略先排除熔断与拒绝准入端点，同名模型按端点身份匹配', async () => {
    for (const blocked of ['circuit', 'reject']) {
        for (const strategy of ['auto-load', 'auto-cost', 'auto-context', 'auto-vision', 'auto-quality', 'auto-escalate']) {
            const result = await chooseModel({ ...common, strategy, endpointStatusGetter: () => status(blocked),
                qualityProfiles: candidates.map(model => ({ modelId: model.id, eligible: true, verifiedRate: 1, samples: 50 })) });
            assert.equal(result.model.id, 103, `${strategy}:${blocked}`);
        }
        assert.equal((await pickEscalationModel({ ...common, currentModel: candidates[0], qualityProfiles: [], endpointStatusGetter: () => status(blocked) })).id, 103);
    }
});

test('全部端点不可用时不回退失败候选，缺少监测数据仍保留原有能力校验', async () => {
    const allBlocked = () => status('circuit').map(entry => ({ ...entry, circuitOpenMs: 30000 }));
    assert.equal((await chooseModel({ ...common, strategy: 'auto-load', endpointStatusGetter: allBlocked })).model, null);
    assert.equal(await pickFailoverModel({ ...common, currentModel: candidates[0], endpointStatusGetter: allBlocked }), null);
    assert.equal(await pickEscalationModel({ ...common, currentModel: candidates[0], qualityProfiles: [], endpointStatusGetter: allBlocked }), null);
    const unknown = await chooseModel({ ...common, strategy: 'auto-context', endpointStatusGetter: () => { throw new Error('监测暂不可用'); } });
    assert.equal(unknown.model.id, 101);
    assert.equal((await chooseModel({ ...common, messages: [{ role: 'user', content: '字'.repeat(20000) }], strategy: 'auto-load', endpointStatusGetter: () => status('none') })).model, null);
});

test('端点故障切换避开同端点其它模型，结构化能力拒绝仍允许同端点兼容模型', async () => {
    for (const error of [{ code: 'ECONNRESET' }, { status: 503 }, { status: 429 }, { code: 'AI_ENDPOINT_CIRCUIT_OPEN' }]) {
        const chosen = await pickFailoverModel({ ...common, error, currentModel: candidates[0], endpointStatusGetter: () => status('none') });
        assert.equal(chosen.id, 103);
    }
    const incompatible = { status: 400, message: 'response_format json_schema is not supported' };
    assert.equal((await pickFailoverModel({ ...common, error: incompatible, currentModel: candidates[0], endpointStatusGetter: () => status('none') })).id, 102);
    let received;
    const error = { code: 'ECONNRESET' };
    await resolveAutomaticModelFailover({ ...common, routerStrategy: 'auto-load', error, currentModel: candidates[0], isRecoverableModelProviderFailure,
        pickFailoverModel: async value => { received = value.error; return candidates[2]; } });
    assert.equal(received, error);
    assert.equal(await resolveAutomaticModelFailover({ ...common, routerStrategy: 'fixed', error, isRecoverableModelProviderFailure,
        pickFailoverModel: async () => { throw new Error('固定模型不能自动切换'); } }), null);
});
