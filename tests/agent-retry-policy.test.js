const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateAgentRetryDelayMs, MAX_RETRY_DELAY_MS } = require('../server/services/agent-runtime/retry-policy');

test('Agent 重试采用有上限的指数退避与抖动', () => {
    assert.equal(calculateAgentRetryDelayMs(1, () => 0), 1000);
    assert.equal(calculateAgentRetryDelayMs(2, () => 0), 2000);
    assert.equal(calculateAgentRetryDelayMs(3, () => 1), 4800);
    assert.equal(calculateAgentRetryDelayMs(99, () => 1), MAX_RETRY_DELAY_MS);
});
