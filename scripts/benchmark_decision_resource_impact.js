'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function hasFlag(name) {
    return process.argv.includes(name);
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

async function sampleGpu() {
    try {
        const { stdout } = await execFileAsync('nvidia-smi', [
            '--query-gpu=index,name,memory.used,memory.total,utilization.gpu',
            '--format=csv,noheader,nounits'
        ], { windowsHide: true, maxBuffer: 1024 * 1024 });
        return { available: true, gpus: parseGpuRows(stdout), sampledAt: new Date().toISOString() };
    } catch (error) {
        return { available: false, gpus: [], sampledAt: new Date().toISOString(), errorCode: error.code || 'nvidia_smi_unavailable' };
    }
}

function aggregateGpuSamples(samples = []) {
    const perGpu = new Map();
    (Array.isArray(samples) ? samples : []).filter(sample => sample?.available).forEach(sample => {
        sample.gpus.forEach(gpu => {
            const summary = perGpu.get(gpu.index) || { index: gpu.index, name: gpu.name, samples: 0, maxMemoryUsedMiB: 0, maxUtilizationGpu: 0 };
            summary.samples += 1;
            summary.maxMemoryUsedMiB = Math.max(summary.maxMemoryUsedMiB, Number(gpu.memoryUsedMiB) || 0);
            summary.maxUtilizationGpu = Math.max(summary.maxUtilizationGpu, Number(gpu.utilizationGpu) || 0);
            perGpu.set(gpu.index, summary);
        });
    });
    return [...perGpu.values()].sort((left, right) => left.index - right.index);
}

function runBenchmark(args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve(__dirname, 'benchmark_decision_providers.js'), ...args], {
            cwd: path.resolve(__dirname, '..'),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(stderr || stdout || 'provider_benchmark_failed'), { code })));
    });
}

async function main() {
    const intervalMs = Math.max(200, Math.min(Number.parseInt(arg('--sample-interval-ms', '1000'), 10) || 1000, 10000));
    const reportPath = arg('--report');
    const benchmarkArgs = process.argv.slice(2).filter((value, index, list) => {
        if (value === '--report' || value === '--sample-interval-ms' || value === '--require-gpu') return false;
        return index === 0 || !['--report', '--sample-interval-ms'].includes(list[index - 1]);
    });
    const samples = [await sampleGpu()];
    if (hasFlag('--require-gpu') && !samples[0].available) throw new Error('未检测到 nvidia-smi；本次验收要求 GPU 采样。');
    const timer = setInterval(() => { void sampleGpu().then(sample => samples.push(sample)); }, intervalMs);
    try {
        const benchmark = await runBenchmark(benchmarkArgs);
        samples.push(await sampleGpu());
        const benchmarkResult = JSON.parse(benchmark.stdout);
        const report = {
            generatedAt: new Date().toISOString(),
            gpuAvailable: samples.some(sample => sample.available),
            gpuSamples: aggregateGpuSamples(samples),
            gpuRawSamples: samples,
            benchmark: benchmarkResult
        };
        if (reportPath) await require('fs').promises.writeFile(path.resolve(reportPath), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally {
        clearInterval(timer);
    }
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
