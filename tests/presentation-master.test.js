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
    assert.throws(() => request({ operation: 'edit_native', profile: 'default' }), /PPTX/);
    assert.throws(() => request({ operation: 'create_template', profile: 'quick' }), /流程/);
    assert.throws(() => request({ pageCount: 100 }), /四十页/);
    assert.throws(() => request({ tokenBudget: 999999 }), /预算/);
    await assert.rejects(() => runtime.workspace({ id: 1 }, '../../outside'), /任务标识/);
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
