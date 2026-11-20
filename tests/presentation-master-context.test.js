'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactMessages, planRequest, usageRecord } = require('../server/services/presentations/master/context');
const { estimateMessagesTokens } = require('../server/services/context-budget');

function turn(path, text, result = { path, sha256: require('node:crypto').createHash('sha256').update(text).digest('hex') }) {
    return [
        { role: 'assistant', content: JSON.stringify({ actions: [{ action: 'write', path, text }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'write', result }]) }
    ];
}

test('只收敛已确认写入的旧正文，保留指引、用户确认、失败、最近操作及原检查点', () => {
    const source = [{ role: 'system', content: '安全指引' }, { role: 'user', content: '用户确认方案并保留数字' },
        ...turn('project/page.svg', '长正文'.repeat(10000)),
        ...turn('project/failed.svg', '失败内容', { error: '未写入' }),
        ...turn('project/recent.svg', '最近正文'),
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,test' } }] }];
    const before = JSON.stringify(source), result = compactMessages(source);
    assert.equal(result.compactedWrites, 1);
    assert.equal(JSON.stringify(source), before);
    assert.equal(result.messages[0].content, source[0].content);
    assert.equal(result.messages[1].content, source[1].content);
    assert.match(result.messages[2].content, /已成功写入/);
    assert.doesNotMatch(result.messages[2].content, /长正文/);
    assert.equal(result.messages[4].content, source[4].content);
    assert.equal(result.messages[6].content, source[6].content);
    assert.deepEqual(result.messages.at(-1), source.at(-1));
    assert.ok(estimateMessagesTokens(result.messages) < estimateMessagesTokens(source));
});

test('无匹配文件回执、工具失败或不完整消息时不压缩', () => {
    const messages = [...turn('a.svg', '正文', { path: 'b.svg' }), ...turn('changed.svg', '正文', { path: 'changed.svg', sha256: '0'.repeat(64) }),
        { role: 'assistant', content: JSON.stringify({ actions: [{ action: 'write', path: 'b.svg', text: '正文' }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'write', error: '失败' }]) },
        ...turn('c.svg', '最近正文')];
    const result = compactMessages(messages);
    assert.equal(result.compactedWrites, 0);
    assert.deepEqual(result.messages, messages);
});

test('操作摘要由正式写入回执决定，保留归档后的证据并区分失败的动作', () => {
    const { actionSummary } = require('../server/services/presentations/master/observations');
    const original = [...turn('done.svg', '<svg/>'), ...turn('wrong.svg', '<svg/>', { path: 'wrong.svg', sha256: '0'.repeat(64) }),
        { role: 'assistant', content: JSON.stringify({ actions: [{ action: 'write', path: 'invalid.svg', text: '无效正文' }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'write', error: '写入失败' }]) }];
    const expected = { writes: 1, failedWrites: 1, runtimeReads: 0, lastWrittenPath: 'done.svg',
        lastActions: [{ action: 'write', failed: true }], lastFailure: { action: 'write' } };
    assert.deepEqual(actionSummary(original), expected);
    assert.deepEqual(actionSummary(compactMessages(original).messages), expected);
});

test('制作检查点用原始快照的分页回执计算进展，并保留可公开的提纲', () => {
    const { checkpointProgressView } = require('../server/services/presentations/master/checkpoint-progress');
    const first = 'inputs/material-1.md', second = 'inputs/material-2.md';
    const read = (path, offset, result, error) => [
        { role: 'assistant', content: JSON.stringify({ actions: [{ action: 'read', path, offset }] }) },
        { role: 'user', content: JSON.stringify([{ action: 'read', result, error }]) }
    ];
    const requestInput = { kind: 'confirmation', stage: 'design', plan: { summary: '按主题组织', pages: [
        { title: '结果', values: [{ text: '已核对事项 3 项', source: { quote: '仅用于内部核验的原文' } }] },
        { title: '计划', values: [] }
    ] } };
    const state = { bootstrapped: true, request: { materials: [{ path: first, title: '资料一' }, { path: second, title: '资料二' }],
        inputFiles: [{ path: first, kind: 'text' }, { path: second, kind: 'text' }] },
    review: { approvals: { direction: { plan: { summary: '报告方向' } } } },
    messages: [
        ...read(first, 6, { path: first, offset: 6, nextOffset: null, totalChars: 12 }),
        ...read(first, 0, { path: first, offset: 0, nextOffset: 6, totalChars: 12, archived: { archive: 0, index: 1 } }),
        ...read(second, 8, { path: second, offset: 8, nextOffset: null, totalChars: 12 }),
        ...read(second, 0, undefined, '内部读取错误'),
        { role: 'assistant', content: JSON.stringify({ requestInput }) }
    ] };
    const actual = checkpointProgressView(state);
    assert.deepEqual(actual.materials, [
        { title: '资料一', saved: true, reads: 2, failedReads: 0, contiguous: 12, totalChars: 12, complete: true },
        { title: '资料二', saved: true, reads: 1, failedReads: 1, contiguous: 0, totalChars: 12, complete: false }
    ]);
    assert.deepEqual(actual.plans.map(plan => plan.status), ['approved', 'previous']);
    assert.deepEqual(actual.plans[1].pages, [{ title: '结果', values: ['已核对事项 3 项'] }, { title: '计划', values: [] }]);
    assert.doesNotMatch(JSON.stringify(actual), /inputs\/|内部读取错误|内部核验的原文/);
    state.citationDraft = requestInput;
    assert.equal(checkpointProgressView(state).plans[1].status, 'citation_review');
    assert.equal(checkpointProgressView(state, requestInput).plans[1].status, 'pending');
    assert.deepEqual(checkpointProgressView({ ...state, messages: [], review: {}, citationDraft: null }).plans, []);
});

test('单轮窗口与累计预算分别限制模型调用，并预留输出和安全余量', () => {
    const { requestLimits } = require('../server/services/presentations/master/context');
    assert.equal(requestLimits({ context_window_tokens: 256000 }).archiveAt, 153600);
    assert.equal(requestLimits({ context_window_tokens: 256000, max_input_tokens: 64000 }).archiveAt, 64000);
    const messages = [{ role: 'user', content: '内容'.repeat(1000) }];
    assert.throws(() => planRequest(messages, messages, { context_window_tokens: 4000 }, 100000), { code: 'PPT_MASTER_CONTEXT_LIMIT' });
    assert.throws(() => planRequest(messages, messages, { context_window_tokens: 4000 }, Infinity), { code: 'PPT_MASTER_CONTEXT_LIMIT' });
    assert.throws(() => planRequest(messages, messages, { context_window_tokens: 256000 }, 5000), { code: 'PPT_MASTER_BUDGET_EXHAUSTED' });
    const plan = planRequest(messages, messages, { context_window_tokens: 9000 }, 100000);
    assert.ok(plan.maxTokens >= 2000);
    assert.ok(plan.inputEstimate + plan.maxTokens + 256 <= 9000);
    assert.equal(planRequest(messages, messages, { context_window_tokens: 256000, max_tokens: 3000 }, 100000).maxTokens, 3000);
    assert.throws(() => planRequest(messages, messages, { context_window_tokens: 256000, max_tokens: 1000 }, 100000), { code: 'PPT_MASTER_MODEL_OUTPUT_LIMIT' });
});

test('诊断按供应方实际用量累计，缺失用量明确标记估算，且不保存正文', () => {
    const state = { steps: 10, usedTokens: 100 }, plan = { inputEstimate: 500, originalEstimate: 900, breakdown: { initial: 200, history: 300, toolResults: 0, images: 0 } };
    usageRecord(state, plan, { usage: { prompt_tokens: 300, completion_tokens: 20 } }, '用户正文', 2, () => 10, { startedAt: '2026-05-04 12:00:00', durationMs: 1500 });
    assert.equal(state.usedTokens, 420);
    assert.deepEqual(state.usageDiagnostics[0], { call: 1, step: 11, inputTokens: 300, outputTokens: 20, inputEstimated: false, outputEstimated: false, inputEstimate: 500, originalEstimate: 900, compactedWrites: 2, breakdown: plan.breakdown, startedAt: '2026-05-04 12:00:00', durationMs: 1500, cumulativeTokens: 420 });
    usageRecord(state, plan, { usage: {} }, '敏感正文', 0, () => 10);
    assert.equal(state.usedTokens, 930);
    assert.equal(state.usageDiagnostics[1].inputEstimated, true);
    assert.equal(state.usageDiagnostics[1].outputEstimated, true);
    assert.match(state.usageDiagnostics[1].startedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.doesNotMatch(JSON.stringify(state.usageDiagnostics), /正文/);
});

test('重复的固定运行包页面只在模型视图保留一份，原始检查点和不同内容完整保留', () => {
    const read = text => ({ role: 'user', content: JSON.stringify([{ action: 'read_runtime', result: { path: 'references/a.md', offset: 0, nextOffset: null, text } }]) });
    const original = [read('相同指引'.repeat(1000)), read('不同指引'), read('相同指引'.repeat(1000))];
    const copy = JSON.stringify(original), result = compactMessages(original);
    assert.equal(JSON.stringify(original), copy);
    assert.match(result.messages[0].content, /后续读取结果/);
    assert.equal(result.messages[1].content, original[1].content);
    assert.equal(result.messages[2].content, original[2].content);
    assert.ok(estimateMessagesTokens(result.messages) < estimateMessagesTokens(original));
    const initial = { role: 'user', content: JSON.stringify({ runtimeDocument: 'references/a.md', path: 'references/a.md', offset: 0, nextOffset: null, text: '相同指引' }) };
    const duplicate = read('相同指引');
    const combined = compactMessages([initial, duplicate]);
    assert.match(combined.messages[0].content, /后续读取结果/);
    assert.equal(combined.messages[1].content, duplicate.content);
});

test('长观察按字符分页且保留 JSON 与写入回执', () => {
    const { boundedObservation } = require('../server/services/presentations/master/observations');
    const text = '🧭'.repeat(25000), action = { action: 'read', path: 'inputs/a.md', offset: 30 };
    const page = { path: action.path, text, nextOffset: null, totalChars: 25030 };
    const result = boundedObservation(action, page);
    assert.equal(Array.from(result.text).length, 24000);
    assert.equal(result.nextOffset, 24030);
    assert.equal(result.truncated, true);
    assert.equal(boundedObservation({ ...action, action: 'read_history' }, page).nextOffset, 12030);
    const receipts = [{ action: 'write', result: { path: 'p.svg', sha256: 'a'.repeat(64) } }, { action: 'read', result }];
    assert.deepEqual(JSON.parse(JSON.stringify(receipts)), receipts);
});

test('任务与平台模型账目对图片缺失用量、有效零值和实际用量采用相同口径', async () => {
    const { recordAgentModelUsage } = require('../server/services/agent-model');
    const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'A'.repeat(200000) } }] }];
    const estimate = estimateMessagesTokens(messages), output = '完成', estimateOutput = require('../server/llm').estimateTokens(output);
    const plan = { inputEstimate: estimate, originalEstimate: estimate, breakdown: {} };
    for (const usage of [undefined, { prompt_tokens: 0, completion_tokens: 10 }, { prompt_tokens: 100, completion_tokens: 20 }, { prompt_tokens: 5 }]) {
        const state = { steps: 0, usedTokens: 0 }, usageRef = { usage };
        usageRecord(state, plan, usageRef, output, 0, require('../server/llm').estimateTokens);
        const recorded = await recordAgentModelUsage({ id: 0 }, { id: 0 }, messages, output, 'ppt_master_engine', '',
            { usageRef, estimatedUsage: { inputTokens: estimate, outputTokens: estimateOutput } });
        assert.equal(state.usedTokens, recorded.totalTokens);
    }
    assert.ok(estimate < 5000);
});

