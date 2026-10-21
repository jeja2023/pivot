'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderEventStateMachine, createStreamAccumulator } = require('../server/streaming');
const { createToolCallAccumulator } = require('../server/services/streaming-tools');

function responsesCompleted(text, usage = null) {
    return { type: 'response.completed', response: { id: 'response-test', output: [
        { type: 'message', content: [{ type: 'output_text', text }] }
    ], ...(usage ? { usage } : {}) } };
}

test('Responses 正文增量和结束完整文本只发送并保存一次', () => {
    const emitted = [];
    const accumulator = createStreamAccumulator({ onContent: value => emitted.push(value) });
    const provider = createProviderEventStateMachine();
    const frames = [
        { type: 'response.output_text.delta', delta: '这是一份' },
        { type: 'response.output_text.delta', delta: '完整答复。' },
        responsesCompleted('这是一份完整答复。', { input_tokens: 7, output_tokens: 8, total_tokens: 15 })
    ];
    frames.forEach(frame => { accumulator.pushJson(frame); provider.ingest(frame); });
    assert.equal(accumulator.getContent(), '这是一份完整答复。');
    assert.equal(emitted.join(''), '这是一份完整答复。');
    assert.equal(provider.finalize().outputText, '这是一份完整答复。');
    assert.equal(accumulator.getUsage().total_tokens, 15);
});

test('兼容接口最后附带完整 message 时不重复追加正文', () => {
    const accumulator = createStreamAccumulator();
    const tools = createToolCallAccumulator();
    const frames = [
        { choices: [{ delta: { content: '工具结果：' } }] },
        { choices: [{ delta: { content: '核对完成。' } }] },
        { choices: [{ message: { content: '工具结果：核对完成。' }, finish_reason: 'stop' }] }
    ];
    frames.forEach(frame => { accumulator.pushJson(frame); tools.ingest(frame); });
    assert.equal(accumulator.getContent(), '工具结果：核对完成。');
    assert.equal(tools.finalize().content, '工具结果：核对完成。');
});

test('正常增量中有意重复的原文不得被文本去重删除', () => {
    const accumulator = createStreamAccumulator();
    for (const delta of ['请逐项核对。', '请逐项核对。', '哈哈', '哈哈']) accumulator.pushJson({ type: 'response.output_text.delta', delta });
    const expected = '请逐项核对。请逐项核对。哈哈哈哈';
    accumulator.pushJson(responsesCompleted(expected));
    assert.equal(accumulator.getContent(), expected);
});

test('只有完整结果的兼容响应仍可输出，部分增量仅补齐缺失后缀', () => {
    const snapshotOnly = createStreamAccumulator();
    snapshotOnly.pushJson(responsesCompleted('完整答复。'));
    assert.equal(snapshotOnly.getContent(), '完整答复。');
    const partial = createStreamAccumulator();
    partial.pushJson({ type: 'response.output_text.delta', delta: '完整' });
    partial.pushJson(responsesCompleted('完整答复。'));
    partial.pushJson(responsesCompleted('完整答复。'));
    assert.equal(partial.getContent(), '完整答复。');
});

test('思考内容和相同措辞的正文分别保留，不跨通道做去重', () => {
    const accumulator = createStreamAccumulator({ includeThoughtTags: true });
    accumulator.pushJson({ type: 'response.reasoning_text.delta', delta: '逐项核对。' });
    accumulator.pushJson({ type: 'response.output_text.delta', delta: '逐项核对。' });
    accumulator.pushJson(responsesCompleted('逐项核对。'));
    accumulator.finish();
    assert.equal(accumulator.getContent(), '<thought>逐项核对。</thought>逐项核对。');
});

test('完整结束结果中的多消息和多文本部分只补齐未流出的内容', () => {
    const accumulator = createStreamAccumulator();
    accumulator.pushJson({ type: 'response.output_text.delta', delta: '第一段。' });
    const completed = responsesCompleted('第一段。');
    completed.response.output[0].content.push({ type: 'output_text', text: '第二段。' });
    completed.response.output.push({ type: 'message', content: [{ type: 'text', text: '第三段。' }] });
    completed.response.output.push({ type: 'function_call', name: 'ignore', arguments: '{}' });
    accumulator.pushJson(completed);
    accumulator.pushJson(completed);
    assert.equal(accumulator.getContent(), '第一段。第二段。第三段。');
});

test('不一致的结束快照不能拼成第二份回复', () => {
    const accumulator = createStreamAccumulator();
    accumulator.pushJson({ type: 'response.output_text.delta', delta: '已发送的正文。' });
    accumulator.pushJson(responsesCompleted('内容不同的完整快照。'));
    assert.equal(accumulator.getContent(), '已发送的正文。');
});
