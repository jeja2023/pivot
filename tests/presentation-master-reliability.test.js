'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { drive } = require('../server/services/presentations/master/driver');
const runtime = require('../server/services/presentations/master/runtime');
const { checkModel } = require('../server/services/presentations/master/model-preflight');
const { normalizeStage, recordDraftPlan, exportReview, initializeReview } = require('../server/services/presentations/master/review-plan');
const { draftWithCitationPlaceholders } = require('../server/services/presentations/master/citation-repair');
const { fitReferenceMessages } = require('../server/services/presentations/master/reference-context');
const { estimateMessagesTokens } = require('../server/services/context-budget');
const { assertServiceCapabilities } = require('../scripts/build_ppt_master_service');

const skill = path.resolve(__dirname, '../artifacts/ppt-master-runtime/skill');
const catalog = require('../config/ppt-master-templates.json').templates;
const user = { id: 1, role: 'admin' };
const project = 'pivot_authoring';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const message = (role, value) => ({ role, content: JSON.stringify(value) });
const readDoc = async relative => (await fs.readFile(path.join(skill, relative), 'utf8')).replace(/\r\n/g, '\n');

test('整稿修改按原编号继承补充和已批准清单，长原文需要读完才能提交新清单', async () => {
    const { regenerate } = require('../server/services/presentations/master/tasks');
    const { registerSupplement, getSupplement, prepareRevisionSources, recordRevisionRead, readSupplement } = require('../server/services/presentations/master/user-supplements');
    const request = { operation: 'generate', profile: 'default', draftFirst: true, modelId: '1', pageCount: 1,
        title: '原稿', instruction: '做汇报', materials: [], inputFiles: [] };
    const state = { request, steps: 3 };
    initializeReview(state);
    const fact = '经复核，年末成本为80万元。';
    registerSupplement(state, '参考信息。'.repeat(600), 'resume');
    const source = registerSupplement(state, fact, 'clarify');
    const plan = { project, summary: '汇报', pages: [{ title: '年末成本为80万元', values: [{ text: '年末成本为80万元', source: { path: source, quote: fact } }] }] };
    recordDraftPlan(state, plan);
    const inherited = await regenerate(user, 'prior', {
        lookup: async () => ({ task: { status: 'completed' }, row: { result_json: { state } } }),
        start: async (_user, _input, context) => context
    }, { note: '只缩短文字' });
    const next = { request, messages: [], previousPlan: inherited.previousPlan,
        inheritedSupplementCount: inherited.inheritedSupplements.length, userSupplements: inherited.inheritedSupplements };
    initializeReview(next);
    prepareRevisionSources(next);
    assert.equal(getSupplement(next, source).text, fact);
    assert.deepEqual(JSON.parse(getSupplement(next, 'previous-plan.json').text), plan);
    const stage = { stage: 'design', plan };
    const external = async () => assert.fail('补充事实应读取原编号的快照');
    await assert.rejects(normalizeStage(stage, next, external), /previous-supplements\.json/);
    const name = 'previous-supplements.json';
    const remainder = readSupplement(getSupplement(next, name), { offset: next.revisionReadOffsets[name] });
    recordRevisionRead(next, { action: 'read', path: name }, { action: 'read', result: remainder });
    const updated = await normalizeStage(stage, next, external);
    assert.deepEqual(updated.plan.pages, plan.pages);
    assert.equal(state.userSupplements.length, 2);
});

