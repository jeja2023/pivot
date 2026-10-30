'use strict';

function createWikiCompileWorker({ config, workerId, pollIntervalMs, logger, setIntervalFn, clearIntervalFn, run }) {
    if (config.enabled !== true || config.workerEnabled !== true) return null;
    const interval = Math.max(250, Number.parseInt(pollIntervalMs, 10) || config.workerPollIntervalMs || 2000);
    let timer = null;
    let inFlight = null;
    const runOnce = () => {
        if (inFlight) return inFlight;
        inFlight = Promise.resolve().then(run).catch(error => {
            logger.warn({ err: error.message }, '知识 Wiki 编译 Worker 执行失败');
            return null;
        }).finally(() => { inFlight = null; });
        return inFlight;
    };
    return {
        start() {
            if (!timer) {
                timer = setIntervalFn(() => { void runOnce(); }, interval);
                timer?.unref?.();
                void runOnce();
            }
            return { workerId, started: true };
        },
        async stop() { if (timer) clearIntervalFn(timer); timer = null; if (inFlight) await inFlight; },
        runOnce,
        getRuntimeStatus: () => ({ workerId, started: Boolean(timer), running: Boolean(inFlight) })
    };
}

module.exports = { createWikiCompileWorker };
