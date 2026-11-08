'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function executionStatistics(spillRoot) {
    const started = performance.now();
    let peakSpillBytes = 0, sampling = null;
    const sample = async () => {
        let total = 0;
        try {
            for (const item of await fs.readdir(spillRoot, { withFileTypes: true })) if (item.isFile()) {
                try { total += (await fs.stat(path.join(spillRoot, item.name))).size; } catch (_) { /* 溢写文件可能刚被引擎回收。 */ }
            }
        } catch (_) { /* 未发生溢写时目录可能尚未创建。 */ }
        peakSpillBytes = Math.max(peakSpillBytes, total);
    };
    const timer = setInterval(() => { if (!sampling) sampling = sample().finally(() => { sampling = null; }); }, 100);
    timer.unref();
    return async () => {
        clearInterval(timer); if (sampling) await sampling; await sample();
        const usage = process.resourceUsage();
        let cgroupPeakBytes = null;
        if (process.platform === 'linux') {
            try { const text = (await fs.readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim(); if (/^\d+$/.test(text)) cgroupPeakBytes = Number(text); } catch (_) { /* 旧 cgroup 不提供峰值，保持未测。 */ }
        }
        return { workerMs: Math.ceil(performance.now() - started), userCpuMs: Math.ceil(usage.userCPUTime / 1000), systemCpuMs: Math.ceil(usage.systemCPUTime / 1000), maxRssBytes: usage.maxRSS * 1024, peakSpillBytes, cgroupPeakBytes };
    };
}

module.exports = { executionStatistics };