test('项目校验的临时读取错误可原样复检，模板文件变化会使已保存校验失效', () => {
    const { recordProjectPreparation, previousProjectFailure, pendingProjectValidation } = require('../server/services/presentations/master/project-preparation');
    const state = { managedProject: 'report', request: { operation: 'generate', profile: 'default', draftFirst: true },
        engine: { tools: ['project'] }, review: { approvals: { design: { plan: { project: 'report' } } } },
        projectPreparation: { files: { 'spec_lock.md': 'a', 'design_spec.md': 'b' } } };
    const action = { action: 'run', tool: 'project', args: ['validate', 'report'] };
    const record = stdout => recordProjectPreparation(state, action, { action: 'run', result: { exitCode: 1, stdout } });
    record('[ERROR]\n  - Schema validation could not read spec_lock.md: Permission denied');
    assert.equal(previousProjectFailure(state, action), null);
    record('[ERROR]\n  - spec_lock.md schema: unknown section');
    assert.equal(previousProjectFailure(state, action).exitCode, 1);
    recordProjectPreparation(state, { action: 'copy', path: 'report/templates/cover.svg' }, { action: 'copy', result: {} });
    assert.equal(previousProjectFailure(state, action), null);
    assert.deepEqual(pendingProjectValidation(state).actions, [action]);
});

test('旧检查点沿用项目校验中可公开的节、字段和页码，省去重新运行或读取规范', () => {
    const { previousProjectFailure, projectPreparationGuidance } = require('../server/services/presentations/master/project-preparation');
    const action = { action: 'run', tool: 'project', args: ['validate', project] };
    const result = { exitCode: 1, stdout: '[ERROR]\n'
        + "  - design_spec.md schema: 'Slide 02 - 私有标题' is missing field 'Relationships'\n"
        + '  - Communication trace: spec_lock.md ## communication is missing key line(s): audience, objective.\n'
        + "  - spec_lock.md schema: section 'communication' field 'consumption_mode' has illegal value '禁止公开内容'\n" };
    const state = { managedProject: project, request: { operation: 'generate', profile: 'default', draftFirst: true },
        engine: { tools: ['project'] }, review: { approvals: { design: { plan: { project } } } },
        projectPreparation: { files: { 'design_spec.md': 'a', 'spec_lock.md': 'b' },
            validation: { signature: 'a:b', exitCode: 1, kinds: ['design', 'lock', 'communication'], cacheable: true } },
        messages: [message('assistant', { actions: [action] }), message('user', [{ action: 'run', result }]),
            message('assistant', { actions: [action] }), message('user', [{ action: 'run', result: { exitCode: 1, cachedSpecFailure: true } }])] };
    const guidance = projectPreparationGuidance(state);
    assert.match(guidance, /design_spec\.md 的 Slide 02 缺少 Relationships/);
    assert.match(guidance, /spec_lock\.md 的 communication 缺少 audience、objective/);
    assert.match(guidance, /spec_lock\.md communication 中的 consumption_mode 取值或格式不符合规范/);
    assert.doesNotMatch(guidance, /私有标题|禁止公开内容/);
    assert.deepEqual(previousProjectFailure(state, action).projectDetails, state.projectPreparation.validation.details);
});

