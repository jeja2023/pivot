'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { drive } = require('../server/services/presentations/master/driver');
const { validateTurn } = require('../server/services/presentations/master/actions');
const { initializeReview, exportReview, verifyReceipt, reviewRecoveryGuidance } = require('../server/services/presentations/master/review-plan');
const { readReviewDraft, recent, inspectPages, readPagePreview, saveReviewPages, readSavedPages } = require('../server/services/presentations/master/tasks');
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

test('同一来源唯一可核对的未批准错数允许更正并展示差异，歧义和符号冲突仍拒绝', async () => {
    const state = makeState('quick'), wrong = globalThis.structuredClone(design);
    const actual = '收入120万元。';
    wrong.requestInput.plan.pages[0].values[0] = { text: '收入100万元', source: { path: 'instruction', quote: '收入100万元' } };
    await assert.rejects(validateTurn(wrong, state, async () => actual), failure => {
        state.citationFacts = failure.citationFacts;
        return Boolean(state.citationFacts.length);
    });
    const fixed = globalThis.structuredClone(design);
    fixed.requestInput.plan.pages[0].values[0].source.quote = actual;
    await assert.rejects(validateTurn(fixed, state, async () => actual + '收入125万元。'), /仍需保留/);
    const corrected = await validateTurn(fixed, state, async () => actual);
    assert.equal(corrected.requestInput.plan.pages[0].values[0].previousText, '收入100万元');
    state.review.approvals.design = { plan: wrong.requestInput.plan };
    await assert.rejects(validateTurn(fixed, state, async () => actual), /仍需保留/);
    const unsigned = globalThis.structuredClone(design);
    const value = unsigned.requestInput.plan.pages[0].values[0];
    value.text = '100万元';
    for (const quote of ['100万元', '利润−100万元']) {
        value.source.quote = quote;
        await assert.rejects(validateTurn(unsigned, makeState('quick'), async () => '利润−100万元'), /引文/);
    }
});

test('检查退出码非零会停止同批导出，只有复检成功才放行', async () => {
    const state = makeState('quick'), calls = [];
    const check = { action: 'run', tool: 'check_svg', args: ['report'] };
    const exp = { action: 'run', tool: 'export', args: ['report'] };
    const batch = { actions: [check, exp] };
    let checks = 0;
    const outputs = [design, batch, { actions: [exp] }, batch, { requestInput: { kind: 'clarification', question: '是否添加附件？' } }];
    const deps = { resolveModel: async () => ({ context_window_tokens: 256000 }), callModel: async () => outputs.shift(),
        execute: async (_user, _id, action) => {
            calls.push(action.tool);
            return { exitCode: action.tool === 'check_svg' && ++checks === 1 ? 1 : 0 };
        } };
    const run = () => drive({ id: 1 }, 'task', state, { ensureCurrent: async () => {}, checkpoint: async () => {} }, deps);
    await run(); approve(state); await run();
    assert.deepEqual(calls, ['check_svg', 'check_svg', 'export']);
    assert.equal(state.failedChecks, undefined);
});

test('修复轮可定位已有材料的唯一完整引文，多个来源有歧义时继续查证', async () => {
    const state = makeState('quick'), first = 'inputs/material-1.md', second = 'inputs/material-2.md';
    state.request.inputFiles = [{ path: first, kind: 'text' }];
    const read = async path => path === 'instruction' ? '制作经营汇报。' : '原始收入120万元。';
    await assert.rejects(validateTurn(design, state, read), failure => {
        state.citationFacts = failure.citationFacts;
        return Boolean(state.citationFacts.length);
    });
    const proposal = () => globalThis.structuredClone(design);
    assert.equal((await validateTurn(proposal(), state, read)).requestInput.plan.pages[0].values[0].source.path, first);
    state.request.inputFiles.push({ path: second, kind: 'text' });
    await assert.rejects(validateTurn(proposal(), state, read), /与材料原文不一致/);
});

