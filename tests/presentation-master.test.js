'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../server/services/presentations/master/contract');
const { drive } = require('../server/services/presentations/master/driver');
const tasks = require('../server/services/presentations/master/tasks');
const runtime = require('../server/services/presentations/master/runtime');

function request(overrides = {}) { return normalize({ title: '实际制作', instruction: '根据已提供材料生成可编辑演示。', modelId: '1', profile: 'quick', pageCount: 2, materials: [{ title: '原文', text: '收入120万元，成本80万元。' }], ...overrides }); }
function state(overrides = {}) { return { request: { ...request(), inputFiles: [], materials: [] }, steps: 0, usedTokens: 0, bootstrapped: false, ...overrides }; }
function driverFixture(turns) {
    const calls = [], snapshots = [];
    const controller = new AbortController();
    const execute = async (_user, _id, action) => {
        calls.push(action);
        if (action.action === 'health') return { status: 'ready', contentDigest: runtime.lock.contentDigest };
        if (action.action === 'read_runtime') return { text: '上游权威指引', nextOffset: null };
        if (action.action === 'deliver') return { sha256: 'final', packageCheck: { status: 'passed', slideCount: 2 } };
        return { exitCode: 0, stdout: '已完成' };
    };
    const hooks = { signal: controller.signal, ensureCurrent: async () => controller.signal.throwIfAborted(), checkpoint: async (value, progress) => snapshots.push({ steps: value.steps, progress }) };
    const deps = { execute, resolveModel: async () => ({ id: 1 }), callModel: async () => turns.shift() };
    return { calls, snapshots, hooks, deps, controller };
}

test('完整引擎合同保留原稿流程和明确预算，拒绝越界规模与不支持的流程组合', async () => {
    const value = request({ operation: 'edit_native', profile: 'default', sourceAssetId: '12' });
    assert.equal(value.operation, 'edit_native'); assert.equal(value.sourceAssetId, '12');
    assert.equal(value.materials[0].excerpt, '收入120万元，成本80万元。');
    assert.equal(request().tokenBudget, 1000000);
    assert.equal(request({ tokenBudget: 400000 }).tokenBudget, 400000);
    assert.throws(() => request({ operation: 'edit_native', profile: 'default' }), /PPTX/);
    assert.throws(() => request({ operation: 'create_template', profile: 'quick' }), /流程/);
    assert.throws(() => request({ pageCount: 100 }), /四十页/);
    assert.equal(request({ tokenBudget: 999999 }).tokenBudget, 999999);
    for (const tokenBudget of [0, 9999, 10000.5, Number.MAX_SAFE_INTEGER + 1, Infinity, [10000], true, '']) assert.throws(() => request({ tokenBudget }), /预算/);
    await assert.rejects(() => runtime.workspace({ id: 1 }, '../../outside'), /任务标识/);
});

