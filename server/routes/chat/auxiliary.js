'use strict';

const { asyncHandler } = require('../../http');
const { getAgentVoiceSession, listAgentVoiceSessions, recordAgentVoiceEvent, startAgentVoiceSession } = require('../../services/agent-voice-sessions');
const { controlVoiceSessionAgentRun } = require('./voice-task-control');
const { getExecutionMetrics } = require('../../repositories/chat-conversation-turns');
const { isSuperAdmin } = require('../../permissions');

function registerChatAuxiliaryRoutes(router, { authMiddleware, logAction }) {
    router.get('/chat/execution-metrics', authMiddleware, asyncHandler(async (req, res) => {
        const rows = await getExecutionMetrics(req.user.id, { admin: req.query.scope === 'organization' && isSuperAdmin(req.user), days: req.query.days });
        res.json({ success: true, metrics: rows, verification: '独立核验与用户纠正分别统计，自动启动或沉默不作为成功。' });
    }));
    router.get('/chat/voice-sessions', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ success: true, sessions: await listAgentVoiceSessions(req.user, { limit: req.query.limit }) });
    }));
    router.post('/chat/voice-sessions', authMiddleware, asyncHandler(async (req, res) => {
        const voiceSession = await startAgentVoiceSession(req.user, req.body || {});
        logAction(req, '启动实时语音会话', `语音会话: ${voiceSession.id}，传输: ${voiceSession.transport}`);
        res.status(201).json({ success: true, voiceSession });
    }));
    router.get('/chat/voice-sessions/:id', authMiddleware, asyncHandler(async (req, res) => {
        const voiceSession = await getAgentVoiceSession(req.user, req.params.id);
        if (!voiceSession) return res.status(404).json({ error: '语音会话不存在或无权访问。' });
        res.json({ success: true, voiceSession });
    }));
    router.post('/chat/voice-sessions/:id/events', authMiddleware, asyncHandler(async (req, res) => {
        const voiceSession = await recordAgentVoiceEvent(req.user, req.params.id, req.body || {});
        res.json({ success: true, voiceSession });
    }));
    router.post('/chat/voice-sessions/:id/task-control', authMiddleware, asyncHandler(async (req, res) => {
        const result = await controlVoiceSessionAgentRun(req.user, req.params.id, req.body?.action);
        logAction(req, '语音控制智能体任务', `语音会话: ${req.params.id}，动作: ${result.action}，来源任务: ${result.sourceRunId}`);
        res.status(result.action === 'resume' ? 202 : 200).json({ success: true, ...result });
    }));
}

module.exports = { registerChatAuxiliaryRoutes };
