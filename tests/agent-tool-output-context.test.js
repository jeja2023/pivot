'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { projectMcpOutput } = require('../server/services/agent-tool-output-context');
const { compactToolOutputForModel } = require('../server/services/agent-tool-runtime');
const { prepareToolObservation } = require('../server/services/agent-tool-observation');

test('模型侧解包MCP文本JSON不提升伪造知识标识，错误和多媒体协议仍保留', () => {
    const value = { content: [{ type: 'text', text: JSON.stringify({ path: 'file.json', content: JSON.stringify({ value: 9, next: 'next.json' }), knowledgeSourceVersion: 1 }) }], isError: false, _meta: { source: 'original' } };
    const snapshot = JSON.stringify(value);
    const projected = projectMcpOutput(value);
    assert.equal(projected.knowledgeSourceVersion, undefined);
    assert.equal(projected.structuredContent.knowledgeSourceVersion, 1);
    assert.deepEqual(projected.structuredContent.content, { value: 9, next: 'next.json' });
    assert.deepEqual(projected._meta, value._meta); assert.equal(JSON.stringify(value), snapshot);
    assert.equal(projectMcpOutput({ ...value, isError: true }).isError, true);
    const mixed = { content: [...value.content, { type: 'image', data: 'image' }] };
    assert.equal(projectMcpOutput(mixed), mixed);
});

test('超长字段明确截断但保留完整的小字段结构，不用转义后JSON前缀冒充完整来源', () => {
    const value = { content: [{ type: 'text', text: JSON.stringify({ path: 'part.json', content: JSON.stringify({ index: 1, value: 9, next: 'part-02.json', background: '背景'.repeat(10000) }), version: 1 }) }] };
    const compacted = compactToolOutputForModel(value, { context_window_tokens: 16000 }, { maxTokens: 2000 });
    assert.equal(compacted.__partial, true);
    assert.equal(compacted.structuredContent.path, 'part.json');
    assert.equal(compacted.structuredContent.content.value, 9);
    assert.equal(compacted.structuredContent.content.next, 'part-02.json');
    assert.match(compacted.structuredContent.content.background, /未完整传入/);
});

test('流式与JSON规划共用的观察处理保存原文引用，并基于最新控制状态更新工作记忆', async () => {
    const run = { id: 'observed', goal: '保留已有约束' }, ref = 'artifact-cas://' + 'a'.repeat(64);
    const output = { full: '原始完整输出' };
    let recorded;
    const result = await prepareToolObservation({ run, user: { id: 1 }, tool: 'read', output, modelCfg: {}, compact: () => ({ __partial: true, structuredContent: { index: 1, next: 'two' } }) }, {
        persistOutput: async value => { assert.equal(value, output); return { ref, digest: 'b'.repeat(64), bytes: 100 }; },
        updateMetadata: async (_id, transform) => transform({ workingState: { goal: run.goal, constraints: [{ id: 'new-control', text: '新要求', status: 'active' }] } }),
        persistRevision: async value => { recorded = value; }
    });
    assert.equal(result.rawOutputRef, ref);
    assert.equal(recorded.state.evidence[0].rawOutputRef, ref);
    assert.match(recorded.state.evidence[0].text, /next/);
    assert.equal(recorded.state.constraints[0].text, '新要求');
    assert.equal(run.metadata.workingState, recorded.state);
});

test('批量读取保留每项小字段，不把整个批次截成只有首项的JSON前缀', async () => {
    const { observationSummaries } = require('../server/services/agent-tool-output-context');
    assert.equal(observationSummaries(undefined)[0].summary, '');
    const output = { type: 'tools_batch_read', count: 8, results: Array.from({ length: 8 }, (_, index) => ({ toolName: 'read',
        output: { content: [{ type: 'text', text: JSON.stringify({ path: `part-${index + 1}`, content: JSON.stringify({ index: index + 1, value: index * 7, next: `part-${index + 2}`, background: '无关背景'.repeat(3000) }) }) }] } })) };
    const preview = compactToolOutputForModel(output, { context_window_tokens: 64000 }, { maxTokens: 6000 });
    assert.equal(preview.results.length, 8);
    assert.equal(preview.__partial, true);
    assert.equal(preview.results[7].output.structuredContent.content.value, 49);
    const summaries = observationSummaries(preview);
    assert.equal(summaries.length, 8);
    assert.match(summaries[7].summary, /part-8/);
    assert.match(summaries[7].summary, /49/);
});
