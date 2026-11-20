'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { drive } = require('../server/services/presentations/master/driver');
const { initializeReview, applyReviewDecision } = require('../server/services/presentations/master/review-plan');
const { validateTurn } = require('../server/services/presentations/master/actions');
const { recordRepairResult, startPageRepair, automaticTurn, repairPrompt } = require('../server/services/presentations/master/automatic-page-repair');

const sources = Array.from({ length: 8 }, (_, index) => `report/svg_output/P0${index + 1}.svg`);
const selected = [1, 2, 4, 5, 8];
const check = { action: 'run', tool: 'check_svg', args: ['report', '--canonical-authoring', '--stage', 'final', '--json'] };
const overlap = "   [ERROR] <g id='region'> data-pptx-bounds overlaps <g id='signal'> data-pptx-bounds";
const font = '   [ERROR] spec_lock typography-size recurrence: undeclared font-size 48';
const report = (...entries) => ({
    exitCode: 1,
    stdout: entries.map(([page, reason]) => `[ERROR] P0${page}.svg - Failed\n${reason}`).join('\n') + '\n\n   [ERROR] 汇总错误数量'
});

function repairCheckpoint() {
    const state = { bootstrapped: true, steps: 24, usedTokens: 0, engine: { pageRepair: 1 },
        request: { operation: 'generate', profile: 'default', pageCount: 8, inputFiles: [], maxSteps: 80, tokenBudget: 0 },
        lastExport: { path: 'report/exports/final.pptx', args: ['report', '--no-notes'] },
        messages: [{ role: 'system', content: '测试修复。' }] };
    initializeReview(state);
    applyReviewDecision(state, { stage: 'design', promptId: 'approved', plan: {
        summary: '报告', project: 'report', pages: sources.map((_, index) => ({ title: `第 ${index + 1} 页`, values: [] }))
    } }, true);
    state.reviewDraft = { sha256: 'a'.repeat(64) };
    state.pageSources = sources;
    state.pageReview = { failedPages: selected.map(page => ({ page, title: `第 ${page} 页`, missingTitle: true, items: [] })) };
    state.pageRepair = { pages: selected };
    return state;
}

test('旧检查点按页续作聚焦最近失败页，宿主完成全稿复检、定稿及导出', async () => {
    const state = repairCheckpoint();
    state.messages.push({ role: 'assistant', content: JSON.stringify({ actions: [check] }) },
        { role: 'user', content: JSON.stringify([{ action: 'run', result: report([8, overlap]) }]) });
    assert.equal(startPageRepair(state, 'report', selected, 1, { previousPages: selected }), true);
    assert.deepEqual(state.pageRepair.remaining, [sources[7]]);
    assert.deepEqual(state.pageRepair.sourceFiles, selected.map(page => sources[page - 1]));
    assert.match(repairPrompt(state.pageRepair), /第 8 页页面对象区域重叠/);
    await assert.rejects(validateTurn({ actions: [{ action: 'run', tool: 'finalize', args: ['report'] }] }, state), /由宿主执行/);
    await assert.rejects(validateTurn({ actions: [{ action: 'write', path: sources[2], text: '<svg/>' }] }, state), /未选页面/);
    const operations = [];
    const done = await drive({ id: 1 }, 'task', state, { ensureCurrent: async () => {}, checkpoint: async () => {} }, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async () => ({ actions: [{ action: 'write', path: sources[7], text: '<svg/>' }] }),
        execute: async (_user, _id, action) => {
            operations.push(action.tool || action.action);
            if (action.action === 'write') return { path: action.path, sha256: createHash('sha256').update(action.text).digest('hex') };
            if (action.tool === 'export') return { exitCode: 0, progressExport: action.args.at(-1) };
            if (action.action === 'deliver') {
                assert.deepEqual(action.repair.pages, selected);
                return { packageCheck: { slideCount: 8, checkedPages: 8, checkedValues: 0,
                    checklistDigest: createHash('sha256').update(JSON.stringify(action.checklist)).digest('hex'),
                    preservation: { sha256: state.reviewDraft.sha256, pages: selected } } };
            }
            return { exitCode: 0 };
        }
    });
    assert.deepEqual(operations, ['write', 'check_svg', 'finalize', 'export', 'deliver']);
    assert.equal(done.receipt.packageCheck.checkedPages, 8);
});

