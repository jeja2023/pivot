const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
require('../server/db');
const {
    generateStealthSignature,
    getStealthConfig,
    isStealthModeEnabled,
    verifyStealthRequest
} = require('../server/services/stealth-service');
const { stealthAccessGuard } = require('../server/middleware/stealth-guard');
const { createSettingsRouter } = require('../server/routes/settings');

test('Stealth Service: 基础签名生成与时钟校验', async () => {
    const secret = 'test-secret-key-1234567890abcdef';
    const now = Date.now();
    const token = generateStealthSignature(now, secret);
    assert.ok(typeof token === 'string' && token.length === 64, 'HMAC-SHA256 应生成 64 字符十六进制签名');

    // 伪造 request 对象进行校验
    process.env.PIVOT_STEALTH_MODE = 'true';
    process.env.PIVOT_STEALTH_SECRET = secret;

    try {
        // 合法请求
        const validReq = {
            headers: {
                'x-pivot-stealth-time': String(now),
                'x-pivot-stealth-token': token
            }
        };
        assert.equal(verifyStealthRequest(validReq), true, '合法签名与有效时间戳应校验通过');

        // 篡改签名
        const forgedReq = {
            headers: {
                'x-pivot-stealth-time': String(now),
                'x-pivot-stealth-token': 'a'.repeat(64)
            }
        };
        assert.equal(verifyStealthRequest(forgedReq), false, '篡改签名应校验失败');

        // 超时重放请求（超过 120 秒）
        const expiredReq = {
            headers: {
                'x-pivot-stealth-time': String(now - 150000),
                'x-pivot-stealth-token': generateStealthSignature(now - 150000, secret)
            }
        };
        assert.equal(verifyStealthRequest(expiredReq), false, '超过 120 秒的时间戳应被防重放机制拦截');

        // 未携带任何 Header 的普通探测
        const probeReq = {
            headers: {}
        };
        assert.equal(verifyStealthRequest(probeReq), false, '未携带隐身签名的请求应直接拒绝');
    } finally {
        delete process.env.PIVOT_STEALTH_MODE;
        delete process.env.PIVOT_STEALTH_SECRET;
    }
});

test('Stealth Service: 环境变量覆盖与配置管理', async () => {
    delete process.env.PIVOT_STEALTH_MODE;
    delete process.env.PIVOT_STEALTH_SECRET;

    const initialConfig = await getStealthConfig();
    assert.ok(typeof initialConfig.secret === 'string' && initialConfig.secret.length >= 16);

    // 环境变量强制开启
    process.env.PIVOT_STEALTH_MODE = 'true';
    assert.equal(isStealthModeEnabled(), true);
    const envConfig = await getStealthConfig();
    assert.equal(envConfig.envOverridden, true);
    assert.equal(envConfig.enabled, true);

    // 环境变量强制关闭（应急恢复）
    process.env.PIVOT_STEALTH_MODE = 'false';
    assert.equal(isStealthModeEnabled(), false);

    delete process.env.PIVOT_STEALTH_MODE;
});

test('Stealth Middleware: 未授权连接物理掐断 (Socket Destroy)', async () => {
    const secret = 'stealth-test-secret-9876543210fedcba';
    process.env.PIVOT_STEALTH_SECRET = secret;
    process.env.PIVOT_STEALTH_MODE = 'true';

    const app = express();
    app.use(stealthAccessGuard);
    app.get('/test-ping', (req, res) => {
        res.json({ ok: true });
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
        // 1. 发起未携带签名的探测请求 -> 预期 TCP 连接被掐断 (ECONNRESET 或 socket hang up)
        await new Promise((resolve) => {
            const req = http.get(`http://127.0.0.1:${port}/test-ping`, () => {
                assert.fail('未授权请求不应收到任何 HTTP 响应');
            });
            req.on('error', (err) => {
                assert.ok(
                    err.code === 'ECONNRESET' || err.message.includes('socket hang up'),
                    `TCP Socket 应被直接掐断，当前错误: ${err.message}`
                );
                resolve();
            });
        });

        // 2. 发起携带合法客户端签名的请求 -> 预期正常返回 200 OK
        const now = Date.now();
        const token = generateStealthSignature(now, secret);
        const responseData = await new Promise((resolve, reject) => {
            const req = http.get({
                hostname: '127.0.0.1',
                port,
                path: '/test-ping',
                headers: {
                    'X-Pivot-Stealth-Time': String(now),
                    'X-Pivot-Stealth-Token': token
                }
            }, (res) => {
                assert.equal(res.statusCode, 200);
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => resolve(JSON.parse(body)));
            });
            req.on('error', reject);
        });

        assert.deepEqual(responseData, { ok: true }, '携带合法桌面端签名的请求应放行');
    } finally {
        delete process.env.PIVOT_STEALTH_MODE;
        delete process.env.PIVOT_STEALTH_SECRET;
        server.close();
    }
});

test('Stealth Routes: API 权限与配置修改', async () => {
    const router = createSettingsRouter({
        authMiddleware: (req, res, next) => {
            req.user = { id: 1, role: 'admin' };
            next();
        },
        adminMiddleware: (req, res, next) => next(),
        logAction: () => {}
    });

    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
        // GET /api/settings/stealth
        const getRes = await fetch(`http://127.0.0.1:${port}/api/settings/stealth`);
        assert.equal(getRes.status, 200);
        const getData = await getRes.json();
        assert.equal(getData.success, true);
        assert.ok(typeof getData.secret === 'string');

        // PUT /api/settings/stealth
        const putRes = await fetch(`http://127.0.0.1:${port}/api/settings/stealth`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false })
        });
        assert.equal(putRes.status, 200);
        const putData = await putRes.json();
        assert.equal(putData.success, true);
        assert.equal(putData.enabled, false);
    } finally {
        server.close();
    }
});
