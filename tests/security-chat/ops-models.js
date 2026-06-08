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
    getModelDailyUsage,
    getSystemHealthSnapshot,
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
    test
} = require('../security-helpers');

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

test('模型用量事件会计入每日模型配额用量', () => {
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
        assert.equal(getModelDailyUsage(userInfo.lastInsertRowid, modelInfo.lastInsertRowid), 123);
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
        assert.ok(result?.backupPath);
        assert.ok(fs.existsSync(result.backupPath));
        assert.ok(result.sizeBytes > 0);
        assert.equal(result.cleanup.deletedFiles, 3);

        const firstBackup = result.backupPath;
        const firstTime = Date.now() - 1000;
        fs.utimesSync(firstBackup, firstTime / 1000, firstTime / 1000);
        const second = await backupDatabase({ backupDir, retentionDays: 7, maxVersions: 1 });
        assert.ok(second?.backupPath);
        assert.equal(fs.existsSync(second.backupPath), true);
        assert.equal(fs.existsSync(firstBackup), false);

        const cleanup = cleanupOldBackups({ backupDir, retentionDays: 7, maxVersions: 1 });
        assert.ok(cleanup.remainingFiles <= 1);

        const status = getMaintenanceStatus();
        assert.ok(status.backup.lastSuccessAt);
        assert.equal(status.backup.backupDir, backupDir);
        assert.equal(status.backup.retentionDays, 7);
        assert.equal(status.backup.maxVersions, 1);
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
