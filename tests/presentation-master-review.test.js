'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { drive } = require('../server/services/presentations/master/driver');
const { validateTurn } = require('../server/services/presentations/master/actions');
const { initializeReview, exportReview, verifyReceipt, reviewRecoveryGuidance } = require('../server/services/presentations/master/review-plan');
const { readReviewDraft } = require('../server/services/presentations/master/tasks');
const { pendingInput, parseDecision } = require('../server/services/presentations/master/confirmation');
const { getMaxImagesPerMessage } = require('../server/image-safety');
const { checkModel } = require('../server/services/presentations/master/model-preflight');

const direction = { requestInput: { kind: 'confirmation', stage: 'direction', question: '是否确认方向？', plan: { summary: '做经营复核。' } } };
const example = { title: '经营回顾', values: [{ text: '收入120万元', source: { path: 'instruction', quote: '原始收入120万元。' } }] };
const design = { requestInput: { kind: 'confirmation', stage: 'design', question: '是否确认页序与数据？',
    plan: { summary: '核对真实金额。', project: 'report', pages: [example] } } };

function makeState(profile = 'default') {
    const state = { bootstrapped: true, steps: 0, usedTokens: 0, request: { operation: 'generate', profile, modelId: '1',
        instruction: '原始收入120万元。', pageCount: 1, maxSteps: 10, tokenBudget: 0, inputFiles: [] },
    messages: [{ role: 'system', content: '受控制作。' }] };
    initializeReview(state);
    return state;
}

function approve(state) {
    const pending = pendingInput('task', state);
    state.response = parseDecision({ decision: 'approve', promptId: pending.promptId }, pending);
}

test('默认制作按阶段批准，非法动作批次整体拒绝，交付绑定页序、事实和当前项目', async () => {
    const state = makeState(), executed = [];
    const hooks = { ensureCurrent: async () => {}, checkpoint: async () => {} };
    const turns = outputs => drive({ id: 1 }, 'task', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000, max_tokens: 12000 }),
        callModel: async (_model, messages) => {
            const next = outputs.shift();
            return typeof next === 'function' ? next(messages) : next;
        },
        execute: async (_user, _id, action) => {
            executed.push(action);
            if (action.action === 'deliver') {
                const expected = exportReview(state, 'report');
                return { packageCheck: { slideCount: 1, checkedPages: 1, checkedValues: 1, checklistDigest: expected.checklistDigest } };
            }
            return { exitCode: 0 };
        }
    });
    const early = { actions: [{ action: 'write', path: 'report/skip.md', text: '不得写入' }, { action: 'run', tool: 'export', args: ['report'] }] };
    await turns([early, messages => { assert.match(messages[0].content, /尚|明确批准/); return direction; }]);
    assert.deepEqual(executed, []);
    assert.equal(state.actionRetries, 1);
    approve(state);
    const bogus = globalThis.structuredClone(design);
    bogus.requestInput.plan.pages[0].values[0].source.quote = '并不存在的收入120万元。';
    await turns([bogus, messages => {
        assert.match(messages[0].content, /未通过核验的引用/);
        assert.match(messages.at(-1).content, /引文与材料原文不一致/);
        return design;
    }]);
    assert.deepEqual(executed, []);
    assert.throws(() => exportReview(state, 'report'), { code: 'PPT_MASTER_CHECKLIST_REQUIRED' });
    approve(state);
    const wrongProject = { actions: [{ action: 'run', tool: 'export', args: ['other'] }] };
    const done = await turns([wrongProject, { actions: [{ action: 'run', tool: 'export', args: ['report'] }] },
        { complete: { path: 'report/exports/final.pptx' } }]);
    assert.equal(done.receipt.packageCheck.slideCount, 1);
    assert.deepEqual(executed.map(action => action.action), ['run', 'deliver']);
    assert.deepEqual(executed.at(-1).checklist, [['经营回顾', ['收入120万元']]]);
    const expected = exportReview(state, 'report');
    assert.throws(() => verifyReceipt({ packageCheck: { slideCount: 1, checklistDigest: '旧回执' } }, expected), { code: 'PPT_MASTER_CHECKLIST_UNVERIFIED' });
});

test('图片可分页，清单确认要求读完所有图片，切换纯文本模型明确拒绝', async () => {
    const state = makeState('quick'), cap = getMaxImagesPerMessage(), attached = [];
    state.request.inputFiles = Array.from({ length: cap + 1 }, (_, index) => ({ path: `inputs/asset-${index + 1}.png`, kind: 'image' }));
    const opts = { ensureCurrent: async () => {}, checkpoint: async () => {} };
    await assert.rejects(validateTurn(design, state, async () => state.request.instruction), /图片未读取/);
    const { messagesForModel } = require('../server/services/presentations/master/model-input');
    await assert.rejects(messagesForModel({ id: 1 }, 'task', state, { supports_vision: 0 }), { code: 'PPT_MASTER_VISION_REQUIRED' });
    const output = [{ actions: [{ action: 'read_images', offset: cap }] }, design];
    await drive({ id: 1 }, 'task', state, opts, {
        resolveModel: async () => ({ context_window_tokens: 256000, supports_vision: 1 }),
        messagesForModel: (...args) => messagesForModel(...args, { sourceImage: async (_user, _id, path) => {
            attached.push(path);
            return 'data:image/jpeg;base64,test';
        } }),
        callModel: async () => output.shift()
    });
    assert.deepEqual(attached, state.request.inputFiles.map(file => file.path));
    assert.equal(state.seenImages.length, cap + 1);
    assert.ok(!JSON.stringify(state).includes('base64,test'));
});