test('复检阻断项收敛时只回写剩余页，超出选页时保留草稿和写入边界', () => {
    const state = repairCheckpoint();
    assert.equal(startPageRepair(state, 'report', selected, 1), true);
    const fail = result => {
        state.pageRepair.phase = 'check';
        recordRepairResult(state, check, { action: 'run', result, error: '复检失败。' });
    };
    fail(report([1, font], [7, font], [8, overlap]));
    assert.deepEqual(state.pageRepair.remaining, [sources[0], sources[7]]);
    fail(report([8, overlap]));
    assert.deepEqual(state.pageRepair.remaining, [sources[7]]);
    assert.equal(automaticTurn(state), null);
    assert.throws(() => fail(report([7, font])), { code: 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED', message: /未选页.*第 7 页.*字号/ });
    assert.deepEqual(state.pageRepair.pages, selected);
    assert.equal(state.reviewDraft.sha256, 'a'.repeat(64));
});

test('只在实际读取相关材料失败时转为补充问题，材料恢复后自动回到修页', async () => {
    const source = 'inputs/material-1.md', question = { requestInput: { kind: 'clarification', question: '请补充对应的原文。' } };
    const state = { pageRepair: { automatic: true, phase: 'edit', sourceFiles: ['report/svg_output/page.svg'] },
        pageReview: { failedPages: [{ items: [{ source: { path: source } }] }] } };
    const read = path => ({ action: 'read', path });
    recordRepairResult(state, read('unrelated.md'), { action: 'read', error: '任务文件不存在。' });
    await assert.rejects(validateTurn(question, state), /标题和数据已获批准/);
    recordRepairResult(state, read(source), { action: 'read', error: '任务文件不存在。' });
    assert.ok((await validateTurn(question, state)).requestInput.context.includes(source));
    recordRepairResult(state, read(source), { action: 'read', result: { text: '已恢复的材料' } });
    await assert.rejects(validateTurn(question, state), /标题和数据已获批准/);
});

test('已批准页面自动修复次数有界，重试仅写失败页，最终失败保留可手动续作的草稿', async () => {
    const source = 'report/svg_output/b.svg', original = 'report/exports/final.pptx';
    const state = { bootstrapped: true, steps: 0, usedTokens: 0, engine: { pageRepair: 1 },
        request: { operation: 'generate', profile: 'quick', pageCount: 2, inputFiles: [], maxSteps: 20, tokenBudget: 0 },
        messages: [{ role: 'system', content: '测试修复。' }], lastExport: { path: original, args: ['report', '--quick-generate', '-o', original] } };
    initializeReview(state);
    applyReviewDecision(state, { stage: 'design', promptId: 'approved', plan: { summary: '报告', project: 'report',
        pages: [{ title: '收入', values: [] }, { title: '成本', values: [{ text: '成本80万元' }] }] } }, true);
    let writes = 0, deliveries = 0, askedAgain = false;
    const checks = [], exports = [];
    const run = drive({ id: 1 }, 'task', state, { ensureCurrent: async () => {}, checkpoint: async () => {} }, {
        resolveModel: async () => ({ context_window_tokens: 256000 }),
        callModel: async () => {
            if (!state.pageRepair) return { complete: { path: original } };
            if (!askedAgain) {
                askedAgain = true;
                return { requestInput: { kind: 'clarification', question: '已批准的成本是多少？' } };
            }
            return { actions: [{ action: 'write', path: source, text: '<svg/>' }] };
        },
        execute: async (_user, _id, op) => {
            if (op.action === 'deliver') {
                deliveries++;
                if (deliveries > 1) assert.deepEqual(op.repair.pages, [2]);
                return { reviewFailure: '交付第 2 页的成本不符。', reviewDraft: { sha256: String(deliveries).repeat(64), byteSize: 1500 },
                    pageReview: { passedPages: [1], failedPages: [{ page: 2, missingValues: [1] }], pageSources: ['report/svg_output/a.svg', source] } };
            }
            if (op.action === 'write') {
                assert.equal(op.path, source); writes++;
                return { path: source, sha256: createHash('sha256').update(op.text).digest('hex') };
            }
            checks.push(op.tool);
            if (op.tool === 'export') {
                exports.push(op.args.at(-1));
                return { exitCode: 0, progressExport: op.args.at(-1) };
            }
            return { exitCode: 0 };
        }
    });
    await assert.rejects(run, { code: 'PPT_MASTER_DELIVERY_REVIEW_REQUIRED' });
    assert.equal(writes, 2);
    assert.equal(deliveries, 3);
    assert.deepEqual(checks, ['check_svg', 'export', 'check_svg', 'export']);
    assert.equal(new Set([original, ...exports]).size, 3);
    assert.deepEqual(state.pageRepair, { sha256: state.reviewDraft.sha256, pages: [2], sourceFiles: [source] });
    assert.equal(state.deliveryReceipt, undefined);
});
