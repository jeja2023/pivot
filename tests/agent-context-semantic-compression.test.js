'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    EVIDENCE_BEGIN,
    HISTORY_BEGIN,
    compactAgentContextMessages
} = require('../server/services/agent-context-semantic-compression');
const { buildPlannerMessages } = require('../server/services/agent-runtime/planner');
const { estimateMessagesTokens } = require('../server/services/context-budget');

function toolObservation(step, size = 9000) {
    return {
        role: 'assistant',
        content: [
            'PIVOT_MCP_TOOL_RESULT_BEGIN',
            `执行观察 ${step}：`,
            JSON.stringify({
                step,
                tool: 'workspace.search',
                output: {
                    text: `文件扫描结果 ${step}：${'x'.repeat(size)}`,
                    rawOutputRef: `artifact-cas://${String(step).repeat(64).slice(0, 64)}`,
                    rawOutputDigest: String(step).repeat(64).slice(0, 64)
                }
            }),
            'PIVOT_MCP_TOOL_RESULT_END'
        ].join('\n')
    };
}

test('超过八条来源时仍保留早期事实和每个原文引用，压缩不能只剩最后几条', () => {
    const { buildWorkingStatePrompt } = require('../server/services/agent-working-state');
    const evidence = Array.from({ length: 16 }, (_, index) => ({ id: `part-${index}`, source: 'read',
        text: index === 0 ? '首段关键标记：松鹤合规紫檀；数值9。' : `分段${index}数值${index * 7}。`,
        rawOutputRef: 'artifact-cas://' + String(index + 1).padStart(64, '0'), status: 'observed' }));
    const state = { goal: '沿链读取并保留第一段标记', evidence };
    const prompt = buildWorkingStatePrompt(state);
    assert.match(prompt, /松鹤合规紫檀/);
    for (const item of evidence) assert(prompt.includes(item.rawOutputRef));
    const result = compactAgentContextMessages([{ role: 'system', content: '固定规则' },
        { role: 'user', content: prompt }, ...Array.from({ length: 8 }, (_, index) => toolObservation(index + 1)), { role: 'user', content: '给出总数与首段标记' }], { inputBudget: 6000, taskWorkingState: state });
    const text = JSON.stringify(result.messages);
    assert.match(text, /松鹤合规紫檀/);
    for (const item of evidence) assert(text.includes(item.rawOutputRef));
});

test('semantic context compaction follows retrievable evidence, working memory, and history layers', () => {
    const state = {
        goal: '完成受控发布',
        constraints: [
            { id: 'c-no-secret', text: '不得泄露凭据，发布必须经过审批。', status: 'active' },
            { id: 'c-evidence', text: '最终交付必须给出可追溯证据。', status: 'active' }
        ],
        pendingWork: [{ id: 'p-release', text: '等待人工批准发布', status: 'pending' }],
        decisions: [{ id: 'd-1', text: '先在影子环境验证', status: 'active' }],
        evidence: [{ id: 'e-1', text: '测试报告通过', rawOutputRef: 'artifact-cas://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'observed' }]
    };
    const history = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `历史第 ${index + 1} 轮：不得跳过审批；其余讨论 ${'普通叙述 '.repeat(420)}`
    }));
    const messages = [
        { role: 'system', content: '系统策略：遵守审批。' },
        { role: 'system', content: 'PIVOT_TASK_WORKING_STATE_BEGIN\n旧状态\nPIVOT_TASK_WORKING_STATE_END' },
        ...history,
        ...Array.from({ length: 8 }, (_, index) => toolObservation(index + 1)),
        { role: 'user', content: '当前目标：完成发布且不要泄露凭据。' }
    ];
    const result = compactAgentContextMessages(messages, { inputBudget: 1800, taskWorkingState: state });
    const body = result.messages.map(message => String(message.content)).join('\n');

    assert.equal(result.metadata.applied, true);
    assert.equal(result.metadata.levelOne.applied, true);
    assert.equal(result.metadata.levelTwo.applied, true);
    assert.equal(result.metadata.levelThree.applied, true);
    assert.match(body, new RegExp(EVIDENCE_BEGIN));
    for (let step = 1; step <= 6; step += 1) {
        assert.match(body, new RegExp(`artifact-cas://${String(step).repeat(64)}`));
    }
    assert.match(body, /\[c-no-secret\]/);
    assert.match(body, /不得泄露凭据/);
    assert.match(body, new RegExp(HISTORY_BEGIN));
    assert.match(body, /当前目标：完成发布且不要泄露凭据/);
    assert.ok(result.metadata.inputTokensAfter < result.metadata.inputTokensBefore);
    assert.deepEqual(result.metadata.retention.constraintIds, ['c-no-secret', 'c-evidence']);
});

test('semantic compaction is a no-op below the target budget', () => {
    const messages = [{ role: 'system', content: '策略' }, { role: 'user', content: '简短请求' }];
    const result = compactAgentContextMessages(messages, { inputBudget: 4096 });
    assert.equal(result.metadata.applied, false);
    assert.deepEqual(result.messages, messages);
    assert.equal(result.messages.contextCompaction.applied, false);
});

test('planner exposes semantic-compaction provenance while preserving task constraints and current goal', () => {
    const state = {
        goal: '完成审计报告',
        constraints: [{ id: 'c-audit', text: '必须保留审批与证据链。', status: 'active' }],
        pendingWork: [{ id: 'p-audit', text: '输出审计报告', status: 'pending' }],
        decisions: [], evidence: []
    };
    const history = Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `旧会话 ${index + 1}：必须保留审批证据。${'细节 '.repeat(1600)}`
    }));
    const observations = Array.from({ length: 8 }, (_, index) => ({
        step: index + 1,
        tool: 'workspace.search',
        output: {
            text: `扫描 ${index + 1} ${'结果 '.repeat(2500)}`,
            rawOutputRef: `artifact-cas://${'b'.repeat(63)}${index}`
        }
    }));
    const messages = buildPlannerMessages('完成审计报告', [{ name: 'workspace.search' }], observations, 'audit', {
        taskWorkingState: state,
        chatHistory: history
    }, { max_input_tokens: 28000, max_tokens: 512 });
    const body = messages.map(message => String(message.content)).join('\n');

    assert.equal(messages.contextCompaction.applied, true);
    assert.ok(messages.contextCompaction.inputTokensAfter < messages.contextCompaction.inputTokensBefore);
    assert.match(body, /\[c-audit\]/);
    assert.match(body, /完成审计报告/);
    assert.ok(estimateMessagesTokens(messages) <= 28000);
});
