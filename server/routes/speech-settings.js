'use strict';

const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../http');
const { isSuperAdmin } = require('../permissions');
const { speechSettings } = require('../services/speech-recognition/settings');
const { speechService } = require('../services/speech-recognition');
const { embeddedSpeech } = require('../services/speech-recognition/embedded');
const { voiceStreaming } = require('../services/speech-recognition/streaming');
const { testSpeechSettings } = require('../services/speech-recognition/settings-test');

function registerSpeechSettingsRoutes(router, { authMiddleware, logAction, settings = speechSettings, service = speechService,
    embedded = embeddedSpeech, streaming = voiceStreaming, testConnection = testSpeechSettings } = {}) {
    const administrator = (req, res, next) => isSuperAdmin(req.user) ? next() : res.status(403).json({ error: '只有系统最高管理员可以配置和测试统一语音服务。' });
    const limiter = rateLimit({ store: require('../services/rate-limit-store').createRateLimitStore('speech:settings'), windowMs: 60000, limit: 12, keyGenerator: req => String(req.user.id),
        standardHeaders: true, legacyHeaders: false, message: { error: '语音服务测试过于频繁，请稍后重试。' } });
    const speechHandler = handler => asyncHandler(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await handler(req, res); }
        catch (error) { res.status(error.statusCode || error.status || 400).json({ success: false, error: error.code?.startsWith('VOICE_') ? error.message : '语音配置无效或无法保存，请检查配置后重试。', code: error.code?.startsWith('VOICE_') ? error.code : 'VOICE_SETTINGS_INVALID' }); }
    });
    router.get('/settings/speech', authMiddleware, administrator, speechHandler(async (_req, res) => {
        res.json({ success: true, config: settings.publicConfig({ administrator: true }), status: await service.capabilities() });
    }));
    router.put('/settings/speech', authMiddleware, administrator, speechHandler(async (req, res) => {
        const config = await settings.save(req.body, { userId: req.user.id });
        streaming.reset(); service.reset(); await embedded.reconfigure();
        if (embedded.enabled()) embedded.ensureReady().catch(() => {});
        logAction?.(req, '修改统一语音识别配置', `识别方式: ${config.provider}，启用: ${config.enabled}`);
        res.json({ success: true, config, status: await service.capabilities() });
    }));
    router.post('/settings/speech/test', authMiddleware, administrator, limiter, speechHandler(async (req, res) => {
        const result = await testConnection(req.body, { settings, service });
        logAction?.(req, '测试统一语音识别服务', `连接结果: ${result.success ? '可用' : '未就绪'}`);
        res.json(result);
    }));
}

module.exports = { registerSpeechSettingsRoutes };
