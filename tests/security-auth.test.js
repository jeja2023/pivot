// 认证与权限安全测试
const {
    ADMIN_TIER,
    CSRF_COOKIE_NAME,
    MANAGER_TIER,
    USER_TIER,
    assert,
    assertSafeOutboundUrl,
    createAdminUsersRouter,
    createAttachmentsRouter,
    createAuthRouter,
    createModelsRouter,
    createSafeLookup,
    createSessionsRouter,
    csrfMiddleware,
    db,
    encodeAttachmentUrl,
    encryptSecret,
    ensureBuiltInAdminAccount,
    fs,
    getClientIp,
    getCookie,
    getApiAccessSetting,
    getPermissionLabel,
    getPermissionTier,
    isAdmin,
    isPathInsideUploadRoot,
    isSensitiveOutboundHost,
    isSuperAdmin,
    normalizeUploadedOriginalName,
    path,
    removeTestPath,
    resolveUploadUrlPath,
    runExpressHandlers,
    test,
    setApiAccessSetting,
    toProjectRelativePath,
    uploadRoot,
    withPermissionFlags
} = require('./security-helpers');
const { refreshAppSettingsCache } = require('../server/services/app-settings');

test('seed repair restores built-in admin role and login status', () => {
    const admin = db.prepare('SELECT id, role, status, deleted_at, nickname, unit FROM users WHERE username = ?').get('admin');
    assert.ok(admin);
    try {
        db.prepare("UPDATE users SET role = 'user', status = 'disabled', deleted_at = ?, nickname = '', unit = '' WHERE username = ?")
            .run('2026-01-01 00:00:00', 'admin');
        ensureBuiltInAdminAccount();
        const repaired = db.prepare('SELECT role, status, deleted_at, nickname, unit FROM users WHERE username = ?').get('admin');
        assert.equal(repaired.role, 'admin');
        assert.equal(repaired.status, 'active');
        assert.equal(repaired.deleted_at, null);
        assert.equal(repaired.nickname, '系统管理员');
        assert.equal(repaired.unit, '智枢科技');
    } finally {
        db.prepare('UPDATE users SET role = ?, status = ?, deleted_at = ?, nickname = ?, unit = ? WHERE id = ?')
            .run(admin.role, admin.status, admin.deleted_at, admin.nickname, admin.unit, admin.id);
    }
});

test('permission helpers expose admin, manager, and user tiers', () => {
    const superAdmin = withPermissionFlags({ id: 1, username: 'admin', role: 'admin' });
    const limitedAdmin = withPermissionFlags({ id: 2, username: 'ops_admin', role: 'admin' });
    const caseVariantAdmin = withPermissionFlags({ id: 3, username: 'Admin', role: 'admin' });
    const spoofedAdminName = withPermissionFlags({ id: 4, username: 'admin', role: 'user' });
    const normalUser = withPermissionFlags({ id: 5, username: 'normal_user', role: 'user' });

    assert.equal(isAdmin(superAdmin), true);
    assert.equal(isSuperAdmin(superAdmin), true);
    assert.equal(superAdmin.is_super_admin, true);
    assert.equal(getPermissionTier(superAdmin), ADMIN_TIER);
    assert.equal(superAdmin.permissionTier, ADMIN_TIER);
    assert.equal(getPermissionLabel(superAdmin), '系统管理员');
    assert.equal(superAdmin.permissionLabel, '系统管理员');
    assert.equal(isAdmin(limitedAdmin), true);
    assert.equal(isSuperAdmin(limitedAdmin), false);
    assert.equal(limitedAdmin.is_super_admin, false);
    assert.equal(getPermissionTier(limitedAdmin), MANAGER_TIER);
    assert.equal(limitedAdmin.permissionTier, MANAGER_TIER);
    assert.equal(getPermissionLabel(limitedAdmin), '管理员');
    assert.equal(limitedAdmin.permissionLabel, '管理员');
    assert.equal(isAdmin(caseVariantAdmin), true);
    assert.equal(isSuperAdmin(caseVariantAdmin), false);
    assert.equal(getPermissionTier(caseVariantAdmin), MANAGER_TIER);
    assert.equal(isAdmin(spoofedAdminName), false);
    assert.equal(isSuperAdmin(spoofedAdminName), false);
    assert.equal(getPermissionTier(spoofedAdminName), USER_TIER);
    assert.equal(isAdmin(normalUser), false);
    assert.equal(isSuperAdmin(normalUser), false);
    assert.equal(getPermissionTier(normalUser), USER_TIER);
    assert.equal(normalUser.permissionTier, USER_TIER);
    assert.equal(getPermissionLabel(normalUser), '用户');
    assert.equal(normalUser.permissionLabel, '用户');
});

test('resolveUploadUrlPath accepts normal and encoded upload URLs', () => {
    const target = resolveUploadUrlPath('/uploads/1/session/file.png?token=abc');
    assert.equal(target, path.resolve(uploadRoot, '1', 'session', 'file.png'));
    assert.equal(toProjectRelativePath(target), 'uploads/1/session/file.png');

    const encoded = resolveUploadUrlPath('/uploads/1/session/file%20(1).jpg?token=abc');
    assert.equal(encoded, path.resolve(uploadRoot, '1', 'session', 'file (1).jpg'));
    assert.equal(toProjectRelativePath(encoded), 'uploads/1/session/file (1).jpg');
});

test('encodeAttachmentUrl encodes upload paths and rejects unsafe paths', () => {
    assert.equal(
        encodeAttachmentUrl('uploads/1/session/file (1).jpg', 'token +/=?'),
        '/uploads/1/session/file%20%281%29.jpg?token=token%20%2B%2F%3D%3F'
    );
    assert.equal(encodeAttachmentUrl('server/index.js', 'token'), '');
    assert.equal(encodeAttachmentUrl('uploads/1/../file.png', 'token'), '');
});