test('只重试一次无效动作，两个失败回复分别计量且不会部分执行', async () => {
    const state = makeState('quick');
    let attempts = 0;
    await assert.rejects(drive({ id: 1 }, 'task', state, { ensureCurrent: async () => {}, checkpoint: async () => {} }, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async (_model, _messages, opts) => {
            attempts++;
            opts.usageRef.usage = { prompt_tokens: 50, completion_tokens: 10 };
            return { actions: [{ action: 'write', path: 'report/allow.md', text: '未执行' }, { action: 'unknown' }] };
        },
        execute: async () => assert.fail('不完整的动作批次不得部分执行')
    }), { code: 'PPT_MASTER_ACTION_INVALID' });
    assert.equal(attempts, 2);
    assert.equal(state.steps, 0);
    assert.equal(state.usedTokens, 120);
});

test('定位不一致的引文及数据项，续跑提示携带原拒绝原因', async () => {
    const state = makeState('quick');
    state.request.pageCount = 2;
    state.request.inputFiles = [{ path: 'inputs/material-1.md', kind: 'text' }];
    const proposal = globalThis.structuredClone(design);
    proposal.requestInput.plan.pages.push({ title: '季度营收', values: [
        { text: '营收120万元', source: { path: 'inputs/material-1.md', quote: '本期营收 120 万元。' } },
        { text: '净利润30万元', source: { path: 'inputs/material-1.md', quote: '本期净利润为30万元。' } }
    ] });
    const read = async path => path === 'instruction' ? state.request.instruction : '本期营收120万元。净利润30万元。';
    await assert.rejects(validateTurn(proposal, state, read), error => {
        assert.equal(error.code, 'PPT_MASTER_ACTION_INVALID');
        assert.match(error.message, /第 2 页第 2 项（inputs\/material-1\.md）的关键数据引文与材料原文不一致/);
        assert.match(reviewRecoveryGuidance(state, error.code, error.message), /第 2 页第 2 项/);
        return true;
    });
    proposal.requestInput.plan.pages[1].values[1].source.quote = '净利润30万元。';
    proposal.requestInput.plan.pages[1].values[1].text = '净利润40万元';
    await assert.rejects(validateTurn(proposal, state, read), /第 2 页第 2 项.*关键数据未完整出现在引文中/);
    proposal.requestInput.plan.pages[1].values[1].text = '净利润30万元';
    const validated = await validateTurn(proposal, state, read);
    assert.equal(validated.requestInput.plan.pages[1].values[1].source.quote, '净利润30万元。');
});

test('引文自动修复使用材料原文，拒绝删除失败引用，修正后继续正式交付', async () => {
    const state = makeState('quick'), calls = [], progress = [];
    const bogus = globalThis.structuredClone(design), omitted = globalThis.structuredClone(design);
    bogus.requestInput.plan.pages[0].values[0].source.quote = '并不存在的收入120万元。';
    delete omitted.requestInput.plan.pages[0].values[0].source;
    const hooks = { ensureCurrent: async () => {}, checkpoint: async (_state, update) => progress.push(update.message) };
    const turns = outputs => drive({ id: 1 }, 'task', state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async (_model, messages) => {
            const next = outputs.shift();
            return typeof next === 'function' ? next(messages) : next;
        },
        execute: async (_user, _task, action) => {
            calls.push(action);
            const expected = exportReview(state, 'report');
            return { packageCheck: { slideCount: 1, checkedPages: 1, checkedValues: 1, checklistDigest: expected.checklistDigest } };
        }
    });
    const checkEvidence = messages => {
        assert.match(messages[0].content, /原始片段/);
        const evidence = messages.find(message => message.role === 'user' && typeof message.content === 'string'
            && message.content.startsWith('{"citationRepairEvidence":'));
        assert.equal(JSON.parse(evidence.content).citationRepairEvidence[0].excerpt, '原始收入120万元。');
    };
    await turns([bogus, messages => { checkEvidence(messages); return omitted; }, messages => { checkEvidence(messages); return design; }]);
    assert.equal(state.citationRepairAttempts, 2);
    assert.equal(state.steps, 1);
    assert.equal(progress.filter(message => /正在查证并修复清单引用/.test(message)).length, 2);
    assert.deepEqual(calls, []);
    assert.equal(pendingInput('task', state).plan.pages[0].values[0].source.quote, '原始收入120万元。');
    approve(state);
    const completed = await turns([{ complete: { path: 'report/exports/final.pptx' } }]);
    assert.equal(completed.receipt.packageCheck.checkedValues, 1);
});

