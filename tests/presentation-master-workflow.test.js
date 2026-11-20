'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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

test('首张页面阶段识别运行包资料，已有检查点的连续只读轮次转入真实写入', async () => {
    const project = 'report', source = project + '/svg_output/P01.svg';
    const state = {
        request: { operation: 'generate', profile: 'default', draftFirst: true, maxSteps: 80, tokenBudget: 0 },
        review: { approvals: { design: { plan: { project } } } },
        bootstrapped: true, managedProject: project, steps: 9, usedTokens: 123, workflowPhaseFrom: 1,
        workflowProgress: { phase: 'first_page', calls: 6 }, messages: [{ role: 'system', content: '首张页面验收' }]
    };
    for (let i = 0; i < 6; i++) {
        const path = `references/page-${i}.md`;
        state.messages.push({ role: 'assistant', content: JSON.stringify({ actions: [{ action: 'read_runtime', path }] }) },
            { role: 'user', content: JSON.stringify([{ action: 'read_runtime', result: { path, text: '指引', nextOffset: null } }]) });
    }
    const executed = [];
    let calls = 0;
    const run = user => drive(user, 'task', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async (_model, messages) => {
            calls++;
            if (calls === 1) return { actions: [{ action: 'read_runtime', path: 'references/modes/_index.md' }] };
            if (calls === 2) {
                assert.match(messages[0].content, /已达到首张页面的连续只读轮次/);
                return { actions: [
                    { action: 'read', path: 'references/executor-base.md', offset: 24000 },
                    { action: 'write', path: source, text: '<svg/>' }
                ] };
            }
            return { requestInput: { kind: 'clarification', question: '请补充下一页使用的材料。' } };
        },
        execute: async (_user, _id, action) => {
            executed.push(action);
            if (action.action === 'read_runtime') return { path: action.path, text: '运行包指引', offset: action.offset, nextOffset: null };
            return { path: action.path, sha256: createHash('sha256').update(action.text).digest('hex') };
        }
    });
    await run({ id: 1 });
    assert.deepEqual(executed.map(({ action, path, offset }) => [action, path, offset]), [
        ['read_runtime', 'references/executor-base.md', 24000], ['write', source, undefined]
    ]);
    assert.equal(state.milestones.firstPageWrite.steps, 10);
    assert.equal(state.firstPageInspectionRounds, undefined);
    assert.equal(state.usageDiagnostics[0].turnSummary.errorCode, 'PPT_MASTER_AUTHORING_READ_LIMIT');
});

test('不同指引的连续只读请求达到首张页面阈值后停止执行并保留检查点', async () => {
    const state = { bootstrapped: true, managedProject: 'report', steps: 0, usedTokens: 0,
        request: { operation: 'generate', profile: 'default', draftFirst: true, maxSteps: 80, tokenBudget: 0 },
        review: { approvals: { design: { plan: { project: 'report' } } } }, messages: [{ role: 'system', content: '测试' }] };
    let calls = 0, reads = 0;
    await assert.rejects(drive({ id: 1 }, 'task', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async () => ({ actions: [{ action: 'read_runtime', path: 'references/page-' + ++calls + '.md' }] }),
        execute: async (_user, _id, action) => { reads++; return { path: action.path, text: '指引', nextOffset: null }; }
    }), { code: 'PPT_MASTER_AUTHORING_READ_LIMIT', message: /仍没有写入首张页面/ });
    assert.equal(calls, 8);
    assert.equal(reads, 6);
    assert.equal(state.milestones?.firstPageWrite, undefined);
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
