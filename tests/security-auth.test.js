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
    getPermissionLabel,
    getPermissionTier,
    http,
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
    toProjectRelativePath,
    uploadRoot,
    withPermissionFlags
} = require('./security-helpers');

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

test('outbound URL guard blocks sensitive SSRF targets', async () => {
    assert.equal(isSensitiveOutboundHost('127.0.0.1'), true);
    assert.equal(isSensitiveOutboundHost('169.254.169.254'), true);
    assert.equal(isSensitiveOutboundHost('metadata.google.internal'), true);
    assert.equal(isSensitiveOutboundHost('192.168.1.10'), false);

    await assert.rejects(
        assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data', { role: 'admin' }),
        /sensitive local|metadata target/
    );
    await assert.rejects(
        assertSafeOutboundUrl('http://localhost:11434/v1', { role: 'admin' }),
        /sensitive local|metadata target/
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
        /sensitive local|metadata target/
    );
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

test('visible global models can be tested by admins and users without exposing ownership controls', async () => {
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
    `).run(`Visible Global ${suffix}`, 'https://global-visible.example/v1', encryptSecret(`global-secret-${suffix}`), 'global-visible-chat', 'OPS');

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

        for (const user of [adminUser, normalUser]) {
            const router = makeRouter(user);
            const testRoute = router.stack.find(layer => layer.route?.path === '/models/test');
            const res = makeRes();
            await runExpressHandlers(testRoute.route.stack.map(layer => layer.handle), {
                body: { id: String(modelInfo.lastInsertRowid), source: 'manual' },
                user,
                log: { debug() {}, info() {}, error() {}, warn() {} }
            }, res);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.success, true);
        }

        assert.deepEqual(seenAuthHeaders, [
            `Bearer global-secret-${suffix}`,
            `Bearer global-secret-${suffix}`
        ]);

        const userRouter = makeRouter(normalUser);
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