test('找不到原文时自动查证次数有上限并保留检查点', async () => {
    const state = makeState('quick');
    const bogus = globalThis.structuredClone(design);
    bogus.requestInput.plan.pages[0].values[0].source.quote = '并不存在的本月收入。';
    bogus.requestInput.plan.pages[0].values[0].text = '本月收入100万元';
    let calls = 0;
    await assert.rejects(drive({ id: 1 }, 'task', state, { ensureCurrent: async () => {}, checkpoint: async () => {} }, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async () => { calls++; return bogus; },
        execute: async () => assert.fail('无法核验的引文不能触发工具动作')
    }), /已尝试查证并修复，检查点已保留/);
    assert.equal(calls, 4);
    assert.equal(state.citationRepairAttempts, 3);
    assert.equal(state.citationRepair[0].excerpt, undefined);
});

test('交付核验失败保留草稿检查点，仍需通过清单才有正式回执', async () => {
    const state = makeState('quick');
    const user = { id: 1 }, taskId = 'task';
    const hint = '交付第 1 页缺少已确认的可见标题，请修正后重新导出。';
    const sha256 = 'a'.repeat(64);
    const calls = [], checkpoints = [];
    const hooks = { ensureCurrent: async () => {}, checkpoint: async (_state, progress) => checkpoints.push(progress.phase) };
    const makeTurn = output => drive(user, taskId, state, hooks, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async () => output,
        execute: async (_user, _taskId, action) => {
            calls.push(action);
            return { reviewFailure: hint, reviewDraft: { sha256, byteSize: 321 } };
        }
    });
    await makeTurn(design);
    approve(state);
    await assert.rejects(makeTurn({ complete: { path: 'report/exports/report.pptx' } }), { code: 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', message: hint });
    assert.deepEqual(calls, [{ action: 'deliver', path: 'report/exports/report.pptx', checklist: [['经营回顾', ['收入120万元']]], retainReviewDraft: true }]);
    assert.deepEqual(state.reviewDraft, { sha256, byteSize: 321 });
    assert.equal(checkpoints.at(-1), 'delivery_review');
    assert.equal(state.deliveryReceipt, undefined);
    assert.match(reviewRecoveryGuidance(state, 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', hint), /经营回顾.*收入120万元/);
    assert.match(reviewRecoveryGuidance(state, 'PPT_MASTER_OPERATION_FAILED', hint), /复用已生成稿件/);
});

test('待核验草稿仅在任务仍可访问且失败状态和文件摘要一致时交付', async () => {
    const user = { id: 1 }, buffer = Buffer.from('待核验文件');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const row = { result_json: { state: { reviewDraft: { sha256, byteSize: buffer.length }, request: { title: '经营回顾' } } } };
    const failed = { row, task: { status: 'failed' } };
    await assert.rejects(readReviewDraft({ id: 2 }, 'task', { lookup: async () => null,
        readOutput: async () => assert.fail('越权时不能读取草稿') }), { code: 'PPT_MASTER_DRAFT_UNAVAILABLE' });
    let checks = 0;
    await assert.rejects(readReviewDraft(user, 'task', { lookup: async () => ++checks === 1 ? failed : null,
        readOutput: async () => buffer }), { code: 'PPT_MASTER_DRAFT_CHANGED' });
    await assert.rejects(readReviewDraft(user, 'task', { lookup: async () => failed,
        readOutput: async () => Buffer.alloc(buffer.length) }), { code: 'PPT_MASTER_DRAFT_CHANGED' });
    assert.deepEqual(await readReviewDraft(user, 'task', { lookup: async () => failed, readOutput: async (_user, _id, name) => {
        assert.equal(name, 'review-draft.pptx'); return buffer;
    } }), { buffer, filename: '经营回顾-待核验草稿.pptx' });
});

test('预检先校验窗口和图片能力，仅合格配置使用端点探针', async () => {
    const request = { operation: 'generate', profile: 'default', modelId: 'model' }, probes = [];
    const model = { id: 5, context_window_tokens: 256000, max_tokens: 12000, supports_vision: 1 };
    const deps = changes => ({ loadModel: async () => ({ ...model, ...changes }), probeModel: async (_user, selected, vision) => probes.push([selected.id, vision]) });
    await assert.rejects(checkModel({ id: 1 }, request, deps({ max_input_tokens: 32000 })), { code: 'PPT_MASTER_CONTEXT_LIMIT' });
    await assert.rejects(checkModel({ id: 1 }, request, deps({ max_tokens: 1000 })), { code: 'PPT_MASTER_MODEL_OUTPUT_LIMIT' });
    await assert.rejects(checkModel({ id: 1 }, request, { ...deps({ supports_vision: 0 }), visionRequired: true }), { code: 'PPT_MASTER_VISION_REQUIRED' });
    assert.deepEqual(probes, []);
    assert.equal((await checkModel({ id: 1 }, request, { ...deps({}), visionRequired: true })).contextWindow, 256000);
    assert.deepEqual(probes, [[5, true]]);
});
