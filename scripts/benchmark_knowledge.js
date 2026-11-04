'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { aggregateRetrievalQuality, evaluateRetrievalSample } = require('./test_support/knowledge_quality_metrics');

async function runBenchmark({ baseUrl, authorization, cases, concurrency = 2, timeoutMs = 30000, fetchFn = fetch } = {}) {
    const root = new URL(baseUrl);
    if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new Error('测试地址必须是不含凭据的 HTTP/HTTPS 根地址。');
    if (!authorization || !Array.isArray(cases) || !cases.length) throw new Error('缺少测试身份或黄金集。');
    const jobs = cases.slice(0, 1000);
    const samples = [];
    let cursor = 0;
    async function worker() {
        while (cursor < jobs.length) {
            const index = cursor++;
            const item = jobs[index];
            const query = String(item.query || '').trim();
            if (!query || query.length > 4000) { samples.push({ index, error: 'invalid_case' }); continue; }
            const start = performance.now();
            try {
                const response = await fetchFn(new URL('/api/knowledge/search', root), {
                    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, ...(item.collectionId ? { collectionId: Number(item.collectionId) } : {}) }),
                    signal: AbortSignal.timeout(timeoutMs)
                });
                const body = await response.json();
                if (!response.ok || body.error) throw new Error('request_failed');
                const citations = Array.isArray(body.citations) ? body.citations : [];
                samples.push({ index, durationMs: Math.round(performance.now() - start), ...evaluateRetrievalSample(item, citations) });
            } catch (_) { samples.push({ index, durationMs: Math.round(performance.now() - start), error: 'request_failed' }); }
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(Number(concurrency) || 2, 1), 16, jobs.length) }, worker));
    const durations = samples.filter(sample => !sample.error).map(sample => sample.durationMs).sort((a, b) => a - b);
    const percentile = p => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)] : null;
    const labeled = samples.filter(sample => sample.hit !== null && sample.hit !== undefined);
    return { total: jobs.length, succeeded: durations.length, failed: samples.length - durations.length,
        p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
        labeledCases: labeled.length, hitRate: labeled.length ? labeled.filter(sample => sample.hit).length / labeled.length : null,
        topK: 5, quality: aggregateRetrievalQuality(samples),
        note: '质量指标仅依据显式标注与成功请求；失败率另列，不将缺少标注或事实核验计为通过。' };
}

async function main() {
    const file = process.argv[2];
    const baseUrl = process.env.KNOWLEDGE_BENCHMARK_BASE_URL;
    const authorization = process.env.KNOWLEDGE_BENCHMARK_AUTHORIZATION;
    if (!file || process.env.KNOWLEDGE_BENCHMARK_CONFIRM !== 'YES') throw new Error('请指定黄金集 JSON 文件，并显式设置 KNOWLEDGE_BENCHMARK_CONFIRM=YES。');
    const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
    const report = await runBenchmark({ baseUrl, authorization, cases, concurrency: process.env.KNOWLEDGE_BENCHMARK_CONCURRENCY });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { process.stderr.write(`知识库压测失败：${error.message}\n`); process.exitCode = 1; });
module.exports = { runBenchmark };
