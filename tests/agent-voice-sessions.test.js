'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const {
    getAgentVoiceSession,
    recordAgentVoiceEvent,
    startAgentVoiceSession,
    sweepExpiredAgentVoiceSessions
} = require('../server/services/agent-voice-sessions');

test('realtime voice sessions retain lifecycle counters without persisting audio or transcripts', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const first = await startAgentVoiceSession(user, { transport: 'browser_native', language: 'zh-CN' });
    try {
        assert.equal(first.status, 'active');
        assert.equal(first.transport, 'browser_native');
        await recordAgentVoiceEvent(user, first.id, { event: 'turn_started' });
        await recordAgentVoiceEvent(user, first.id, { event: 'barge_in' });
        const completed = await recordAgentVoiceEvent(user, first.id, { event: 'turn_completed' });
        assert.equal(completed.turnCount, 1);
        assert.equal(completed.bargeInCount, 1);
        const ended = await recordAgentVoiceEvent(user, first.id, { event: 'ended' });
        assert.equal(ended.status, 'ended');
        const row = await queryOne('SELECT metadata FROM agent_voice_sessions WHERE id = ?', [first.id]);
        const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        assert.deepEqual(metadata, {
            input: 'browser_speech_recognition', output: 'browser_speech_synthesis',
            audioRetention: 'none', transcriptRetention: 'none'
        });
        assert.equal((await getAgentVoiceSession(user, first.id)).status, 'ended');
    } finally {
        await execute('DELETE FROM agent_voice_sessions WHERE id = ?', [first.id]);
    }
});

test('starting a new realtime voice session closes an existing active session for the same user', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const first = await startAgentVoiceSession(user, {});
    const second = await startAgentVoiceSession(user, {});
    try {
        assert.equal((await getAgentVoiceSession(user, first.id)).status, 'ended');
        assert.equal((await getAgentVoiceSession(user, second.id)).status, 'active');
    } finally {
        await execute('DELETE FROM agent_voice_sessions WHERE id IN (?, ?)', [first.id, second.id]);
    }
});

test('voice transport is fail-closed to the implemented browser-native channel', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const session = await startAgentVoiceSession(user, { transport: 'unconfigured_provider' });
    try {
        assert.equal(session.transport, 'browser_native');
    } finally {
        await execute('DELETE FROM agent_voice_sessions WHERE id = ?', [session.id]);
    }
});

test('voice heartbeat keeps a session live and a missed terminal event is recovered by TTL sweep', async () => {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const session = await startAgentVoiceSession(user, {});
    try {
        await recordAgentVoiceEvent(user, session.id, { event: 'heartbeat' });
        assert.equal(await sweepExpiredAgentVoiceSessions({ now: new Date(Date.now() + 1000), ttlMs: 30000 }), 0);
        assert.equal(await sweepExpiredAgentVoiceSessions({ now: new Date(Date.now() + 31000), ttlMs: 30000 }), 1);
        assert.equal((await getAgentVoiceSession(user, session.id)).status, 'ended');
        await assert.rejects(
            () => recordAgentVoiceEvent(user, session.id, { event: 'turn_started' }),
            error => error.code === 'AGENT_VOICE_SESSION_ENDED'
        );
    } finally {
        await execute('DELETE FROM agent_voice_sessions WHERE id = ?', [session.id]);
    }
});
