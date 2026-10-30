'use strict';
const { assert, test, runExpressHandlers } = require('./security-helpers');
const { queryOne, execute } = require('../server/db/client');
const { createModelsRouter } = require('../server/routes/models');
const { getUserRunnableModelsAsync } = require('../server/services/models');
const { encryptSecret } = require('../server/security');

function makeModelsRouter(user) {
    return createModelsRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        logAction: () => {},
        normalizePage: value => Number(value) || 1,
        normalizeLimit: value => Number(value) || 20
    });
}

async function patchModelStatus(user, id, body) {
    const router = makeModelsRouter(user);
    const route = router.stack.find(layer => layer.route?.path === '/models/:id/status' && layer.route?.methods?.patch);
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(route.route.stack.map(layer => layer.handle), { params: { id: String(id) }, user, body }, response);
    return response;
}

async function getModels(user, queryParams = {}) {
    const router = makeModelsRouter(user);
    const route = router.stack.find(layer => layer.route?.path === '/models' && layer.route?.methods?.get);
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(route.route.stack.map(layer => layer.handle), { query: queryParams, user }, response);
    return response;
}

async function updateModel(user, id, body) {
    const router = makeModelsRouter(user);
    const route = router.stack.find(layer => layer.route?.path === '/models/:id' && layer.route?.methods?.put);
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(route.route.stack.map(layer => layer.handle), { params: { id: String(id) }, user, body }, response);
    return response;
}

test('模型支持关闭与开启：停用模型不删除配置、自动清除默认引用且不出现在可运行列表', async () => {
    const admin = await queryOne("SELECT id, username, role, unit FROM users WHERE username = 'admin'");
    assert.ok(admin);
    const suffix = `${process.pid}_${Date.now()}`;
    const user = await queryOne('INSERT INTO users (username, password_hash, unit, role, status) VALUES (?, ?, ?, ?, ?) RETURNING id, username, role, unit', [`status_usr_${suffix}`, 'hash', '研发部', 'user', 'active']);
    const stranger = await queryOne('INSERT INTO users (username, password_hash, unit, role, status) VALUES (?, ?, ?, ?, ?) RETURNING id, username, role, unit', [`status_str_${suffix}`, 'hash', '财务部', 'user', 'active']);
    const secret = encryptSecret('stored-key', 'models.api_key');
    const globalModel = await queryOne("INSERT INTO models (user_id, name, url, model_name, api_key, allowed_units, is_default, status) VALUES (NULL, ?, ?, ?, ?, '', 1, 'active') RETURNING id", [`status_global_${suffix}`, 'https://models.example.com/v1', 'global-chat', secret]);
    const personalModel = await queryOne("INSERT INTO models (user_id, name, url, model_name, api_key, allowed_units, is_default, status) VALUES (?, ?, ?, ?, ?, '', 1, 'active') RETURNING id", [user.id, `status_personal_${suffix}`, 'https://models.example.com/v1', 'personal-chat', secret]);

    try {
        await execute('UPDATE users SET default_model_id = ? WHERE id = ?', [globalModel.id, user.id]);
        await execute("INSERT INTO app_settings (key, value) VALUES ('default_model_id', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(globalModel.id)]);

        // 1. 普通用户不能关闭全局模型
        const forbidGlobal = await patchModelStatus(user, globalModel.id, { status: 'disabled' });
        assert.equal(forbidGlobal.statusCode, 403);

        // 2. 陌生用户不能关闭他人的个人模型
        const forbidStranger = await patchModelStatus(stranger, personalModel.id, { status: 'disabled' });
        assert.equal(forbidStranger.statusCode, 403);

        // 3. 非法状态值拒绝
        const invalidStatus = await patchModelStatus(admin, globalModel.id, { status: 'invalid_status' });
        assert.equal(invalidStatus.statusCode, 400);

        // 4. 超管关闭全局模型：状态变更为 disabled，同时清除默认标记与引用
        const closeGlobal = await patchModelStatus(admin, globalModel.id, { status: 'disabled' });
        assert.equal(closeGlobal.statusCode, 200);
        assert.equal(closeGlobal.body.status, 'disabled');

        const updatedGlobalRow = await queryOne('SELECT status, is_default FROM models WHERE id = ?', [globalModel.id]);
        assert.equal(updatedGlobalRow.status, 'disabled');
        assert.equal(Number(updatedGlobalRow.is_default), 0);
        assert.equal((await queryOne("SELECT value FROM app_settings WHERE key = 'default_model_id'")).value, '');
        assert.equal((await queryOne('SELECT default_model_id FROM users WHERE id = ?', [user.id])).default_model_id, null);

        // 5. 个人用户关闭自己的模型
        const closePersonal = await patchModelStatus(user, personalModel.id, { status: 'disabled' });
        assert.equal(closePersonal.statusCode, 200);
        assert.equal(closePersonal.body.status, 'disabled');
        const updatedPersonalRow = await queryOne('SELECT status, is_default FROM models WHERE id = ?', [personalModel.id]);
        assert.equal(updatedPersonalRow.status, 'disabled');

        // 6. 停用的模型不出现在用户的可运行列表
        const runnableList = await getUserRunnableModelsAsync(user);
        assert.equal(runnableList.some(item => Number(item.id) === Number(globalModel.id)), false);
        assert.equal(runnableList.some(item => Number(item.id) === Number(personalModel.id)), false);

        // 7. GET /models 列表默认展示 active 与 disabled 模型（供设置页面查看与管理）
        const allList = await getModels(admin, { limit: '100' });
        assert.equal(allList.statusCode, 200);
        const globalInList = allList.body.data.find(item => Number(item.id) === Number(globalModel.id));
        const personalInList = allList.body.data.find(item => Number(item.id) === Number(personalModel.id));
        assert.ok(globalInList);
        assert.equal(globalInList.status, 'disabled');
        assert.ok(personalInList);
        assert.equal(personalInList.status, 'disabled');

        // 8. 传递 status=active 时过滤掉已关闭模型
        const activeOnlyList = await getModels(admin, { status: 'active', limit: '100' });
        assert.equal(activeOnlyList.body.data.some(item => Number(item.id) === Number(globalModel.id)), false);

        // 9. 重新开启模型
        const reopenGlobal = await patchModelStatus(admin, globalModel.id, { status: 'active' });
        assert.equal(reopenGlobal.statusCode, 200);
        assert.equal(reopenGlobal.body.status, 'active');
        assert.equal((await queryOne('SELECT status FROM models WHERE id = ?', [globalModel.id])).status, 'active');

        // 10. PUT /models/:id 支持编辑时开启/关闭模型
        const editDisable = await updateModel(user, personalModel.id, {
            name: `status_personal_${suffix}`,
            url: 'https://models.example.com/v1',
            model_name: 'personal-chat',
            api_key: '********',
            status: 'active'
        });
        assert.equal(editDisable.statusCode, 200);
        assert.equal((await queryOne('SELECT status FROM models WHERE id = ?', [personalModel.id])).status, 'active');
    } finally {
        await execute('DELETE FROM models WHERE id IN (?, ?)', [globalModel.id, personalModel.id]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [user.id, stranger.id]);
    }
});
