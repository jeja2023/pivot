'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { idleDays, expireIdleChatTasks } = require('../server/services/agent-idle-chat-tasks');
const { canTransitionAgentRunStatus } = require('../server/services/agent-runtime/state-machine');

test('会话等待期限默认七天，可关闭并对异常值安全回退', async () => {
    assert.equal(idleDays({}), 7);
    assert.equal(idleDays({ AGENT_CHAT_INPUT_IDLE_DAYS: '0' }), 0);
    assert.equal(idleDays({ AGENT_CHAT_INPUT_IDLE_DAYS: '-1' }), 7);
    assert.equal(idleDays({ AGENT_CHAT_INPUT_IDLE_DAYS: '999' }), 365);
    assert.equal(await expireIdleChatTasks({ env: { AGENT_CHAT_INPUT_IDLE_DAYS: '0' }, query: () => { throw new Error('关闭时不能查询'); } }), 0);
    assert.equal(canTransitionAgentRunStatus('needs_input', 'partial'), true);
});
