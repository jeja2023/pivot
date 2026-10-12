'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { asyncHandler } = require('../server/http');
const { registerArticleRoutes } = require('../server/routes/apps/regulations/articles');

test('asyncHandler 在 res.headersSent 为 true 或捕获 ERR_HTTP_HEADERS_SENT 时静默结束流且不调用 next(err)', async () => {
    let nextCalled = false;
    const req = {};
    const res = {
        headersSent: true,
        writableEnded: false,
        ended: false,
        end() { this.ended = true; }
    };
    const next = () => {
        nextCalled = true;
    };

    const handler = asyncHandler(async () => {
        const error = new Error('响应头已发送，不能重复写入响应');
        error.code = 'ERR_HTTP_HEADERS_SENT';
        throw error;
    });

    await handler(req, res, next);
    assert.equal(nextCalled, false, '不应向后级错误中间件传播重复响应头错误');
    assert.equal(res.ended, true, '应安全结束流');
});

test('asyncHandler 在未发送响应头时正常将错误传给 next', async () => {
    let nextCalled = false;
    let nextError = null;
    const req = {};
    const res = {
        headersSent: false,
        writableEnded: false
    };
    const next = (err) => {
        nextCalled = true;
        nextError = err;
    };

    const customError = new Error('普通业务错误');
    const handler = asyncHandler(async () => {
        throw customError;
    });

    await handler(req, res, next);
    assert.equal(nextCalled, true, '普通业务错误应传给 next');
    assert.equal(nextError, customError);
});

test('/search/hybrid 在 res.headersSent 为 true 时不会重复调用 res.json', async () => {
    const routes = {};
    const router = {
        get(path, ...middlewares) {
            routes[path] = middlewares;
        },
        put() {},
        post() {},
        delete() {}
    };

    registerArticleRoutes(router, {
        authMiddleware: (_req, _res, next) => next(),
        logAction: () => {}
    });

    assert.ok(routes['/search/hybrid'], '应注册 /search/hybrid 路由');
    const routeHandler = routes['/search/hybrid'][routes['/search/hybrid'].length - 1];

    let jsonCalled = false;
    const req = {
        query: { query: '测试' },
        user: { id: 1, role: 'admin' }
    };
    const res = {
        headersSent: true,
        writableEnded: true,
        json() {
            jsonCalled = true;
            throw new Error('ERR_HTTP_HEADERS_SENT');
        }
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };

    // 执行路由，传入 headersSent: true 的 res
    await routeHandler(req, res, next);
    assert.equal(jsonCalled, false, '当 headersSent 已为 true 时不应调用 res.json');
    assert.equal(nextCalled, false, '不应触发错误传播');
});
