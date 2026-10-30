'use strict';

function createPeriodicRunner({ run, intervalMs, initialDelayMs = null, setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    let initial = null;
    let timer = null;
    let inFlight = null;
    let stopped = false;
    const tick = () => {
        if (stopped || inFlight) return inFlight;
        inFlight = Promise.resolve().then(run).finally(() => { inFlight = null; });
        return inFlight;
    };
    return {
        start() {
            if (timer || stopped) return;
            if (initialDelayMs !== null) {
                initial = setTimeoutFn(() => { initial = null; void tick(); }, initialDelayMs);
                initial?.unref?.();
            }
            timer = setIntervalFn(() => { void tick(); }, intervalMs);
            timer?.unref?.();
        },
        async stop() {
            stopped = true;
            if (initial) clearTimeoutFn(initial);
            if (timer) clearIntervalFn(timer);
            initial = null;
            timer = null;
            if (inFlight) await inFlight;
        },
        tick
    };
}

module.exports = { createPeriodicRunner };
