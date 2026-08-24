// 模型上下文设置单测：context_window_tokens、全局上下文窗口、无界判定、Agent 输出上限解析。
// 由 security-chat.test.js 统一加载。
const fs = require('node:fs');
const path = require('node:path');
const { assert, createSettingsRouter, db, runExpressHandlers, test } = require('../security-helpers');
const { getModelContextBudget } = require('../../server/services/context-budget');
const { resolveAgentMaxTokens } = require('../../server/services/agent-model');
const { validateModelTokenSettings, normalizeModelTokenLimit } = require('../../server/services/models');
const {
    RUNTIME_SETTING_KEYS,
    getChatAgentRuntimeConfig,
    getGlobalContextRuntimeConfig,
    getGlobalSamplingRuntimeConfig,
    getUploadRuntimeConfig,
    saveRuntimeConfigAsync
} = require('../../server/services/runtime-settings');
const { syncGlobalAiConcurrencySettings } = require('../../server/services/concurrency');
const { syncAgentRuntimeConcurrency } = require('../../server/services/agent-runtime');
const {
    deleteAppSettingAsync,
    getAppSettingRow,
    getAppSettingsMap,
    refreshAppSettingsCache,
    setAppSettingAsync
} = require('../../server/services/app-settings');

function createJsonResponse() {
    return {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

test('context_window_tokens 直接决定上下文窗口与输入预算', () => {
    const b = getModelContextBudget({ context_window_tokens: 32768, max_tokens: 2000 });
    assert.equal(b.unbounded, false);
    assert.equal(b.contextWindow, 32768);
    // 输入预算 = 窗口 - 预留输出 - 安全余量
    assert.ok(b.inputBudget > 0 && b.inputBudget < 32768);
    assert.ok(b.inputBudget <= 32768 - 2000);
});

test('仅配置 max_input_tokens 时由其推导窗口', () => {
    const b = getModelContextBudget({ max_input_tokens: 8000 });
    assert.equal(b.unbounded, false);
    assert.equal(b.inputBudget, 8000);
    assert.ok(b.contextWindow > 8000);
});

test('context_window_tokens 与 max_input_tokens 同时存在时输入预算取两者较小', () => {
    const b = getModelContextBudget({ context_window_tokens: 32768, max_input_tokens: 4000, max_tokens: 1000 });
    assert.equal(b.contextWindow, 32768);
    assert.equal(b.inputBudget, 4000);
});

test('两个上下文字段都未配置时预算为无界', () => {
    const b = getModelContextBudget({});
    assert.equal(b.unbounded, true);
    assert.equal(b.inputBudget, Number.MAX_SAFE_INTEGER);
});

test('resolveAgentMaxTokens 优先显式值，其次模型配置，最后回退 1200', () => {
    assert.equal(resolveAgentMaxTokens({ max_tokens: 4096 }, { maxTokens: 500 }), 500);
    assert.equal(resolveAgentMaxTokens({ max_tokens: 4096 }, {}), 4096);
    assert.equal(resolveAgentMaxTokens({}, {}), 1200);
    assert.equal(resolveAgentMaxTokens({ max_tokens: null }, {}), 1200);
    assert.equal(resolveAgentMaxTokens({ max_tokens: 0 }, {}), 1200);
});

test('normalizeModelTokenLimit 范围校验：留空/0 为 null，负数与非数字与超限报错', () => {
    assert.deepEqual(normalizeModelTokenLimit('', 'x'), { value: null });
    assert.deepEqual(normalizeModelTokenLimit(undefined, 'x'), { value: null });
    assert.deepEqual(normalizeModelTokenLimit(0, 'x'), { value: null });
    assert.deepEqual(normalizeModelTokenLimit(8000, 'x'), { value: 8000 });
    assert.ok(normalizeModelTokenLimit(-1, '输出').error);
    assert.ok(normalizeModelTokenLimit('abc', '输入').error);
    assert.ok(normalizeModelTokenLimit(99999999, '窗口').error);
});

test('validateModelTokenSettings 拦截负数/非法值，避免异常 token 入库并被转发上游', () => {
    assert.ok(validateModelTokenSettings({ max_tokens: -500 }).error);
    assert.ok(validateModelTokenSettings({ max_input_tokens: 'abc' }).error);
    const ok = validateModelTokenSettings({ max_input_tokens: 8000, max_tokens: 2000, context_window_tokens: 32768 });
    assert.deepEqual(ok.values, { maxInputTokens: 8000, maxTokens: 2000, contextWindowTokens: 32768 });
});

test('validateModelTokenSettings 关系校验：输入/输出上限须小于上下文窗口', () => {
    assert.ok(validateModelTokenSettings({ max_input_tokens: 40000, context_window_tokens: 32768 }).error);
    assert.ok(validateModelTokenSettings({ max_tokens: 40000, context_window_tokens: 32768 }).error);
    // 未设窗口时不做关系校验
    assert.ok(!validateModelTokenSettings({ max_input_tokens: 40000 }).error);
});

test('运行时上下文默认值可从设置页保存并影响上下文预算', async () => {
    const keys = [
        RUNTIME_SETTING_KEYS.modelContextWindowTokens,
        RUNTIME_SETTING_KEYS.contextReservedOutputTokens,
        RUNTIME_SETTING_KEYS.memoryThreshold
    ];
    const previousRows = keys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    try {
        const saved = await saveRuntimeConfigAsync({
            model_context_window_tokens: '64K',
            context_reserved_output_tokens: '4K',
            memory_threshold: '32K'
        }, null);
        assert.equal(saved.error, undefined);
        assert.equal(getGlobalContextRuntimeConfig().modelContextWindowTokens, 64000);
        assert.equal(getGlobalContextRuntimeConfig().contextReservedOutputTokens, 4000);
        assert.equal(getGlobalContextRuntimeConfig().memoryThreshold, 32000);

        const budget = getModelContextBudget({});
        assert.equal(budget.unbounded, false);
        assert.equal(budget.contextWindow, 64000);
        assert.ok(budget.inputBudget < 64000);
    } finally {
        keys.forEach((key, index) => {
            const row = previousRows[index];
            if (row) {
                db.prepare(`
                    INSERT INTO app_settings (key, value, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at,
                        updated_by = excluded.updated_by
                `).run(row.key, row.value, row.updated_at, row.updated_by);
            } else {
                db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
            }
        });
        await refreshAppSettingsCache();
        syncGlobalAiConcurrencySettings();
        syncAgentRuntimeConcurrency();
    }
});

test('普通聊天连续 Agent 开关可从运行时配置即时读写', async () => {
    const key = RUNTIME_SETTING_KEYS.chatAutoAgentEnabled;
    const previous = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key);
    try {
        const disabled = await saveRuntimeConfigAsync({ [key]: 0 }, null);
        assert.equal(disabled.error, undefined);
        assert.equal(getChatAgentRuntimeConfig().autoAgentEnabled, false);

        const enabled = await saveRuntimeConfigAsync({ [key]: 1 }, null);
        assert.equal(enabled.error, undefined);
        assert.equal(getChatAgentRuntimeConfig().autoAgentEnabled, true);
    } finally {
        if (previous) {
            db.prepare(`
                INSERT INTO app_settings (key, value, updated_at, updated_by)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by
            `).run(previous.key, previous.value, previous.updated_at, previous.updated_by);
        } else {
            db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
        }
        await refreshAppSettingsCache();
    }
});

test('运行时采样默认值可从设置页保存并回读', async () => {
    const keys = [
        RUNTIME_SETTING_KEYS.samplingTemperature,
        RUNTIME_SETTING_KEYS.samplingTopP,
        RUNTIME_SETTING_KEYS.samplingPresencePenalty,
        RUNTIME_SETTING_KEYS.samplingFrequencyPenalty
    ];
    const previousRows = keys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    try {
        const saved = await saveRuntimeConfigAsync({
            sampling_temperature: 0.35,
            sampling_top_p: 0.92,
            sampling_presence_penalty: -0.3,
            sampling_frequency_penalty: 0.1
        }, null);
        assert.equal(saved.error, undefined);
        assert.equal(getGlobalSamplingRuntimeConfig().temperature, 0.35);
        assert.equal(getGlobalSamplingRuntimeConfig().topP, 0.92);
        assert.equal(getGlobalSamplingRuntimeConfig().presencePenalty, -0.3);
        assert.equal(getGlobalSamplingRuntimeConfig().frequencyPenalty, 0.1);
    } finally {
        keys.forEach((key, index) => {
            const row = previousRows[index];
            if (row) {
                db.prepare(`
                    INSERT INTO app_settings (key, value, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at,
                        updated_by = excluded.updated_by
                `).run(row.key, row.value, row.updated_at, row.updated_by);
            } else {
                db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
            }
        });
        await refreshAppSettingsCache();
    }
});

test('设置接口仅向管理员返回全局运行参数', async () => {
    const router = createSettingsRouter({
        authMiddleware: (_req, _res, next) => next(),
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/settings' && layer.route?.methods?.get);
    assert.ok(route);

    const normalReq = { user: { id: 42, username: 'alice', role: 'user', unit: 'QA' }, headers: {} };
    const normalRes = createJsonResponse();
    await runExpressHandlers(route.route.stack.map(layer => layer.handle), normalReq, normalRes);
    assert.equal(normalRes.statusCode, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(normalRes.body, 'runtimeConfig'), false);
    assert.equal(normalRes.body.uploadLimits?.maxAttachmentsPerMessage, getUploadRuntimeConfig().maxAttachmentsPerMessage);

    const adminReq = { user: { id: 2, username: 'manager', role: 'admin', unit: 'QA' }, headers: {} };
    const adminRes = createJsonResponse();
    await runExpressHandlers(route.route.stack.map(layer => layer.handle), adminReq, adminRes);
    assert.equal(adminRes.statusCode, 200);
    assert.ok(adminRes.body.runtimeConfig?.items?.length > 0);
    assert.equal(adminRes.body.uploadLimits?.maxAttachmentsPerMessage, getUploadRuntimeConfig().maxAttachmentsPerMessage);
});

test('设置接口只返回脱敏后的 app_settings 元数据', async () => {
    const key = 'rag_embedding_api_key';
    const previous = getAppSettingRow(key);
    await setAppSettingAsync(key, 'settings-page-secret', { updatedBy: 1 });
    try {
        const router = createSettingsRouter({
            authMiddleware: (_req, _res, next) => next(),
            adminMiddleware: (_req, _res, next) => next(),
            logAction: () => {}
        });
        const route = router.stack.find(layer => layer.route?.path === '/settings' && layer.route?.methods?.get);
        const res = createJsonResponse();
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), {
            user: { id: 42, username: 'alice', role: 'user', unit: 'QA' },
            headers: {}
        }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.settings?.[key]?.value, '');
        assert.equal(res.body.settings?.[key]?.redacted, true);
        assert.equal(JSON.stringify(res.body).includes('settings-page-secret'), false);
    } finally {
        if (previous) {
            await setAppSettingAsync(key, previous.value, {
                updatedAt: previous.updated_at,
                updatedBy: previous.updated_by
            });
        } else {
            await deleteAppSettingAsync(key);
        }
        await refreshAppSettingsCache();
    }
});

test('非内置 admin 管理员不能修改全局运行参数', async () => {
    const managerUser = { id: 2, username: 'manager', role: 'admin', unit: 'QA' };
    const router = createSettingsRouter({
        authMiddleware: (req, _res, next) => { req.user = managerUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/admin/settings/runtime' && layer.route?.methods?.put);
    assert.ok(route);

    const req = {
        body: { max_concurrent_ai_requests: 3 },
        headers: {},
        user: managerUser,
        log: { warn: () => {} }
    };
    const res = createJsonResponse();

    await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /admin 权限层级/);
});

test('管理员运行时设置接口可保存并发配置', async () => {
    const adminUser = { id: 1, username: 'admin', role: 'admin', unit: 'QA' };
    const keys = [
        RUNTIME_SETTING_KEYS.maxConcurrentAiRequests,
        RUNTIME_SETTING_KEYS.modelEndpointDefaultConcurrency,
        RUNTIME_SETTING_KEYS.agentDagNodeConcurrency
    ];
    const previousRows = keys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    const router = createSettingsRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/admin/settings/runtime' && layer.route?.methods?.put);
    assert.ok(route);

    const req = {
        body: {
            max_concurrent_ai_requests: 3,
            model_endpoint_default_concurrency: 2,
            agent_dag_node_concurrency: 5
        },
        headers: {},
        user: adminUser,
        log: { warn: () => {} }
    };
    const res = {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };

    try {
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.runtimeConfig.values.maxConcurrentAiRequests, 3);
        assert.equal(res.body.runtimeConfig.values.modelEndpointDefaultConcurrency, 2);
        assert.equal(res.body.runtimeConfig.values.agentDagNodeConcurrency, 5);
    } finally {
        keys.forEach((key, index) => {
            const row = previousRows[index];
            if (row) {
                db.prepare(`
                    INSERT INTO app_settings (key, value, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at,
                        updated_by = excluded.updated_by
                `).run(row.key, row.value, row.updated_at, row.updated_by);
            } else {
                db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
            }
        });
        await refreshAppSettingsCache();
        syncGlobalAiConcurrencySettings();
        syncAgentRuntimeConcurrency();
    }
});

test('全局运行时资源参数可通过设置接口保存', async () => {
    const adminUser = { id: 1, username: 'admin', role: 'admin', unit: 'QA' };
    const keys = [
        RUNTIME_SETTING_KEYS.uploadAttachmentMaxBytes,
        RUNTIME_SETTING_KEYS.maxAttachmentsPerMessage,
        RUNTIME_SETTING_KEYS.maxImagesPerMessage,
        RUNTIME_SETTING_KEYS.attachmentContextMaxChars,
        RUNTIME_SETTING_KEYS.ragTopKMax
    ];
    const previousRows = keys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    const router = createSettingsRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/admin/settings/runtime' && layer.route?.methods?.put);
    const req = {
        body: {
            upload_attachment_max_bytes: '96M',
            max_attachments_per_message: 12,
            max_images_per_message: 6,
            attachment_context_max_chars: '120K',
            rag_top_k_max: 80
        },
        headers: {},
        user: adminUser,
        log: { warn: () => {} }
    };
    const res = {
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };

    try {
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.runtimeConfig.values.uploadAttachmentMaxBytes, 96000000);
        assert.equal(res.body.runtimeConfig.values.maxAttachmentsPerMessage, 12);
        assert.equal(res.body.runtimeConfig.values.maxImagesPerMessage, 6);
        assert.equal(getUploadRuntimeConfig().maxAttachmentsPerMessage, 12);
        assert.equal(res.body.runtimeConfig.values.attachmentContextMaxChars, 120000);
        assert.equal(res.body.runtimeConfig.values.ragTopKMax, 80);
    } finally {
        keys.forEach((key, index) => {
            const row = previousRows[index];
            if (row) {
                db.prepare(`
                    INSERT INTO app_settings (key, value, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at,
                        updated_by = excluded.updated_by
                `).run(row.key, row.value, row.updated_at, row.updated_by);
            } else {
                db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
            }
        });
        await refreshAppSettingsCache();
        syncGlobalAiConcurrencySettings();
        syncAgentRuntimeConcurrency();
    }
});

test('runtime settings save path awaits PostgreSQL upserts and syncs endpoint runtimes', () => {
    const runtimeSettings = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server', 'services', 'runtime-settings.js'), 'utf8');
    const settingsRoute = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server', 'routes', 'settings.js'), 'utf8');

    assert.match(runtimeSettings, /async function saveRuntimeConfigAsync\(updates = \{\}, userId = null\)/);
    assert.match(runtimeSettings, /ON CONFLICT \(key\) DO UPDATE SET/);
    assert.match(settingsRoute, /const result = await saveRuntimeConfigAsync\(req\.body \|\| \{\}, req\.user\?\.id \|\| null\);/);
    assert.match(settingsRoute, /const \{ getModelEndpointRuntimeStatus, syncConfiguredRuntimes \} = require\('\.\.\/services\/model-runtime'\);/);
    assert.match(settingsRoute, /globalAiConcurrency = syncGlobalAiConcurrencySettings\(\);\s*syncConfiguredRuntimes\(\);\s*modelEndpointRuntime = getModelEndpointRuntimeStatus\(\);/);
    assert.match(settingsRoute, /invalidateMonitorSummaryCache\(\);/);
});

test('app_settings helper keeps one PostgreSQL row per setting key', async () => {
    const key = RUNTIME_SETTING_KEYS.maxConcurrentAiRequests;
    const previous = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key);
    try {
        await setAppSettingAsync(key, '1', { updatedAt: '2026-01-01 00:00:00' });
        await setAppSettingAsync(key, '4', { updatedAt: '2026-01-03 00:00:00', updatedBy: 1 });
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM app_settings WHERE key = ?').get(key).count, 1);
        assert.equal(getAppSettingRow(key).value, '4');
        assert.equal(getAppSettingsMap()[key].value, '4');
    } finally {
        if (previous) {
            db.prepare(`
                INSERT INTO app_settings (key, value, updated_at, updated_by)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by
            `).run(previous.key, previous.value, previous.updated_at, previous.updated_by);
        } else {
            db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
        }
        await refreshAppSettingsCache();
    }
});
