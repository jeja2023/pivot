require('dotenv').config();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a-secure-test-jwt-secret-with-at-least-32-chars-long-1234567890';
const assert = require('node:assert/strict');
const test = require('node:test');
const { queryOne, execute } = require('../server/db/client');
const { createSettingsRouter } = require('../server/routes/settings');
const { ragRouter } = require('../server/routes/rag');
const { createModelsRouter } = require('../server/routes/models');
const { runExpressHandlers } = require('./security-helpers');

test('非系统管理员查看模型与服务配置时URL受控脱敏，且支持测试全局服务与模型', async () => {
    const existingAdmin = await queryOne("SELECT id, username, role, unit FROM users WHERE username = 'admin' AND deleted_at IS NULL");
    assert.ok(existingAdmin, '应存在默认系统管理员');
    const adminUser = { id: Number(existingAdmin.id), username: 'admin', role: 'admin', unit: existingAdmin.unit || 'QA' };

    const suffix = Date.now().toString(36);
    const regularUserInsert = await queryOne(
        `INSERT INTO users (username, password_hash, nickname, unit, role, status) VALUES ('mask_test_${suffix}', 'hash', '普通测试用户', 'QA', 'user', 'active') RETURNING id`
    );
    const regularUser = { id: Number(regularUserInsert.id), username: `mask_test_${suffix}`, role: 'user', unit: 'QA' };

    const settingsRouter = createSettingsRouter({
        authMiddleware: (req, _res, next) => next(),
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const settingsGetRoute = settingsRouter.stack.find(layer => layer.route?.path === '/settings' && layer.route?.methods?.get);
    const embeddingPutRoute = settingsRouter.stack.find(layer => layer.route?.path === '/settings/embedding' && layer.route?.methods?.put);
    const ocrTestRoute = settingsRouter.stack.find(layer => layer.route?.path === '/settings/ocr-test' && layer.route?.methods?.post);

    const embeddingTestRoute = ragRouter.stack.find(layer => layer.route?.path === '/settings/test-embedding' && layer.route?.methods?.post);
    const rerankTestRoute = ragRouter.stack.find(layer => layer.route?.path === '/settings/test-rerank' && layer.route?.methods?.post);

    const modelsRouter = createModelsRouter({
        authMiddleware: (req, _res, next) => next(),
        logAction: () => {},
        normalizePage: p => Number(p || 1),
        normalizeLimit: l => Number(l || 20)
    });
    const modelTestRoute = modelsRouter.stack.find(layer => layer.route?.path === '/models/test' && layer.route?.methods?.post);

    const routeHandler = route => route.route.stack.slice(-1).map(layer => layer.handle);

    let globalModelId = null;

    try {
        // 1. 系统管理员调用 GET /settings，能正常查看系统级服务真实 URL
        const adminRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(settingsGetRoute), { headers: {}, user: adminUser }, adminRes);
        assert.equal(adminRes.statusCode, 200);
        if (adminRes.body.retrievalModelConfig?.apiUrl) {
            assert.notEqual(adminRes.body.retrievalModelConfig.apiUrl, '********');
        }
        if (adminRes.body.ocrConfig?.serviceUrl) {
            assert.notEqual(adminRes.body.ocrConfig.serviceUrl, '********');
        }

        // 2. 普通用户调用 GET /settings，未由该用户自己配置的模型/服务 URL 全部受控脱敏
        const regularRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(settingsGetRoute), { headers: {}, user: regularUser }, regularRes);
        assert.equal(regularRes.statusCode, 200);
        if (regularRes.body.retrievalModelConfig?.apiUrl) {
            assert.equal(regularRes.body.retrievalModelConfig.apiUrl, '********');
        }
        if (regularRes.body.embeddingConfig?.apiUrl) {
            assert.equal(regularRes.body.embeddingConfig.apiUrl, '********');
        }
        if (regularRes.body.ocrConfig?.serviceUrl) {
            assert.equal(regularRes.body.ocrConfig.serviceUrl, '********');
        }
        if (regularRes.body.rerankConfig?.apiUrl) {
            assert.equal(regularRes.body.rerankConfig.apiUrl, '********');
        }

        // 3. 普通用户配置了个人向量服务后，个人 embeddingConfig 返回自身配置 URL，系统 retrieval 与 OCR 依然脱敏
        const putReq = {
            headers: {},
            body: {
                rag_embedding_mode: 'http',
                rag_embedding_api_url: 'https://embedding.example.com/v1',
                rag_embedding_model: 'custom-embed'
            },
            user: regularUser
        };
        const putRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(embeddingPutRoute), putReq, putRes);
        assert.equal(putRes.statusCode, 200);
        assert.equal(putRes.body.embeddingConfig.apiUrl, 'https://embedding.example.com/v1');
        if (putRes.body.rerankConfig?.apiUrl) {
            assert.equal(putRes.body.rerankConfig.apiUrl, '********');
        }

        // 4. OCR 测试权限校验：普通用户测试已保存/脱敏配置不应被403拒绝；测试新自定义URL必须被403拒绝
        const ocrSavedTestRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(ocrTestRoute), { headers: {}, body: { serviceUrl: '********' }, user: regularUser }, ocrSavedTestRes);
        assert.notEqual(ocrSavedTestRes.statusCode, 403, '测试脱敏 OCR 服务不应被 403 阻断');

        const ocrCustomTestRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(ocrTestRoute), { headers: {}, body: { serviceUrl: 'http://custom-untrusted-ocr.com' }, user: regularUser }, ocrCustomTestRes);
        assert.equal(ocrCustomTestRes.statusCode, 403, '普通用户测试自定义 OCR 地址必须被 403 阻断');

        // 5. 向量生成服务测试权限校验：普通用户测试已保存配置不应被403拒绝；测试新自定义URL必须被403拒绝
        const embedSavedTestRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(embeddingTestRoute), { headers: {}, body: { apiUrl: '********' }, user: regularUser }, embedSavedTestRes);
        assert.notEqual(embedSavedTestRes.statusCode, 403, '测试脱敏向量生成服务不应被 403 阻断');

        const embedCustomTestRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(embeddingTestRoute), { headers: {}, body: { apiUrl: 'http://custom-untrusted-embed.com' }, user: regularUser }, embedCustomTestRes);
        assert.equal(embedCustomTestRes.statusCode, 403, '普通用户测试自定义向量服务地址必须被 403 阻断');

        // 6. 重排序服务测试权限校验：普通用户测试已保存配置不应被403拒绝；测试新自定义URL必须被403拒绝
        const rerankSavedTestRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(rerankTestRoute), { headers: {}, body: { apiUrl: '********' }, user: regularUser }, rerankSavedTestRes);
        assert.notEqual(rerankSavedTestRes.statusCode, 403, '测试脱敏重排序服务不应被 403 阻断');

        const rerankCustomTestRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(routeHandler(rerankTestRoute), { headers: {}, body: { apiUrl: 'http://custom-untrusted-rerank.com' }, user: regularUser }, rerankCustomTestRes);
        assert.equal(rerankCustomTestRes.statusCode, 403, '普通用户测试自定义重排序服务地址必须被 403 阻断');

        // 7. 全局聊天模型测试权限校验：普通用户可以对无限制单位的全局模型执行连接测试
        const globalModel = await queryOne(
            "INSERT INTO models (name, model_name, url, api_key, user_id, status) VALUES ('全局测试模型', 'global-chat-test', 'http://127.0.0.1:8888', 'test-key', NULL, 'active') RETURNING id"
        );
        globalModelId = globalModel.id;

        const modelTestRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(
            routeHandler(modelTestRoute),
            {
                headers: {},
                body: { id: globalModelId, url: '********', api_key: '********' },
                user: regularUser,
                log: { debug() {}, info() {}, error() {} }
            },
            modelTestRes
        );
        // 普通用户不会被拦截为 403 "无权测试该模型或模型不存在"
        assert.notEqual(modelTestRes.statusCode, 403, '普通用户测试全局模型不应被 403 拒绝');
        if (modelTestRes.body?.error) {
            assert.notEqual(modelTestRes.body.error, '无权测试该模型或模型不存在');
        }
    } finally {
        if (globalModelId) {
            await execute('DELETE FROM models WHERE id = ?', [globalModelId]);
        }
        await execute('DELETE FROM user_settings WHERE user_id = ?', [regularUser.id]);
        await execute('DELETE FROM users WHERE id = ?', [regularUser.id]);
        const { closePgPool } = require('../server/db/pg-connection');
        await closePgPool();
    }
});
