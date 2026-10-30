const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimitStore } = require('../server/services/rate-limit-store');

test('独立限流存储实例共享计数并隔离不同路由', { skip: !process.env.DATABASE_URL }, async () => {
    const prefix = `test:${process.pid}:${Date.now()}`;
    const a = createRateLimitStore(prefix);
    const b = createRateLimitStore(prefix);
    const other = createRateLimitStore(`${prefix}:other`);
    a.init({ windowMs: 60000 }); b.init({ windowMs: 60000 }); other.init({ windowMs: 60000 });
    try {
        assert.equal((await a.increment('user_1')).totalHits, 1);
        assert.equal((await b.increment('user_1')).totalHits, 2);
        assert.equal((await other.increment('user_1')).totalHits, 1);
        assert.equal((await b.increment('user_2')).totalHits, 1);
    } finally {
        await a.resetKey('user_1'); await a.resetKey('user_2'); await other.resetKey('user_1');
    }
});
