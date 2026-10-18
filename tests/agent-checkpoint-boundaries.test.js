'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { beginAgentToolCheckpoint, completeAgentToolCheckpoint } = require('../server/services/agent-checkpoints');

test('checkpoint replay is bound to its run, owner, tool and input', async () => {
    const owner = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const suffix = `${process.pid}-${Date.now()}`;
    const other = await queryOne("INSERT INTO users (username, password_hash, role, status) VALUES (?, 'hash', 'user', 'active') RETURNING id", [`checkpoint-other-${suffix}`]);
    const ids = [`checkpoint-first-${suffix}`, `checkpoint-same-user-${suffix}`, `checkpoint-other-user-${suffix}`];
    for (const [index, id] of ids.entries()) {
        const userId = index === 2 ? other.id : owner.id;
        await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '检查点边界', '测试重放隔离', 'running', '{}', NOW(), NOW())", [id, userId]);
    }
    const operationKey = `checkpoint-boundary-${suffix}`;
    const data = { operationKey, toolName: 'example.read', input: { query: 'a' }, idempotent: true, user: owner };
    try {
        await beginAgentToolCheckpoint(ids[0], data);
        await completeAgentToolCheckpoint(operationKey, { result: '仅限原任务' }, { user: owner });
        await assert.rejects(() => beginAgentToolCheckpoint(ids[1], data), error => error.code === 'AGENT_OPERATION_SCOPE_MISMATCH');
        await assert.rejects(() => beginAgentToolCheckpoint(ids[2], { ...data, user: other }), error => error.code === 'AGENT_OPERATION_SCOPE_MISMATCH');
        await assert.rejects(() => beginAgentToolCheckpoint(ids[0], { ...data, user: other }), error => error.code === 'AGENT_CHECKPOINT_SCOPE_DENIED');
        await assert.rejects(() => beginAgentToolCheckpoint(ids[0], { ...data, toolName: 'other.read' }), error => error.code === 'AGENT_OPERATION_SCOPE_MISMATCH');
        await assert.rejects(() => beginAgentToolCheckpoint(ids[0], { ...data, input: { query: 'b' } }), error => error.code === 'AGENT_OPERATION_INPUT_MISMATCH');
        assert.deepEqual((await beginAgentToolCheckpoint(ids[0], data)).output, { result: '仅限原任务' });
    } finally {
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?, ?)', ids);
        await execute('DELETE FROM users WHERE id = ?', [other.id]);
    }
});

test('an originally non-idempotent pending checkpoint cannot become replayable by changing the current declaration', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `checkpoint-idempotency-${process.pid}-${Date.now()}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '检查点幂等性', '测试原始声明', 'running', '{}', NOW(), NOW())", [runId, user.id]);
    try {
        const data = { operationKey: `${runId}:write`, toolName: 'example.write', input: {}, idempotent: false, user };
        await beginAgentToolCheckpoint(runId, data);
        await assert.rejects(() => beginAgentToolCheckpoint(runId, { ...data, idempotent: true }), error => error.code === 'AGENT_RECOVERY_REQUIRES_APPROVAL');
    } finally {
        await execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
    }
});
