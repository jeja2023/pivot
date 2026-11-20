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

test('自动选择与切换共用实际总窗口，优先保留能容纳完整输入的模型', async () => {
    const narrow = { ...candidates[0], max_input_tokens: 0, context_window_tokens: 2048, max_tokens: 512 };
    const wide = { ...candidates[2], max_input_tokens: 0, context_window_tokens: 16384, max_tokens: 512 };
    const inputs = { ...common, messages: [{ role: 'user', content: '合成内容'.repeat(310) }],
        candidateModels: [narrow, wide], endpointStatusGetter: () => [] };
    for (const strategy of ['auto-context', 'auto-cost', 'auto-load']) {
        assert.equal((await chooseModel({ ...inputs, strategy })).model.id, wide.id);
    }
    assert.equal((await pickFailoverModel({ ...inputs, currentModel: { id: 500, url: 'https://unavailable.invalid' }, error: { status: 503 } })).id, wide.id);
});

test('自动初选和降级均能把存储凭据解析为可用模型，损坏凭据会跳过', async () => {
    const http = require('node:http');
    const { encryptSecret } = require('../server/security');
    const { callModelText } = require('../server/services/agent-model');
    const { createChatFixture } = require('./security-chat/chat-route-harness');
    const { execute } = require('../server/db/client');
    const auth = '合成模型凭据'.split('').map(char => char.codePointAt(0).toString(16)).join('');
    const accepted = [];
    const server = http.createServer((request, response) => {
        request.resume();
        const valid = request.headers.authorization === 'Bearer ' + auth && request.headers['x-api-key'] === auth;
        accepted.push(valid);
        response.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '合成请求已认证' } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
    const fixture = createChatFixture({ prefix: 'route_credential', upstreamUrl: endpoint,
        modelColumns: { api_key: encryptSecret(auth, 'models.api_key'), max_input_tokens: 12000 } });
    try {
        await execute(`INSERT INTO models (user_id, name, url, model_name, status, api_key) VALUES (?,?,?,?,?,?)`,
            [fixture.userId, '模拟损坏凭据', endpoint, 'broken-fixture', 'active', encryptSecret(auth, 'fixture.invalid_context')]);
        const request = { user: fixture.user, messages: [{ role: 'user', content: '请核对合成说明。' }], endpointStatusGetter: () => [] };
        const selected = (await chooseModel({ ...request, hintModelId: fixture.modelId, strategy: 'auto-cost' })).model;
        const fallback = await pickFailoverModel({ ...request, currentModel: { id: 500, url: 'https://unavailable.invalid' }, error: { status: 503 } });
        for (const model of [selected, fallback]) {
            assert.equal(Number(model.id), fixture.modelId);
            assert.equal(await callModelText(model, request.messages, { user: fixture.user, timeoutMs: 2000 }), '合成请求已认证');
        }
        assert.deepEqual(accepted, [true, true]);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await execute('DELETE FROM models WHERE user_id = ? AND id <> ?', [fixture.userId, fixture.modelId]);
        fixture.cleanup();
    }
});

test('成本升级的局部超时保留首次回答，任务取消继续传播', async () => {
    const { createFinalAnswerEscalator } = require('../server/services/agent-runtime/model-escalation');
    const controller = new AbortController();
    const calls = [];
    const makeEscalator = withTimeout => createFinalAnswerEscalator({
        run: { id: 'synthetic-run', goal: '整理资料' }, user: { id: 7 }, signal: controller.signal,
        budget: { counts: { tokens_total: 0 }, limits: { max_tokens_total: 10000 } },
        assessConfidence: () => ({ confident: false }), remainingModelRequestMs: () => 10000, withTimeout,
        logger: { warn() {} }
    });
    const input = { answer: '首次总结', modelCfg: { id: 1 }, observations: [] };
    const optionalTimeout = makeEscalator(async (_operation, ms, _label, options) => {
        calls.push(ms);
        throw Object.assign(new Error('合成局部超时'), { code: options.timeoutCode });
    });
    assert.equal(await optionalTimeout(input), null);
    assert.equal(await optionalTimeout(input), null);
    assert.deepEqual(calls, [5000]);
    const cancel = makeEscalator(async () => {
        controller.abort(Object.assign(new Error('用户停止任务'), { code: 'AGENT_RUN_CANCELLED' }));
        throw controller.signal.reason;
    });
    await assert.rejects(cancel(input), error => error.code === 'AGENT_RUN_CANCELLED');
});
