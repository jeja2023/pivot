'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { drive } = require('../server/services/presentations/master/driver');
const { validateTurn } = require('../server/services/presentations/master/actions');
const { initializeReview, exportReview, verifyReceipt } = require('../server/services/presentations/master/review-plan');
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
    await turns([bogus, messages => { assert.match(messages[0].content, /引文与材料原文不一致/); return design; }]);
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