test('小窗口通过模板预检后可从清单进入首轮制稿，目录中的规范预算与固定运行包相符', async t => {
    if (!await fs.access(path.join(skill, 'SKILL.md')).then(() => true, () => false)) return t.skip('未准备固定运行包');
    const model = { id: 1, context_window_tokens: 32768, max_tokens: 8192, max_input_tokens: 24000 };
    for (const entry of catalog) {
        const text = await readDoc(entry.path + '/templates/design_spec.md');
        const selectedTemplateSpec = { id: entry.id, path: entry.path, text, digest: sha(text) };
        assert.equal(entry.specInputTokens, estimateMessagesTokens([message('user', { selectedTemplateSpec })]));
        const request = { operation: 'generate', profile: 'default', modelId: '1', pageCount: 1, tokenBudget: 0, maxSteps: 10,
            draftFirst: true, title: '季度汇报', instruction: '编写季度汇报', materials: [], inputFiles: [], template: { type: 'runtime', id: entry.id } };
        const state = { request, steps: 0, usedTokens: 0 };
        initializeReview(state);
        const preflight = await checkModel(user, request, { loadModel: async () => model, probeModel: async () => {} });
        assert.equal(preflight.inputBudget, 24000);
        // 以实际字数估算不可移出的输入，不能让模板和长任务要求挤掉清单。
        await assert.rejects(checkModel(user, { ...request, instruction: '中'.repeat(16000),
            materials: Array.from({ length: 20 }, (_, index) => ({ id: String(index), title: '材'.repeat(230) })) }, {
            loadModel: async () => ({ ...model, max_tokens: 18000 }), probeModel: async () => {}
        }), { code: 'PPT_MASTER_CONTEXT_LIMIT' });
        let calls = 0;
        const rule = text.match(/- \*\*Page Message Discipline\*\*: ([^\n.]+\.)/)[1];
        const { normalizeTemplateUse } = require('../server/services/presentations/master/template-application');
        assert.deepEqual(normalizeTemplateUse({ request, templateSpec: selectedTemplateSpec },
            { templateUse: { page: 1, rule: 'Evidence Obligation', visibleText: '季度汇报' } }, [{ title: '季度汇报', values: [] }]),
        { id: entry.id, digest: selectedTemplateSpec.digest });
        const result = await drive(user, 'fixture', state, { ensureCurrent: async () => {}, checkpoint: async () => {} }, {
            resolveModel: async () => model,
            callModel: async (_model, messages) => {
                calls++;
                assert.ok(estimateMessagesTokens(messages) <= preflight.inputBudget, entry.id);
                if (calls > 1) {
                    assert.ok(messages.some(item => item.content.includes('read_runtime') && item.content.includes('暂收起指引正文')), entry.id);
                    return { requestInput: { kind: 'clarification', question: '请提供最终图稿。' } };
                }
                return { requestInput: { kind: 'confirmation', stage: 'design', question: '核对本页。', plan: { summary: '季度汇报', project,
                    pages: [{ title: '季度汇报', values: [] }], templateUse: { rule, page: 1, visibleText: '季度汇报' } } } };
            },
            execute: async (_user, _id, op) => {
                if (op.action === 'health') return { status: 'ready', serviceProtocol: 1, contentDigest: runtime.lock.contentDigest, managedProject: 1,
                    deliveryChecklist: 1, currentExport: 1, selectedTemplateRecovery: 1, tools: ['project', 'check_svg', 'apply_template'] };
                if (op.action === 'list') return { files: [{ path: project + '/validation/workflow.log' }] };
                if (op.action === 'read_runtime') return { path: op.path, text: await readDoc(op.path), offset: 0, nextOffset: null };
                if (op.tool === 'apply_template') return { exitCode: 0, templateSpecDigest: sha(text) };
                return { exitCode: 0 };
            }
        });
        assert.equal(calls, 2);
        assert.equal(result.pending.question, '请提供最终图稿。');
    }
});

test('阶段视图的跨区间分页仅保留未覆盖正文，分页偏移按 Unicode 字符计算', () => {
    const read = message('user', [{ action: 'read_runtime', result: { path: 'workflows/test.md', offset: 1, nextOffset: null, text: '😀乙丙丁戊' } }]);
    const doc = message('user', { runtimeDocument: 'workflows/test.md', text: '甲😀…丁戊', phase: 'validated_project' });
    const ranges = new Map([[doc, [{ offset: 0, points: Array.from('甲😀') }, { offset: 4, points: Array.from('丁戊') }]]]);
    const result = JSON.parse(fitReferenceMessages([doc, read], Infinity, ranges)[1].content)[0].result;
    assert.deepEqual(result.uncovered, [{ offset: 2, text: '乙丙' }]);
    assert.equal(result.text, undefined);
    assert.equal(JSON.parse(read.content)[0].result.text, '😀乙丙丁戊');
});

