'use strict';

const crypto = require('crypto');
const { execute, query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const VOICE_TRANSPORTS = new Set(['browser_native']);
const VOICE_EVENTS = new Set(['turn_started', 'turn_completed', 'barge_in', 'heartbeat', 'paused', 'resumed', 'ended', 'failed']);
const VOICE_SESSION_TTL_MS = 2 * 60 * 1000;

function voiceError(message, code = 'AGENT_VOICE_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function normalizeLanguage(value) {
    const language = String(value || 'zh-CN').trim().slice(0, 32);
    return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language) ? language : 'zh-CN';
}

function serializeVoiceSession(row = {}) {
    return {
        id: row.id,
        sessionId: row.session_id || null,
        transport: row.transport,
        language: row.language,
        status: row.status,
        turnCount: Number(row.turn_count || 0),
        bargeInCount: Number(row.barge_in_count || 0),
        startedAt: row.started_at || null,
        endedAt: row.ended_at || null,
        updatedAt: row.updated_at || null
    };
}

async function assertOwnedChatSession(user, sessionId) {
    const value = String(sessionId || '').trim();
    if (!value) return null;
    const session = await queryOne('SELECT id FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [value, user.id]);
    if (!session) throw voiceError('语音会话引用的聊天会话不存在或无权访问。', 'AGENT_VOICE_SESSION_FORBIDDEN', 404);
    return session.id;
}

async function startAgentVoiceSession(user, input = {}) {
    if (!user?.id) throw voiceError('语音会话需要有效用户。', 'AGENT_VOICE_USER_REQUIRED', 401);
    const transport = VOICE_TRANSPORTS.has(String(input.transport || '')) ? String(input.transport) : 'browser_native';
    const sessionId = await assertOwnedChatSession(user, input.sessionId || input.session_id);
    const now = getBeijingTimestamp();
    const id = `voice_${crypto.randomUUID()}`;
    await execute(`UPDATE agent_voice_sessions SET status = 'ended', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE user_id = ? AND status IN ('active', 'paused')`, [now, now, user.id]);
    const metadata = {
        input: transport === 'browser_native' ? 'browser_speech_recognition' : 'provider',
        output: transport === 'browser_native' ? 'browser_speech_synthesis' : 'provider',
        audioRetention: 'none',
        transcriptRetention: 'none'
    };
    const row = await queryOne(`
        INSERT INTO agent_voice_sessions (id, user_id, session_id, transport, language, status, metadata, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?::jsonb, ?, ?)
        RETURNING *
    `, [id, user.id, sessionId, transport, normalizeLanguage(input.language), JSON.stringify(metadata), now, now]);
    return serializeVoiceSession(row);
}

async function recordAgentVoiceEvent(user, voiceSessionId, input = {}) {
    const event = String(input.event || '').trim();
    if (!VOICE_EVENTS.has(event)) throw voiceError('未知的语音会话事件。', 'AGENT_VOICE_EVENT_INVALID');
    const row = await queryOne('SELECT * FROM agent_voice_sessions WHERE id = ? AND user_id = ?', [String(voiceSessionId || ''), user.id]);
    if (!row) throw voiceError('语音会话不存在或无权访问。', 'AGENT_VOICE_NOT_FOUND', 404);
    const now = getBeijingTimestamp();
    if (['ended', 'failed'].includes(row.status) && !['ended', 'failed'].includes(event)) {
        throw voiceError('语音会话已结束，不能再记录新事件。', 'AGENT_VOICE_SESSION_ENDED', 409);
    }
    const status = event === 'ended' ? 'ended' : event === 'failed' ? 'failed' : event === 'paused' ? 'paused' : event === 'resumed' ? 'active' : row.status;
    const turnDelta = event === 'turn_completed' ? 1 : 0;
    const bargeDelta = event === 'barge_in' ? 1 : 0;
    const updated = await queryOne(`
        UPDATE agent_voice_sessions
        SET status = ?, turn_count = turn_count + ?, barge_in_count = barge_in_count + ?,
            ended_at = CASE WHEN ? IN ('ended', 'failed') THEN COALESCE(ended_at, ?) ELSE ended_at END,
            updated_at = ?
        WHERE id = ? AND user_id = ?
        RETURNING *
    `, [status, turnDelta, bargeDelta, status, now, now, row.id, user.id]);
    return serializeVoiceSession(updated);
}

async function sweepExpiredAgentVoiceSessions({ now = new Date(), ttlMs = VOICE_SESSION_TTL_MS } = {}) {
    const effectiveTtlMs = Math.min(Math.max(Number(ttlMs) || VOICE_SESSION_TTL_MS, 30000), 30 * 60 * 1000);
    const timestamp = getBeijingTimestamp(now);
    const cutoff = getBeijingTimestamp(new Date(now.getTime() - effectiveTtlMs));
    const row = await queryOne(`
        WITH expired AS (
            UPDATE agent_voice_sessions
            SET status = 'ended', ended_at = COALESCE(ended_at, ?), updated_at = ?
            WHERE status IN ('active', 'paused') AND updated_at <= ?
            RETURNING id
        ) SELECT COUNT(*) AS count FROM expired
    `, [timestamp, timestamp, cutoff]);
    return Number(row?.count || 0);
}

async function getAgentVoiceSession(user, voiceSessionId) {
    const row = await queryOne('SELECT * FROM agent_voice_sessions WHERE id = ? AND user_id = ?', [String(voiceSessionId || ''), user?.id]);
    return row ? serializeVoiceSession(row) : null;
}

async function assertActiveAgentVoiceSession(user, voiceSessionId, sessionId) {
    const voiceSession = await getAgentVoiceSession(user, voiceSessionId);
    if (!voiceSession || voiceSession.status !== 'active') {
        throw voiceError('临时语音消息需要当前用户的活动语音会话。', 'AGENT_VOICE_SESSION_INACTIVE', 409);
    }
    if (!voiceSession.sessionId || voiceSession.sessionId !== String(sessionId || '')) {
        throw voiceError('临时语音消息必须绑定当前语音会话所属的聊天会话。', 'AGENT_VOICE_SESSION_MISMATCH', 403);
    }
    return voiceSession;
}

async function listAgentVoiceSessions(user, { limit = 20 } = {}) {
    const rows = await query('SELECT * FROM agent_voice_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?', [user?.id, Math.min(Math.max(Number(limit) || 20, 1), 100)]);
    return rows.map(serializeVoiceSession);
}

module.exports = { assertActiveAgentVoiceSession, getAgentVoiceSession, listAgentVoiceSessions, recordAgentVoiceEvent, startAgentVoiceSession, sweepExpiredAgentVoiceSessions };
