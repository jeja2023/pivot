'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const GPU_SAMPLE_COMMAND = 'nvidia-smi';
const GPU_SAMPLE_ARGS = Object.freeze([
    '--query-gpu=index,name,memory.used,memory.total,utilization.gpu',
    '--format=csv,noheader,nounits'
]);

function normalizeGpuSampleTimeout(value, fallback = 3000) {
    const parsed = Number.parseInt(value, 10);
    return Math.max(100, Math.min(Number.isFinite(parsed) ? parsed : fallback, 30000));
}

function parseGpuRows(output = '') {
    return String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const [index, name, memoryUsedMiB, memoryTotalMiB, utilizationGpu] = line.split(',').map(item => item.trim());
        return {
            index: Number.parseInt(index, 10),
            name,
            memoryUsedMiB: Number.parseFloat(memoryUsedMiB),
            memoryTotalMiB: Number.parseFloat(memoryTotalMiB),
            utilizationGpu: Number.parseFloat(utilizationGpu)
        };
    }).filter(row => Number.isFinite(row.index));
}

function gpuSamplingErrorCode(error = {}) {
    if (error?.code === 'ETIMEDOUT' || error?.killed === true || error?.signal === 'SIGTERM') return 'gpu_sample_timeout';
    return String(error?.code || 'nvidia_smi_unavailable').slice(0, 80);
}

async function sampleDecisionGpu({ timeoutMs = 3000, exec = execFileAsync, now = () => new Date().toISOString() } = {}) {
    const safeTimeoutMs = normalizeGpuSampleTimeout(timeoutMs);
    try {
        const { stdout } = await exec(GPU_SAMPLE_COMMAND, GPU_SAMPLE_ARGS, {
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            timeout: safeTimeoutMs
        });
        return { available: true, sampledAt: now(), gpus: parseGpuRows(stdout) };
    } catch (error) {
        return { available: false, sampledAt: now(), gpus: [], errorCode: gpuSamplingErrorCode(error) };
    }
}

function aggregateGpuSamples(samples = []) {
    const perGpu = new Map();
    (Array.isArray(samples) ? samples : []).filter(sample => sample?.available).forEach(sample => {
        (Array.isArray(sample.gpus) ? sample.gpus : []).forEach(gpu => {
            const summary = perGpu.get(gpu.index) || { index: gpu.index, name: gpu.name, samples: 0, maxMemoryUsedMiB: 0, maxUtilizationGpu: 0 };
            summary.samples += 1;
            summary.maxMemoryUsedMiB = Math.max(summary.maxMemoryUsedMiB, Number(gpu.memoryUsedMiB) || 0);
            summary.maxUtilizationGpu = Math.max(summary.maxUtilizationGpu, Number(gpu.utilizationGpu) || 0);
            perGpu.set(gpu.index, summary);
        });
    });
    return [...perGpu.values()].sort((left, right) => left.index - right.index);
}

module.exports = {
    aggregateGpuSamples,
    normalizeGpuSampleTimeout,
    parseGpuRows,
    sampleDecisionGpu
};
