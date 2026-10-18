'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { issueExecutionGrant } = require('../server/services/agent-execution-grant');
const { consumeExecutionGrant, registerExecutionGrant } = require('../server/services/agent-execution-grant-ledger');

const SECRET = 'postgres-execution-grant-test-secret-must-be-at-least-32-bytes';

test('execution grant ledger persists a bound grant and atomically rejects replay', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    assert.ok(user?.id);
    const runId = `execution-grant-${process.pid}-${Date.now()}`;
    const previous = process.env.PIVOT_AGENT_EXECUTION_GRANT_SECRET;
    process.env.PIVOT_AGENT_EXECUTION_GRANT_SECRET = SECRET;
    try {
        await execute(`
            INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at)
            VALUES (?, ?, 'execution grant', '验证受控执行授权', 'running', '{}', NOW(), NOW())
        `, [runId, user.id]);
        const input = { action: 'exec', command: 'node', script: 'process.stdout.write("ok")' };
        const issued = issueExecutionGrant({
            runId, userId: user.id, tool: 'terminal.runtime', capability: 'code.execute', input,
            policy: { decision: 'allow', approvalGranted: true },
            workspace: { scopeId: `run:${runId}`, mode: 'rw', target: '/workspace' }, network: { mode: 'deny' }
        });
        const registered = await registerExecutionGrant(issued);
        assert.equal(registered.registered, true);
        const consumed = await consumeExecutionGrant({ token: issued.token, payload: issued.payload, consumer: 'integration-test' });
        assert.equal(consumed.consumed, true);
        const row = await queryOne('SELECT status, consumer FROM agent_execution_grants WHERE grant_id = ?', [issued.payload.grantId]);
        assert.equal(row.status, 'consumed');
        assert.equal(row.consumer, 'integration-test');
        await assert.rejects(
            () => consumeExecutionGrant({ token: issued.token, payload: issued.payload, consumer: 'replay' }),
            error => error.code === 'AGENT_EXECUTION_GRANT_REPLAYED'
        );
    } finally {
        if (previous === undefined) delete process.env.PIVOT_AGENT_EXECUTION_GRANT_SECRET;
        else process.env.PIVOT_AGENT_EXECUTION_GRANT_SECRET = previous;
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
