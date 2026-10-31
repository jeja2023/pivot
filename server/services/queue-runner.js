'use strict';

const { clearImmediate } = require('node:timers');

// 合并重复调度；停机后取消未开始的任务并等待已经开始的批次。
function createQueueRunner(run, intervalMs = 15000) {
    let interval = null;
    let immediate = null;
    let active = null;
    let stopped = false;
    function drain() {
        if (stopped) return Promise.resolve();
        if (active) return active;
        const current = Promise.resolve().then(() => stopped ? undefined : run({ shouldStop: () => stopped })).finally(() => { if (active === current) active = null; });
        active = current;
        return current;
    }
    function schedule() {
        if (stopped || immediate) return;
        immediate = setImmediate(() => {
            immediate = null;
            void drain().catch(() => {});
        });
    }
    function start() {
        stopped = false;
        if (!interval) { interval = setInterval(schedule, intervalMs); interval.unref?.(); schedule(); }
        return { stop };
    }
    async function stop() {
        stopped = true;
        if (interval) clearInterval(interval);
        if (immediate) clearImmediate(immediate);
        interval = null;
        immediate = null;
        if (active) await active;
    }
    return { drain, schedule, start, stop };
}

module.exports = { createQueueRunner };