test('继续任务允许增加至五十万以上，拒绝降低或不安全的累计预算', () => {
    const { normalizeTokenBudget } = require('../server/services/presentations/master/contract');
    assert.equal(normalizeTokenBudget(800000, 500000), 800000);
    for (const value of [499999, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeTokenBudget(value, 500000), /预算/);
});

test('智能体工具的预算上限与完整制作合同一致，允许显式指定一百万', () => {
    const definition = require('../server/services/agent-tools-presentations').presentationToolDefinitions().find(item => item.name === 'presentation.master');
    const { normalizeToolContract, validateToolInput } = require('../server/services/agent-contracts');
    const tool = normalizeToolContract(definition);
    assert.deepEqual(validateToolInput(tool, { action: 'start', tokenBudget: 1000000 }), []);
    assert.deepEqual(validateToolInput(tool, { action: 'resume', taskId: 'example', tokenBudget: 1200000 }), []);
    assert.ok(validateToolInput(tool, { tokenBudget: Number.MAX_SAFE_INTEGER + 1 }).length);
});

test('驱动完整上游流程，动作按顺序执行，仅真实导出交付收据结束任务', async () => {
    const fixture = driverFixture([{ message: '生成页面', actions: [{ action: 'write', path: 'project/svg_output/slide_01.svg', text: '<svg/>' }, { action: 'run', tool: 'check_svg', args: ['project', '--quick-generate', '--json'] }] }, { message: '结束', complete: { path: 'project/exports/final.pptx' } }]);
    const current = state();
    const result = await drive({ id: 1 }, 'id', current, fixture.hooks, fixture.deps);
    assert.equal(result.receipt.packageCheck.status, 'passed'); assert.equal(current.steps, 2);
    assert.deepEqual(fixture.calls.slice(0, 4).map(item => item.action), ['health', 'read_runtime', 'read_runtime', 'read_runtime']);
    assert.equal(fixture.calls.at(-1).action, 'deliver');
    assert.ok(fixture.calls.findIndex(item => item.action === 'write') < fixture.calls.findIndex(item => item.action === 'run'));
});

test('多轮制作对旧写入收敛上下文，检查点保留原文且用实际用量累计', async () => {
    const fixture = driverFixture([]), current = state(), sent = [];
    const longText = '长页面正文'.repeat(3000);
    fixture.deps.execute = async (_user, _id, action) => {
        if (action.action === 'health') return { status: 'ready', contentDigest: runtime.lock.contentDigest };
        if (action.action === 'read_runtime') return { text: '完整上游指引', nextOffset: null };
        if (action.action === 'write') return { path: action.path, bytes: Buffer.byteLength(action.text), sha256: require('node:crypto').createHash('sha256').update(action.text).digest('hex') };
        if (action.action === 'deliver') return { packageCheck: { status: 'passed' } };
        return {};
    };
    fixture.deps.callModel = async (_model, messages, options) => {
        sent.push(messages);
        options.usageRef.usage = { prompt_tokens: 100, completion_tokens: 20 };
        return sent.length <= 2 ? { actions: [{ action: 'write', path: `project/page${sent.length}.svg`, text: longText }] }
            : { complete: { path: 'project/exports/final.pptx' } };
    };
    const result = await drive({ id: 1 }, 'id', current, fixture.hooks, fixture.deps);
    assert.equal(result.receipt.packageCheck.status, 'passed');
    assert.ok(JSON.stringify(current.messages).includes(longText));
    assert.equal(JSON.stringify(sent[2]).split(longText).length - 1, 1);
    assert.match(JSON.stringify(sent[2]), /已成功写入/);
    assert.ok(current.usageDiagnostics[2].originalEstimate > current.usageDiagnostics[2].inputEstimate);
    assert.equal(current.usageDiagnostics[2].compactedWrites, 1);
    assert.equal(current.usedTokens, 360);
});

test('动作间检查点保留已完成回执及未确认动作，恢复时不会伪称全部执行', async () => {
    const fixture = driverFixture([]), current = state(), checkpoints = [];
    const text = '页面内容', hash = require('node:crypto').createHash('sha256').update(text).digest('hex');
    fixture.deps.execute = async (_user, _id, action) => {
        if (action.action === 'health') return { status: 'ready', contentDigest: runtime.lock.contentDigest };
        if (action.action === 'read_runtime') return { text: '上游权威指引', nextOffset: null };
        if (action.action === 'write') return { path: action.path, sha256: hash };
        if (action.action === 'read') { fixture.controller.abort(); throw new Error('执行中断'); }
    };
    fixture.deps.callModel = async () => ({ actions: [{ action: 'write', path: 'p.svg', text }, { action: 'read', path: 'inputs/a.md' }] });
    fixture.hooks.checkpoint = async value => checkpoints.push(JSON.parse(JSON.stringify(value)));
    await assert.rejects(() => drive({ id: 1 }, 'id', current, fixture.hooks, fixture.deps));
    const last = checkpoints.at(-1), observations = JSON.parse(last.messages.at(-1).content);
    assert.equal(observations[0].result.sha256, hash);
    assert.equal(observations[1].action, 'pending');
    assert.match(observations[1].error, /尚未确认/);
});

test('选择固定上游模板时复制和校验真实模板工作区，并将选择交给制作模型', async () => {
    const fixture = driverFixture([{ requestInput: { kind: 'confirmation', question: '确认按咨询决策模板制作？' } }]), current = state();
    current.request.profile = 'default'; current.request.template = { type: 'runtime', id: 'master-style-consulting-decision' };
    const output = await drive({ id: 1 }, 'id', current, fixture.hooks, fixture.deps);
    assert.ok(output.pending); assert.ok(fixture.calls.some(action => action.action === 'copy_template' && action.source === 'templates/styles/consulting-decision'));
    assert.ok(fixture.calls.some(action => action.action === 'validate_template' && action.kind === 'style'));
    assert.ok(current.messages.some(message => message.content.includes('selected-template')));
});

test('用户确认单独等待，实际答复随检查点继续；模型不能把完成和动作混在同轮', async () => {
    const first = driverFixture([{ requestInput: { kind: 'confirmation', question: '确认设计方向？', context: '两页，结论与证据。' } }]), current = state();
    const pending = await drive({ id: 1 }, 'id', current, first.hooks, first.deps);
    assert.equal(pending.pending.question, '确认设计方向？'); assert.ok(!first.calls.some(item => item.action === 'deliver'));
    current.response = '确认，保留全部金额。';
    const second = driverFixture([{ complete: { path: 'project/exports/final.pptx' } }]);
    await drive({ id: 1 }, 'id', current, second.hooks, second.deps);
    assert.ok(current.messages.some(item => item.content.includes('实际答复：确认，保留全部金额。')));
    assert.equal(second.calls.filter(item => item.action === 'health').length, 0);
    const mixed = driverFixture([{ actions: [{ action: 'list' }], complete: { path: 'x' } }]);
    await assert.rejects(() => drive({ id: 1 }, 'id', state(), mixed.hooks, mixed.deps), /不能混合/);
    const unconfirmed = driverFixture([{ complete: { path: 'project/exports/final.pptx' } }]);
    const defaultState = state(); defaultState.request.profile = 'default';
    await assert.rejects(() => drive({ id: 1 }, 'id', defaultState, unconfirmed.hooks, unconfirmed.deps), /实际确认/);
    assert.ok(!unconfirmed.calls.some(item => item.action === 'deliver'));
});

test('预算耗尽与取消在后续动作前生效，不执行伪造的完整交付', async () => {
    const fixture = driverFixture([{ complete: { path: 'x.pptx' } }]), current = state();
    current.usedTokens = current.request.tokenBudget;
    await assert.rejects(() => drive({ id: 1 }, 'id', current, fixture.hooks, fixture.deps), /预算/);
    assert.ok(!fixture.calls.some(item => item.action === 'deliver'));
    fixture.controller.abort();
    await assert.rejects(() => drive({ id: 1 }, 'id', state(), fixture.hooks, fixture.deps), /abort/i);
});

test('累计用量未达上限但下一轮预留不足时拒绝调用并说明原因', async () => {
    const fixture = driverFixture([]), current = state();
    current.bootstrapped = true; current.steps = 11; current.usedTokens = 299001;
    current.request.tokenBudget = 400000;
    current.messages = [{ role: 'system', content: '预留测试' }];
    fixture.deps.messagesForModel = async () => [{ role: 'system', content: '汉'.repeat(220000) }];
    let calls = 0; fixture.deps.callModel = async () => { calls++; };
    await assert.rejects(() => drive({ id: 1 }, 'id', current, fixture.hooks, fixture.deps), error =>
        error.code === 'PPT_MASTER_BUDGET_EXHAUSTED' && /预计输入及至少2000令牌输出/.test(error.message));
    assert.equal(calls, 0); assert.equal(current.usedTokens, 299001);
});

test('供应商实际用量进入累计预算，超额返回不再执行本轮制作动作', async () => {
    const fixture = driverFixture([]), current = state();
    current.request.tokenBudget = 160000;
    fixture.deps.callModel = async (_model, _messages, options) => {
        options.usageRef.usage = { prompt_tokens: 160001, completion_tokens: 10 };
        return { actions: [{ action: 'write', path: 'project/svg_output/page.svg', text: '<svg/>' }] };
    };
    await assert.rejects(() => drive({ id: 1 }, 'id', current, fixture.hooks, fixture.deps), /实际模型用量/);
    assert.equal(current.usedTokens, 160011);
    assert.ok(!fixture.calls.some(item => item.action === 'write'));
});

test('图片重建传递真实图片给视觉模型，检查点不保存图片编码，拒绝纯文本模型', async () => {
    const { messagesForModel } = require('../server/services/presentations/master/model-input');
    const current = state(); current.request.profile = 'image_to_pptx'; current.request.inputFiles = [{ path: 'inputs/source.png' }];
    current.messages = [{ role: 'system', content: '上游流程' }];
    await assert.rejects(() => messagesForModel({ id: 1 }, 'id', current, { supports_vision: 0 }), /支持图片输入/);
    const messages = await messagesForModel({ id: 1 }, 'id', current, { supports_vision: 1 }, { sourceImage: async () => 'data:image/jpeg;base64,test' });
    assert.equal(messages.at(-1).content.at(-1).image_url.url, 'data:image/jpeg;base64,test');
    assert.equal(current.messages.length, 1); assert.ok(!JSON.stringify(current).includes('base64'));
});

test('模型图片按任务快照读取并压缩，拒绝越界和伪装图片', async () => {
    const { sourceImage } = require('../server/services/presentations/master/model-input');
    const sharp = require('sharp');
    const user = { id: 1 }, id = 'tooltask_' + require('node:crypto').randomBytes(24).toString('base64url');
    const image = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#e0e0e0' } }).png().toBuffer();
    await runtime.inputFile(user, id, 'source.png', image);
    const data = await sourceImage(user, id, 'inputs/source.png');
    assert.match(data, /^data:image\/jpeg;base64,/);
    await assert.rejects(() => sourceImage(user, id, '../source.png'), /输入快照/);
    await runtime.inputFile(user, id, 'fake.png', Buffer.from('not an image'));
    await assert.rejects(() => sourceImage(user, id, 'inputs/fake.png'));
});

test('任务保存持久检查点和等待问题，取消或权限撤回不会登记完成产物', async () => {
    const current = state(); let status = 'working', saved, delivered = 0;
    const store = { beginExecution: () => new AbortController(), endExecution() {}, getForUser: async () => ({ status }),
        requestInput: async (_id, _user, question) => { status = 'input_required'; saved = question; },
        complete: async (_id, _user, result, options) => { status = options?.failed ? 'failed' : 'completed'; saved = result; } };
    let leaseId;
    const repository = { claim: async (_user, _id, lease) => { leaseId = lease; return true; }, save: async () => true, renew: async () => true, release: async () => {}, read: async () => ({ result_json: { _lease: leaseId, _leaseUntil: Date.now() / 1000 + 180, state: { ...current, prepared: true } } }) };
    const deps = { store, repository, ensureAccess: async () => {}, parentActive: async () => true,
        drive: async () => ({ pending: { question: '确认页数？' } }), deliver: async () => { delivered++; } };
    await tasks.run('test-id', { id: 1 }, deps);
    assert.equal(status, 'input_required'); assert.equal(saved.question, '确认页数？'); assert.equal(delivered, 0);
    status = 'working'; deps.drive = async () => { status = 'cancelled'; return { receipt: {} }; };
    await tasks.run('test-id', { id: 1 }, deps); assert.equal(status, 'cancelled'); assert.equal(delivered, 0);
    status = 'working'; deps.ensureAccess = async () => { throw new Error('权限已撤回'); };
    await tasks.run('test-id', { id: 1 }, deps); assert.equal(status, 'failed'); assert.equal(delivered, 0);
});

test('确认在前一执行器退出期间到达时，退出后启动续接并保留真实答复', async () => {
    let status = 'working', leaseId, releaseExit, enteredWaiting, continued = 0;
    const exiting = new Promise(resolve => { releaseExit = resolve; });
    const waiting = new Promise(resolve => { enteredWaiting = resolve; });
    const current = { ...state(), prepared: true };
    const store = { beginExecution: () => new AbortController(), endExecution() {}, getForUser: async () => ({ status }),
        requestInput: async () => { status = 'input_required'; enteredWaiting(); await exiting; }, complete: async () => {} };
    const repository = { claim: async (_user, _id, lease) => { leaseId = lease; return true; }, save: async () => true,
        renew: async () => true, release: async () => {}, read: async () => ({ result_json: { _lease: leaseId, _leaseUntil: Date.now() / 1000 + 180, state: current } }),
        acceptResponse: async (_user, _id, saved) => { assert.equal(saved.response, '确认保留金额'); status = 'working'; return true; } };
    const user = { id: 1 }, id = 'confirmation-race';
    const running = tasks.run(id, user, { store, repository, ensureAccess: async () => {}, parentActive: async () => true,
        drive: async () => ({ pending: { question: '确认方案？' } }) });
    await waiting;
    try {
        await tasks.respond(user, id, '确认保留金额', { store, repository, identity: async () => '', ensureAccess: async () => {},
            get: async () => ({ status }), run: async () => { continued++; } });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(continued, 0);
    } finally { releaseExit(); await running; }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(continued, 1);
});
