/* NVIDIA GPU VRAM monitor and adaptive AI concurrency protection */
const { exec } = require('child_process');
const { aiSemaphore } = require('./concurrency');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { parsePositiveInt } = require('../number');
const { getGlobalAiConcurrencyConfig } = require('./runtime-settings');

const parseRatio = (value, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    const ratio = parsed > 1 ? parsed / 100 : parsed;
    return ratio > 0 && ratio <= 1 ? ratio : fallback;
};

const DEFAULT_GPU_THRESHOLDS = Object.freeze({
    safe: 0.85,
    critical: 0.95,
    reject: 0.97,
    recover: 0.9
});

function normalizeGpuThresholds(env = process.env) {
    const thresholds = {
        safe: parseRatio(env.GPU_VRAM_SAFE_THRESHOLD, DEFAULT_GPU_THRESHOLDS.safe),
        critical: parseRatio(env.GPU_VRAM_CRITICAL_THRESHOLD, DEFAULT_GPU_THRESHOLDS.critical),
        reject: parseRatio(env.GPU_VRAM_REJECT_THRESHOLD, DEFAULT_GPU_THRESHOLDS.reject),
        recover: parseRatio(env.GPU_VRAM_RECOVER_THRESHOLD, DEFAULT_GPU_THRESHOLDS.recover)
    };
    if (thresholds.safe < thresholds.critical
        && thresholds.critical < thresholds.reject
        && thresholds.recover < thresholds.reject) {
        return thresholds;
    }
    logger.warn({ thresholds, defaults: DEFAULT_GPU_THRESHOLDS }, 'GPU 显存阈值顺序无效，已回退到安全默认值');
    return { ...DEFAULT_GPU_THRESHOLDS };
}

const MONITOR_INTERVAL = parsePositiveInt(process.env.GPU_MONITOR_INTERVAL_MS, 15000);
const gpuThresholds = normalizeGpuThresholds();
const VRAM_SAFE_THRESHOLD = gpuThresholds.safe;
const VRAM_CRITICAL_THRESHOLD = gpuThresholds.critical;
const VRAM_REJECT_THRESHOLD = gpuThresholds.reject;
const VRAM_RECOVER_THRESHOLD = gpuThresholds.recover;
const MAX_CONCURRENT_CAP = parsePositiveInt(process.env.GPU_CONCURRENT_MAX, 12);
const MIN_CONCURRENT_CAP = parsePositiveInt(process.env.GPU_CONCURRENT_MIN, 2);

const state = {
    available: false,
    updatedAt: null,
    gpus: [],
    maxRatio: 0,
    overloaded: false,
    throttled: false,
    protectionReason: '',
    error: null,
    thresholds: {
        safe: VRAM_SAFE_THRESHOLD,
        critical: VRAM_CRITICAL_THRESHOLD,
        reject: VRAM_REJECT_THRESHOLD,
        recover: VRAM_RECOVER_THRESHOLD
    },
    intervalMs: MONITOR_INTERVAL,
    configuredMaxConcurrent: null,
    effectiveMaxConcurrent: null,
    minConcurrentCap: MIN_CONCURRENT_CAP,
    maxConcurrentCap: MAX_CONCURRENT_CAP
};

function getGpuMemoryUsage() {
    return new Promise((resolve) => {
        const command = [
            'nvidia-smi',
            '--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu',
            '--format=csv,noheader,nounits'
        ].join(' ');

        exec(command, { timeout: 5000 }, (err, stdout) => {
            if (err) {
                let msg = err.message;
                if (msg.includes('not recognized') || msg.includes('not found') || err.code === 127) {
                    msg = '找不到 nvidia-smi 命令，请检查驱动是否安装或容器 GPU 透传是否正确配置';
                }
                return resolve({ error: msg, gpus: [] });
            }
            try {
                const lines = stdout.trim().split('\n').filter(Boolean);
                const gpus = lines.map(line => {
                    const [index, name, used, total, utilization, temperature] = line.split(',').map(v => v.trim());
                    const usedMiB = parseInt(used, 10) || 0;
                    const totalMiB = parseInt(total, 10) || 0;
                    return {
                        index: parseInt(index, 10),
                        name,
                        usedMiB,
                        totalMiB,
                        usedBytes: usedMiB * 1024 * 1024,
                        totalBytes: totalMiB * 1024 * 1024,
                        ratio: totalMiB > 0 ? usedMiB / totalMiB : 0,
                        utilization: (parseInt(utilization, 10) || 0) / 100,
                        temperature: parseInt(temperature, 10) || null
                    };
                });
                resolve({ error: null, gpus });
            } catch (e) {
                resolve({ error: '解析 GPU 指标数据失败: ' + e.message, gpus: [] });
            }
        });
    });
}

