// 从 security-chat.test.js 拆出；仍由父级入口统一加载。
const {
    ConcurrencySemaphore,
    applyChatLanguageInstruction,
    assert,
    backupDatabase,
    cleanupApiCallLogs,
    cleanupExpiredRefreshTokens,
    cleanupOldBackups,
    cleanupOldLogs,
    contentContainsVisionInput,
    createOpenAIRouter,
    db,
    fs,
    getLocalHostnames,
    getMaintenanceStatus,
    getApiAccessSetting,
    getModelDailyUsage,
    getSystemHealthSnapshot,
    http,
    isDockerInternalServiceHost,
    isLocalModelHost,
    messagesContainVisionInput,
    modelSupportsVision,
    normalizeHostAlias,
    normalizeRegenerateFlag,
    optimizeDatabase,
    overallStatus,
    path,
    recordModelTokenUsage,
    runExpressHandlers,
    setApiAccessSetting,
    test
} = require('../security-helpers');
const { refreshAppSettingsCache } = require('../../server/services/app-settings');
const {
    applyCompletionNoThinkSoftSwitch,
    applyCompletionThinkingControls,
    createCompletionResponseProxy,
    normalizeCompletionRequest
} = require('../../server/routes/openai/helpers');
const { logger: appLogger } = require('../../server/logger');

test('代码补全仅对推理模型追加 no-think 软开关', () => {
    const messages = [{ role: 'user', content: 'Complete this code' }];
    const configuredReasoning = applyCompletionNoThinkSoftSwitch(messages, {
        model_name: 'custom-model',
        supports_reasoning: 1
    });
    const qwen3Fallback = applyCompletionNoThinkSoftSwitch(messages, {
        model_name: 'Qwen3.6-35B'
    });
    const qwen25 = applyCompletionNoThinkSoftSwitch(messages, {
        model_name: 'Qwen2.5-14B'
    });

    assert.equal(configuredReasoning[0].content, 'Complete this code\n/no_think');
    assert.equal(qwen3Fallback[0].content, 'Complete this code\n/no_think');
    assert.equal(qwen25[0].content, 'Complete this code');
    assert.equal(messages[0].content, 'Complete this code');

    const repeated = applyCompletionNoThinkSoftSwitch(configuredReasoning, {
        supports_reasoning: 1
    });
    assert.equal(repeated[0].content, 'Complete this code\n/no_think');
});

test('Qwen3 代码补全强制关闭 chat template thinking 且不影响 Qwen2.5', () => {
    const payload = {
        model: 'upstream-model',
        chat_template_kwargs: {
            enable_thinking: true,
            custom_flag: 'preserved'
        }
    };
    const qwen3 = applyCompletionThinkingControls(payload, {
        model_name: 'Qwen3.6-35B'
    });
    const qwen25 = applyCompletionThinkingControls(payload, {
        model_name: 'Qwen2.5-14B'
    });

    assert.notStrictEqual(qwen3, payload);
    assert.equal(qwen3.chat_template_kwargs.enable_thinking, false);
    assert.equal(qwen3.chat_template_kwargs.custom_flag, 'preserved');
    assert.equal(payload.chat_template_kwargs.enable_thinking, true);
    assert.strictEqual(qwen25, payload);
});

test('代码补全空正文诊断保留 reasoning、结束原因与用量', () => {
    let diagnostic = null;
    const res = {
        json(body) {
            this.body = body;
            return this;
        }
    };
    const proxy = createCompletionResponseProxy(res, {
        model: 'Qwen3.6-35B',
        stream: false,
        onEmptyCompletion(value) {
            diagnostic = value;
        }
    });

    proxy.json({
        id: 'chatcmpl-reasoning-only',
        model: 'Qwen3.6-35B',
        choices: [{
            index: 0,
            message: { content: '', reasoning_content: 'thinking only' },
            finish_reason: 'length'
        }],
        usage: { prompt_tokens: 128, completion_tokens: 16, total_tokens: 144 }
    });

    assert.equal(res.body.choices[0].text, '');
    assert.equal(diagnostic.hasReasoningContent, true);
    assert.equal(diagnostic.finishReason, 'length');
    assert.equal(diagnostic.usage.completion_tokens, 16);
});

test('代码补全请求完整校验文本批量、候选数与 legacy 参数', () => {
    const normalized = normalizeCompletionRequest({
        prompt: ['const a = ', 'const b = '],
        n: 2,
        best_of: 3,
        echo: true,
        logprobs: 5
    });
    assert.deepEqual(normalized.prompts, ['const a = ', 'const b = ']);
    assert.equal(normalized.n, 2);
    assert.equal(normalized.generationCount, 3);
    assert.equal(normalized.echo, true);
    assert.equal(normalized.logprobs, 5);

    assert.throws(
        () => normalizeCompletionRequest({ prompt: [101, 102] }),
        error => error.code === 'token_prompt_not_supported' && error.param === 'prompt'
    );
    assert.throws(
        () => normalizeCompletionRequest({ prompt: 'x', stream: true, best_of: 2 }),
        error => error.code === 'invalid_best_of'
    );
    assert.throws(
        () => normalizeCompletionRequest({ prompt: 'x', n: 2, best_of: 1 }),
        error => error.code === 'invalid_best_of'
    );
});

