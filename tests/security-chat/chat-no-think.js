const {
    applyChatNoThinkSoftSwitch,
    assert,
    createStreamAccumulator,
    createVisibleReasoningStreamFilter,
    modelSupportsReasoning,
    shouldDisableChatThinking,
    stripVisibleReasoningScaffold,
    test
} = require('../security-helpers');
const { limitVisionImages } = require('../../server/services/chat-vision');
const { buildThinkingControlPayload } = require('../../server/routes/apps/helpers');
const { buildChatRequestData } = require('../../server/services/model-stream-service');

test('chat no-think switch only applies to reasoning models', () => {
    assert.equal(modelSupportsReasoning({ supports_reasoning: 1 }), true);
    assert.equal(modelSupportsReasoning({ supports_reasoning: 0 }), false);
    assert.equal(shouldDisableChatThinking({ supports_reasoning: 1, chat_thinking_enabled: 0 }), true);
    assert.equal(shouldDisableChatThinking({ supports_reasoning: 0, chat_thinking_enabled: 0 }), false);
    assert.equal(shouldDisableChatThinking({ supports_reasoning: 1, chat_thinking_enabled: 1 }), false);
});

test('chat no-think switch appends directive to the latest user message once', () => {
    const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'latest' }
    ];
    const model = { supports_reasoning: 1, chat_thinking_enabled: 0 };
    const out = applyChatNoThinkSoftSwitch(messages, model);

    assert.equal(out[1].content, 'first');
    assert.equal(out[3].content, 'latest\n/no_think');
    assert.equal(messages[3].content, 'latest');

    const repeated = applyChatNoThinkSoftSwitch([{ role: 'user', content: 'latest\n/no_think' }], model);
    assert.equal(repeated[0].content, 'latest\n/no_think');

    const enabled = applyChatNoThinkSoftSwitch([{ role: 'user', content: 'latest' }], { supports_reasoning: 1, chat_thinking_enabled: 1 });
    assert.equal(enabled[0].content, 'latest');

    const defaultClosed = applyChatNoThinkSoftSwitch([{ role: 'user', content: 'latest' }], { supports_reasoning: 1 });
    assert.equal(defaultClosed[0].content, 'latest\n/no_think');

    const vision = applyChatNoThinkSoftSwitch([
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ], model);
    assert.equal(vision[0].content[0].text, 'look\n/no_think');
    assert.equal(vision[0].content[1].type, 'image_url');
});

test('chat vision limit keeps multiple images within the per-message cap', () => {
    const input = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'look' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,def' } }
            ]
        }
    ];

    const out = limitVisionImages(input);
    const imageParts = out[0].content.filter(part => part.type === 'image_url');

    assert.equal(imageParts.length, 2);
    assert.equal(out[0].content[0].text, 'look');
});

test('chat no-think switch drops reasoning deltas from streamed content', () => {
    const emitted = [];
    const accumulator = createStreamAccumulator({
        includeThoughtTags: false,
        includeThoughtContent: false,
        onContent: chunk => emitted.push(chunk)
    });
    accumulator.pushJson({ choices: [{ delta: { reasoning_content: 'hidden reasoning' } }] });
    accumulator.pushJson({ choices: [{ delta: { content: 'visible answer' } }] });
    accumulator.finish();

    assert.equal(accumulator.getContent(), 'visible answer');
    assert.deepEqual(emitted, ['visible answer']);
});

test('chat no-think switch strips visible reasoning scaffold from final text', () => {
    const raw = [
        'Analyze User Input:',
        'User says: "介绍一下你自己"',
        '',
        'Key constraints from system prompt:',
        'Must use Chinese throughout.',
        '',
        'Draft:',
        '你好，我是通义千问，可以帮助你完成问答、写作和分析任务。',
        '',
        'Check Constraints:',
        'All good. Proceed.',
        'Output matches the draft.'
    ].join('\n');

    assert.equal(
        stripVisibleReasoningScaffold(raw),
        '你好，我是通义千问，可以帮助你完成问答、写作和分析任务。'
    );
});