test('重复校验只在结果或源稿改变后推进，检查点恢复保留相同检查的识别', () => {
    const { createInspectionProgress } = require('../server/services/presentations/master/inspection-progress');
    const action = { action: 'run', tool: 'check_svg', args: ['report'] };
    const observation = { action: 'run', result: { exitCode: 0, stdout: '全部通过' } };
    const progress = createInspectionProgress([{ role: 'assistant', content: JSON.stringify({ actions: [action] }) },
        { role: 'user', content: JSON.stringify([observation]) }]);
    for (let index = 0; index < 3; index++) assert.equal(progress.evaluate([action], [observation]).progressed, false);
    assert.equal(progress.stalled(), true);
    const write = { action: 'write', path: 'report/svg_output/page.svg', savedSha256: 'a'.repeat(64) };
    const receipt = { action: 'write', result: { path: write.path, sha256: 'a'.repeat(64) } };
    assert.equal(progress.evaluate([write], [receipt]).productive, true);
    assert.equal(progress.evaluate([action], [observation]).progressed, true);
    assert.equal(progress.evaluate([write], [receipt]).progressed, false);
    assert.equal(progress.evaluate([action], [observation]).progressed, false);
});

test('引文核对与图片同轮发送时，下一轮不会重复附图', async () => {
    const { messagesForModel, selectImagePage } = require('../server/services/presentations/master/model-input');
    const { runModelTurn } = require('../server/services/presentations/master/model-turn');
    const state = makeState('quick'), path = 'inputs/asset-1.png', model = { context_window_tokens: 256000, supports_vision: 1 };
    state.request.inputFiles = [{ path, kind: 'image' }];
    state.seenImages = [path];
    state.imagePage = selectImagePage(state);
    const imageCalls = [];
    const deps = { messagesForModel: (...args) => messagesForModel(...args, { sourceImage: async () => 'data:image/jpeg;base64,test' }),
        callModel: async (_model, messages) => {
            imageCalls.push(messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
            assert.match(messages.at(-1).content, /citationRepairEvidence/);
            return {};
        } };
    for (let round = 0; round < 2; round++) await runModelTurn({ id: 1 }, 'task', state, model,
        { ensureCurrent: async () => {}, checkpoint: async () => {} }, deps, '', [{ page: 1 }]);
    assert.deepEqual(imageCalls, [true, false]);
    assert.equal(state.imagePage, undefined);
});

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
        assert.match(messages[0].content, /按实际数据项核对引用/);
        const evidence = messages.find(message => message.role === 'user' && typeof message.content === 'string'
            && message.content.startsWith('{"citationRepairEvidence":'));
        assert.equal(JSON.parse(evidence.content).citationRepairEvidence[0].excerpt, '原始收入120万元。');
    };
    await turns([bogus, messages => { checkEvidence(messages); return omitted; }, messages => { checkEvidence(messages); return design; }]);
    assert.equal(state.citationRepairAttempts, undefined);
    assert.equal(state.actionRetries, 2);
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
    }), { code: 'PPT_MASTER_CITATION_REVIEW_REQUIRED', message: /第 1 页第 1 项/ });
    assert.equal(calls, 4);
    assert.equal(state.citationRepairAttempts, 3);
    assert.equal(state.citationRepair[0].excerpt, undefined);
    assert.equal(state.citationPause, true);
});

test('同一材料中的唯一完整数据行可还原引文，歧义、限定条件和金额冲突仍需查证', async () => {
    const state = makeState('quick'), proposal = globalThis.structuredClone(design);
    const entry = proposal.requestInput.plan.pages[0].values[0];
    entry.source.quote = '报告显示收入120万元。';
    const raw = '费用80万元。\n收入 １２０ 万元。';
    const verified = await validateTurn(proposal, state, async () => raw);
    assert.equal(verified.requestInput.plan.pages[0].values[0].source.quote, '收入 １２０ 万元。');
    const match = source => validateTurn({ requestInput: { ...design.requestInput, plan: { ...design.requestInput.plan,
        pages: [{ title: '经营回顾', values: [entry] }] } } }, state, async () => source);
    for (const source of [raw + '\n收入120万元。', '预计收入120万元。', '预计\n收入120万元。', '收入120万元\n以上。', '收入1200万元。']) {
        await assert.rejects(match(source), /关键数据引文与材料原文不一致/);
    }
    entry.source.quote = '报告显示收入150万元。';
    await assert.rejects(match(raw), /关键数据引文与材料原文不一致/);
    entry.source.quote = '本期收入\r\n120\t万元';
    assert.equal((await match('本期收入\n120 万元')).requestInput.plan.pages[0].values[0].source.quote, entry.source.quote);
    entry.source.quote = '收入\u0000120万元';
    await assert.rejects(match(raw), /无效字符/);
});

