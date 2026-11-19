'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { drive } = require('../server/services/presentations/master/driver');
const { initializeReview, applyReviewDecision } = require('../server/services/presentations/master/review-plan');
const { validateTurn } = require('../server/services/presentations/master/actions');
const { recordRepairResult } = require('../server/services/presentations/master/automatic-page-repair');

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
