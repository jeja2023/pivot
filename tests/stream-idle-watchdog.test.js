const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_IDLE_TIMEOUT_MS,
    MIN_IDLE_TIMEOUT_MS,
    createStreamIdleWatchdog,
    resolveStreamIdleTimeoutMs
} = require('../server/services/stream-idle-watchdog');

test('空闲超时配置：缺省取默认值，显式 0 与非法值关闭看门狗，过小值抬到下限', () => {
    assert.equal(resolveStreamIdleTimeoutMs(undefined), DEFAULT_IDLE_TIMEOUT_MS);
    assert.equal(resolveStreamIdleTimeoutMs(''), DEFAULT_IDLE_TIMEOUT_MS);
    assert.equal(resolveStreamIdleTimeoutMs('0'), 0);
    assert.equal(resolveStreamIdleTimeoutMs('abc'), 0);
    assert.equal(resolveStreamIdleTimeoutMs('-1'), 0);
    assert.equal(resolveStreamIdleTimeoutMs('100'), MIN_IDLE_TIMEOUT_MS);
    assert.equal(resolveStreamIdleTimeoutMs('60000'), 60000);
});

function createFakeClock() {
    let currentTime = 0;
    const tasks = [];
    return {
        now: () => currentTime,
        setIntervalFn: (handler, intervalMs) => {
            const task = { handler, intervalMs, nextAt: currentTime + intervalMs, cleared: false };
            tasks.push(task);
            return task;
        },
        clearIntervalFn: (task) => { if (task) task.cleared = true; },
        advance(ms) {
            const target = currentTime + ms;
            // 逐个到期时间推进，模拟真实定时器的触发节奏
            for (;;) {
                const due = tasks.filter(task => !task.cleared && task.nextAt <= target)
                    .sort((a, b) => a.nextAt - b.nextAt)[0];
                if (!due) break;
                currentTime = due.nextAt;
                due.nextAt += due.intervalMs;
                due.handler();
            }
            currentTime = target;
        }
    };
}

test('持续有数据时不会误判空闲', () => {
    const clock = createFakeClock();
    let fired = 0;
    const watchdog = createStreamIdleWatchdog({
        idleMs: 10000,
        onIdle: () => { fired += 1; },
        now: clock.now,
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn
    });
    assert.equal(watchdog.enabled, true);
    assert.equal(watchdog.idleMs, 10000);
    for (let i = 0; i < 20; i += 1) {
        clock.advance(4000);
        watchdog.touch();
    }
    assert.equal(fired, 0);
});

test('空闲超过阈值后触发一次，且不会重复触发', () => {
    const clock = createFakeClock();
    const fires = [];
    const watchdog = createStreamIdleWatchdog({
        idleMs: 10000,
        onIdle: (idleMs) => { fires.push(idleMs); },
        now: clock.now,
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn
    });
    clock.advance(9000);
    assert.deepEqual(fires, [], '未到阈值不得触发');
    clock.advance(2000);
    assert.deepEqual(fires, [10000]);
    // 继续推进很久也只应触发一次：回调里会中止上游并结束响应，重复触发会重复写响应
    clock.advance(120000);
    assert.deepEqual(fires, [10000]);
    watchdog.stop();
});

test('stop() 之后不再触发，touch() 也不会复活看门狗', () => {
    const clock = createFakeClock();
    let fired = 0;
    const watchdog = createStreamIdleWatchdog({
        idleMs: 10000,
        onIdle: () => { fired += 1; },
        now: clock.now,
        setIntervalFn: clock.setIntervalFn,
        clearIntervalFn: clock.clearIntervalFn
    });
    watchdog.stop();
    watchdog.touch();
    clock.advance(60000);
    assert.equal(fired, 0);
});

test('关闭配置或缺少回调时返回惰性看门狗，调用不报错', () => {
    const disabled = createStreamIdleWatchdog({ idleMs: 0, onIdle: () => { throw new Error('不该被调用'); } });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.idleMs, 0);
    disabled.touch();
    disabled.stop();

    const noCallback = createStreamIdleWatchdog({ idleMs: 10000 });
    assert.equal(noCallback.enabled, false);
    noCallback.touch();
    noCallback.stop();
});

// 下面两项复刻路由里的真实接线方式（真 stream + destroy + 事件处理器），
// 锁定「上游静默挂住 → 中止上游 → 许可只释放一次 → 不重复给客户端写错误帧」。
const { PassThrough } = require('node:stream');

function wireLikeRoute(upstream, { idleMs }) {
    const events = [];
    let released = false;
    let streamIdleAborted = false;
    const releaseSlots = () => {
        if (released) return;
        released = true;
        events.push('release');
    };
    const watchdog = createStreamIdleWatchdog({
        idleMs,
        onIdle: () => {
            streamIdleAborted = true;
            events.push('idle');
            try { upstream.destroy(); } catch (_) {}
            events.push('client-error-frame');
            releaseSlots();
        }
    });
    upstream.on('data', () => { watchdog.touch(); events.push('data'); });
    upstream.on('end', () => { watchdog.stop(); events.push('end'); releaseSlots(); });
    upstream.on('error', () => {
        watchdog.stop();
        if (streamIdleAborted) { releaseSlots(); return; }
        events.push('client-error-frame');
        releaseSlots();
    });
    upstream.on('close', () => { watchdog.stop(); events.push('close'); releaseSlots(); });
    return { events, watchdog };
}

test('上游静默挂住时：中止上游、只给客户端写一次错误帧、许可只释放一次', async () => {
    const upstream = new PassThrough();
    const { events } = wireLikeRoute(upstream, { idleMs: MIN_IDLE_TIMEOUT_MS });
    upstream.write('data: hello\n\n');
    // 之后不再写入任何字节，模拟上游发完头就静默挂住（既无 end 也无 error）
    await new Promise(resolve => setTimeout(resolve, MIN_IDLE_TIMEOUT_MS + 1500));
    assert.ok(events.includes('idle'), '应判定为空闲并中止');
    assert.equal(events.filter(item => item === 'client-error-frame').length, 1, '错误帧不得重复写出');
    assert.equal(events.filter(item => item === 'release').length, 1, '许可只能释放一次');
    assert.equal(upstream.destroyed, true, '上游流必须被销毁，socket 才能释放');
});

test('上游正常结束时看门狗不介入，也不会在结束后再触发', async () => {
    const upstream = new PassThrough();
    const { events } = wireLikeRoute(upstream, { idleMs: MIN_IDLE_TIMEOUT_MS });
    upstream.write('data: hello\n\n');
    upstream.end();
    await new Promise(resolve => setTimeout(resolve, MIN_IDLE_TIMEOUT_MS + 1500));
    assert.ok(!events.includes('idle'), '正常结束不得被判定为空闲');
    assert.ok(events.includes('end'));
    assert.equal(events.filter(item => item === 'release').length, 1);
});
