const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const express = require('express');
const { queryOne, execute } = require('../server/db/client');
const { getAppAvailability, getAppCatalog, updateAppAvailability } = require('../server/services/app-availability');
const { registerAppAvailabilityRoutes } = require('../server/routes/apps/availability');

test('应用全局开关持久保存，仅系统 admin 可修改，普通管理员和用户只见开启应用', async t => {
    const admin = await queryOne("SELECT id, username, role FROM users WHERE username = 'admin'");
    const manager = { ...admin, username: 'other_admin' };
    const user = { ...admin, role: 'user', username: 'member' };
    const audits = [];
    const app = express();
    app.use(express.json());
    registerAppAvailabilityRoutes(app, {
        authMiddleware(req, res, next) {
            req.user = { admin, manager, user }[req.headers['x-test-actor']];
            if (!req.user) return res.status(401).json({ error: '请先登录。' });
            next();
        },
        logAction(req, action, detail) { audits.push({ user: req.user.username, action, detail }); }
    });
    app.get(['/apps/ocr/jobs', '/apps/data-analysis/datasets'], (_req, res) => res.json({ success: true }));
    app.get('/apps/presentations/remote/valid/state', (_req, res) => res.json({ success: true }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const call = async (path, actor = 'admin', enabled, method = 'GET') => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method, headers: { 'x-test-actor': actor, 'Content-Type': 'application/json' },
            ...(method === 'PUT' ? { body: JSON.stringify(enabled === undefined ? {} : { enabled }) } : {})
        });
        return { status: response.status, body: await response.json() };
    };
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        for (const id of ['ocr', 'presentations', 'data-analysis', 'data-modeling']) await execute('DELETE FROM app_settings WHERE key = ?', [`app_enabled:${id}`]);
    });

    await t.test('旧数据默认开启，目录不缓存且仅 admin 收到管理权限', async () => {
        assert.equal((await getAppAvailability()).every(item => item.enabled), true);
        assert.equal((await call('/apps/catalog', 'anonymous')).status, 401);
        for (const actor of ['admin', 'manager', 'user']) {
            const result = await call('/apps/catalog', actor);
            assert.equal(result.status, 200);
            assert.equal(result.body.canManage, actor === 'admin');
            assert.equal(result.body.apps.length, 8);
        }
    });
    await t.test('普通管理员、伪造系统权限标识和用户均不能修改', async () => {
        for (const actor of ['manager', 'user']) assert.equal((await call('/apps/ocr/availability', actor, false, 'PUT')).status, 403);
        await assert.rejects(updateAppAvailability({ ...manager, isSuperAdmin: true, permissionTier: 'admin' }, 'ocr', false), { status: 403 });
        assert.equal(audits.length, 0);
    });
    await t.test('不替换业务路由原有独立令牌鉴权，关闭时仍拦截演示遥控入口', async () => {
        assert.equal((await call('/apps/presentations/remote/valid/state', 'anonymous')).status, 200);
        await updateAppAvailability(admin, 'presentations', false);
        assert.equal((await call('/apps/presentations/remote/valid/state', 'anonymous')).status, 403);
        await updateAppAvailability(admin, 'presentations', true);
    });
    await t.test('拒绝不存在的应用、缺失及非布尔值', async () => {
        assert.equal((await call('/apps/unknown/availability', 'admin', false, 'PUT')).status, 404);
        assert.equal((await call('/apps/constructor/availability', 'admin', false, 'PUT')).status, 404);
        for (const value of [undefined, null, 'false', 0, {}, []]) assert.equal((await call('/apps/ocr/availability', 'admin', value, 'PUT')).status, 400);
    });
    await t.test('关闭后全员无法直接进入，只有 admin 保留重新开启入口，开启后全员恢复', async () => {
        const closed = await call('/apps/ocr/availability', 'admin', false, 'PUT');
        assert.equal(closed.status, 200);
        assert.equal(closed.body.app.enabled, false);
        const stored = await queryOne('SELECT value, updated_by FROM app_settings WHERE key = ?', ['app_enabled:ocr']);
        assert.equal(stored.value, 'false');
        assert.equal(Number(stored.updated_by), Number(admin.id));
        for (const [actor, account] of Object.entries({ admin, manager, user })) {
            const catalog = await getAppCatalog(account);
            assert.equal(catalog.apps.some(item => item.id === 'ocr'), actor === 'admin');
            assert.equal((await call('/apps/ocr/jobs', actor)).status, 403);
            assert.equal((await call('/apps/OCR/jobs', actor)).status, 403);
        }
        assert.equal(audits.at(-1).action, '关闭应用');
        assert.equal((await call('/apps/ocr/availability', 'admin', true, 'PUT')).status, 200);
        assert.equal((await getAppCatalog(user)).apps.some(item => item.id === 'ocr'), true);
        assert.equal((await call('/apps/ocr/jobs', 'user')).status, 200);
        assert.equal(audits.at(-1).action, '开启应用');
    });
    await t.test('分析与建模入口开关独立，共享数据集接口在任一应用开启时保留', async () => {
        await updateAppAvailability(admin, 'data-analysis', false);
        assert.equal((await getAppCatalog(user)).apps.some(item => item.id === 'data-analysis'), false);
        assert.equal((await getAppCatalog(user)).apps.some(item => item.id === 'data-modeling'), true);
        assert.equal((await call('/apps/data-analysis/datasets', 'user')).status, 200);
        await updateAppAvailability(admin, 'data-modeling', false);
        assert.equal((await call('/apps/data-analysis/datasets', 'user')).status, 403);
    });
});