test('代码补全代理转换全部流式 choices 并在错误帧后禁止 DONE', () => {
    const res = {
        chunks: [],
        writableEnded: false,
        write(chunk) {
            this.chunks.push(String(chunk));
            return true;
        },
        end() {
            this.writableEnded = true;
            return this;
        }
    };
    let streamError = null;
    const proxy = createCompletionResponseProxy(res, {
        model: 'Qwen3.6-35B',
        stream: true,
        echoText: 'p=',
        choiceIndexOffset: 4,
        includeLogprobs: true,
        onStreamError(error) {
            streamError = error;
        }
    });

    proxy.write('data: {"id":"chatcmpl-multi","choices":[{"index":0,"delta":{"content":"1"},"logprobs":{"content":[{"token":"1","logprob":-0.1,"top_logprobs":[]}]}},{"index":1,"delta":{"content":"2"},"logprobs":{"content":[{"token":"2","logprob":-0.2,"top_logprobs":[]}]}}]}\n\n');
    proxy.write('data: {"error":{"message":"runtime disconnected","type":"api_error","code":"upstream_stream_error"}}\n\n');
    proxy.write('data: [DONE]\n\n');
    proxy.end();

    const output = res.chunks.join('');
    assert.match(output, /"index":4/);
    assert.match(output, /"index":5/);
    assert.match(output, /"text":"p=1"/);
    assert.match(output, /"text":"p=2"/);
    assert.match(output, /"text_offset":\[2\]/);
    assert.match(output, /event: error/);
    assert.match(output, /runtime disconnected/);
    assert.doesNotMatch(output, /data: \[DONE\]/);
    assert.equal(streamError.error.code, 'upstream_stream_error');
});