test('多页同名数据逐项修复，检查点恢复后校验整份清单并重新请求确认', async () => {
    const state = makeState('quick'), proposal = globalThis.structuredClone(design);
    const material = 'inputs/material-1.md', quote = '年度收入120万元。';
    state.request.inputFiles = [{ path: material, kind: 'text' }];
    state.request.pageCount = 6;
    proposal.requestInput.plan.pages = Array.from({ length: 6 }, (_, index) => ({
        title: '经营回顾' + (index + 1),
        values: index === 5 ? [{ text: '费用80万元' }] : [{ text: '收入120万元', source: { path: 'instruction', quote } }]
    }));
    const hooks = { ensureCurrent: async () => {}, checkpoint: async () => {} };
    const deps = { resolveModel: async () => ({ context_window_tokens: 256000 }),
        inputBuffer: async (_user, _id, name) => { assert.equal(name, 'material-1.md'); return Buffer.from(quote); } };
    let calls = 0;
    await assert.rejects(drive({ id: 1 }, 'task', state, hooks, { ...deps, callModel: async () => {
        if (++calls > 1) throw new Error('模拟检查点中断');
        return proposal;
    } }), /模拟检查点中断/);
    const resumed = JSON.parse(JSON.stringify(state)), draft = globalThis.structuredClone(resumed.citationDraft);
    const changes = resumed.citationRepair.map(({ page, item, text }) => ({ page, item, text, path: material, quote }));
    assert.deepEqual(changes.map(change => change.page), [1, 2, 3, 4, 5]);
    const patch = changes => validateTurn({ repairCitations: changes }, resumed, async () => quote);
    for (const invalid of [[changes[0], changes[0]], [{ ...changes[0], page: 6 }], [{ ...changes[0], text: '其他项' }]]) {
        await assert.rejects(patch(invalid), /最新待核对清单/);
    }
    await assert.rejects(patch([{ ...changes[0], path: 'inputs/other.md' }]), /当前任务的文本材料/);
    await assert.rejects(validateTurn({ repairCitations: changes, complete: {} }, resumed), /一并提交/);
    await assert.rejects(validateTurn({ complete: { path: 'report/exports/final.pptx' } }, resumed), /待核对的引文/);
    assert.deepEqual(resumed.citationDraft, draft);
    await drive({ id: 1 }, 'task', resumed, hooks, { ...deps, callModel: async (_model, messages) => {
        assert.match(messages[0].content, /repairCitations/);
        assert.equal(JSON.parse(messages.at(-1).content).citationRepairEvidence.length, 5);
        return { repairCitations: changes };
    } });
    const pending = pendingInput('task', resumed);
    assert.deepEqual(pending.plan.pages.map(page => page.title), draft.plan.pages.map(page => page.title));
    assert.deepEqual(pending.plan.pages.at(-1), draft.plan.pages.at(-1));
    assert.ok(pending.plan.pages.slice(0, 5).every(page => page.values[0].source.path === material));
    assert.equal(resumed.citationDraft, undefined);
    assert.throws(() => exportReview(resumed, 'report'), /明确批准/);
    approve(resumed);
    const done = await drive({ id: 1 }, 'task', resumed, hooks, { ...deps, callModel: async () => ({ complete: { path: 'report/exports/final.pptx' } }),
        execute: async () => ({ packageCheck: { slideCount: 6, checkedPages: 6, checkedValues: 6, checklistDigest: exportReview(resumed, 'report').checklistDigest } }) });
    assert.equal(done.receipt.packageCheck.checkedPages, 6);
});

