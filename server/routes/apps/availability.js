const { asyncHandler } = require('../../http');
const { getAppAvailability, getAppCatalog, updateAppAvailability } = require('../../services/app-availability');

function registerAppAvailabilityRoutes(router, { authMiddleware, logAction }) {
    router.get('/apps/catalog', authMiddleware, asyncHandler(async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await getAppCatalog(req.user));
    }));
    router.put('/apps/:appId/availability', authMiddleware, asyncHandler(async (req, res) => {
        const app = await updateAppAvailability(req.user, req.params.appId, req.body?.enabled);
        logAction(req, app.enabled ? '开启应用' : '关闭应用', `应用: ${app.name} (${app.id})`);
        res.json({ success: true, app });
    }));
    router.use('/apps', asyncHandler(async (req, res, next) => {
        const id = req.path.split('/')[1].toLowerCase();
        if (!['mindmaps', 'presentations', 'official-writing', 'data-analysis', 'regulations', 'ocr', 'pdf-tools'].includes(id)) return next();
        const apps = await getAppAvailability();
        // 数据分析和数据建模复用数据集接口，任一入口开启时保留共享底座。
        const enabled = apps.some(app => app.enabled && (app.id === id || (id === 'data-analysis' && app.id === 'data-modeling')));
        if (!enabled) return res.status(403).json({ error: '应用已关闭，请返回应用中心或联系系统 admin 开启。', code: 'APP_DISABLED' });
        // 各业务路由继续执行原有鉴权，包括使用独立令牌的演示遥控入口。
        return next();
    }));
}

module.exports = { registerAppAvailabilityRoutes };
