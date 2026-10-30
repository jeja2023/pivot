const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateMessageTokens, fitMessagesToContextBudget } = require('../server/services/context-budget');

test('工具调用参数计入预算并与所有结果一起裁剪', () => {
    const call = { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'x', arguments: 'a'.repeat(3000) } },
        { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } }
    ] };
    assert.ok(estimateMessageTokens(call) > 500);
    const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'old' },
        call,
        { role: 'tool', tool_call_id: 'a', content: 'answer a' },
        { role: 'tool', tool_call_id: 'b', content: 'answer b' },
        { role: 'user', content: 'current' }
    ];
    const result = fitMessagesToContextBudget(messages, { max_input_tokens: 360, max_tokens: 80 });
    assert.equal(result.messages.some(message => message.tool_calls), false);
    assert.equal(result.messages.some(message => message.role === 'tool'), false);
    assert.equal(result.messages.at(-1).content, 'current');
});