function getConfiguredConcurrencyBounds() {
    const configuredMax = parsePositiveInt(getGlobalAiConcurrencyConfig().maxConcurrent, 1);
    const upper = Math.max(1, Math.min(MAX_CONCURRENT_CAP, configuredMax));
    const lower = Math.max(1, Math.min(upper, MIN_CONCURRENT_CAP));
    return { configuredMax, upper, lower };
}

function updateAdaptiveConcurrencyState(nextMax, bounds, reason = '') {
    state.effectiveMaxConcurrent = nextMax;
    state.throttled = nextMax < bounds.upper;
    state.protectionReason = state.throttled ? (reason || 'GPU_CONCURRENCY_THROTTLED') : '';
}

async function refreshGpuStatus() {
    const result = await getGpuMemoryUsage();
    const bounds = getConfiguredConcurrencyBounds();
    state.available = result.gpus.length > 0;
    state.updatedAt = getBeijingTimestamp();
    state.gpus = result.gpus;
    state.error = result.error;
    state.maxRatio = result.gpus.length ? Math.max(...result.gpus.map(g => g.ratio)) : 0;
    state.configuredMaxConcurrent = bounds.configuredMax;
    state.minConcurrentCap = bounds.lower;
    state.maxConcurrentCap = bounds.upper;

    const status = aiSemaphore.getStatus();
    const currentMax = Math.min(status.max, bounds.upper);
    let nextMax = currentMax;

    if (!state.available) {
        state.overloaded = false;
        updateAdaptiveConcurrencyState(bounds.upper, bounds);
        aiSemaphore.setRejectingNewRequests(false);
        if (status.max !== bounds.upper) {
            aiSemaphore.updateMaxConcurrent(bounds.upper);
        }
        return state;
    }

    if (state.maxRatio >= VRAM_REJECT_THRESHOLD) {
        state.overloaded = true;
        const reason = `GPU 显存占用已达到 ${(state.maxRatio * 100).toFixed(1)}%，系统正在保护模型服务。`;
        aiSemaphore.setRejectingNewRequests(true, reason);
        aiSemaphore.rejectQueuedRequests(reason, 'AI_OVERLOADED');
        nextMax = Math.max(bounds.lower, currentMax - 2);
    } else {
        if (state.overloaded && state.maxRatio <= VRAM_RECOVER_THRESHOLD) {
            state.overloaded = false;
            aiSemaphore.setRejectingNewRequests(false);
        } else if (!state.overloaded) {
            aiSemaphore.setRejectingNewRequests(false);
        }

        if (state.maxRatio > VRAM_CRITICAL_THRESHOLD) {
            nextMax = Math.max(bounds.lower, currentMax - 2);
            logger.warn({ maxRatio: state.maxRatio, nextMax }, 'GPU 显存接近满载，正在下调 AI 并发');
        } else if (state.maxRatio > VRAM_SAFE_THRESHOLD) {
            nextMax = Math.max(bounds.lower, currentMax - 1);
            logger.info({ maxRatio: state.maxRatio, nextMax }, 'GPU 显存较高，正在微调 AI 并发');
        } else {
            nextMax = bounds.upper;
            if (status.max < bounds.upper) {
                logger.info({ maxRatio: state.maxRatio, nextMax }, 'GPU 显存恢复安全，正在恢复到全局配置的 AI 并发');
            }
        }
    }

    updateAdaptiveConcurrencyState(nextMax, bounds, state.overloaded ? 'GPU_VRAM_REJECT' : 'GPU_VRAM_THROTTLE');
    if (nextMax !== status.max) {
        aiSemaphore.updateMaxConcurrent(nextMax);
    }

    return state;
}
async function startGpuMonitor() {
    logger.info({ intervalMs: MONITOR_INTERVAL }, 'GPU 动态负载监控服务已启动');
    await refreshGpuStatus();
    setInterval(() => {
        refreshGpuStatus().catch(err => {
            state.error = 'GPU 状态刷新异常: ' + err.message;
            logger.warn({ err: err.message }, 'GPU 监控刷新失败');
        });
    }, MONITOR_INTERVAL).unref();
}

function getGpuMonitorStatus() {
    return {
        ...state,
        gpus: state.gpus.map(gpu => ({ ...gpu }))
    };
}

module.exports = {
    startGpuMonitor,
    refreshGpuStatus,
    getGpuMonitorStatus,
    normalizeGpuThresholds
};
