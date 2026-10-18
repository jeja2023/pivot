'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { controlVoiceSessionAgentRun } = require('../server/routes/chat');

const user = { id: 7 };

function deps(overrides = {}) {
    return {
        getAgentVoiceSession: async () => ({ id: 'voice-1', status: 'active', sessionId: 'chat-1' }),
        listChatAgentRunsForSession: async () => [{ id: 'run-1', status: 'executing' }],
        pauseAgentRun: async id => ({ id, status: 'needs_input' }),
        resumeAgentRun: async id => ({ id: `resumed-${id}`, status: 'queued' }),
        cancelAgentRun: async id => ({ id, status: 'cancelled' }),
        ...overrides
    };
}

test('voice task control can pause only the newest active chat-bound Agent run', async () => {
    const result = await controlVoiceSessionAgentRun(user, 'voice-1', 'pause', deps());
    assert.equal(result.action, 'pause');
    assert.equal(result.sourceRunId, 'run-1');
    assert.equal(result.run.status, 'needs_input');
    assert.match(result.message, /继续任务/);
});

test('voice task control resumes only a resumable needs-input run', async () => {
    const result = await controlVoiceSessionAgentRun(user, 'voice-1', 'resume', deps({
        listChatAgentRunsForSession: async () => [{ id: 'old', status: 'completed' }, { id: 'paused', status: 'needs_input' }]
    }));
    assert.equal(result.sourceRunId, 'paused');
    assert.equal(result.run.id, 'resumed-paused');
});

test('voice task control rejects a mismatched session or absent target', async () => {
    await assert.rejects(
        () => controlVoiceSessionAgentRun(user, 'voice-1', 'pause', deps({ getAgentVoiceSession: async () => ({ id: 'voice-1', status: 'active', sessionId: '' }) })),
        error => error.code === 'AGENT_VOICE_TASK_SESSION_INVALID'
    );
    await assert.rejects(
        () => controlVoiceSessionAgentRun(user, 'voice-1', 'cancel', deps({ listChatAgentRunsForSession: async () => [] })),
        error => error.code === 'AGENT_VOICE_TASK_TARGET_NOT_FOUND'
    );
});
