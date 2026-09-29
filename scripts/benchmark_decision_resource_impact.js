'use strict';

const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { readTypedEnv } = require('../server/config/env-registry');
const { aggregateGpuSamples, sampleDecisionGpu } = require('../server/services/decision-gpu-sampling');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function hasFlag(name) {
    return process.argv.includes(name);
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
    const gpuSampleTimeoutMs = readTypedEnv('PIVOT_DECISION_GPU_SAMPLE_TIMEOUT_MS');
    const reportPath = arg('--report');
    const benchmarkArgs = process.argv.slice(2).filter((value, index, list) => {
        if (value === '--report' || value === '--sample-interval-ms' || value === '--require-gpu') return false;
        return index === 0 || !['--report', '--sample-interval-ms'].includes(list[index - 1]);
    });
    const sampleGpu = () => sampleDecisionGpu({ timeoutMs: gpuSampleTimeoutMs });
    const samples = [await sampleGpu()];
    if (hasFlag('--require-gpu') && !samples[0].available) throw new Error('未检测到 nvidia-smi；本次验收要求 GPU 采样。');
    const timer = setInterval(() => { void sampleGpu().then(sample => samples.push(sample)); }, intervalMs);
    try {
        const benchmark = await runBenchmark(benchmarkArgs);
        samples.push(await sampleGpu());
        const benchmarkResult = JSON.parse(benchmark.stdout);
        const report = {
            generatedAt: new Date().toISOString(),
            gpuSampleTimeoutMs,
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