test('标题的业务断言须匹配同页已核实原文，普通年份与页码可直接使用', async () => {
    const state = { request: { operation: 'generate', profile: 'default', draftFirst: true, pageCount: 1, inputFiles: [] } };
    initializeReview(state);
    const source = { path: 'instruction', quote: '成本增长35%' };
    const stage = { stage: 'design', question: '核对', plan: { project, summary: '经营指标', pages: [
        { title: '营收增长35%', values: [{ text: '成本增长35%', source }] }
    ] } };
    let pending;
    await assert.rejects(normalizeStage(stage, state, async () => source.quote), failure => {
        pending = failure;
        return failure.citationIssues?.[0]?.text === stage.plan.pages[0].title;
    });
    const placeholder = draftWithCitationPlaceholders(pending);
    assert.doesNotMatch(placeholder.plan.pages[0].title, /35%/);
    recordDraftPlan(state, stage.plan);
    assert.throws(() => exportReview(state, project), /标题/);
    const page = stage.plan.pages[0];
    for (const title of ['营收增长：35%', '营收，同比增加35%', '订单数量为3500']) {
        page.title = title;
        assert.ok(await normalizeStage(stage, state, async () => source.quote).then(() => false, err => err.citationIssues?.length > 0));
    }
    page.title = '营收增长35%';
    page.titleSource = { path: 'previous-plan.json', quote: page.title };
    await assert.rejects(normalizeStage(stage, state, async () => source.quote), error => error.citationIssues?.[0]?.text === page.title);
    page.titleSource = { path: 'instruction', quote: '营收增长35%' };
    const result = await normalizeStage(stage, state, async () => '成本增长35%。营收增长35%。');
    assert.deepEqual(result.plan.pages[0].titleSource, page.titleSource);
    recordDraftPlan(state, result.plan);
    assert.equal(exportReview(state, project).checklist[0][0], page.title);
    page.title = '2026年季度报告（第2页）';
    delete page.titleSource;
    page.values = [];
    assert.equal((await normalizeStage(stage, state, async () => '')).plan.pages[0].values.length, 0);
    for (const title of ['ISO 9001 质量管理体系', '信息安全标准 ISO/IEC 27001:2022', '质量管理执行GB/T 19001-2016', '机型 A100-2 使用说明']) {
        page.title = title;
        assert.equal((await normalizeStage(stage, state, async () => '')).plan.pages[0].title, title);
    }
    for (const title of ['ISO 9001 认证成本35万元', '机型 A100 交付120台', '型号10台已交付', 'ISO 9001%增长']) {
        page.title = title;
        await assert.rejects(normalizeStage(stage, state, async () => ''), error => error.citationIssues?.[0]?.page === 1);
    }
});

test('预检返回有界等待的专用诊断并释放请求，超时不登记为协议不兼容', async t => {
    const axios = require('axios');
    const model = { id: 7781, model_name: 'preflight-timeout', url: 'http://127.0.0.1:1/v1', context_window_tokens: 256000, max_tokens: 8192 };
    const post = t.mock.method(axios, 'post', async (_url, _body, config) => {
        throw Object.assign(new Error(`timeout of ${config.timeout}ms exceeded`), { code: 'ECONNABORTED' });
    });
    await assert.rejects(checkModel(user, { modelId: '7781', operation: 'generate' }, { loadModel: async () => model }),
        { code: 'PPT_MASTER_MODEL_PREFLIGHT_TIMEOUT', status: 504 });
    assert.equal(post.mock.callCount(), 1);
    const { readTypedEnv } = require('../server/config/env-registry');
    assert.equal(post.mock.calls[0].arguments[2].timeout, Math.min(readTypedEnv('PIVOT_PPT_MASTER_MODEL_PREFLIGHT_TIMEOUT_MS'),
        require('../server/services/agent-model').AGENT_MODEL_REQUEST_TIMEOUT_MS));
});