test('用户补充单独持久登记，原任务引用可随事实重新排序', async () => {
    const { registerSupplement } = require('../server/services/presentations/master/user-supplements');
    const { resetCitationRepair, reopenReview } = require('../server/services/presentations/master/review-plan');
    const state = makeState('quick');
    state.request.pageCount = 2;
    const path = registerSupplement(state, '经核实，项目预算80万元。', 'clarify', 'prompt');
    const fact = { text: '项目预算80万元', source: { path, quote: '项目预算80万元' } };
    const proposal = globalThis.structuredClone(design);
    proposal.requestInput.plan.pages.push({ title: '项目预算', values: [fact] });
    const read = async () => state.request.instruction;
    const wrong = globalThis.structuredClone(proposal);
    wrong.requestInput.plan.pages[1].values[0].source.path = 'instruction';
    await assert.rejects(validateTurn(wrong, state, read), error => {
        state.citationFacts = error.citationFacts;
        return /第 2 页第 1 项/.test(error.message);
    });
    const reordered = globalThis.structuredClone(proposal);
    reordered.requestInput.plan.pages.reverse();
    assert.equal((await validateTurn(reordered, state, read)).requestInput.plan.pages[0].values[0].source.path, 'user-supplement:1');
    reordered.requestInput.plan.pages[0].values = [];
    await assert.rejects(validateTurn(reordered, state, read), /之前待核对的数据项仍需保留/);
    resetCitationRepair(state, { allowRevision: true });
    await validateTurn(reordered, state, read);
    reordered.requestInput.plan.pages[0].values = [{ text: fact.text }];
    await assert.rejects(validateTurn(reordered, state, read), /仍需为该数据项提供可核对的引用/);
    await assert.rejects(validateTurn({ actions: [{ action: 'write', path, text: '改写原文' }] }, state, read), /安全相对路径/);
    state.review.approvals.design = { plan: design.requestInput.plan };
    state.deliveryReceipt = { old: true };
    reopenReview(state);
    assert.equal(state.deliveryReceipt, undefined);
    assert.throws(() => exportReview(state, 'report'), { code: 'PPT_MASTER_CHECKLIST_REQUIRED' });
    assert.equal(state.userSupplements[0].text, '经核实，项目预算80万元。');
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

test('按页恢复只能写指定源稿并复用原有确认，导出仍绑定范围', async () => {
    const state = makeState('quick');
    const sha256 = 'b'.repeat(64);
    state.pageRepair = { sha256, pages: [1], sourceFiles: ['report/svg_output/page1.svg'] };
    await assert.rejects(validateTurn({ actions: [{ action: 'write', path: 'report/svg_output/page2.svg', text: '<svg/>' }] }, state), /未选页面/);
    await assert.rejects(validateTurn(design, state, async () => state.request.instruction), /原已确认清单/);
    await assert.doesNotReject(validateTurn({ actions: [{ action: 'write', path: 'report/svg_output/page1.svg', text: '<svg/>' }] }, state));
});

test('制作记录仅显示当前仍可查阅的任务摘要', async () => {
    const user = { id: 1 };
    const list = async actor => {
        assert.equal(actor, user);
        return [{ id: 'one', status: 'completed', created_at: '先前', request: { title: '已交付', sourceAssetId: '1' } },
            { id: 'two', status: 'failed', request: { title: '已撤权', sourceAssetId: '2' } }];
    };
    const checkAccess = async (actor, request) => {
        assert.equal(actor, user);
        if (request.sourceAssetId === '2') throw Object.assign(new Error('已撤权'), { status: 403 });
    };
    assert.deepEqual(await recent(user, { list, checkAccess }), [{ id: 'one', status: 'completed', title: '已交付', createdAt: '先前' }]);
});

test('旧失败任务无草稿时也能核验已登记导出，并只返回通过页', async () => {
    const state = makeState('quick'), user = { id: 1 };
    const plan = { project: 'report', pages: [{ title: '通过页', values: [] }, { title: '未通过页', values: [{ text: '成本120万元' }] }] };
    state.review.approvals.design = { plan, digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
    state.messages.push({ role: 'assistant', content: JSON.stringify({ complete: { path: 'report/exports/original.pptx' } }) });
    const lookup = async () => ({ row: { result_json: { state } }, task: { status: 'failed' } });
    const file = page => 'review-' + 'a'.repeat(64) + '-' + page + '.png';
    const review = await inspectPages(user, 'old-task', { lookup, execute: async (actor, id, input) => {
        assert.equal(actor, user); assert.equal(id, 'old-task');
        assert.deepEqual(input, { action: 'inspect_export', path: 'report/exports/original.pptx', checklist: [['通过页', []], ['未通过页', ['成本120万元']]] });
        return { pageReview: { passedPages: [1], failedPages: [{ page: 2, missingValues: [1] }] }, pages: [{ page: 1, file: file(1) }, { page: 2, file: file(2) }] };
    } });
    assert.deepEqual(review.pages, [{ page: 1, file: file(1), title: '通过页' }]);
    assert.equal(review.failedPages[0].items[0].text, '成本120万元');
    await assert.rejects(readPagePreview(user, 'old-task', file(1), { lookup: async () => null, readOutput: async () => assert.fail('无权读取时不取图片') }), { code: 'PPT_MASTER_PREVIEW_UNAVAILABLE' });
    await assert.rejects(readPagePreview(user, 'old-task', '../../secret.png', { lookup }), /标识无效/);
});

test('通过页只能按当前核验结果保存，恢复后从已保存图片读取', async () => {
    const user = { id: 1 }, state = makeState('quick'), id = 'old-task';
    const plan = { project: 'report', pages: [{ title: '通过页', values: [] }, { title: '未通过页', values: [] }] };
    state.review.approvals.design = { plan, digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
    state.messages.push({ role: 'assistant', content: JSON.stringify({ complete: { path: 'report/exports/original.pptx' } }) });
    const row = { review_revision: '最初失败', result_json: { state } }, task = { status: 'failed' };
    const revision = 'b'.repeat(64), file = 'review-' + revision + '-1.png';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7eQAAAAASUVORK5CYII=', 'base64');
    const executor = {};
    let referenceCount = 0;
    const deps = {
        lookup: async () => ({ row, task }),
        execute: async () => ({ pageReview: { passedPages: [1], failedPages: [{ page: 2, missingTitle: true }] },
            pages: [{ page: 1, file }, { page: 2, file: 'review-' + revision + '-2.png' }] }),
        readOutput: async (_actor, _id, name) => { assert.equal(name, file); return png; },
        tenantContext: async () => ({ tenantId: 2 }),
        putBuffer: async options => {
            assert.equal(options.mimeType, 'image/png');
            assert.equal(options.ownerUserId, 1);
            assert.equal(options.tenantId, 2);
            return { objectId: 'stored-png' };
        },
        persist: async (_actor, _id, expected, snapshot, commit) => {
            assert.equal(expected, '最初失败');
            await commit(executor, row.result_json.savedReviewPages);
            row.result_json.savedReviewPages = snapshot;
            return snapshot;
        },
        incrementRefCount: async (objectId, delta, options) => {
            assert.equal(objectId, 'stored-png');
            assert.equal(options.executor, executor);
            referenceCount += delta;
        }
    };
    await assert.rejects(saveReviewPages(user, id, 'a'.repeat(64), { ...deps, putBuffer: async () => assert.fail('过期预览不能保存') }),
        { code: 'PPT_MASTER_DRAFT_CHANGED' });
    const saved = await saveReviewPages(user, id, revision, deps);
    assert.deepEqual(saved.pages, [{ page: 1, title: '通过页', file }]);
    assert.deepEqual(saved.failedPages, [{ page: 2 }]);
    assert.equal(referenceCount, 1);
    assert.deepEqual(await saveReviewPages(user, id, revision, { ...deps, execute: async () => assert.fail('重试应复用保存结果') }), saved);
    task.status = 'completed';
    row.review_revision = '已完成';
    assert.deepEqual(await readSavedPages(user, id, deps), saved);
    assert.deepEqual(await readPagePreview(user, id, file, {
        ...deps,
        readOutput: async () => assert.fail('已保存页面不能依赖临时工作区'),
        readBuffer: async options => {
            assert.deepEqual(options, { objectId: 'stored-png', tenantId: 2, userId: 1, tenantScoped: true });
            return { buffer: png };
        }
    }), png);
    await assert.rejects(readSavedPages(user, id, { lookup: async () => null }), { code: 'PPT_MASTER_PREVIEW_UNAVAILABLE' });
});

test('重新生成从授权快照恢复完整材料并以新任务关联原任务', async () => {
    const { regenerate } = require('../server/services/presentations/master/tasks');
    const user = { id: 1 }, bytes = Buffer.from('完整原始材料');
    const request = { title: '经营回顾', materials: [{ id: 'a', path: 'inputs/material-1.md', digest: createHash('sha256').update(bytes).digest('hex') }] };
    const previous = { row: { result_json: { state: { request } } }, task: { status: 'failed' } };
    const options = { lookup: async () => previous, readOriginal: async () => bytes, start: async (_user, input, context) => {
        assert.equal(input.materials[0].text, '完整原始材料');
        assert.equal(context.regeneratedFrom, 'previous');
        return { id: 'new' };
    } };
    for (const status of ['failed', 'completed']) {
        previous.task.status = status;
        assert.deepEqual(await regenerate(user, 'previous', options), { id: 'new' });
    }
    previous.task.status = 'working';
    await assert.rejects(regenerate(user, 'previous', options), { code: 'PPT_MASTER_REGENERATE_UNAVAILABLE' });
    previous.task.status = 'completed';
    assert.equal(request.materials[0].text, undefined);
    await assert.rejects(regenerate(user, 'previous', { ...options, readOriginal: async () => Buffer.from('被更换的材料') }), /原材料快照已不可用/);
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