test('resolveUploadUrlPath rejects traversal and non-upload URLs', () => {
    assert.equal(resolveUploadUrlPath('/api/health'), null);
    assert.equal(resolveUploadUrlPath('/uploads/../data/chat.db'), null);
    assert.equal(resolveUploadUrlPath('/uploads/%2e%2e/data/chat.db'), null);
    assert.equal(resolveUploadUrlPath('/uploads/1/../../server/index.js'), null);
    assert.equal(isPathInsideUploadRoot(path.resolve(__dirname, '..', 'server', 'index.js')), false);
});

test('normalizeUploadedOriginalName preserves Chinese names and repairs latin1 mojibake', () => {
    const name = '测试文档.pdf';
    const mojibake = Buffer.from(name, 'utf8').toString('latin1');

    assert.equal(normalizeUploadedOriginalName(name), name);
    assert.equal(normalizeUploadedOriginalName(mojibake), name);
    assert.equal(normalizeUploadedOriginalName('../测试文档.pdf'), name);
});

test('getCookie ignores malformed percent-encoded cookie pairs', () => {
    const req = {
        headers: {
            cookie: 'bad=%E0%A4%A; pivot_csrf_token=valid-token'
        }
    };
    assert.equal(getCookie(req, 'pivot_csrf_token'), 'valid-token');
    assert.equal(getCookie(req, 'bad'), undefined);
});

function createMemoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return data.has(key) ? data.get(key) : null;
        },
        setItem(key, value) {
            data.set(key, String(value));
        },
        removeItem(key) {
            data.delete(key);
        },
        clear() {
            data.clear();
        }
    };
}

function createJsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return body;
        },
        clone() {
            return createJsonResponse(status, body);
        }
    };
}

function createConfigSandbox(fetchImpl) {
    const vm = require('node:vm');
    const sandbox = {
        console,
        URL,
        document: { documentElement: { dataset: {} } },
        localStorage: createMemoryStorage({ pivot_token: 'legacy-token' }),
        sessionStorage: createMemoryStorage(),
        fetch: fetchImpl,
        window: {
            APP_VERSION_TAG: '',
            location: { origin: 'http://localhost' },
            Pivot: {}
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'client', 'chat', 'config.js'), 'utf8'), sandbox, {
        filename: 'client/chat/config.js'
    });
    return sandbox;
}

