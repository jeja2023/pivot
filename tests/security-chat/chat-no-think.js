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
