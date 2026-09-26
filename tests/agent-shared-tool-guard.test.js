'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute } = require('../server/db/client');
const { acquireSharedToolLease } = require('../server/services/agent-shared-tool-guard');

test('shared tool leases enforce one limit across independent callers and recover expired leases', async () => {
    const toolName = `shared-guard-${process.pid}-${Date.now()}`;
    const first = await acquireSharedToolLease({ toolName, maxConcurrent: 1, leaseMs: 10_000 });
    try {
        await assert.rejects(
            () => acquireSharedToolLease({ toolName, maxConcurrent: 1, leaseMs: 10_000 }),
            error => error.code === 'TOOL_SHARED_BULKHEAD_FULL'
        );
        await execute('UPDATE agent_tool_execution_leases SET lease_expires_at = NOW() - INTERVAL \'1 second\' WHERE lease_token = ?', [first.token]);
        const replacement = await acquireSharedToolLease({ toolName, maxConcurrent: 1, leaseMs: 10_000 });
        assert.notEqual(replacement.token, first.token);
        await replacement.release();
    } finally {
        await first.release();
    }
});
