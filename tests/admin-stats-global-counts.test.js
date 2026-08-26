const test = require('node:test');
const assert = require('node:assert/strict');

// 全库总量统计是全表扫描：原实现用 Promise.all 并发 7 条，一个管理员打开运维面板就能
// 占掉 7/10 个池连接，池满后所有接口（含每请求查 users 的鉴权中间件）一起拿不到连接。
// 这里锁定三条约束：串行执行、命中缓存不再打库、SWR 不阻塞请求链路。
const dbClientPath = require.resolve('../server/db/client');

function withFakeDbClient(handler) {
    const saved = require.cache[dbClientPath];
    const calls = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    require.cache[dbClientPath] = {
        id: dbClientPath,
        filename: dbClientPath,
        loaded: true,
        exports: {
            async queryOne(sql) {
                calls.push(sql.replace(/\s+/g, ' ').trim());
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise(resolve => setTimeout(resolve, 5));
                concurrent -= 1;
                if (/SUM\(token_count\)/.test(sql)) return { total: 4242 };
                return { count: 7 };
            }
        }
    };
    const restore = () => {
        if (saved) require.cache[dbClientPath] = saved;
        else delete require.cache[dbClientPath];
    };
    return handler({ calls, stats: () => ({ maxConcurrent }) }).finally(restore);
}

test('全库总量统计串行执行，一次刷新只占用一个池连接', async () => {
    await withFakeDbClient(async ({ calls, stats }) => {
        const cache = require('../server/services/admin-stats-cache');
        cache.resetGlobalCountsCacheForTests();
        const counts = await cache.getCachedGlobalCounts();
        assert.equal(stats().maxConcurrent, 1, '全表扫描不得并发发出');
        assert.equal(calls.length, 7);
        assert.equal(counts.users, 7);
        assert.equal(counts.tokens, 4242);
        assert.equal(counts.stale, false);
        assert.equal(typeof counts.computedAt, 'string');
    });
});

test('缓存有效期内重复读取不再打库', async () => {
    await withFakeDbClient(async ({ calls }) => {
        const cache = require('../server/services/admin-stats-cache');
        cache.resetGlobalCountsCacheForTests();
        await cache.getCachedGlobalCounts();
        const firstRoundCalls = calls.length;
        for (let i = 0; i < 5; i += 1) await cache.getCachedGlobalCounts();
        assert.equal(calls.length, firstRoundCalls, '命中缓存时不应再产生任何查询');
    });
});

test('缓存过期后立即返回旧值并在后台刷新（SWR），请求链路不等待全表扫描', async () => {
    await withFakeDbClient(async ({ calls }) => {
        const cache = require('../server/services/admin-stats-cache');
        cache.resetGlobalCountsCacheForTests();
        await cache.getCachedGlobalCounts();
        const before = calls.length;

        cache.invalidateGlobalCountsCache();
        const startedAt = Date.now();
        const stale = await cache.getCachedGlobalCounts();
        // 7 条查询每条 5ms，若同步等待刷新至少要 35ms；SWR 应当立刻返回
        assert.ok(Date.now() - startedAt < 30, '过期后不得同步等待重算');
        assert.equal(stale.users, 7);

        await new Promise(resolve => setTimeout(resolve, 120));
        assert.ok(calls.length > before, '后台应完成一次刷新');
    });
});

test('刷新失败时保留上一次可用数值，不把面板清零', async () => {
    const saved = require.cache[dbClientPath];
    try {
        let shouldFail = false;
        require.cache[dbClientPath] = {
            id: dbClientPath,
            filename: dbClientPath,
            loaded: true,
            exports: {
                async queryOne(sql) {
                    if (shouldFail) throw new Error('connection terminated');
                    if (/SUM\(token_count\)/.test(sql)) return { total: 99 };
                    return { count: 3 };
                }
            }
        };
        const cache = require('../server/services/admin-stats-cache');
        cache.resetGlobalCountsCacheForTests();
        const ok = await cache.getCachedGlobalCounts();
        assert.equal(ok.users, 3);

        shouldFail = true;
        cache.invalidateGlobalCountsCache();
        await cache.getCachedGlobalCounts();
        await new Promise(resolve => setTimeout(resolve, 50));
        const afterFailure = await cache.getCachedGlobalCounts();
        assert.equal(afterFailure.users, 3, '刷新失败后仍应返回上一次的可用数值');
        assert.equal(afterFailure.tokens, 99);
    } finally {
        if (saved) require.cache[dbClientPath] = saved;
        else delete require.cache[dbClientPath];
        require('../server/services/admin-stats-cache').resetGlobalCountsCacheForTests();
    }
});
