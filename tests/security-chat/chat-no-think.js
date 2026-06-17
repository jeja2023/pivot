const {
    applyChatNoThinkSoftSwitch,
    assert,
    modelSupportsReasoning,
    shouldDisableChatThinking,
    test
} = require('../security-helpers');

test('chat no-think switch only applies to reasoning models', () => {
    assert.equal(modelSupportsReasoning({ supports_reasoning: 1 }), true);
    assert.equal(modelSupportsReasoning({ supports_reasoning: 0 }), false);
    assert.equal(shouldDisableChatThinking({ supports_reasoning: 1, disable_chat_thinking: 1 }), true);
    assert.equal(shouldDisableChatThinking({ supports_reasoning: 0, disable_chat_thinking: 1 }), false);
    assert.equal(shouldDisableChatThinking({ supports_reasoning: 1, disable_chat_thinking: 0 }), false);
});

test('chat no-think switch appends directive to the latest user message once', () => {
    const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'latest' }
    ];
    const model = { supports_reasoning: 1, disable_chat_thinking: 1 };
    const out = applyChatNoThinkSoftSwitch(messages, model);

    assert.equal(out[1].content, 'first');
    assert.equal(out[3].content, 'latest\n/no_think');
    assert.equal(messages[3].content, 'latest');

    const repeated = applyChatNoThinkSoftSwitch([{ role: 'user', content: 'latest\n/no_think' }], model);
    assert.equal(repeated[0].content, 'latest\n/no_think');

    const disabled = applyChatNoThinkSoftSwitch([{ role: 'user', content: 'latest' }], { supports_reasoning: 1 });
    assert.equal(disabled[0].content, 'latest');

    const vision = applyChatNoThinkSoftSwitch([
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ], model);
    assert.equal(vision[0].content[0].text, 'look\n/no_think');
    assert.equal(vision[0].content[1].type, 'image_url');
});
