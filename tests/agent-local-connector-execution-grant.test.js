'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { consumeConnectorExecutionGrant, requiresConnectorExecutionGrant } = require('../server/services/agent-local-connector');

test('可变本机工作区任务在创建连接器任务前必须消费绑定授权，只读任务不需要授权', async () => {
    assert.equal(requiresConnectorExecutionGrant('workspace.patch'), true);
    assert.equal(requiresConnectorExecutionGrant('workspace.test'), true);
    assert.equal(requiresConnectorExecutionGrant('workspace.read'), false);
    const consumed = [];
    const summary = await consumeConnectorExecutionGrant('workspace.patch', { changes: [{ path: 'a.js', content: 'x' }] }, { id: 7 }, {
        executionGrant: 'signed-token', executionGrantExpected: { runId: 'run-1', tool: 'mcp.1.workspace.patch', workspaceScopeId: 'run:run-1' }
    }, {
        verifyExecutionGrant(token, expected) {
            assert.equal(token, 'signed-token');
            assert.equal(expected.userId, 7);
            assert.equal(expected.tool, 'mcp.1.workspace.patch');
            assert.deepEqual(expected.input, { changes: [{ path: 'a.js', content: 'x' }] });
            return { payload: { grantId: 'g-1' }, summary: { grantId: 'g-1', tool: 'mcp.1.workspace.patch' } };
        },
        async consumeExecutionGrant(value) { consumed.push(value); }
    });
    assert.deepEqual(summary, { grantId: 'g-1', tool: 'mcp.1.workspace.patch' });
    assert.equal(consumed.length, 1);
    await assert.rejects(
        () => consumeConnectorExecutionGrant('workspace.patch', {}, { id: 7 }),
        error => error.code === 'AGENT_EXECUTION_GRANT_REQUIRED'
    );
    assert.equal(await consumeConnectorExecutionGrant('workspace.read', {}, { id: 7 }), null);
});