test('apiFetch refreshes expired cookie state and retries the original request', async () => {
    const calls = [];
    const sandbox = createConfigSandbox(async (url, options = {}) => {
        calls.push({ url, headers: { ...(options.headers || {}) }, method: options.method || 'GET' });
        if (url === '/api/chat' && calls.length === 1) {
            return createJsonResponse(403, { error: 'csrf invalid', code: 'CSRF_INVALID' });
        }
        if (url === '/api/auth/refresh') {
            return createJsonResponse(200, { success: true, csrfToken: 'fresh-csrf' });
        }
        if (url === '/api/chat') {
            return createJsonResponse(200, { ok: true });
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    const res = await sandbox.apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });

    assert.equal(res.ok, true);
    assert.deepEqual(calls.map(call => call.url), ['/api/chat', '/api/auth/refresh', '/api/chat']);
    assert.equal(calls[2].headers['X-CSRF-Token'], 'fresh-csrf');
    assert.equal(sandbox.sessionStorage.getItem('pivot_csrf_token'), 'fresh-csrf');
});

test('apiFetch returns to login when refresh token is no longer valid', async () => {
    const calls = [];
    const sandbox = createConfigSandbox(async (url, options = {}) => {
        calls.push({ url, headers: { ...(options.headers || {}) } });
        if (url === '/api/sessions') {
            return createJsonResponse(401, { error: 'missing auth', code: 'AUTH_MISSING' });
        }
        if (url === '/api/auth/refresh') {
            return createJsonResponse(401, { error: 'refresh expired', code: 'REFRESH_TOKEN_INVALID' });
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    let showAuthCount = 0;
    let closedRealtimeCount = 0;
    sandbox.window.showAuth = () => { showAuthCount += 1; };
    sandbox.window.closeAgentRealtime = () => { closedRealtimeCount += 1; };

    await assert.rejects(() => sandbox.apiFetch('/api/sessions'), /Refresh failed|令牌刷新失败/);

    assert.deepEqual(calls.map(call => call.url), ['/api/sessions', '/api/auth/refresh']);
    assert.equal(showAuthCount, 1);
    assert.equal(closedRealtimeCount, 1);
    assert.equal(sandbox.sessionStorage.getItem('pivot_csrf_token'), null);
});

test('outbound URL guard blocks sensitive SSRF targets', async () => {
    assert.equal(isSensitiveOutboundHost('127.0.0.1'), true);
    assert.equal(isSensitiveOutboundHost('169.254.169.254'), true);
    assert.equal(isSensitiveOutboundHost('metadata.google.internal'), true);
    assert.equal(isSensitiveOutboundHost('192.168.1.10'), false);

    await assert.rejects(
        assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data', { role: 'admin' }),
        /sensitive local|metadata target|敏感的本地|云元数据/
    );
    await assert.rejects(
        assertSafeOutboundUrl('http://localhost:11434/v1', { role: 'admin' }),
        /sensitive local|metadata target|敏感的本地|云元数据/
    );
});

test('getClientIp trusts forwarded headers only from configured proxies', () => {
    const previous = process.env.TRUSTED_PROXY_IPS;
    try {
        delete process.env.TRUSTED_PROXY_IPS;
        assert.equal(getClientIp({
            headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.5' },
            socket: { remoteAddress: '10.0.0.5' }
        }), '10.0.0.5');

        process.env.TRUSTED_PROXY_IPS = '10.0.0.5,127.0.0.1/32';
        assert.equal(getClientIp({
            headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.5' },
            socket: { remoteAddress: '10.0.0.5' }
        }), '203.0.113.9');
    } finally {
        if (previous === undefined) delete process.env.TRUSTED_PROXY_IPS;
        else process.env.TRUSTED_PROXY_IPS = previous;
    }
});

test('safe outbound lookup rejects private resolved addresses during HTTP requests', async () => {
    const lookup = createSafeLookup({ blockPrivate: true });
    await assert.rejects(
        new Promise((resolve, reject) => {
            lookup('localhost', { all: false }, (err, address) => {
                if (err) return reject(err);
                resolve(address);
            });
        }),
        /sensitive local|metadata target|敏感的本地|云元数据/
    );
});

test('safe outbound lookup pins the first validated address for an agent', async () => {
    const dns = require('node:dns');
    const originalLookup = dns.lookup;
    let calls = 0;
    try {
        dns.lookup = (hostname, options, callback) => {
            calls += 1;
            callback(null, [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
        };
        const lookup = createSafeLookup({ blockPrivate: true });
        const resolveLookup = options => new Promise((resolve, reject) => {
            lookup('pinned.example.test', options, (error, address, family) => error ? reject(error) : resolve({ address, family }));
        });
        assert.deepEqual(await resolveLookup({ all: false }), { address: '93.184.216.34', family: 4 });
        assert.deepEqual(await resolveLookup({ all: false }), { address: '93.184.216.34', family: 4 });
        assert.equal(calls, 1);
    } finally {
        dns.lookup = originalLookup;
    }
});

test('session detail only appends valid attachment tokens', async () => {
    const { createSessionsRouter } = require('../server/routes/sessions');
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`session_attach_${suffix}`, 'hash', 'Session Attachment Test', 'QA', 'user', 'active');
    const userId = userInfo.lastInsertRowid;
    const sessionId = `session-attach-${suffix}`;
    const activePath = `uploads/${userId}/${sessionId}/active.png`;
    const spacedPath = `uploads/${userId}/${sessionId}/space file (1).png`;
    const encodedPath = `uploads/${userId}/${sessionId}/encoded file (2).png`;
    const deletedPath = `uploads/${userId}/${sessionId}/deleted.png`;
    const expiredPath = `uploads/${userId}/${sessionId}/expired.png`;
    const encodedUrl = encodeAttachmentUrl(encodedPath);
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(sessionId, userId, 'Session Attachment Test');
    db.prepare(`
        INSERT INTO messages (session_id, user_id, role, content, created_at)
        VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(
        sessionId,
        userId,
        'user',
        `![a](/${activePath}) ![s](/${spacedPath}) ![enc](${encodedUrl}) ![d](/${deletedPath}) ![e](/${expiredPath})`
    );
    db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '+1 day'), datetime('now', '+8 hours'))
    `).run(userId, sessionId, 'active.png', activePath, 'image/png', 1, 'active-token');
    db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '+1 day'), datetime('now', '+8 hours'))
    `).run(userId, sessionId, 'space file (1).png', spacedPath, 'image/png', 1, 'space-token');
    db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '+1 day'), datetime('now', '+8 hours'))
    `).run(userId, sessionId, 'encoded file (2).png', encodedPath, 'image/png', 1, 'encoded-token');
    db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, deleted_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '+1 day'), datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(userId, sessionId, 'deleted.png', deletedPath, 'image/png', 1, 'deleted-token');
    db.prepare(`
        INSERT INTO attachments (user_id, session_id, file_name, file_path, file_type, file_size, access_token, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+8 hours', '-1 day'), datetime('now', '+8 hours'))
    `).run(userId, sessionId, 'expired.png', expiredPath, 'image/png', 1, 'expired-token');

    const router = createSessionsRouter({
        authMiddleware: (req, res, next) => {
            req.user = { id: userId, username: `session_attach_${suffix}`, role: 'user', status: 'active' };
            next();
        },
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/sessions/:id' && layer.route.methods.get);
    const req = { params: { id: sessionId }, query: {}, headers: {} };
    let payload = null;
    const res = {
        status() { return this; },
        json(data) {
            payload = data;
            return this;
        }
    };
    const handlers = route.route.stack.map(item => item.handle);

    try {
        await handlers[0](req, res, err => { if (err) throw err; });
        await new Promise((resolve, reject) => {
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                originalJson(data);
                resolve();
                return res;
            };
            handlers[1](req, res, reject);
        });
        const content = payload.messages[0].content;
        assert.match(content, /active\.png\?token=active-token/);
        assert.match(content, /space%20file%20%281%29\.png\?token=space-token/);
        assert.match(content, /encoded%20file%20%282%29\.png\?token=encoded-token/);
        assert.doesNotMatch(content, /deleted\.png\?token=deleted-token/);
        assert.doesNotMatch(content, /expired\.png\?token=expired-token/);
    } finally {
        db.prepare('DELETE FROM attachments WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('attachment upload requires a session owned by the current user', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`upload_owner_${suffix}`, 'hash', 'Upload Owner Test', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const ownedSessionId = `upload-owned-${suffix}`;
    const tempFile = path.join(uploadRoot, `upload-temp-${suffix}.txt`);
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.writeFileSync(tempFile, 'hello upload');
    db.prepare(`
        INSERT INTO sessions (id, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(ownedSessionId, userId, 'Upload Owner Test');

    const router = createAttachmentsRouter({
        authMiddleware: (req, _res, next) => {
            req.user = { id: userId, username: `upload_owner_${suffix}`, role: 'user', status: 'active' };
            next();
        },
        uploadLimiter: (_req, _res, next) => next(),
        upload: {
            single: () => (req, _res, next) => {
                req.file = {
                    path: tempFile,
                    originalname: 'proof.txt',
                    mimetype: 'text/plain',
                    size: fs.statSync(tempFile).size
                };
                next();
            }
        },
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100),
        logAction: () => {}
    });
    const route = router.stack.find(layer => layer.route?.path === '/api/upload' && layer.route.methods.post);
    const req = { query: { sessionId: `missing-${suffix}` }, body: {}, headers: {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };

    try {
        await runExpressHandlers(route.route.stack.map(layer => layer.handle), req, res);
        assert.equal(res.statusCode, 404);
        assert.equal(fs.existsSync(tempFile), false);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE user_id = ?').get(userId).count, 0);
    } finally {
        removeTestPath(tempFile);
        db.prepare('DELETE FROM attachments WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(ownedSessionId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
});

test('csrfMiddleware requires matching cookie and header for cookie writes', () => {
    let statusCode = 0;
    let body = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(value) {
            body = value;
            return this;
        }
    };

    csrfMiddleware({ method: 'POST', path: '/chat', headers: {}, socket: {} }, res, () => {
        throw new Error('CSRF should not pass without token');
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'CSRF 校验失败');
    assert.equal(body.code, 'CSRF_INVALID');

    let passed = false;
    csrfMiddleware({
        method: 'POST',
        path: '/chat',
        headers: {
            cookie: `${CSRF_COOKIE_NAME}=abc`,
            'x-csrf-token': 'abc'
        },
        socket: {}
    }, res, () => {
        passed = true;
    });
    assert.equal(passed, true);
});

test('admin password reset revokes target refresh tokens', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`admin_reset_${suffix}`, 'old-hash', 'Admin Reset Test', 'QA', 'user', 'active');
    db.prepare(`
        INSERT INTO refresh_tokens (user_id, token, expires_at, created_at)
        VALUES (?, ?, datetime('now', '+8 hours', '+7 days'), datetime('now', '+8 hours'))
    `).run(userInfo.lastInsertRowid, `admin-reset-refresh-${suffix}`);

    const router = createAdminUsersRouter({
        authMiddleware: (req, res, next) => {
            req.user = { id: 1, username: 'admin', role: 'admin' };
            next();
        },
        adminMiddleware: (req, res, next) => next(),
        upload: { single: () => (req, res, next) => next() },
        logAction: () => {}
    });
    const passwordRoute = router.stack.find(layer => layer.route?.path === '/admin/users/:id/password');
    assert.ok(passwordRoute);
    const req = {
        params: { id: String(userInfo.lastInsertRowid) },
        body: { password: 'NewPassword123' }
    };
    let statusCode = 200;
    let payload = null;
    const res = {
        status(code) {
            statusCode = code;
            return this;
        },
        json(data) {
            payload = data;
            return this;
        }
    };
    const handlers = passwordRoute.route.stack.map(item => item.handle);

    try {
        await handlers[0](req, res, err => { if (err) throw err; });
        await handlers[1](req, res, err => { if (err) throw err; });
        await new Promise((resolve, reject) => {
            const originalJson = res.json.bind(res);
            res.json = (data) => {
                originalJson(data);
                resolve();
                return res;
            };
            handlers[2](req, res, reject);
        });
        assert.equal(statusCode, 200);
        assert.equal(payload.success, true);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM refresh_tokens WHERE user_id = ?').get(userInfo.lastInsertRowid).count, 0);
        assert.notEqual(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userInfo.lastInsertRowid).password_hash, 'old-hash');
    } finally {
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(userInfo.lastInsertRowid);
    }
});

test('model probe routes authenticate before rate limiting', () => {
    const router = createModelsRouter({
        authMiddleware: (req, res, next) => next(),
        probeLimiter: (req, res, next) => next(),
        logAction: () => {},
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100)
    });
    for (const pathName of ['/models/fetch-remote', '/models/test']) {
        const route = router.stack.find(layer => layer.route?.path === pathName);
        assert.ok(route, `${pathName} route should exist`);
        const handlers = route.route.stack.map(item => item.handle);
        assert.equal(handlers[0].name, 'authMiddleware');
        assert.equal(handlers[1].name, 'probeLimiter');
    }
});

test('non-root admin creates private chat models and cannot delete global models', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`model_admin_${suffix}`, 'hash', 'Model Admin', 'QA', 'admin', 'active');
    const adminUser = { id: Number(userInfo.lastInsertRowid), username: `model_admin_${suffix}`, role: 'admin', unit: 'QA' };
    const globalInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, model_name, created_at)
        VALUES (NULL, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`Global ${suffix}`, 'https://global-model.example/v1', 'global-chat');

    const router = createModelsRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        probeLimiter: (_req, _res, next) => next(),
        logAction: () => {},
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100)
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/models' && layer.route?.methods?.post);
    const deleteRoute = router.stack.find(layer => layer.route?.path === '/models/:id' && layer.route?.methods?.delete);
    const listRoute = router.stack.find(layer => layer.route?.path === '/models' && layer.route?.methods?.get);
    assert.ok(createRoute);
    assert.ok(deleteRoute);
    assert.ok(listRoute);

    try {
        const createReq = {
            body: {
                name: `Private ${suffix}`,
                url: 'https://private-model.example/v1',
                model_name: 'private-chat',
                scope: 'global',
                allowed_units: 'ALL'
            },
            user: adminUser
        };
        const createRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), createReq, createRes);
        assert.equal(createRes.statusCode, 200);
        const privateModel = db.prepare('SELECT * FROM models WHERE name = ?').get(`Private ${suffix}`);
        assert.equal(privateModel.user_id, adminUser.id);
        assert.equal(privateModel.allowed_units || '', '');

        const deleteReq = { params: { id: String(globalInfo.lastInsertRowid) }, user: adminUser };
        const deleteRes = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(deleteRoute.route.stack.map(layer => layer.handle), deleteReq, deleteRes);
        assert.equal(deleteRes.statusCode, 403);

        const listReq = { query: { page: '1', limit: '20' }, user: adminUser };
        const listRes = {
            json(body) { this.body = body; return this; }
        };
        await runExpressHandlers(listRoute.route.stack.map(layer => layer.handle), listReq, listRes);
        assert.equal(listRes.body.data.some(model => model.id === globalInfo.lastInsertRowid), true);
        assert.equal(listRes.body.data.some(model => model.id === privateModel.id), true);
    } finally {
        db.prepare('DELETE FROM models WHERE name IN (?, ?)').run(`Global ${suffix}`, `Private ${suffix}`);
        db.prepare('DELETE FROM users WHERE id = ?').run(adminUser.id);
    }
});

test('visible global models can be tested by admins but not regular users', async () => {
    const suffix = Date.now().toString(36);
    const axios = require('axios');
    const originalGet = axios.get;
    const adminInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`global_test_admin_${suffix}`, 'hash', 'Global Test Admin', 'QA', 'admin', 'active');
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`global_test_user_${suffix}`, 'hash', 'Global Test User', 'OPS', 'user', 'active');
    const adminUser = { id: Number(adminInfo.lastInsertRowid), username: `global_test_admin_${suffix}`, role: 'admin', unit: 'QA' };
    const normalUser = { id: Number(userInfo.lastInsertRowid), username: `global_test_user_${suffix}`, role: 'user', unit: 'OPS' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, api_key, model_name, allowed_units, created_at)
        VALUES (NULL, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`Visible Global ${suffix}`, 'https://192.0.2.20/v1', encryptSecret(`global-secret-${suffix}`), 'global-visible-chat', 'OPS');

    const makeRouter = user => createModelsRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        probeLimiter: (_req, _res, next) => next(),
        logAction: () => {},
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100)
    });
    const makeRes = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });

    try {
        const seenAuthHeaders = [];
        axios.get = async (_url, options = {}) => {
            seenAuthHeaders.push(options.headers?.Authorization || '');
            return { data: { data: [{ id: 'global-visible-chat' }] }, status: 200 };
        };

        const adminRouter = makeRouter(adminUser);
        const adminTestRoute = adminRouter.stack.find(layer => layer.route?.path === '/models/test');
        const adminTestRes = makeRes();
        await runExpressHandlers(adminTestRoute.route.stack.map(layer => layer.handle), {
            body: { id: String(modelInfo.lastInsertRowid), source: 'manual' },
            user: adminUser,
            log: { debug() {}, info() {}, error() {}, warn() {} }
        }, adminTestRes);
        assert.equal(adminTestRes.statusCode, 200);
        assert.equal(adminTestRes.body.success, true);

        const userRouter = makeRouter(normalUser);
        const userTestRoute = userRouter.stack.find(layer => layer.route?.path === '/models/test');
        const userTestRes = makeRes();
        await runExpressHandlers(userTestRoute.route.stack.map(layer => layer.handle), {
            body: { id: String(modelInfo.lastInsertRowid), source: 'manual' },
            user: normalUser,
            log: { debug() {}, info() {}, error() {}, warn() {} }
        }, userTestRes);
        assert.equal(userTestRes.statusCode, 403);

        assert.deepEqual(seenAuthHeaders, [
            `Bearer global-secret-${suffix}`
        ]);

        const keyRoute = userRouter.stack.find(layer => layer.route?.path === '/models/:id/key');
        const keyRes = makeRes();
        await runExpressHandlers(keyRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(modelInfo.lastInsertRowid) },
            body: { password: 'irrelevant' },
            user: normalUser
        }, keyRes);
        assert.equal(keyRes.statusCode, 403);
    } finally {
        axios.get = originalGet;
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(adminUser.id, normalUser.id);
    }
});

test('model ownership boundaries protect personal model secrets from admins', async () => {
    const suffix = Date.now().toString(36);
    const password = 'Password123';
    const passwordHash = require('bcryptjs').hashSync(password, 4);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`model_owner_${suffix}`, passwordHash, 'Model Owner', 'QA', 'user', 'active');
    const owner = { id: Number(userInfo.lastInsertRowid), username: `model_owner_${suffix}`, role: 'user', unit: 'QA' };
    const superAdmin = { id: 1, username: 'admin', role: 'admin', unit: '' };
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, api_key, model_name, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(owner.id, `Owner Private ${suffix}`, 'https://owner-model.example/v1', encryptSecret(`secret-${suffix}`), 'owner-chat');

    const makeRouter = user => createModelsRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        probeLimiter: (_req, _res, next) => next(),
        logAction: () => {},
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100)
    });
    const makeRes = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });

    try {
        const superRouter = makeRouter(superAdmin);
        const deleteRoute = superRouter.stack.find(layer => layer.route?.path === '/models/:id' && layer.route?.methods?.delete);
        const keyRoute = superRouter.stack.find(layer => layer.route?.path === '/models/:id/key');
        const updateRoute = superRouter.stack.find(layer => layer.route?.path === '/models/:id' && layer.route?.methods?.put);
        const testRoute = superRouter.stack.find(layer => layer.route?.path === '/models/test');

        const keyRes = makeRes();
        await runExpressHandlers(keyRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(modelInfo.lastInsertRowid) },
            body: { password },
            user: superAdmin
        }, keyRes);
        assert.equal(keyRes.statusCode, 403);

        const deleteRes = makeRes();
        await runExpressHandlers(deleteRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(modelInfo.lastInsertRowid) },
            user: superAdmin
        }, deleteRes);
        assert.equal(deleteRes.statusCode, 403);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM models WHERE id = ?').get(modelInfo.lastInsertRowid).count, 1);

        const updateRes = makeRes();
        await runExpressHandlers(updateRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(modelInfo.lastInsertRowid) },
            body: {
                name: `Updated ${suffix}`,
                url: 'https://owner-model.example/v1',
                model_name: 'owner-chat',
                api_key: '********'
            },
            user: superAdmin
        }, updateRes);
        assert.equal(updateRes.statusCode, 403);

        const testRes = makeRes();
        await runExpressHandlers(testRoute.route.stack.map(layer => layer.handle), {
            body: { id: String(modelInfo.lastInsertRowid), source: 'manual' },
            user: superAdmin,
            log: { debug() {}, info() {}, error() {}, warn() {} }
        }, testRes);
        assert.equal(testRes.statusCode, 403);

        const ownerRouter = makeRouter(owner);
        const ownerKeyRoute = ownerRouter.stack.find(layer => layer.route?.path === '/models/:id/key');
        const ownerKeyRes = makeRes();
        await runExpressHandlers(ownerKeyRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(modelInfo.lastInsertRowid) },
            body: { password },
            user: owner
        }, ownerKeyRes);
        assert.equal(ownerKeyRes.statusCode, 200);
        assert.equal(ownerKeyRes.body.key, `secret-${suffix}`);
    } finally {
        db.prepare('DELETE FROM models WHERE id = ?').run(modelInfo.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(owner.id);
    }
});

test('model deletion soft deletes referenced models without breaking history', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`model_delete_${suffix}`, 'hash', 'Model Delete Owner', 'QA', 'admin', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `model_delete_${suffix}`, role: 'admin', unit: 'QA' };
    const sessionId = `model-delete-${suffix}`;
    const modelInfo = db.prepare(`
        INSERT INTO models (user_id, name, url, api_key, model_name, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(user.id, `Delete Referenced ${suffix}`, 'https://delete-model.example/v1', encryptSecret(`secret-${suffix}`), 'delete-chat');
    const modelId = Number(modelInfo.lastInsertRowid);
    const router = createModelsRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        probeLimiter: (_req, _res, next) => next(),
        logAction: () => {},
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100)
    });
    const deleteRoute = router.stack.find(layer => layer.route?.path === '/models/:id' && layer.route?.methods?.delete);
    const makeRes = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });
    try {
        db.prepare('INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime(\'now\', \'+8 hours\'), datetime(\'now\', \'+8 hours\'))')
            .run(sessionId, user.id, 'Referenced model session');
        db.prepare('INSERT INTO messages (session_id, user_id, role, content, model_id, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\', \'+8 hours\'))')
            .run(sessionId, user.id, 'assistant', 'history keeps model id', modelId);
        db.prepare('UPDATE users SET default_model_id = ? WHERE id = ?').run(modelId, user.id);

        const res = makeRes();
        await runExpressHandlers(deleteRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(modelId) },
            user
        }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        const model = db.prepare('SELECT status, is_default FROM models WHERE id = ?').get(modelId);
        assert.equal(model.status, 'deleted');
        assert.equal(model.is_default, 0);
        assert.equal(db.prepare('SELECT default_model_id FROM users WHERE id = ?').get(user.id).default_model_id, null);
        assert.equal(db.prepare('SELECT model_id FROM messages WHERE session_id = ?').get(sessionId).model_id, modelId);
    } finally {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        db.prepare('DELETE FROM models WHERE id = ?').run(modelId);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('deleting a user releases the username without reviving the old identity', async () => {
    const suffix = Date.now().toString(36);
    const username = `reuse_${suffix}`;
    const oldUserInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'old-hash', 'Old Identity', 'QA', 'user', 'active', datetime('now', '+8 hours'))
    `).run(username);
    const oldUserId = Number(oldUserInfo.lastInsertRowid);
    db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)')
        .run(oldUserId, 'identity_marker', 'old');

    const superAdmin = { id: 1, username: 'admin', role: 'admin', unit: '' };
    const router = createAdminUsersRouter({
        authMiddleware: (req, _res, next) => { req.user = superAdmin; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        upload: { single: () => (_req, _res, next) => next() },
        logAction: () => {}
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/admin/users' && layer.route?.methods?.post);
    const listRoute = router.stack.find(layer => layer.route?.path === '/admin/users' && layer.route?.methods?.get);
    const deleteRoute = router.stack.find(layer => layer.route?.path === '/admin/users/:id' && layer.route?.methods?.delete);
    const makeRes = () => ({
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    });

    let newUserId;
    try {
        const deleteRes = makeRes();
        await runExpressHandlers(deleteRoute.route.stack.map(layer => layer.handle), {
            params: { id: String(oldUserId) }
        }, deleteRes);
        assert.equal(deleteRes.statusCode, 200);
        assert.equal(deleteRes.body.success, true);

        const archived = db.prepare('SELECT username, deleted_username, deleted_at FROM users WHERE id = ?').get(oldUserId);
        assert.match(archived.username, /^@deleted:/);
        assert.equal(archived.deleted_username, username);
        assert.ok(archived.deleted_at);

        const createRes = makeRes();
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), {
            body: { username, password: 'Password123', nickname: 'New Identity', unit: 'QA', role: 'user' }
        }, createRes);
        assert.equal(createRes.statusCode, 200);
        assert.equal(createRes.body.success, true);
        newUserId = Number(createRes.body.user.id);
        assert.notEqual(newUserId, oldUserId);

        const active = db.prepare('SELECT id, username, deleted_at FROM users WHERE username = ?').get(username);
        assert.equal(active.id, newUserId);
        assert.equal(active.deleted_at, null);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_settings WHERE user_id = ?').get(newUserId).count, 0);

        const listRes = makeRes();
        await runExpressHandlers(listRoute.route.stack.map(layer => layer.handle), {
            query: { includeDeleted: 'true', limit: '10000' }
        }, listRes);
        const matchingUsers = listRes.body.data.filter(user => user.username === username);
        assert.equal(matchingUsers.length, 2);
        assert.deepEqual(new Set(matchingUsers.map(user => Number(user.id))), new Set([oldUserId, newUserId]));
    } finally {
        if (newUserId) db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(newUserId);
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(oldUserId);
        if (newUserId) db.prepare('DELETE FROM users WHERE id = ?').run(newUserId);
        db.prepare('DELETE FROM users WHERE id = ?').run(oldUserId);
    }
});

test('non-root admin cannot manage administrator accounts', async () => {
    const suffix = Date.now().toString(36);
    const adminInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`limited_admin_${suffix}`, 'hash', 'Limited Admin', 'QA', 'admin', 'active');
    const targetInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`target_admin_${suffix}`, 'hash', 'Target Admin', 'QA', 'admin', 'active');
    const adminUser = { id: Number(adminInfo.lastInsertRowid), username: `limited_admin_${suffix}`, role: 'admin', unit: 'QA' };
    const router = createAdminUsersRouter({
        authMiddleware: (req, _res, next) => { req.user = adminUser; next(); },
        adminMiddleware: (_req, _res, next) => next(),
        upload: { single: () => (_req, _res, next) => next() },
        logAction: () => {}
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/admin/users' && layer.route?.methods?.post);
    const updateRoute = router.stack.find(layer => layer.route?.path === '/admin/users/:id' && layer.route?.methods?.put);
    const deleteRoute = router.stack.find(layer => layer.route?.path === '/admin/users/:id' && layer.route?.methods?.delete);

    try {
        const createReq = {
            body: { username: `new_admin_${suffix}`, password: 'Password123', nickname: 'New Admin', unit: 'QA', role: 'admin' },
            user: adminUser
        };
        const createRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), createReq, createRes);
        assert.equal(createRes.statusCode, 403);

        const updateReq = {
            params: { id: String(targetInfo.lastInsertRowid) },
            body: { nickname: 'Changed', unit: 'QA', role: 'user', status: 'active' },
            user: adminUser
        };
        const updateRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(updateRoute.route.stack.map(layer => layer.handle), updateReq, updateRes);
        assert.equal(updateRes.statusCode, 403);

        const deleteReq = { params: { id: String(targetInfo.lastInsertRowid) }, user: adminUser };
        const deleteRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(deleteRoute.route.stack.map(layer => layer.handle), deleteReq, deleteRes);
        assert.equal(deleteRes.statusCode, 403);
    } finally {
        db.prepare('DELETE FROM users WHERE username IN (?, ?, ?)').run(`limited_admin_${suffix}`, `target_admin_${suffix}`, `new_admin_${suffix}`);
    }
});

test('session tag summary and batch operations are scoped to current user', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`tag_user_${suffix}`, 'hash', 'Tag User', 'QA', 'user', 'active');
    const otherInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`tag_other_${suffix}`, 'hash', 'Other User', 'QA', 'user', 'active');
    const userId = Number(userInfo.lastInsertRowid);
    const otherId = Number(otherInfo.lastInsertRowid);
    const sessionA = `tag-a-${suffix}`;
    const sessionB = `tag-b-${suffix}`;
    const sessionOther = `tag-other-${suffix}`;
    db.prepare('INSERT INTO sessions (id, user_id, title, tags, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\', \'+8 hours\'), datetime(\'now\', \'+8 hours\'))')
        .run(sessionA, userId, 'Tag A', 'alpha,beta');
    db.prepare('INSERT INTO sessions (id, user_id, title, tags, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\', \'+8 hours\'), datetime(\'now\', \'+8 hours\'))')
        .run(sessionB, userId, 'Tag B', 'beta');
    db.prepare('INSERT INTO sessions (id, user_id, title, tags, created_at, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\', \'+8 hours\'), datetime(\'now\', \'+8 hours\'))')
        .run(sessionOther, otherId, 'Other', 'alpha');

    const currentUser = { id: userId, username: `tag_user_${suffix}`, role: 'user', unit: 'QA' };
    const router = createSessionsRouter({
        authMiddleware: (req, _res, next) => { req.user = currentUser; next(); },
        normalizePage: value => Math.max(parseInt(value, 10) || 1, 1),
        normalizeLimit: value => Math.min(Math.max(parseInt(value, 10) || 20, 1), 100),
        logAction: () => {}
    });
    const summaryRoute = router.stack.find(layer => layer.route?.path === '/sessions/tags/summary');
    const batchRoute = router.stack.find(layer => layer.route?.path === '/sessions/tags/batch');
    const renameRoute = router.stack.find(layer => layer.route?.path === '/sessions/tags/rename');

    try {
        const summaryReq = { query: {}, user: currentUser };
        const summaryRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(summaryRoute.route.stack.map(layer => layer.handle), summaryReq, summaryRes);
        assert.equal(summaryRes.statusCode, 200);
        const alpha = summaryRes.body.data.find(item => item.tag === 'alpha');
        assert.equal(alpha.count, 1);

        const batchReq = {
            body: { sessionIds: [sessionA, sessionB, sessionOther], operation: 'add', tags: 'gamma' },
            user: currentUser
        };
        const batchRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(batchRoute.route.stack.map(layer => layer.handle), batchReq, batchRes);
        assert.equal(batchRes.body.affected, 2);
        assert.match(db.prepare('SELECT tags FROM sessions WHERE id = ?').get(sessionA).tags, /gamma/);
        assert.doesNotMatch(db.prepare('SELECT tags FROM sessions WHERE id = ?').get(sessionOther).tags, /gamma/);

        const renameReq = { body: { fromTag: 'gamma', toTag: 'delta' }, user: currentUser };
        const renameRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await runExpressHandlers(renameRoute.route.stack.map(layer => layer.handle), renameReq, renameRes);
        assert.equal(renameRes.body.affected, 2);
        assert.match(db.prepare('SELECT tags FROM sessions WHERE id = ?').get(sessionB).tags, /delta/);
    } finally {
        db.prepare('DELETE FROM sessions WHERE id IN (?, ?, ?)').run(sessionA, sessionB, sessionOther);
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(userId, otherId);
    }
});

test('api access disabled blocks api key creation', async () => {
    const suffix = Date.now().toString(36);
    const userInfo = db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+8 hours'))
    `).run(`api_key_user_${suffix}`, 'hash', 'API Key User', 'QA', 'user', 'active');
    const user = { id: Number(userInfo.lastInsertRowid), username: `api_key_user_${suffix}`, role: 'user', unit: 'QA' };
    const previousRow = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get('api_access_enabled');
    const previousValue = getApiAccessSetting();
    const router = createAuthRouter({
        authMiddleware: (req, _res, next) => { req.user = user; next(); },
        loginLimiter: (_req, _res, next) => next(),
        isPublicRegistrationEnabled: () => true,
        logAction: () => {},
        publicUrl: 'http://localhost'
    });
    const createRoute = router.stack.find(layer => layer.route?.path === '/auth/keys' && layer.route?.methods?.post);
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };

    try {
        await setApiAccessSetting(false, user.id);
        await runExpressHandlers(createRoute.route.stack.map(layer => layer.handle), {
            body: { name: 'blocked-key' },
            user
        }, res);
        assert.equal(res.statusCode, 403);
        assert.match(res.body.error, /API/);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ?').get(user.id).count, 0);
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
        db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        assert.equal(getApiAccessSetting(), previousValue);
    }
});

