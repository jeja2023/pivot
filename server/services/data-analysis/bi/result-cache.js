'use strict';

const { performance } = require('node:perf_hooks');
const repository = require('../../../repositories/analysis-model-cache');
const jobs = require('../../../repositories/analysis-model-jobs');
const objectRepository = require('../../../repositories/analysis-objects');
const objects = require('./objects');
const { biError } = require('./errors');

async function reuseModelResult({ job, context, authorize, signal, inputResolutionMs }) {
    if (job.execution_kind !== 'model_query') return false;
    const leaseId = `${job.id}:${job.execution_epoch}:cache`, started = performance.now();
    try {
        const candidate = await repository.retainMatch(job, { context, authorize, leaseId });
        if (!candidate) return false;
        const resultObject = await objectRepository.get(candidate.row.result_object_id), resultPageObject = await objectRepository.get(candidate.row.result_page_object_id);
        await objects.verify(resultObject, { signal }); await objects.verify(resultPageObject, { signal });
        if (signal.aborted) throw biError('ANALYSIS_MODEL_LEASE_LOST', '分析已取消或租约失效。', 409);
        const result = { ...candidate.row.result_metadata_json, runId: job.id,
            cache: { hit: true, sourceRunId: candidate.row.id, computedAt: candidate.row.result_metadata_json.cache?.computedAt || candidate.row.completed_at } };
        const committed = await jobs.complete(job, { result, resultObject, resultPageObject, cacheContext: context,
            runtimeMetrics: { cacheHit: true, cacheVerificationMs: Math.ceil(performance.now() - started), inputResolutionMs, workerMs: 0, runtimeMs: 0, maxRssBytes: 0, userCpuMs: 0, systemCpuMs: 0, peakSpillBytes: 0 },
            authorize: async trx => {
                const current = await authorize(trx);
                if (!await repository.confirm(trx, job, candidate, context, current)) throw biError('ANALYSIS_MODEL_CACHE_MISS', '缓存条件已变化，将按当前授权重新计算。', 409);
                return current;
            } });
        if (!committed) throw biError('ANALYSIS_MODEL_LEASE_LOST', '缓存结果登记时执行租约已失效。', 409);
        return true;
    } catch (error) {
        if (error.code === 'ANALYSIS_MODEL_CACHE_MISS') return false;
        throw error;
    } finally { await objectRepository.release('lease', leaseId); }
}

module.exports = { reuseModelResult };
