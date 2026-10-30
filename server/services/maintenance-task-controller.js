'use strict';

function createMaintenanceTaskController({ setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    const timers = new Set();
    const pending = new Set();
    let stopped = false;

    function run(operation, onError = () => {}) {
        if (stopped) return;
        let task;
        task = Promise.resolve().then(() => {
            if (!stopped) return operation();
        }).catch(error => { try { onError(error); } catch (_) {} }).finally(() => pending.delete(task));
        pending.add(task);
        return task;
    }

    function every(intervalMs, operation, onError, { immediate = false, initialOnError = onError } = {}) {
        if (stopped) return;
        let running = false;
        const fire = errorHandler => {
            if (running || stopped) return;
            running = true;
            run(async () => {
                try { return await operation(); }
                finally { running = false; }
            }, errorHandler);
        };
        const timer = setIntervalFn(() => fire(onError), intervalMs);
        timer.unref?.();
        timers.add(timer);
        if (immediate) fire(initialOnError);
    }

    async function stop() {
        stopped = true;
        for (const timer of timers) clearIntervalFn(timer);
        timers.clear();
        await Promise.all([...pending]);
    }

    return { run, every, stop };
}

module.exports = { createMaintenanceTaskController };