test('uploadSecurityMiddleware rejects mismatched magic bytes and removes the file', async () => {
    const { createKnowledgeUploadMiddleware, createUploadMiddleware, uploadSecurityMiddleware } = require('../server/upload');
    assert.equal(typeof createUploadMiddleware().single('file'), 'function');
    assert.equal(typeof createKnowledgeUploadMiddleware().single('file'), 'function');

    const badPath = path.join(uploadRoot, `bad-magic-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(badPath), { recursive: true });
    fs.writeFileSync(badPath, Buffer.from('not a real png'));
    const req = { file: { path: badPath, originalname: 'bad.png' }, files: {} };
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    let nextCalled = false;
    uploadSecurityMiddleware(req, res, () => { nextCalled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /文件内容/);
    assert.equal(fs.existsSync(badPath), false);
});
test('refresh tokens are hashed at rest and rotated once', async () => {
    const { hashRefreshToken, login, refreshTokens, register } = require('../server/auth');
    const suffix = Date.now().toString(36);
    const username = `refresh_hash_${suffix}`;
    const password = 'Pivot-Test-123!';
    const user = await register(username, password, 'Refresh Token Test', 'QA');
    try {
        const signedIn = await login(username, password);
        const stored = db.prepare('SELECT token FROM refresh_tokens WHERE user_id = ?').get(user.id);
        assert.ok(stored);
        assert.equal(stored.token, hashRefreshToken(signedIn.refreshToken));
        assert.notEqual(stored.token, signedIn.refreshToken);

        const rotated = await refreshTokens(signedIn.refreshToken);
        assert.equal(db.prepare('SELECT token FROM refresh_tokens WHERE token = ?').get(hashRefreshToken(signedIn.refreshToken)), undefined);
        assert.ok(db.prepare('SELECT token FROM refresh_tokens WHERE token = ?').get(hashRefreshToken(rotated.refreshToken)));
        await assert.rejects(() => refreshTokens(signedIn.refreshToken), /refresh|token|令牌/i);

        const concurrentSession = await login(username, password);
        const concurrent = await Promise.allSettled([
            refreshTokens(concurrentSession.refreshToken),
            refreshTokens(concurrentSession.refreshToken)
        ]);
        assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(concurrent.filter(item => item.status === 'rejected').length, 1);
    } finally {
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
});

test('metrics requires a bearer token unless LAN anonymous access is explicit', () => {
    const { metricsAuthMiddleware } = require('../server/metrics');
    const previousToken = process.env.METRICS_TOKEN;
    const previousLanFlag = process.env.METRICS_ALLOW_UNAUTHENTICATED_LAN;
    const run = (req) => {
        let nextCalled = false;
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            type() { return this; },
            send(body) { this.body = body; return this; }
        };
        metricsAuthMiddleware(req, res, () => { nextCalled = true; });
        return { nextCalled, res };
    };

    try {
        process.env.METRICS_TOKEN = 'metrics-test-token';
        delete process.env.METRICS_ALLOW_UNAUTHENTICATED_LAN;
        assert.equal(run({ headers: {}, query: { token: 'metrics-test-token' } }).res.statusCode, 401);
        assert.equal(run({ headers: { authorization: 'Bearer metrics-test-token' }, query: {} }).nextCalled, true);

        delete process.env.METRICS_TOKEN;
        assert.equal(run({ headers: {}, query: {} }).res.statusCode, 503);
        process.env.METRICS_ALLOW_UNAUTHENTICATED_LAN = 'true';
        assert.equal(run({ headers: {}, query: {} }).nextCalled, true);
    } finally {
        if (previousToken === undefined) delete process.env.METRICS_TOKEN;
        else process.env.METRICS_TOKEN = previousToken;
        if (previousLanFlag === undefined) delete process.env.METRICS_ALLOW_UNAUTHENTICATED_LAN;
        else process.env.METRICS_ALLOW_UNAUTHENTICATED_LAN = previousLanFlag;
    }
});