test('视觉预检接受完整围栏 JSON 与等义颜色，仍拒绝错误颜色', async t => {
    const axios = require('axios');
    const model = { id: 7782, model_name: 'preflight-vision', url: 'http://127.0.0.1:1/v1', context_window_tokens: 32768,
        max_tokens: 8192, supports_vision: 1 };
    let color = '红';
    t.mock.method(axios, 'post', async () => ({ data: { choices: [{ message: {
        content: '\x60\x60\x60json\n' + JSON.stringify({ result: 'PPT_MASTER_PREFLIGHT_V1', color }) + '\n\x60\x60\x60'
    } }] } }));
    const probe = () => checkModel({}, { modelId: '7782', operation: 'generate' }, { loadModel: async () => model, visionRequired: true });
    await assert.rejects(probe(), { code: 'PPT_MASTER_MODEL_PREFLIGHT_FAILED' });
    color = '蓝色';
    assert.equal((await probe()).vision, true);
});

test('独立服务打包核对模板恢复与输入快照能力，支持已有镜像的预检', () => {
    const health = { serviceProtocol: 1, runtimeId: 'sha256:' + 'a'.repeat(64), deliveryChecklist: 1, currentExport: 1, pageRepair: 1,
        progressSnapshots: 1, managedProject: 1, boundedSourceBundle: 1, selectedTemplateRecovery: 1, atomicInputSnapshots: 1,
        checklistDisplayEquivalence: 1, checklistGroupedValues: 1, optionalSourcePackage: 1, expandedChecklist: 1, projectSpecReceipts: 1, startupHealthTimeoutSeconds: 300 };
    assert.doesNotThrow(() => assertServiceCapabilities(health));
    for (const key of ['selectedTemplateRecovery', 'atomicInputSnapshots', 'checklistDisplayEquivalence', 'checklistGroupedValues', 'optionalSourcePackage', 'expandedChecklist', 'projectSpecReceipts', 'startupHealthTimeoutSeconds']) {
        assert.throws(() => assertServiceCapabilities({ ...health, [key]: undefined }), new RegExp(key));
    }
});

test('已有视频素材的模板请求在模型探测和任务创建前校验执行器上限', async t => {
    const { start } = require('../server/services/presentations/master/tasks');
    t.mock.method(runtime, 'availability', async () => ({ enabled: true }));
    const query = t.mock.method(require('../server/services/presentations/presentation-service'), 'getPresentationAsset', async () =>
        ({ asset: { filename: '访谈.mp4', byteSize: 54 * 1024 * 1024, mimeType: 'video/mp4' } }));
    await assert.rejects(start(user, { title: '汇报', instruction: '用视频制作演示。', modelId: '1', template: { type: 'runtime', id: catalog[0].id },
        assetIds: ['12'] }), { status: 413, code: 'PPT_MASTER_INPUT_TOO_LARGE', message: /访谈\.mp4.*50 MiB/ });
    assert.equal(query.mock.callCount(), 1);
    assert.deepEqual(query.mock.calls[0].arguments[2], { metadataOnly: true });
});

test('直接执行器并发登记同一快照只接受相同内容，校验单文件边界', async t => {
    const { MAX_INPUT_FILE_BYTES, checkInputSize, saveInputSnapshot } = require('../server/services/presentations/master/input-snapshots');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-input-retry-'));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const inputs = path.join(tmp, 'workspace', 'inputs');
    await fs.mkdir(inputs, { recursive: true });
    const write = text => saveInputSnapshot(inputs, 'material-1.md', Buffer.from(text));
    await Promise.all([write('原始材料'), write('原始材料')]);
    await assert.rejects(write('已改变'), { code: 'PPT_MASTER_INPUT_CHANGED' });
    assert.deepEqual(await fs.readdir(tmp), ['workspace']);
    assert.equal(await fs.readFile(path.join(inputs, 'material-1.md'), 'utf8'), '原始材料');
    checkInputSize('视频.mp4', MAX_INPUT_FILE_BYTES);
    assert.throws(() => checkInputSize('视频.mp4', MAX_INPUT_FILE_BYTES + 1), { code: 'PPT_MASTER_INPUT_TOO_LARGE', status: 413 });
});
