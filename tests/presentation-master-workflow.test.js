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

test('首张 SVG 先核对可见文字再走执行器版式检查，失败会拦住同批后续页', async () => {
    const project = 'report', first = project + '/svg_output/P01.svg', second = project + '/svg_output/P02.svg';
    const state = { bootstrapped: true, managedProject: project, steps: 0, usedTokens: 0, engine: { tools: ['check_svg'] },
        request: { operation: 'generate', profile: 'default', draftFirst: true, maxSteps: 80, tokenBudget: 0 },
        review: { approvals: { design: { plan: { project, pages: [
            { title: '断网机房中的 AI 运行环境', values: [{ text: '保留 RTX 2080 Ti 与 120 万元' }] },
            { title: '安装检查', values: [{ text: '预算30万元' }] }
        ] } } } }, messages: [{ role: 'system', content: '测试' }] };
    const svg = body => '<svg xmlns="http://www.w3.org/2000/svg">' + body + '</svg>';
    const good = '<text>断网机房中的<tspan> AI 运行环境</tspan></text><text>保留 RTX 2080 Ti 与 120 万元</text>';
    const bad = '<text>断网机房中的</text><text>AI 运行环境</text><g display="none">' + good + '</g>';
    const table = '<g data-pptx-replace-with="table"><metadata type="application/json">' +
        '{"schema":"ppt-master.semantic-table.v2","rows":[["预算",{"paragraphs":[{"runs":[{"text":"30"},{"text":"万元"}]}]}]]}' + '</metadata></g>';
    const row = text => ({ actions: [
        { action: 'write', path: first, text: svg(text) },
        { action: 'write', path: second, text: svg('<text>安装检查</text>' + table) }
    ] });
    const replies = [row(bad), row(good), row(good), { requestInput: { kind: 'clarification', question: '验收完成' } }];
    const executed = [];
    let checks = 0;
    await drive({ id: 1 }, 'task', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async (_model, messages) => {
            if (replies.length === 3) assert.match(messages.at(-1).content, /完整标题/);
            return replies.shift();
        },
        execute: async (_user, _id, action) => {
            executed.push(action.path || action.tool);
            if (action.tool === 'check_svg') {
                assert.deepEqual(action.args, [project, '--canonical-authoring', '--stage', 'page', '--page', first, '--json']);
                if (++checks === 1) return { exitCode: 1, stdout: '[ERROR] P01.svg - Failed\n   [ERROR] Detected module without explicit data-pptx-bounds\n' };
                return { exitCode: 0 };
            }
            return { path: action.path, sha256: createHash('sha256').update(action.text).digest('hex') };
        }
    });
    assert.deepEqual(executed, [first, 'check_svg', first, 'check_svg', second]);
    assert.equal(state.authoringPages.first, 'passed');
    assert.deepEqual(state.usageDiagnostics[0].turnSummary.actions[0].pageCheck, { page: 1, kind: 'source_content' });
    assert.deepEqual(state.usageDiagnostics[1].turnSummary.actions[1].svgCheckPages, [{ page: 1, reasons: ['页面模块缺少边界声明'] }]);
});