test('chat no-think stream filter keeps final answer streaming after Draft', () => {
    const filter = createVisibleReasoningStreamFilter();
    const emitted = [];
    emitted.push(filter.push('Analyze User Input:\nUser says: "介绍一下你自己"\n'));
    emitted.push(filter.push('Key constraints from system prompt:\nMust use Chinese throughout.\n'));
    emitted.push(filter.push('Draft:\n你好，我是通义千问，'));
    emitted.push(filter.push('可以帮助你完成问答任务。'));
    emitted.push(filter.push('\nCheck Constraints:\nAll good. Proceed.'));
    emitted.push(filter.finish());

    const output = emitted.join('');
    assert.doesNotMatch(output, /Analyze User Input|Key constraints|Check Constraints|All good/);
    assert.equal(output, '你好，我是通义千问，可以帮助你完成问答任务。');
});

test('chat no-think stream filter passes normal answer chunks immediately', () => {
    const filter = createVisibleReasoningStreamFilter();
    assert.equal(filter.push('你好，'), '你好，');
    assert.equal(filter.push('我是通义千问。'), '我是通义千问。');
    assert.equal(filter.finish(), '');
});

test('thinking control payload targets self-hosted Qwen3 only', () => {
    const disabled = { chat_template_kwargs: { enable_thinking: false } };
    // Qwen3 / QwQ 的 /no_think 软开关在部分版本失效，必须显式下发 chat_template_kwargs。
    assert.deepEqual(buildThinkingControlPayload({ model_name: 'Qwen3.6-35B' }), disabled);
    assert.deepEqual(buildThinkingControlPayload({ model_name: 'Qwen/Qwen3.6-35B-A3B-FP8' }), disabled);
    assert.deepEqual(buildThinkingControlPayload({ model_name: 'qwen-3-32b' }), disabled);
    assert.deepEqual(buildThinkingControlPayload({ name: 'QwQ-32B' }), disabled);
    // 其他厂商对未知字段会直接返回 400，即使标记了 supports_reasoning 也不能附加。
    assert.deepEqual(buildThinkingControlPayload({ model_name: 'gpt-4o', supports_reasoning: 1 }), {});
    assert.deepEqual(buildThinkingControlPayload({ model_name: 'deepseek-r1' }), {});
    assert.deepEqual(buildThinkingControlPayload({ model_name: 'qwen2.5-72b' }), {});
    assert.deepEqual(buildThinkingControlPayload({}), {});
});

test('thinking control payload can be disabled for incompatible endpoints', () => {
    const previous = process.env.MODEL_THINKING_TEMPLATE_KWARGS;
    try {
        process.env.MODEL_THINKING_TEMPLATE_KWARGS = '0';
        assert.deepEqual(buildThinkingControlPayload({ model_name: 'Qwen3.6-35B' }), {});
    } finally {
        if (previous === undefined) delete process.env.MODEL_THINKING_TEMPLATE_KWARGS;
        else process.env.MODEL_THINKING_TEMPLATE_KWARGS = previous;
    }
});

test('chat stream payload closes Qwen3 thinking unless explicitly enabled', () => {
    const disabled = { enable_thinking: false };
    // 未勾选"支持推理"的遗漏配置：Qwen3 会先在思考里写完答案再正式输出一遍，必须在模型端关闭。
    assert.deepEqual(
        buildChatRequestData({ model_name: 'Qwen3.6-35B' }, 'Qwen3.6-35B').chat_template_kwargs,
        disabled
    );
    // 已勾选但未开启对话思考：与既有 /no_think 软开关一致地关闭。
    assert.deepEqual(
        buildChatRequestData({ model_name: 'Qwen3.6-35B', supports_reasoning: 1, chat_thinking_enabled: 0 }, 'Qwen3.6-35B').chat_template_kwargs,
        disabled
    );
    // 管理员显式开启对话思考时必须保留思维链，不能被强制关闭。
    assert.equal(
        buildChatRequestData({ model_name: 'Qwen3.6-35B', supports_reasoning: 1, chat_thinking_enabled: 1 }, 'Qwen3.6-35B').chat_template_kwargs,
        undefined
    );
    // 其他厂商即使关闭思考也不能附加该字段，否则会因未知字段返回 400。
    assert.equal(
        buildChatRequestData({ model_name: 'gpt-4o', supports_reasoning: 1, chat_thinking_enabled: 0 }, 'gpt-4o').chat_template_kwargs,
        undefined
    );
    assert.equal(
        buildChatRequestData({ model_name: 'qwen2.5-72b' }, 'qwen2.5-72b').chat_template_kwargs,
        undefined
    );
});