test('ConcurrencySemaphore 会报告等待请求的队列位置', async () => {
    const semaphore = new ConcurrencySemaphore({
        maxConcurrent: 1,
        maxQueueSize: 2,
        queueTimeoutMs: 5000
    });
    await semaphore.acquire();

    let notice = null;
    const waiting = semaphore.acquire({
        onQueued: info => {
            notice = info;
        }
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notice.position, 1);
    assert.equal(notice.queueAhead, 0);
    assert.equal(notice.queueLength, 1);
    assert.equal(notice.maxQueue, 2);

    semaphore.release();
    await waiting;
    semaphore.release();
});

test('ConcurrencySemaphore keeps configured max while adaptive max changes', () => {
    const semaphore = new ConcurrencySemaphore({
        maxConcurrent: 3,
        maxQueueSize: 2,
        queueTimeoutMs: 5000
    });

    assert.equal(semaphore.getStatus().max, 3);
    assert.equal(semaphore.getStatus().configuredMax, 3);

    semaphore.updateMaxConcurrent(1);
    assert.equal(semaphore.getStatus().max, 1);
    assert.equal(semaphore.getStatus().effectiveMax, 1);
    assert.equal(semaphore.getStatus().configuredMax, 3);

    semaphore.updateLimits({ maxConcurrent: 4 });
    assert.equal(semaphore.getStatus().max, 4);
    assert.equal(semaphore.getStatus().configuredMax, 4);
});

test('模型视觉能力辅助函数可检测视觉输入和标记', () => {
    assert.equal(modelSupportsVision({ supports_vision: 1 }), true);
    assert.equal(modelSupportsVision({ supports_vision: 0 }), false);
    assert.equal(contentContainsVisionInput('![screenshot](/uploads/1/session/a.png)'), true);
    assert.equal(contentContainsVisionInput('![screenshot](/uploads/1/session/a%20(1).jpg?token=abc)'), true);
    assert.equal(contentContainsVisionInput('![screenshot](/uploads/1/session/a (1).jpg?token=abc)'), true);
    assert.equal(contentContainsVisionInput('plain text without image'), false);
    assert.equal(messagesContainVisionInput([
        { role: 'user', content: [{ type: 'text', text: 'look at image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ]), true);
});

test('聊天语言指令要求可见推理保持中文', () => {
    const withoutSystem = applyChatLanguageInstruction([{ role: 'user', content: '介绍一下' }]);
    assert.equal(withoutSystem[0].role, 'system');
    assert.match(withoutSystem[0].content, /【重要语言规则】/);
    assert.match(withoutSystem[0].content, /必须全程使用中文/);
    assert.match(withoutSystem[0].content, /reasoning_content/);

    const withSystem = applyChatLanguageInstruction([
        { role: 'system', content: '你是助手。' },
        { role: 'user', content: '介绍一下' }
    ]);
    assert.equal(withSystem.length, 2);
    assert.match(withSystem[0].content, /你是助手/);
    assert.match(withSystem[0].content, /禁止使用英文提纲或英文推理/);
});

test('聊天重新生成标记只接受显式 true 值', () => {
    assert.equal(normalizeRegenerateFlag(true), true);
    assert.equal(normalizeRegenerateFlag('true'), true);
    assert.equal(normalizeRegenerateFlag(false), false);
    assert.equal(normalizeRegenerateFlag(undefined), false);
    assert.equal(normalizeRegenerateFlag({ type: 'click' }), false);
    assert.equal(normalizeRegenerateFlag('false'), false);
});

test('模型用量事件会计入每日模型配额用量', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`quota_test_${suffix}`, 'hash', 'Quota Test', 'QA', 'user', 'active');
    const modelInfo = db.prepare(`
        INSERT INTO models (name, url, model_name, created_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'))
    `).run(`Quota Model ${suffix}`, 'http://127.0.0.1:1/v1', 'test-model');

    try {
        recordModelTokenUsage(userInfo.lastInsertRowid, modelInfo.lastInsertRowid, 123, 'openai_api_key');
        assert.equal(await getModelDailyUsage(userInfo.lastInsertRowid, modelInfo.lastInsertRowid), 123);
    } finally {
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('本地模型主机检测包含请求主机和已配置主机别名', () => {
    assert.equal(normalizeHostAlias('http://50.64.150.40:8080/v1'), '50.64.150.40');
    assert.equal(normalizeHostAlias('ai.example.com:3000'), 'ai.example.com');

    const previousAliases = process.env.PIVOT_LOCAL_MODEL_HOSTS;
    const previousAdvertiseAliases = process.env.PIVOT_ADVERTISE_HOSTS;
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    const previousLegacyAliases = process.env.MODEL_LOCAL_HOSTS;
    process.env.PIVOT_LOCAL_MODEL_HOSTS = '203.0.113.10,llama-server:8080';
    process.env.PIVOT_ADVERTISE_HOSTS = '192.168.31.10,pivot.local:4088';
    process.env.CORS_ORIGIN = 'http://pivot.example.com:4088';
    process.env.MODEL_LOCAL_HOSTS = '198.51.100.44';
    try {
        const names = getLocalHostnames({
            publicUrl: 'https://50.64.150.40/app',
            requestHosts: ['ai.example.com:3000', 'models.internal:8080, proxy.example']
        });
        assert.equal(names.has('50.64.150.40'), true);
        assert.equal(names.has('ai.example.com'), true);
        assert.equal(names.has('models.internal'), true);
        assert.equal(names.has('203.0.113.10'), true);
        assert.equal(names.has('llama-server'), true);
        assert.equal(names.has('192.168.31.10'), true);
        assert.equal(names.has('pivot.local'), true);
        assert.equal(names.has('pivot.example.com'), true);
        assert.equal(isLocalModelHost('http://192.168.31.10:8000/v1', names), true);
        assert.equal(isLocalModelHost('http://pivot.example.com:8000/v1', names), true);
        assert.equal(names.has('198.51.100.44'), false);
    } finally {
        if (previousAliases === undefined) {
            delete process.env.PIVOT_LOCAL_MODEL_HOSTS;
        } else {
            process.env.PIVOT_LOCAL_MODEL_HOSTS = previousAliases;
        }
        if (previousAdvertiseAliases === undefined) {
            delete process.env.PIVOT_ADVERTISE_HOSTS;
        } else {
            process.env.PIVOT_ADVERTISE_HOSTS = previousAdvertiseAliases;
        }
        if (previousCorsOrigin === undefined) {
            delete process.env.CORS_ORIGIN;
        } else {
            process.env.CORS_ORIGIN = previousCorsOrigin;
        }
        if (previousLegacyAliases === undefined) {
            delete process.env.MODEL_LOCAL_HOSTS;
        } else {
            process.env.MODEL_LOCAL_HOSTS = previousLegacyAliases;
        }
    }
});

test('可信或已检测容器运行时中 Docker 内部服务名视为本地', () => {
    const previousTrust = process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS;
    const previousKubernetesHost = process.env.KUBERNETES_SERVICE_HOST;
    const previousContainerFlag = process.env.PIVOT_RUNNING_IN_CONTAINER;
    try {
        process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = 'true';
        delete process.env.PIVOT_RUNNING_IN_CONTAINER;
        delete process.env.KUBERNETES_SERVICE_HOST;
        assert.equal(isDockerInternalServiceHost('llama-server'), true);
        assert.equal(isDockerInternalServiceHost('llama-server:8080'), true);
        assert.equal(isDockerInternalServiceHost('api.internal'), false);
        assert.equal(isDockerInternalServiceHost('10.0.0.8'), false);
        assert.equal(isLocalModelHost('llama-server', new Set()), true);

        process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = 'false';
        process.env.PIVOT_RUNNING_IN_CONTAINER = 'true';
        assert.equal(isDockerInternalServiceHost('llama-server'), false);
        assert.equal(isLocalModelHost('llama-server', new Set()), false);

        delete process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS;
        process.env.PIVOT_RUNNING_IN_CONTAINER = 'true';
        assert.equal(isDockerInternalServiceHost('llama-server'), true);
        assert.equal(isLocalModelHost('llama-server', new Set()), true);

        process.env.PIVOT_RUNNING_IN_CONTAINER = 'false';
        assert.equal(isDockerInternalServiceHost('llama-server'), false);

        delete process.env.PIVOT_RUNNING_IN_CONTAINER;
        process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
        assert.equal(isDockerInternalServiceHost('llama-server'), false);
    } finally {
        if (previousTrust === undefined) {
            delete process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS;
        } else {
            process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS = previousTrust;
        }
        if (previousKubernetesHost === undefined) {
            delete process.env.KUBERNETES_SERVICE_HOST;
        } else {
            process.env.KUBERNETES_SERVICE_HOST = previousKubernetesHost;
        }
        if (previousContainerFlag === undefined) {
            delete process.env.PIVOT_RUNNING_IN_CONTAINER;
        } else {
            process.env.PIVOT_RUNNING_IN_CONTAINER = previousContainerFlag;
        }
    }
});

test('系统健康快照报告核心检查和汇总状态', () => {
    assert.equal(overallStatus([{ status: 'ok' }, { status: 'degraded' }]), 'degraded');
    assert.equal(overallStatus([{ status: 'ok' }, { status: 'error' }]), 'error');

    const health = getSystemHealthSnapshot();
    assert.ok(['ok', 'degraded', 'error'].includes(health.status));
    assert.ok(health.checks.some(item => item.name === 'database'));
    assert.ok(health.checks.some(item => item.name === 'dataDir'));
    assert.ok(health.checks.some(item => item.name === 'uploadsDir'));
    const disk = health.checks.find(item => item.name === 'disk');
    assert.ok(disk);
    assert.ok(['ok', 'degraded', 'error', 'unknown'].includes(disk.status));
    assert.ok(typeof disk.path === 'string' && disk.path.length > 0);
    if (disk.status !== 'unknown') {
        assert.ok(Number(disk.total) >= 0);
        assert.ok(Number(disk.free) >= 0);
        assert.ok(Number(disk.usedRatio) >= 0);
    }
});

test('维护任务会记录清理和优化状态', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`maint_${suffix}`, 'hash', 'Maintenance Test', 'QA', 'user', 'active');
    const keyInfo = db.prepare(`
        INSERT INTO api_keys (user_id, name, key_hash, key_preview, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `maint-key-${suffix}`, `hash-${suffix}`, `preview-${suffix}`);

    db.prepare(`
        INSERT INTO audit_logs (user_id, action, details, timestamp)
        VALUES (?, ?, ?, datetime('now', '+8 hours', '-400 days'))
    `).run(userInfo.lastInsertRowid, `MAINT_AUDIT_${suffix}`, 'old audit');
    db.prepare(`
        INSERT INTO api_call_logs (user_id, api_key_id, model_name, status, created_at)
        VALUES (?, ?, ?, 'success', datetime('now', '+8 hours', '-60 days'))
    `).run(userInfo.lastInsertRowid, keyInfo.lastInsertRowid, `maint-model-${suffix}`);
    db.prepare(`
        INSERT INTO refresh_tokens (user_id, token, expires_at, created_at)
        VALUES (?, ?, datetime('now', '+8 hours', '-1 day'), datetime('now', '+8 hours', '-2 days'))
    `).run(userInfo.lastInsertRowid, `expired-refresh-${suffix}`);

    try {
        assert.ok(await cleanupOldLogs(180) >= 1);
        assert.ok(await cleanupApiCallLogs(30) >= 1);
        assert.ok(await cleanupExpiredRefreshTokens() >= 1);
        assert.equal(await optimizeDatabase(), true);
        const status = getMaintenanceStatus();
        assert.ok(status.auditCleanup.lastSuccessAt);
        assert.ok(status.apiCallLogCleanup.lastSuccessAt);
        assert.ok(status.refreshTokenCleanup.lastSuccessAt);
        assert.ok(status.optimize.lastSuccessAt);
        assert.equal(status.optimize.vacuumPages, 200);
    } finally {
        db.prepare('DELETE FROM audit_logs WHERE action = ?').run(`MAINT_AUDIT_${suffix}`);
        db.prepare('DELETE FROM api_call_logs WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM api_keys WHERE id = ?').run(keyInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('数据库备份任务创建热备份并清理旧版本', async () => {
    const backupDir = path.join(process.env.DATA_DIR, `backup-test-${Date.now().toString(36)}`);
    fs.mkdirSync(backupDir, { recursive: true });
    try {
        for (let i = 0; i < 3; i += 1) {
            const oldPath = path.join(backupDir, `chat_backup_old_${i}.db`);
            fs.writeFileSync(oldPath, `old-${i}`);
            const oldTime = Date.now() - (10 + i) * 24 * 60 * 60 * 1000;
            fs.utimesSync(oldPath, oldTime / 1000, oldTime / 1000);
        }

        const result = await backupDatabase({ backupDir, retentionDays: 7, maxVersions: 2 });
        assert.deepEqual(result, { skipped: true, reason: 'postgres_mode' });

        const cleanup = cleanupOldBackups({ backupDir, retentionDays: 7, maxVersions: 1 });
        assert.equal(cleanup.deletedFiles, 3);
        assert.equal(cleanup.remainingFiles, 0);
    } finally {
        fs.rmSync(backupDir, { recursive: true, force: true });
    }
});

test('OpenAI 模型发现会排除内置工具伪模型', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`openai_models_${suffix}`, 'hash', 'OpenAI Models User', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `openai_models_${suffix}`, role: 'user', unit: 'QA' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Chat Model', 'https://model.example/v1/chat/completions', `chat-model-${suffix}`);
    const router = createOpenAIRouter({
        authMiddleware: (req, res, next) => {
            req.user = user;
            next();
        },
        embeddingLimiter: (req, res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/models');
    assert.ok(route);

    try {
        const req = {};
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
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.body?.data?.some(item => item.id === `chat-model-${suffix}`));
        assert.equal(res.body.data.some(item => item.id === 'pivot-tools'), false);
    } finally {
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('OpenAI 聊天补全兼容 prompt 风格的代码补全请求', async () => {
    const suffix = Date.now().toString(36);
    let capturedPayload = null;
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            capturedPayload = JSON.parse(body);
            const shouldReturnEmpty = capturedPayload.messages?.[0]?.content?.includes('EMPTY_COMPLETION');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: shouldReturnEmpty ? '' : 'return a + b',
                        reasoning_content: shouldReturnEmpty ? 'output budget consumed by reasoning' : ''
                    },
                    finish_reason: shouldReturnEmpty ? 'length' : 'stop'
                }],
                usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
            }));
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`openai_autocomplete_${suffix}`, 'hash', 'OpenAI Autocomplete User', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `openai_autocomplete_${suffix}`, role: 'admin', unit: 'QA' };
    const modelName = `autocomplete-model-${suffix}`;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Autocomplete Model', `http://127.0.0.1:${upstream.address().port}/v1`, modelName);
    const router = createOpenAIRouter({
        authMiddleware: (req, res, next) => {
            req.user = user;
            next();
        },
        embeddingLimiter: (req, res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/chat/completions');
    assert.ok(route);

    try {
        const req = {
            body: {
                model: modelName,
                messages: [],
                prompt: 'function add(a, b) {\n  ',
                suffix: ';\n}',
                language: 'javascript',
                filepath: 'src/math.js',
                max_tokens: 32,
                stop: ['\n\n'],
                stream: false
            },
            headers: {},
            ip: '127.0.0.1'
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
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body?.choices?.[0]?.message?.content, 'return a + b');
        assert.equal(capturedPayload.model, modelName);
        assert.equal(capturedPayload.max_tokens, 32);
        assert.deepEqual(capturedPayload.stop, ['\n\n']);
        assert.equal(capturedPayload.messages.length, 1);
        assert.equal(capturedPayload.messages[0].role, 'user');
        assert.match(capturedPayload.messages[0].content, /Complete the code at the cursor/);
        assert.match(capturedPayload.messages[0].content, /Language: javascript/);
        assert.match(capturedPayload.messages[0].content, /File path: src\/math\.js/);
        assert.match(capturedPayload.messages[0].content, /function add/);
        assert.match(capturedPayload.messages[0].content, /Code after cursor/);
        assert.doesNotMatch(capturedPayload.messages[0].content, /\/no_think/);

        let emptyDiagnostic = null;
        const originalWarn = appLogger.warn;
        appLogger.warn = (details, message) => {
            if (message === 'OpenAI code completion returned no visible content') emptyDiagnostic = details;
        };
        try {
            const emptyReq = {
                body: {
                    model: modelName,
                    messages: [],
                    prompt: 'EMPTY_COMPLETION',
                    max_tokens: 8,
                    stream: false
                },
                headers: {},
                ip: '127.0.0.1'
            };
            const emptyRes = {
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
            await runExpressHandlers(route.route.stack.map(layer => layer.handle), emptyReq, emptyRes);
            assert.equal(emptyRes.body.choices[0].message.content, '');
            assert.equal(emptyDiagnostic.endpoint, '/v1/chat/completions');
            assert.equal(emptyDiagnostic.hasReasoningContent, true);
            assert.equal(emptyDiagnostic.finishReason, 'length');
        } finally {
            appLogger.warn = originalWarn;
        }
    } finally {
        await new Promise(resolve => upstream.close(resolve));
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('OpenAI completions 兼容 Continue 风格的 prompt 请求', async () => {
    const suffix = Date.now().toString(36);
    let capturedPayload = null;
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            capturedPayload = JSON.parse(body);
            const noThinkEnabled = /\/no_think\s*$/.test(capturedPayload.messages?.[0]?.content || '');
            const hardThinkingDisabled = capturedPayload.chat_template_kwargs?.enable_thinking === false;
            const completionEnabled = noThinkEnabled && hardThinkingDisabled;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
                id: 'chatcmpl-test',
                object: 'chat.completion',
                created: 1710000000,
                model: 'autocomplete-model',
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: completionEnabled ? 'return a + b' : '',
                        reasoning_content: completionEnabled ? '' : 'reasoning consumed the output budget'
                    },
                    finish_reason: completionEnabled ? 'stop' : 'length'
                }],
                usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
            }));
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`openai_completion_${suffix}`, 'hash', 'OpenAI Completion User', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `openai_completion_${suffix}`, role: 'admin', unit: 'QA' };
    const modelName = `qwen3.6-completion-${suffix}`;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, supports_reasoning, status, created_at)
        VALUES (?, ?, ?, ?, 1, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Reasoning Completion Model', `http://127.0.0.1:${upstream.address().port}/v1`, modelName);
    const router = createOpenAIRouter({
        authMiddleware: (req, res, next) => {
            req.user = user;
            next();
        },
        embeddingLimiter: (req, res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/completions');
    assert.ok(route);

    try {
        const req = {
            body: {
                model: modelName,
                messages: [],
                prompt: 'function add(a, b) {\n  ',
                suffix: ';\n}',
                language: 'javascript',
                filepath: 'src/math.js',
                max_tokens: 32,
                stop: ['\n\n'],
                stream: false
            },
            headers: {},
            ip: '127.0.0.1'
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
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body?.object, 'text_completion');
        assert.equal(res.body?.choices?.[0]?.text, 'return a + b');
        assert.equal(capturedPayload.model, modelName);
        assert.equal(capturedPayload.max_tokens, 32);
        assert.deepEqual(capturedPayload.stop, ['\n\n']);
        assert.equal(capturedPayload.messages.length, 1);
        assert.equal(capturedPayload.messages[0].role, 'user');
        assert.match(capturedPayload.messages[0].content, /Complete the code at the cursor/);
        assert.match(capturedPayload.messages[0].content, /Language: javascript/);
        assert.match(capturedPayload.messages[0].content, /File path: src\/math\.js/);
        assert.match(capturedPayload.messages[0].content, /function add/);
        assert.match(capturedPayload.messages[0].content, /Code after cursor/);
        assert.match(capturedPayload.messages[0].content, /\/no_think\s*$/);
        assert.equal(capturedPayload.chat_template_kwargs.enable_thinking, false);
    } finally {
        await new Promise(resolve => upstream.close(resolve));
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('OpenAI completions 完整支持文本 prompt 数组与 legacy 候选参数', async () => {
    const suffix = Date.now().toString(36);
    const capturedPayloads = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const payload = JSON.parse(body);
            capturedPayloads.push(payload);
            const promptLabel = payload.messages?.[0]?.content?.includes('FIRST:') ? 'first' : 'second';
            const makeChoice = (index, text, score) => ({
                index,
                message: { role: 'assistant', content: text },
                finish_reason: 'stop',
                logprobs: {
                    content: [{
                        token: text,
                        logprob: score,
                        top_logprobs: [{ token: text, logprob: score }]
                    }]
                }
            });
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
                id: `chatcmpl-${promptLabel}`,
                object: 'chat.completion',
                created: 1710000002,
                model: 'qwen3.6-batch',
                choices: [
                    makeChoice(0, `${promptLabel}-low`, -2),
                    makeChoice(1, `${promptLabel}-best`, -0.1),
                    makeChoice(2, `${promptLabel}-second`, -1)
                ],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
            }));
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`openai_completion_batch_${suffix}`, 'hash', 'OpenAI Completion Batch User', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `openai_completion_batch_${suffix}`, role: 'admin', unit: 'QA' };
    const modelName = `qwen3.6-completion-batch-${suffix}`;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Completion Batch Model', `http://127.0.0.1:${upstream.address().port}/v1`, modelName);
    const router = createOpenAIRouter({
        authMiddleware: (req, res, next) => {
            req.user = user;
            next();
        },
        embeddingLimiter: (req, res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/completions');

    try {
        const req = {
            body: {
                model: modelName,
                prompt: ['FIRST:', 'SECOND:'],
                n: 2,
                best_of: 3,
                echo: true,
                logprobs: 2,
                seed: 7,
                logit_bias: { 42: 1 },
                user: 'continue-editor',
                max_tokens: 24,
                stream: false
            },
            headers: {},
            ip: '127.0.0.1'
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
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(capturedPayloads.length, 2);
        capturedPayloads.forEach(payload => {
            assert.equal(payload.n, 3);
            assert.equal(payload.logprobs, true);
            assert.equal(payload.top_logprobs, 2);
            assert.equal(payload.seed, 7);
            assert.deepEqual(payload.logit_bias, { 42: 1 });
            assert.equal(payload.user, 'continue-editor');
            assert.match(payload.messages[0].content, /\/no_think\s*$/);
            assert.equal(payload.chat_template_kwargs.enable_thinking, false);
        });
        assert.deepEqual(res.body.choices.map(choice => choice.index), [0, 1, 2, 3]);
        assert.deepEqual(res.body.choices.map(choice => choice.text), [
            'FIRST:first-best',
            'FIRST:first-second',
            'SECOND:second-best',
            'SECOND:second-second'
        ]);
        assert.equal(res.body.choices[0].logprobs.tokens[0], 'first-best');
        assert.equal(res.body.choices[0].logprobs.text_offset[0], 'FIRST:'.length);
        assert.deepEqual(res.body.usage, { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 });
    } finally {
        await new Promise(resolve => upstream.close(resolve));
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('OpenAI completions 流式响应会转换为 text completion SSE', async () => {
    const suffix = Date.now().toString(36);
    const capturedPayloads = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const capturedPayload = JSON.parse(body);
            capturedPayloads.push(capturedPayload);
            const noThinkEnabled = /\/no_think\s*$/.test(capturedPayload.messages?.[0]?.content || '');
            const hardThinkingDisabled = capturedPayload.chat_template_kwargs?.enable_thinking === false;
            res.setHeader('Content-Type', 'text/event-stream');
            if (noThinkEnabled && hardThinkingDisabled) {
                res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1710000001,"model":"autocomplete-model","choices":[{"index":0,"delta":{"content":"ret"},"finish_reason":null},{"index":1,"delta":{"content":"sum"},"finish_reason":null}]}\n\n');
                res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1710000001,"model":"autocomplete-model","choices":[{"index":0,"delta":{"content":"urn"},"finish_reason":null},{"index":1,"delta":{"content":" = a + b"},"finish_reason":null}]}\n\n');
                res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1710000001,"model":"autocomplete-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"},{"index":1,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":4,"total_tokens":9}}\n\n');
            } else {
                res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1710000001,"model":"autocomplete-model","choices":[{"index":0,"delta":{"reasoning_content":"hidden reasoning"},"finish_reason":null}]}\n\n');
                res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1710000001,"model":"autocomplete-model","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":5,"completion_tokens":16,"total_tokens":21}}\n\n');
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`openai_completion_stream_${suffix}`, 'hash', 'OpenAI Completion Stream User', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `openai_completion_stream_${suffix}`, role: 'admin', unit: 'QA' };
    const modelName = `qwen3.6-completion-stream-${suffix}`;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Completion Stream Model', `http://127.0.0.1:${upstream.address().port}/v1`, modelName);
    const router = createOpenAIRouter({
        authMiddleware: (req, res, next) => {
            req.user = user;
            next();
        },
        embeddingLimiter: (req, res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/completions');
    assert.ok(route);

    try {
        const req = new (require('node:events').EventEmitter)();
        Object.assign(req, {
            body: {
                model: modelName,
                prompt: ['function add(a, b) {\n  ', 'function subtract(a, b) {\n  '],
                suffix: ';\n}',
                max_tokens: 16,
                n: 2,
                seed: 11,
                stream_options: { include_usage: true },
                stream: true
            },
            headers: {},
            ip: '127.0.0.1'
        });
        const res = {
            statusCode: 200,
            headers: {},
            writableEnded: false,
            status(code) {
                this.statusCode = code;
                return this;
            },
            setHeader(name, value) {
                this.headers[name.toLowerCase()] = value;
            },
            write(chunk) {
                this.chunks.push(String(chunk));
            },
            end() {
                this.writableEnded = true;
                if (typeof this.onEnd === 'function') this.onEnd();
            },
            chunks: []
        };
        const done = new Promise(resolve => { res.onEnd = resolve; });
        await Promise.race([
            runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res),
            done
        ]);

        const output = res.chunks.join('');
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-type'], 'text/event-stream');
        assert.equal(capturedPayloads.length, 2);
        capturedPayloads.forEach(capturedPayload => {
            assert.match(capturedPayload.messages[0].content, /\/no_think\s*$/);
            assert.equal(capturedPayload.n, 2);
            assert.equal(capturedPayload.seed, 11);
            assert.deepEqual(capturedPayload.stream_options, { include_usage: true });
            assert.equal(capturedPayload.chat_template_kwargs.enable_thinking, false);
        });
        assert.doesNotMatch(output, /hidden reasoning/);
        assert.match(output, /"object":"text_completion"/);
        assert.match(output, /"text":"ret"/);
        assert.match(output, /"text":"urn"/);
        assert.match(output, /"index":1/);
        assert.match(output, /"index":2/);
        assert.match(output, /"index":3/);
        assert.match(output, /"text":"sum"/);
        assert.match(output, /"text":" = a \+ b"/);
        assert.match(output, /"finish_reason":"stop"/);
        assert.equal((output.match(/"usage":/g) || []).length, 1);
        assert.match(output, /"prompt_tokens":10/);
        assert.match(output, /"completion_tokens":8/);
        assert.match(output, /"total_tokens":18/);
        assert.match(output, /data: \[DONE\]/);
        assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1);
    } finally {
        await new Promise(resolve => upstream.close(resolve));
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('OpenAI completions 上游流中断会返回 SSE error 且不伪造 DONE', async () => {
    const suffix = Date.now().toString(36);
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"id":"chatcmpl-broken","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
            setTimeout(() => res.destroy(new Error('simulated upstream disconnect')), 20);
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`openai_completion_error_${suffix}`, 'hash', 'OpenAI Completion Error User', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `openai_completion_error_${suffix}`, role: 'admin', unit: 'QA' };
    const modelName = `qwen3.6-completion-error-${suffix}`;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, status, created_at)
        VALUES (?, ?, ?, ?, 'active', datetime('now', '+8 hours'))
    `).run(user.id, 'Completion Error Model', `http://127.0.0.1:${upstream.address().port}/v1`, modelName);
    const router = createOpenAIRouter({
        authMiddleware: (req, res, next) => {
            req.user = user;
            next();
        },
        embeddingLimiter: (req, res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/completions');

    try {
        const req = new (require('node:events').EventEmitter)();
        Object.assign(req, {
            body: {
                model: modelName,
                prompt: 'const value = ',
                max_tokens: 8,
                stream: true
            },
            headers: {},
            ip: '127.0.0.1'
        });
        const res = {
            statusCode: 200,
            headers: {},
            chunks: [],
            writableEnded: false,
            status(code) {
                this.statusCode = code;
                return this;
            },
            setHeader(name, value) {
                this.headers[name.toLowerCase()] = value;
            },
            write(chunk) {
                this.chunks.push(String(chunk));
                return true;
            },
            json(body) {
                this.body = body;
                this.writableEnded = true;
                if (typeof this.onEnd === 'function') this.onEnd();
                return this;
            },
            end() {
                this.writableEnded = true;
                if (typeof this.onEnd === 'function') this.onEnd();
                return this;
            }
        };
        const done = new Promise(resolve => { res.onEnd = resolve; });
        const timeout = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('stream error test timed out')), 3000);
            done.finally(() => clearTimeout(timer));
        });
        await Promise.race([
            runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res),
            done,
            timeout
        ]);

        const output = res.chunks.join('');
        assert.match(output, /"text":"partial"/);
        assert.match(output, /event: error/);
        assert.match(output, /upstream_stream_error|ECONNRESET|aborted/i);
        assert.doesNotMatch(output, /data: \[DONE\]/);
        assert.equal(res.writableEnded, true);
    } finally {
        await new Promise(resolve => upstream.close(resolve));
        db.prepare('DELETE FROM model_usage_events WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('api access disabled blocks openai router at the router level', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`openai_block_${suffix}`, 'hash', 'OpenAI Block User', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `openai_block_${suffix}`, role: 'user', unit: 'QA' };
    const previousRow = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get('api_access_enabled');
    const previousValue = getApiAccessSetting();
    const router = createOpenAIRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        embeddingLimiter: (_req, _res, next) => next(),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/models');
    const req = {
        method: 'GET',
        url: '/models',
        originalUrl: '/models',
        headers: {},
        user
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
        await setApiAccessSetting(false, user.id);
        await new Promise((resolve, reject) => {
            const originalJson = res.json.bind(res);
            res.json = (body) => {
                originalJson(body);
                resolve();
                return res;
            };
            router.handle(req, res, err => {
                if (err) reject(err);
            });
        });
        assert.equal(res.statusCode, 403);
        assert.match(res.body.error, /API/);
        assert.ok(route);
    } finally {
        if (previousRow) {
            db.prepare(`
                INSERT INTO app_settings (key, value, updated_at, updated_by)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by
            `).run(previousRow.key, previousRow.value, previousRow.updated_at, previousRow.updated_by);
        } else {
            db.prepare('DELETE FROM app_settings WHERE key = ?').run('api_access_enabled');
        }
        await refreshAppSettingsCache();
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        assert.equal(getApiAccessSetting(), previousValue);
    }
});
test('public health snapshot is lightweight and does not expose filesystem paths', () => {
    const health = getSystemHealthSnapshot({ public: true });
    assert.ok(['ok', 'degraded', 'error'].includes(health.status));
    assert.ok(health.checks.some(item => item.name === 'database'));
    assert.equal(JSON.stringify(health).includes('path'), false);
    assert.equal(health.checks.some(item => item.name === 'dataDir' || item.name === 'uploadsDir' || item.name === 'disk'), false);
});
