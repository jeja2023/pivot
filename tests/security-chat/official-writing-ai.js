// 公文写作 AI 路由的纯函数单测：思考块剥离、正文解析、推理模型识别与 /no_think 软开关。
// 覆盖 Qwen3（思考型）返回空正文的回归场景。由 security-chat.test.js 统一加载。
const { assert, test } = require('../security-helpers');
const {
    stripThinkTags,
    extractCompletionContent,
    shouldDisableThinking,
    applyNoThinkSoftSwitch
} = require('../../server/routes/apps');

test('stripThinkTags 剥离闭合与被截断的思考块', () => {
    assert.equal(stripThinkTags('<think>思考</think>\n\n正文'), '正文');
    assert.equal(stripThinkTags('<think>被截断的思考没有结束'), '');
    assert.equal(stripThinkTags('普通正文'), '普通正文');
    assert.equal(stripThinkTags(''), '');
    assert.equal(stripThinkTags(null), '');
});

test('extractCompletionContent 兼容多形态并剥离思考块', () => {
    assert.equal(extractCompletionContent({ choices: [{ message: { content: '<think>x</think>正文A' } }] }), '正文A');
    // 数组形态 content
    assert.equal(extractCompletionContent({ choices: [{ message: { content: [{ type: 'text', text: '正文' }, { text: 'B' }] } }] }), '正文\nB');
    // Responses 风格 output_text
    assert.equal(extractCompletionContent({ output_text: '<think>y</think>正文C' }), '正文C');
});

test('extractCompletionContent 对只有 reasoning_content 的响应返回空（不把思考当正文）', () => {
    assert.equal(extractCompletionContent({ choices: [{ message: { content: '', reasoning_content: '一大段思考' } }] }), '');
    assert.equal(extractCompletionContent({ choices: [{ message: { content: null } }] }), '');
});

test('shouldDisableThinking 识别推理型模型（标志位或常见模型名）', () => {
    assert.equal(shouldDisableThinking({ model_name: 'Qwen3.6-235B' }), true);
    assert.equal(shouldDisableThinking({ model_name: 'QwQ-32B' }), true);
    assert.equal(shouldDisableThinking({ model_name: 'DeepSeek-R1-Distill' }), true);
    assert.equal(shouldDisableThinking({ model_name: 'foo', supports_reasoning: 1 }), true);
    // 非推理型不应误判
    assert.equal(shouldDisableThinking({ model_name: 'Qwen2.5-14B' }), false);
    assert.equal(shouldDisableThinking({ model_name: 'llama-3.1-8b' }), false);
});

test('applyNoThinkSoftSwitch 仅在最后一条 user 消息追加 /no_think 且不改原数组', () => {
    const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
    const out = applyNoThinkSoftSwitch(msgs);
    assert.equal(out[1].content, 'U\n/no_think');
    assert.equal(out[0].content, 'S');
    // 原数组不被改动
    assert.equal(msgs[1].content, 'U');
});