test('已写入但首张检查尚未完成的旧进程中断状态，恢复后先使用执行器核验', async () => {
    const path = 'report/svg_output/P01.svg';
    const state = { bootstrapped: true, managedProject: 'report', steps: 2, usedTokens: 456, engine: { tools: ['check_svg'] },
        request: { operation: 'generate', profile: 'quick', draftFirst: true, maxSteps: 80, tokenBudget: 0 },
        authoringPages: { paths: { 1: path }, first: 'pending' }, milestones: { firstPageWrite: { steps: 2 } },
        review: { approvals: { design: { plan: { project: 'report', pages: [{ title: '首页', values: [] }] } } } },
        messages: [{ role: 'system', content: '测试' }] };
    const seen = [];
    await drive({ id: 1 }, 'task', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async () => { seen.push('model'); return { requestInput: { kind: 'clarification', question: '验收完成' } }; },
        execute: async (_user, _id, action) => {
            seen.push(action.tool);
            assert.ok(action.args.includes('--quick-generate'));
            assert.equal(action.args.at(-2), path);
            return { exitCode: 0 };
        }
    });
    assert.deepEqual(seen, ['check_svg', 'model']);
    assert.equal(state.authoringPages.first, 'passed');
    assert.equal(state.milestones.firstPageWrite.steps, 2);
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

test('规范写入兼容正文别名，缺失的可选记录不会阻断本批，项目校验失败后只复检新摘要', async () => {
    const project = 'report', spec = project + '/design_spec.md', lock = project + '/spec_lock.md', page = project + '/svg_output/P01.svg';
    const state = { bootstrapped: true, managedProject: project, steps: 0, usedTokens: 0, engine: { tools: ['project', 'check_svg'] },
        request: { operation: 'generate', profile: 'default', draftFirst: true, maxSteps: 80, tokenBudget: 0 },
        review: { approvals: { design: { plan: { project, pages: [{ title: '首页', values: [] }] } } } },
        messages: [{ role: 'system', content: '测试' }] };
    const writePage = { action: 'write', path: page, text: '<svg xmlns="http://www.w3.org/2000/svg"><text>首页</text></svg>' };
    const validate = { action: 'run', tool: 'project', args: ['validate', project] };
    const replies = [
        { actions: [{ ...writePage, unsupported: '私有内容' }] },
        { actions: [
            { action: 'read', path: project + '/validation/text_calibration.json' },
            { action: 'write', file_path: spec, content: '设计规范', encoding: 'UTF-8', append: false, offset: 0, description: '只用于显示' },
            { action: 'write', path: lock, text: '错误执行锁' },
            writePage
        ] },
        { actions: [validate, writePage] },
        { actions: [{ action: 'write', path: lock, text: '修好的执行锁' }, writePage] },
        { requestInput: { kind: 'clarification', question: '验收完成' } }
    ];
    const ran = [];
    let validations = 0;
    await drive({ id: 1 }, 'task', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async (_model, messages) => {
            if (replies.length === 4) {
                assert.match(messages[0].content, /第 1 项 write 含不支持的参数/);
                assert.match(messages[0].content, /第4个键/);
                assert.ok(messages[0].content.includes(require('../server/services/presentations/master/action-parameters').writeExample));
                assert.doesNotMatch(messages[0].content, /私有内容/);
            }
            if (replies.length === 3) assert.match(messages[0].content, /执行锁的结构/);
            return replies.shift();
        },
        execute: async (_user, _id, action) => {
            ran.push(action.path || action.tool);
            if (action.action === 'read') throw runtime.error('任务文件不存在。', 'PPT_MASTER_OPERATION_FAILED', 422);
            if (action.tool === 'project') {
                if (++validations === 1) return { exitCode: 1, stdout: 'Project validation\n[ERROR]\n  - spec_lock.md schema: unknown section\n\n[WARN]\n  - detail\n' };
                return { exitCode: 0 };
            }
            if (action.tool === 'check_svg') return { exitCode: 0 };
            assert.equal(action.content, undefined);
            assert.equal(action.description, undefined);
            assert.equal(action.offset, undefined);
            if (action.action === 'write') assert.deepEqual(Object.keys(action).sort(), ['action', 'path', 'text']);
            return { path: action.path, sha256: createHash('sha256').update(action.text).digest('hex') };
        }
    });
    assert.deepEqual(ran, [project + '/validation/text_calibration.json', spec, lock, 'project', lock, 'project', page, 'check_svg']);
    assert.equal(state.authoringPages.first, 'passed');
    assert.equal(state.usageDiagnostics[0].turnSummary.actionType, 'write');
    assert.equal(state.usageDiagnostics[1].turnSummary.actions[0].unavailable, true);
    assert.deepEqual(state.usageDiagnostics[1].turnSummary.actions.at(-1).projectIssues, ['lock']);
    assert.deepEqual(state.usageDiagnostics[2].turnSummary.actions[0].projectIssues, ['lock']);
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
