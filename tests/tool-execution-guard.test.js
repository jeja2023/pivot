'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createToolExecutionGuard, executeWithRetry, retryDelayMs } = require('../server/services/tool-execution-guard');

test('工具执行守卫隔离并发、限流和熔断恢复探测', () => {
    let clock = 1_000;
    const guard = createToolExecutionGuard({ now: () => clock, getConfig: () => ({ maxConcurrentPerTool: 1, maxCallsPerMinute: 3, failureThreshold: 2, cooldownMs: 100 }) });
    const first = guard.acquire({ toolName: 'mcp.1.echo', serverId: 1 });
    assert.throws(() => guard.acquire({ toolName: 'mcp.1.echo', serverId: 1 }), error => error.code === 'TOOL_BULKHEAD_FULL');
    first.release({ error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    const second = guard.acquire({ toolName: 'mcp.1.echo', serverId: 1 });
    second.release({ error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    assert.throws(() => guard.acquire({ toolName: 'mcp.1.echo', serverId: 1 }), error => error.code === 'TOOL_CIRCUIT_OPEN');
    clock += 101;
    const probe = guard.acquire({ toolName: 'mcp.1.echo', serverId: 1 });
    probe.release();
    assert.equal(guard.snapshot()['server:1|tool:mcp.1.echo'].consecutiveFailures, 0);
});

test('只对临时失败执行指数退避重试，非临时失败立即返回', async () => {
    let attempts = 0;
    const delays = [];
    const result = await executeWithRetry(async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('temporary'), { code: 'ECONNRESET' });
        return 'ok';
    }, { retryable: true, maxAttempts: 3, sleep: async delay => delays.push(delay), random: () => 0.5 });
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [retryDelayMs(1, () => 0.5), retryDelayMs(2, () => 0.5)]);
    await assert.rejects(() => executeWithRetry(async () => { throw Object.assign(new Error('invalid'), { code: 'TOOL_OUTPUT_INVALID' }); }, { retryable: true, maxAttempts: 3, sleep: async () => {} }), /invalid/);
});
