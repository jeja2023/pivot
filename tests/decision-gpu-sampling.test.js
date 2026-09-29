const assert = require('node:assert/strict');
const test = require('node:test');
const {
    aggregateGpuSamples,
    normalizeGpuSampleTimeout,
    parseGpuRows,
    sampleDecisionGpu
} = require('../server/services/decision-gpu-sampling');
const { getDecisionRuntimeConfig } = require('../server/services/decision-runtime');

test('GPU 采样限制超时、解析结构化指标并避免阻塞发布证据采集', async () => {
    assert.equal(normalizeGpuSampleTimeout('0'), 100);
    assert.equal(normalizeGpuSampleTimeout('999999'), 30000);
    assert.deepEqual(parseGpuRows('0, NVIDIA A10, 512, 24576, 19\n'), [{
        index: 0, name: 'NVIDIA A10', memoryUsedMiB: 512, memoryTotalMiB: 24576, utilizationGpu: 19
    }]);
    const timeout = await sampleDecisionGpu({
        timeoutMs: 500,
        exec: async (_file, _args, options) => {
            assert.equal(options.timeout, 500);
            throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true });
        },
        now: () => '2026-09-29T00:00:00.000Z'
    });
    assert.deepEqual(timeout, {
        available: false, sampledAt: '2026-09-29T00:00:00.000Z', gpus: [], errorCode: 'gpu_sample_timeout'
    });
});

test('GPU 采样汇总保留每张卡的峰值而不保留原始命令输出', () => {
    const summary = aggregateGpuSamples([
        { available: true, gpus: [{ index: 0, name: 'A10', memoryUsedMiB: 300, utilizationGpu: 10 }] },
        { available: true, gpus: [{ index: 0, name: 'A10', memoryUsedMiB: 450, utilizationGpu: 8 }, { index: 1, name: 'A10', memoryUsedMiB: 200, utilizationGpu: 24 }] },
        { available: false, gpus: [] }
    ]);
    assert.deepEqual(summary, [
        { index: 0, name: 'A10', samples: 2, maxMemoryUsedMiB: 450, maxUtilizationGpu: 10 },
        { index: 1, name: 'A10', samples: 1, maxMemoryUsedMiB: 200, maxUtilizationGpu: 24 }
    ]);
});

test('决策运行时从类型化配置读取 GPU 采样超时', () => {
    assert.equal(getDecisionRuntimeConfig({ PIVOT_DECISION_GPU_SAMPLE_TIMEOUT_MS: '750' }).gpuSampleTimeoutMs, 750);
    assert.equal(getDecisionRuntimeConfig({ PIVOT_DECISION_GPU_SAMPLE_TIMEOUT_MS: '1' }).gpuSampleTimeoutMs, 100);
});
