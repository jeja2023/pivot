const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkWritableDirectory } = require('../server/services/system-health');

test('可写性探针使用固定文件名，不再随调用次数堆积残留文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-probe-'));
    try {
        for (let i = 0; i < 20; i += 1) {
            assert.equal((await checkWritableDirectory('data', dir)).status, 'ok');
        }
        assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('历史遗留的 pid-时间戳 探针文件会被异步清理，业务文件不受影响', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-probe-legacy-'));
    try {
        fs.writeFileSync(path.join(dir, '.pivot-health-18232-1780893927962.tmp'), 'ok');
        fs.writeFileSync(path.join(dir, '.pivot-health-25876-1781077307281.tmp'), 'ok');
        fs.writeFileSync(path.join(dir, 'chat.db'), 'data');
        assert.equal((await checkWritableDirectory('data', dir)).status, 'ok');
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            if (fs.readdirSync(dir).length === 1) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.deepEqual(fs.readdirSync(dir), ['chat.db']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('运行时诊断快照同时给出事件循环、连接池、在途请求与堆占用', () => {
    const { getRuntimeDiagnostics } = require('../server/services/runtime-diagnostics');
    const snapshot = getRuntimeDiagnostics();
    assert.ok(['ok', 'degraded'].includes(snapshot.status));
    assert.equal(typeof snapshot.eventLoop.p99Ms, 'number');
    assert.equal(typeof snapshot.pgPool.max, 'number');
    assert.equal(typeof snapshot.requests.current, 'number');
    assert.equal(typeof snapshot.heap.usedRatio, 'number');
});

test('连接池快照不会因为观测动作而懒初始化连接池', () => {
    const { getPgPoolSnapshot } = require('../server/services/runtime-diagnostics');
    const { peekPgPool } = require('../server/db/pg-connection');
    const before = peekPgPool();
    getPgPoolSnapshot();
    assert.equal(peekPgPool(), before);
});

test('在途请求中间件在响应结束后归零', () => {
    const { inFlightRequestMiddleware, getInFlightRequestSnapshot } = require('../server/services/runtime-diagnostics');
    const listeners = new Map();
    const res = {
        once(event, handler) { listeners.set(event, handler); return this; }
    };
    const base = getInFlightRequestSnapshot().current;
    let nextCalled = false;
    inFlightRequestMiddleware({ method: 'GET', path: '/api/settings' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(getInFlightRequestSnapshot().current, base + 1);
    assert.ok(getInFlightRequestSnapshot().routes.some(item => item.route === 'GET /api/settings'));
    listeners.get('finish')();
    assert.equal(getInFlightRequestSnapshot().current, base);
    // 同一请求的 finish + close 双触发只能扣减一次
    listeners.get('close')();
    assert.equal(getInFlightRequestSnapshot().current, base);
});

test('接口路径判定：静态文件探测与悬挂兜底共用同一套前缀规则', () => {
    const { isApiRequestPath } = require('../server/http');
    assert.equal(isApiRequestPath('/api'), true);
    assert.equal(isApiRequestPath('/api/settings'), true);
    assert.equal(isApiRequestPath('/v1'), true);
    assert.equal(isApiRequestPath('/v1/chat/completions'), true);
    // 页面、静态资源与下载目录仍然要走静态中间件
    assert.equal(isApiRequestPath('/chat'), false);
    assert.equal(isApiRequestPath('/chat/config.js'), false);
    assert.equal(isApiRequestPath('/downloads/Pivot-Setup.exe'), false);
    // 前缀相近但不属于接口链路，不能误判
    assert.equal(isApiRequestPath('/apidocs'), false);
    assert.equal(isApiRequestPath('/v10/models'), false);
    assert.equal(isApiRequestPath(''), false);
    assert.equal(isApiRequestPath(undefined), false);
});

test('接口兜底只看管 /api、/v1 的 GET，且放行 SSE、长轮询与导出下载', () => {
    const { shouldWatchRequest } = require('../server/services/runtime-diagnostics');
    const watch = (method, requestPath) => shouldWatchRequest({ method, path: requestPath }, 20000);
    assert.equal(watch('GET', '/api/settings'), true);
    assert.equal(watch('GET', '/v1/models'), true);
    assert.equal(watch('GET', '/api/stats/monitor-summary'), true);
    // 写操作可能是上传或模型生成，耗时天然更长，不介入
    assert.equal(watch('POST', '/api/chat'), false);
    // 页面与静态资源不属于接口链路
    assert.equal(watch('GET', '/chat'), false);
    // 长连接与长耗时下载显式放行
    assert.equal(watch('GET', '/api/events'), false);
    assert.equal(watch('GET', '/api/mcp/local-device/tasks/next'), false);
    assert.equal(watch('GET', '/api/stats/report/export'), false);
    assert.equal(watch('GET', '/api/attachments/123/download'), false);
    // 显式关闭时不生效
    assert.equal(shouldWatchRequest({ method: 'GET', path: '/api/settings' }, 0), false);
});

test('接口悬挂超过阈值后主动返回 503 并带上诊断信息', async () => {
    const previous = process.env.API_REQUEST_WATCHDOG_MS;
    process.env.API_REQUEST_WATCHDOG_MS = '40';
    try {
        const { apiRequestWatchdog } = require('../server/services/runtime-diagnostics');
        const listeners = new Map();
        let statusCode = 0;
        let body = null;
        const res = {
            headersSent: false,
            writableEnded: false,
            locals: {},
            once(event, handler) { listeners.set(event, handler); return this; },
            status(code) { statusCode = code; return this; },
            json(payload) { body = payload; this.headersSent = true; return this; }
        };
        const logs = [];
        const req = { method: 'GET', path: '/api/settings', originalUrl: '/api/settings', log: { error: (payload, msg) => logs.push(msg) } };
        // 模拟 handler 永不返回：什么都不做，等兜底触发
        apiRequestWatchdog(req, res, () => {});
        await new Promise(resolve => setTimeout(resolve, 160));
        assert.equal(statusCode, 503);
        assert.equal(body.code, 'SERVER_BUSY_TIMEOUT');
        assert.equal(typeof body.diagnostics.eventLoopP99Ms, 'number');
        assert.equal(typeof body.diagnostics.pgPoolBusy, 'number');
        assert.equal(res.locals.watchdogTripped, true);
        assert.ok(logs.some(msg => msg.includes('接口处理超时')));
    } finally {
        if (previous === undefined) delete process.env.API_REQUEST_WATCHDOG_MS;
        else process.env.API_REQUEST_WATCHDOG_MS = previous;
    }
});

test('响应已开始写出（SSE/流式）时兜底不介入', async () => {
    const previous = process.env.API_REQUEST_WATCHDOG_MS;
    process.env.API_REQUEST_WATCHDOG_MS = '40';
    try {
        const { apiRequestWatchdog } = require('../server/services/runtime-diagnostics');
        let statusCode = 0;
        const res = {
            headersSent: true,
            writableEnded: false,
            locals: {},
            once() { return this; },
            status(code) { statusCode = code; return this; },
            json() { return this; }
        };
        apiRequestWatchdog({ method: 'GET', path: '/api/stats/monitor-summary' }, res, () => {});
        await new Promise(resolve => setTimeout(resolve, 160));
        assert.equal(statusCode, 0);
    } finally {
        if (previous === undefined) delete process.env.API_REQUEST_WATCHDOG_MS;
        else process.env.API_REQUEST_WATCHDOG_MS = previous;
    }
});

test('请求正常结束会清掉兜底定时器，不会误报 503', async () => {
    const previous = process.env.API_REQUEST_WATCHDOG_MS;
    process.env.API_REQUEST_WATCHDOG_MS = '40';
    try {
        const { apiRequestWatchdog } = require('../server/services/runtime-diagnostics');
        const listeners = new Map();
        let statusCode = 0;
        const res = {
            headersSent: false,
            writableEnded: false,
            locals: {},
            once(event, handler) { listeners.set(event, handler); return this; },
            status(code) { statusCode = code; return this; },
            json() { return this; }
        };
        apiRequestWatchdog({ method: 'GET', path: '/api/settings' }, res, () => {});
        listeners.get('finish')();
        await new Promise(resolve => setTimeout(resolve, 160));
        assert.equal(statusCode, 0);
    } finally {
        if (previous === undefined) delete process.env.API_REQUEST_WATCHDOG_MS;
        else process.env.API_REQUEST_WATCHDOG_MS = previous;
    }
});
