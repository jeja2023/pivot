'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const directory = '../server/services/presentations/master/';
const { drive } = require(directory + 'driver');
const { allocateWorkflowCall, prepareManagedProject } = require(directory + 'workflow-progress');
const { createInspectionProgress } = require(directory + 'inspection-progress');
const { recordCheck, requireChecks } = require(directory + 'tool-checks');
const { normalizeStage } = require(directory + 'review-plan');
const { deliverWithRecovery } = require(directory + 'delivery-recovery');
const runtime = require(directory + 'runtime');
const hooks = { ensureCurrent: async () => {}, checkpoint: async () => {} };

test('首案阶段持续读取不同指引仍在阶段上限暂停，续跑保留累计进度', async () => {
    const current = { request: { operation: 'generate', profile: 'default', inputFiles: [], maxSteps: 80, tokenBudget: 0 },
        bootstrapped: true, messages: [{ role: 'system', content: '制作验收' }], steps: 0, usedTokens: 0,
        review: { approvals: {} } };
    let calls = 0;
    const dependencies = { resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async () => ({ actions: [{ action: 'read_runtime', path: 'references/topic-' + ++calls + '.md' }] }),
        execute: async (_user, _id, action) => ({ path: action.path, text: '当前指引', totalChars: 4, nextOffset: null }) };
    await assert.rejects(drive({ id: 1 }, 'case', current, hooks, dependencies), { code: 'PPT_MASTER_PHASE_LIMIT' });
    assert.equal(calls, 18);
    assert.equal(current.steps, 18);
    assert.ok(current.usedTokens > 0);
    assert.deepEqual(current.workflowProgress, { phase: 'design', calls: 18 });
    current.review.approvals.design = { plan: { project: 'draft' } };
    assert.match(allocateWorkflowCall(current), /第一张页面 SVG/);
    current.milestones = { firstPageWrite: { steps: 13 } };
    assert.equal(allocateWorkflowCall(current), '');
});

test('只读图表检索不会重置制作阶段进展', () => {
    const progress = createInspectionProgress([]);
    const action = { action: 'run', tool: 'chart_recall', args: ['show', 'column_chart'] };
    const observation = { action: 'run', result: { exitCode: 0, stdout: '图表参考' } };
    for (let index = 0; index < 4; index++) assert.equal(progress.evaluate([action], [observation]).productive, false);
    assert.equal(progress.stalled(), true);
});

test('宿主项目准备复用已有工作区并明确导入文字', async () => {
    const current = { request: { operation: 'generate', profile: 'quick', inputFiles: [{ kind: 'text', path: 'inputs/material-1.md' }] },
        engine: { managedProject: 1 }, messages: [] };
    const actions = [];
    await prepareManagedProject(current, async action => {
        actions.push(action);
        if (action.action === 'list') return { files: [{ path: 'pivot_authoring_ppt169/validation/workflow.log' }] };
        return { exitCode: 0 };
    });
    assert.equal(current.managedProject, 'pivot_authoring_ppt169');
    assert.deepEqual(actions.map(action => action.args?.[0]), [undefined, 'import-sources']);
    assert.equal(JSON.parse(current.messages[0].content).importedText, true);
});

test('最终复检覆盖同一项目的旧检查，成功的单页检查不能代替整稿复检', () => {
    const action = args => ({ action: 'run', tool: 'check_svg', args: ['deck', '--quick-generate', ...args] });
    const current = {};
    const invalid = action(['--stage', 'draft']);
    const final = action(['--stage', 'final', '--canonical-authoring', '--json']);
    recordCheck(current, invalid, { exitCode: 1 });
    recordCheck(current, action(['--stage', 'page', '--page', 'p01.svg']), { exitCode: 0 });
    assert.throws(() => requireChecks(current, 'deck'), { code: 'PPT_MASTER_ACTION_INVALID' });
    requireChecks(current, 'deck', [final]);
    recordCheck(current, final, { exitCode: 0 });
    requireChecks(current, 'deck');
    assert.equal(current.failedChecks, undefined);
});

test('空引文只能用明确来源的唯一原文补齐，未知来源进入逐项修复', async () => {
    const state = { request: { operation: 'generate', profile: 'quick', pageCount: 1,
        inputFiles: [{ path: 'inputs/material-1.md', kind: 'text' }] }, review: { approvals: {} } };
    const plan = path => ({ stage: 'design', question: '确认？', plan: { summary: '报告', project: 'project',
        pages: [{ title: '报告', values: [{ text: '收入120万元', source: { path, quote: '' } }] }] } });
    const verify = async () => '收入120万元。';
    const result = await normalizeStage(plan('inputs/material-1.md'), state, verify);
    assert.equal(result.plan.pages[0].values[0].source.quote, '收入120万元。');
    await assert.rejects(normalizeStage(plan('other.md'), state, verify), failure => failure.citationIssues?.[0]?.page === 1);
});

test('当前导出回执失效时只自动复检和重试一次，失败后保留诊断', async () => {
    const path = 'project/exports/result.pptx';
    const state = { messages: [], lastExport: { path, args: ['project', '--quick-generate', '-o', path] } };
    const delivery = { action: 'deliver', path }, actions = [];
    const stale = runtime.error('最终文件与最近成功的上游导出或当前源稿不一致。', 'PPT_MASTER_OPERATION_FAILED', 422);
    const execute = async action => {
        actions.push(action.tool || action.action);
        if (action.action === 'deliver' && actions.length === 1) throw stale;
        return action.action === 'deliver' ? { path } : { exitCode: 0, progressExport: path };
    };
    assert.deepEqual(await deliverWithRecovery(state, delivery, execute, hooks), { path });
    assert.deepEqual(actions, ['deliver', 'check_svg', 'export', 'deliver']);
    await assert.rejects(deliverWithRecovery(state, delivery, async () => { throw stale; }, hooks), stale);
    assert.match(state.messages.at(-1).content, /导出回执已失效/);
});

test('模型预检和创建可共享按操作划分的旧引擎能力门禁', () => {
    const available = { enabled: true, transport: 'service', checklistReady: true, currentExportReady: false };
    assert.throws(() => runtime.requireReady(available, 'generate'), { code: 'PPT_MASTER_CHECKLIST_UNVERIFIED' });
    runtime.requireReady(available, 'create_template');
});

test('显式关闭 DeepSeek 官方端点的思考同时覆盖两种协议', () => {
    const { applyAgentThinkingControls } = require('../server/services/agent-model');
    const { responsesRequest } = require('../server/services/agent-responses-protocol');
    const model = { url: 'https://api.deepseek.com/v1', model_name: 'deepseek-flash' };
    const options = { enableThinking: false, maxTokens: 120 };
    assert.deepEqual(applyAgentThinkingControls({}, model, options).thinking, { type: 'disabled' });
    assert.deepEqual(responsesRequest(model, [{ role: 'user', content: '合成验收' }], [], options).data.reasoning, { effort: 'none' });
    assert.equal(applyAgentThinkingControls({}, { ...model, url: 'https://example.invalid/v1' }, options).thinking, undefined);
});
