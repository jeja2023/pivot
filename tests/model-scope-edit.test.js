'use strict';
const { assert, test, runExpressHandlers } = require('./security-helpers');
const { queryOne, execute } = require('../server/db/client');
const { createModelsRouter } = require('../server/routes/models');
const { getUserRunnableModelsAsync } = require('../server/services/models');
const { encryptSecret, decryptSecret } = require('../server/security');

async function updateModel(user, id, body) {
    const router = createModelsRouter({ authMiddleware: (req, _res, next) => { req.user = user; next(); }, logAction: () => {}, normalizePage: value => Number(value) || 1, normalizeLimit: value => Number(value) || 20 });
    const route = router.stack.find(layer => layer.route?.path === '/models/:id' && layer.route?.methods?.put);
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await runExpressHandlers(route.route.stack.map(layer => layer.handle), { params: { id: String(id) }, user, body }, response);
    return response;
}

test('最高管理员可以切换模型可用范围，并清除无权使用者的默认引用', async () => {
    const admin = await queryOne("SELECT id, username, role, unit FROM users WHERE username = 'admin'");
    assert.ok(admin);
    const suffix = `${process.pid}_${Date.now()}`;
    const reader = await queryOne('INSERT INTO users (username, password_hash, unit, role, status) VALUES (?, ?, ?, ?, ?) RETURNING id, username, role, unit', [`scope_reader_${suffix}`, 'hash', '研发部', 'user', 'active']);
    const outsider = await queryOne('INSERT INTO users (username, password_hash, unit, role, status) VALUES (?, ?, ?, ?, ?) RETURNING id, username, role, unit', [`scope_out_${suffix}`, 'hash', '财务部', 'user', 'active']);
    const secret = encryptSecret('stored-key', 'models.api_key');
    const model = await queryOne("INSERT INTO models (user_id, name, url, model_name, api_key, allowed_units, is_default) VALUES (NULL, ?, ?, ?, ?, '', 1) RETURNING id", [`scope_${suffix}`, 'https://models.example.com/v1', 'example-model', secret]);
    const previousDefault = await queryOne("SELECT value FROM app_settings WHERE key = 'default_model_id'");
    const body = { name: `scope_${suffix}`, url: 'https://models.example.com/v1', model_name: 'example-model', api_key: '********' };
    try {
        await execute('UPDATE users SET default_model_id = ? WHERE id IN (?, ?)', [model.id, reader.id, outsider.id]);
        await execute("INSERT INTO app_settings (key, value) VALUES ('default_model_id', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(model.id)]);
        const personal = await updateModel(admin, model.id, { ...body, scope: 'personal', allowed_units: '研发部' });
        assert.equal(personal.statusCode, 200);
        let row = await queryOne('SELECT user_id, allowed_units, is_default, api_key FROM models WHERE id = ?', [model.id]);
        assert.equal(Number(row.user_id), Number(admin.id));
        assert.equal(row.allowed_units, '');
        assert.equal(Number(row.is_default), 0);
        assert.equal(row.api_key, secret);
        assert.equal(decryptSecret(row.api_key, 'models.api_key'), 'stored-key');
        assert.equal((await queryOne('SELECT default_model_id FROM users WHERE id = ?', [reader.id])).default_model_id, null);
        assert.equal((await queryOne("SELECT value FROM app_settings WHERE key = 'default_model_id'")).value, '');
        assert.equal((await getUserRunnableModelsAsync(reader)).some(item => Number(item.id) === Number(model.id)), false);
        const global = await updateModel(admin, model.id, { ...body, scope: 'global', allowed_units: '研发部' });
        assert.equal(global.statusCode, 200);
        row = await queryOne('SELECT user_id, allowed_units, api_key FROM models WHERE id = ?', [model.id]);
        assert.equal(row.user_id, null);
        assert.equal(row.allowed_units, '研发部');
        assert.equal(row.api_key, secret);
        assert.equal((await getUserRunnableModelsAsync(reader)).some(item => Number(item.id) === Number(model.id)), true);
        assert.equal((await getUserRunnableModelsAsync(outsider)).some(item => Number(item.id) === Number(model.id)), false);
        await execute('UPDATE users SET default_model_id = ? WHERE id IN (?, ?)', [model.id, reader.id, outsider.id]);
        const restrict = await updateModel(admin, model.id, { ...body, scope: 'global', allowed_units: '财务部' });
        assert.equal(restrict.statusCode, 200);
        assert.equal((await queryOne('SELECT default_model_id FROM users WHERE id = ?', [reader.id])).default_model_id, null);
        assert.equal(Number((await queryOne('SELECT default_model_id FROM users WHERE id = ?', [outsider.id])).default_model_id), Number(model.id));
        const denied = await updateModel(reader, model.id, { ...body, scope: 'personal' });
        assert.equal(denied.statusCode, 403);
        const own = await queryOne('INSERT INTO models (user_id, name, url, model_name) VALUES (?, ?, ?, ?) RETURNING id', [reader.id, `reader_${suffix}`, body.url, body.model_name]);
        try {
            const anotherPrivate = await updateModel(admin, own.id, { ...body, scope: 'global' });
            assert.equal(anotherPrivate.statusCode, 403);
            const unauthorized = await updateModel(reader, own.id, { ...body, scope: 'global' });
            assert.equal(unauthorized.statusCode, 403);
            const invalid = await updateModel(reader, own.id, { ...body, scope: 'unexpected' });
            assert.equal(invalid.statusCode, 400);
            const legacy = await updateModel(reader, own.id, body);
            assert.equal(legacy.statusCode, 200);
            assert.equal(Number((await queryOne('SELECT user_id FROM models WHERE id = ?', [own.id])).user_id), Number(reader.id));
        } finally { await execute('DELETE FROM models WHERE id = ?', [own.id]); }
    } finally {
        await execute('UPDATE users SET default_model_id = NULL WHERE default_model_id = ?', [model.id]);
        await execute('DELETE FROM models WHERE id = ?', [model.id]);
        await execute('DELETE FROM users WHERE id IN (?, ?)', [reader.id, outsider.id]);
        if (previousDefault) await execute("UPDATE app_settings SET value = ? WHERE key = 'default_model_id'", [previousDefault.value]);
        else await execute("DELETE FROM app_settings WHERE key = 'default_model_id'");
    }
});
