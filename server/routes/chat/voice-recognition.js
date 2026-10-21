'use strict';

const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../../http');
const { speechService } = require('../../services/speech-recognition');
const { voiceStreaming } = require('../../services/speech-recognition/streaming');

function registerVoiceRecognitionRoutes(router, { authMiddleware, service = speechService }) {
    const limiter = rateLimit({ windowMs: 60000, limit: 60, keyGenerator: req => String(req.user.id),
        standardHeaders: true, legacyHeaders: false, message: { error: '语音请求过于频繁，请稍后重试。', code: 'VOICE_RATE_LIMIT' } });
    router.get('/chat/voice-recognition', authMiddleware, asyncHandler(async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        const status = await service.capabilities();
        res.json({ success: true, ...status, streaming: status.streaming === true && voiceStreaming.enabled() });
    }));
    router.post('/chat/voice-stream-tickets', authMiddleware, limiter, asyncHandler(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(voiceStreaming.issueTicket(req.user));
    }));
    router.post('/chat/voice-transcriptions', authMiddleware, limiter, asyncHandler(async (req, res) => {
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', abort);
        res.once('close', abort);
        res.set('Cache-Control', 'no-store');
        try { res.json({ success: true, ...(await service.transcribe(req.user, req.body, { signal: controller.signal })) }); }
        finally { if (req.body) req.body.audioBase64 = ''; req.removeListener('aborted', abort); res.removeListener('close', abort); }
    }));
}

module.exports = { registerVoiceRecognitionRoutes };