test('每轮用量明细展示脱敏的本轮工作、工具失败与历史检查点回填，不泄露私有目录或正文', () => {
    const { usageDiagnosticsView, recordTurnDiagnostic } = require('../server/services/presentations/master/observations');
    const sha = require('node:crypto').createHash('sha256').update('保密正文').digest('hex');
    const state = {
        steps: 2,
        lastActionCorrection: 'PPT_MASTER_ACTION_INVALID',
        inspectionDiagnostic: { action: 'read_history', archive: 1, index: 4, offset: 0 },
        messages: [
            { role: 'system', content: '指引' },
            {
                role: 'assistant',
                content: JSON.stringify({
                    actions: [
                        { action: 'read_runtime', path: 'workflows/generate-pptx.md', offset: 0 },
                        { action: 'write', path: 'private-project/svg_output/slide_01.svg', text: '保密正文' }
                    ]
                })
            },
            {
                role: 'user',
                content: JSON.stringify([
                    { action: 'read_runtime', result: { path: 'workflows/generate-pptx.md', offset: 0, nextOffset: 24000 } },
                    { action: 'write', result: { path: 'private-project/svg_output/slide_01.svg', sha256: sha } }
                ])
            },
            {
                role: 'assistant',
                content: JSON.stringify({
                    actions: [
                        { action: 'run', tool: 'check_svg', args: ['private-project', '--page', 'private-project/svg_output/slide_01.svg'] },
                        { action: 'run', tool: 'export', args: ['private-project', '-o', 'private-project/exports/deck.pptx'] }
                    ]
                })
            },
            {
                role: 'user',
                content: JSON.stringify([
                    { action: 'run', result: { exitCode: 1 }, error: '检查未通过' }
                ])
            }
        ],
        usageDiagnostics: [
            { call: 1, step: 1, inputTokens: 100, outputTokens: 20, cumulativeTokens: 120, startedAt: '2026-05-04 10:00:00', durationMs: 2500 },
            { call: 2, step: 1, inputTokens: 110, outputTokens: 30, cumulativeTokens: 260 },
            { call: 3, step: 2, inputTokens: 150, outputTokens: 40, cumulativeTokens: 450 }
        ]
    };
    const view = usageDiagnosticsView(state, { code: 'PPT_MASTER_TOOL_REPEATED_FAILURE' });
    assert.equal(view[0].outcome, 'retry');
    assert.equal(view[0].errorCode, 'PPT_MASTER_ACTION_INVALID');
    assert.equal(view[0].startedAt, '2026-05-04 10:00:00');
    assert.equal(view[0].durationMs, 2500);
    assert.equal(view[1].outcome, 'productive');
    assert.deepEqual(view[1].actions, [
        { action: 'read_runtime', path: 'workflows/generate-pptx.md', offset: 0, nextOffset: 24000 },
        { action: 'write', path: 'svg_output/slide_01.svg', confirmed: true }
    ]);
    assert.equal(view[2].outcome, 'tool_failed');
    assert.equal(view[2].skippedActions, 1);
    assert.equal(view[2].exitCode, 1);
    assert.deepEqual(view[2].actions, [
        { action: 'run', tool: 'check_svg', path: 'svg_output/slide_01.svg', failed: true, exitCode: 1 }
    ]);
    recordTurnDiagnostic(state, { outcome: 'retry', errorCode: 'PPT_MASTER_CITATION_REVIEW_REQUIRED', citationCount: 2, citationLocation: '第 2 页第 1 项' });
    const updated = usageDiagnosticsView(state);
    assert.equal(updated[2].outcome, 'retry');
    assert.equal(updated[2].citationCount, 2);
    assert.equal(updated[2].citationLocation, '第 2 页第 1 项');
    assert.doesNotMatch(JSON.stringify(updated), /private-project|保密正文/);
});
