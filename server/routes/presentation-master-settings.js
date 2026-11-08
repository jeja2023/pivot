'use strict';

const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../http');
const { isSuperAdmin } = require('../permissions');
const { pptMasterSettings } = require('../services/presentations/master/settings');
const client = require('../services/presentations/master/service-client');
async function testConnection(patch, { settings = pptMasterSettings, request = client.request } = {}) {
    const value = await settings.prepare(patch);
    if (!value.enabled) return { success: false, state: 'disabled', message: 'PPT Master服务已停用；标准PPT制作继续可用。' };
    const started = Date.now();
    try {
        const health = client.compatible(await request(value, '/v1/info', { timeout: 5000 }));
        return { success: true, state: 'ready', version: String(health.version || '').slice(0, 80), serviceProtocol: health.serviceProtocol, elapsedMs: Date.now() - started,
            message: 'PPT Master连接及服务协议检查通过。测试未修改当前配置。' };
    } catch (error) {
        return { success: false, state: error.code === 'PPT_SERVICE_UNAUTHORIZED' ? 'unauthorized' : error.code === 'PPT_SERVICE_PROTOCOL_MISMATCH' ? 'incompatible' : 'unavailable',
            message: error.code === 'PPT_SERVICE_UNAUTHORIZED' ? '服务拒绝访问，请检查新填写或已保存的访问密钥。' : error.code === 'PPT_SERVICE_PROTOCOL_MISMATCH' ? '服务协议不兼容，请检查PPT Master镜像版本。' : '无法连接PPT Master，请检查地址、访问密钥和服务状态。标准PPT制作不受影响。' };
    }
}
function registerPresentationMasterSettingsRoutes(router, { authMiddleware, logAction, settings = pptMasterSettings, test = testConnection, reset = client.reset } = {}) {
    const administrator = (req, res, next) => isSuperAdmin(req.user) ? next() : res.status(403).json({ error: '只有系统admin账号可以配置和测试全站PPT Master服务。' });
    const limiter = rateLimit({ store: require('../services/rate-limit-store').createRateLimitStore('ppt-master:settings'), windowMs: 60000, limit: 12, keyGenerator: req => String(req.user.id),
        standardHeaders: true, legacyHeaders: false, message: { error: 'PPT服务连接测试过于频繁，请稍后重试。' } });
    const handler = action => asyncHandler(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await action(req, res); }
        catch (error) { res.status(error.statusCode || error.status || 400).json({ success: false, code: error.code?.startsWith('PPT_MASTER_SETTINGS_') ? error.code : 'PPT_MASTER_SETTINGS_INVALID',
            error: error.code?.startsWith('PPT_MASTER_SETTINGS_') ? error.message : 'PPT服务配置无效或无法保存，请检查后重试。' }); }
    });
    router.get('/settings/ppt-master', authMiddleware, administrator, handler(async (_req, res) => res.json({ success: true, config: await settings.publicConfig({ administrator: true }) })));
    router.put('/settings/ppt-master', authMiddleware, administrator, handler(async (req, res) => {
        const config = await settings.save(req.body, { userId: req.user.id }); reset();
        logAction?.(req, '修改PPT Master服务配置', `服务启用: ${config.enabled}`);
        res.json({ success: true, config });
    }));
    router.post('/settings/ppt-master/test', authMiddleware, administrator, limiter, handler(async (req, res) => {
        const result = await test(req.body, { settings });
        logAction?.(req, '测试PPT Master服务连接', `连接结果: ${result.success ? '可用' : '未就绪'}`);
        res.json(result);
    }));
}
module.exports = { registerPresentationMasterSettingsRoutes, testConnection };
