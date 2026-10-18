'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extractPromptCacheUsage } = require('../server/services/agent-model');

test('提供方缓存 token 仅在明确返回时计为已观测，兼容 OpenAI 与 Anthropic 字段', () => {
    assert.deepEqual(extractPromptCacheUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }), {
        cacheReadTokens: 80, cacheCreationTokens: 0, cacheObserved: true
    });
    assert.deepEqual(extractPromptCacheUsage({ input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }), {
        cacheReadTokens: 30, cacheCreationTokens: 10, cacheObserved: true
    });
    assert.deepEqual(extractPromptCacheUsage({ prompt_tokens: 100 }), {
        cacheReadTokens: 0, cacheCreationTokens: 0, cacheObserved: false
    });
});
