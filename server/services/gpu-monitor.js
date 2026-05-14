/* NVIDIA GPU VRAM monitor and adaptive AI concurrency protection */
const { exec } = require('child_process');
const { aiSemaphore } = require('./concurrency');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');

const parsePositiveInt = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseRatio = (value, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed > 1 ? parsed / 100 : parsed;
};

const MONITOR_INTERVAL = parsePositiveInt(process.env.GPU_MONITOR_INTERVAL_MS, 15000);
const VRAM_SAFE_THRESHOLD = parseRatio(process.env.GPU_VRAM_SAFE_THRESHOLD, 0.85);
const VRAM_CRITICAL_THRESHOLD = parseRatio(process.env.GPU_VRAM_CRITICAL_THRESHOLD, 0.95);
const VRAM_REJECT_THRESHOLD = parseRatio(process.env.GPU_VRAM_REJECT_THRESHOLD, 0.97);
const VRAM_RECOVER_THRESHOLD = parseRatio(process.env.GPU_VRAM_RECOVER_THRESHOLD, Math.min(0.9, VRAM_SAFE_THRESHOLD));
const MAX_CONCURRENT_CAP = parsePositiveInt(process.env.GPU_CONCURRENT_MAX, 12);
const MIN_CONCURRENT_CAP = parsePositiveInt(process.env.GPU_CONCURRENT_MIN, 2);

const state = {
    available: false,
    updatedAt: null,
    gpus: [],
    maxRatio: 0,
    overloaded: false,
    error: null,
    thresholds: {
        safe: VRAM_SAFE_THRESHOLD,
        critical: VRAM_CRITICAL_THRESHOLD,
        reject: VRAM_REJECT_THRESHOLD,
        recover: VRAM_RECOVER_THRESHOLD
    },
    intervalMs: MONITOR_INTERVAL
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

async function refreshGpuStatus() {
    const result = await getGpuMemoryUsage();
    state.available = result.gpus.length > 0;
    state.updatedAt = getBeijingTimestamp();
    state.gpus = result.gpus;
    state.error = result.error;
    state.maxRatio = result.gpus.length ? Math.max(...result.gpus.map(g => g.ratio)) : 0;

    if (!state.available) {
        aiSemaphore.setRejectingNewRequests(false);
        return state;
    }

    const status = aiSemaphore.getStatus();
    let nextMax = status.max;

    if (state.maxRatio >= VRAM_REJECT_THRESHOLD) {
        state.overloaded = true;
        const reason = `GPU 显存占用已达到 ${(state.maxRatio * 100).toFixed(1)}%，系统正在保护模型服务。`;
        aiSemaphore.setRejectingNewRequests(true, reason);
        aiSemaphore.rejectQueuedRequests(reason, 'AI_OVERLOADED');
        nextMax = Math.max(MIN_CONCURRENT_CAP, status.max - 2);
    } else {
        if (state.overloaded && state.maxRatio <= VRAM_RECOVER_THRESHOLD) {
            state.overloaded = false;
            aiSemaphore.setRejectingNewRequests(false);
        } else if (!state.overloaded) {
            aiSemaphore.setRejectingNewRequests(false);
        }

        if (state.maxRatio > VRAM_CRITICAL_THRESHOLD) {
            nextMax = Math.max(MIN_CONCURRENT_CAP, status.max - 2);
            logger.warn({ maxRatio: state.maxRatio, nextMax }, 'GPU 显存接近满载，正在下调 AI 并发');
        } else if (state.maxRatio > VRAM_SAFE_THRESHOLD) {
            nextMax = Math.max(MIN_CONCURRENT_CAP, status.max - 1);
            logger.info({ maxRatio: state.maxRatio, nextMax }, 'GPU 显存较高，正在微调 AI 并发');
        } else if (state.maxRatio < 0.7 && status.queued > 0) {
            nextMax = Math.min(MAX_CONCURRENT_CAP, status.max + 1);
            logger.info({ maxRatio: state.maxRatio, nextMax }, 'GPU 显存充足且有排队，请求提升 AI 并发');
        }
    }

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
    }, MONITOR_INTERVAL);
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
    getGpuMonitorStatus
};
