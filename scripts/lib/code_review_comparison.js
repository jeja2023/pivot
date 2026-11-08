'use strict';

const TERMINAL = new Set(['completed', 'completed_with_errors', 'partial', 'error', 'cancelled']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
function invalid(message) { throw new Error(`代码审查对照记录无效：${message}`); }
function count(value, label) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !/^\d+$/.test(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) invalid(`${label}必须是非负整数`);
    return Number(value);
}
function observation(value, seen) {
    const run = value?.detail?.run;
    const quality = value?.quality;
    if (!run?.id || seen.has(String(run.id))) invalid('运行ID缺失或重复使用');
    seen.add(String(run.id));
    if (!TERMINAL.has(run.status)) invalid('必须包含终态运行，失败或取消记录也不能省略');
    if (!Array.isArray(value.detail.steps) || value.detail.warnings?.length) invalid('运行步骤缺失或详情包含读取失败警告');
    if (![value.contextDigest, value.modelConfigDigest, value.instructionDigest].every(item => DIGEST.test(item || ''))) invalid('缺少固定输入、模型配置或指引摘要');
    if (typeof quality?.passed !== 'boolean' || typeof quality?.evidence !== 'string' || !quality.evidence.trim()) invalid('缺少独立验收结果和证据位置');
    const regressions = count(quality.regressions, '回归缺陷数');
    const started = Date.parse(run.started_at); const completed = Date.parse(run.completed_at);
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) invalid('起止时间缺失或无效');
    const modelId = String(run.chosen_model_id || run.model_id || '');
    if (!modelId || !String(run.goal || '').trim()) invalid('缺少实际模型或任务目标');
    return {
        id: String(run.id), modelId, goal: run.goal, contextDigest: value.contextDigest, modelConfigDigest: value.modelConfigDigest, instructionDigest: value.instructionDigest,
        passed: run.status === 'completed' && quality.passed && regressions === 0, regressions,
        inputTokens: count(run.input_tokens, '输入Token'), outputTokens: count(run.output_tokens, '输出Token'),
        totalTokens: count(run.total_tokens, '总Token'),
        toolCalls: value.detail.steps.filter(step => step.type === 'tool').length, durationMs: completed - started
    };
}
function totals(rows) {
    return rows.reduce((result, item) => {
        for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'toolCalls', 'durationMs', 'regressions']) result[key] += item[key];
        result.passed += Number(item.passed);
        return result;
    }, { passed: 0, regressions: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, durationMs: 0 });
}
function compareCodeReviewRuns(document) {
    if (document?.schemaVersion !== 1 || !['fixture', 'measured'].includes(document.evidenceType) || !Array.isArray(document.pairs) || !document.pairs.length || document.pairs.length > 500) invalid('版本、证据类型或配对数量不正确');
    const runIds = new Set(); const pairIds = new Set(); const groups = new Map();
    for (const pair of document.pairs) {
        if (typeof pair.caseId !== 'string' || !pair.caseId.trim() || !Number.isSafeInteger(pair.repeat) || pair.repeat < 1) invalid('用例名称或重复次数不正确');
        const baseline = observation(pair.baseline, runIds); const candidate = observation(pair.candidate, runIds);
        if (baseline.modelId !== candidate.modelId || baseline.goal !== candidate.goal || baseline.contextDigest !== candidate.contextDigest || baseline.modelConfigDigest !== candidate.modelConfigDigest) invalid('两组必须使用相同模型、目标、输入快照、工具与模型参数配置');
        if (baseline.instructionDigest === candidate.instructionDigest) invalid('基线与候选指引相同，不能作为指引对照');
        const key = `${baseline.modelId}:${pair.caseId}:${pair.repeat}`;
        if (pairIds.has(key)) invalid('模型、用例和重复次数的配对重复');
        pairIds.add(key);
        if (!groups.has(baseline.modelId)) groups.set(baseline.modelId, []);
        groups.get(baseline.modelId).push({ caseId: pair.caseId, repeat: pair.repeat, baseline, candidate });
    }
    return {
        schemaVersion: 1, evidenceType: document.evidenceType,
        limitations: ['验收结论由提供的独立证据决定，运行完成不等于业务正确。', '摘要由评测组织者冻结，不能据此证明所有外部环境相同。', '仅统计实际记录，不估算费用、不外推上游收益或替代生产验收。'],
        models: [...groups].map(([modelId, pairs]) => {
            const baseline = totals(pairs.map(item => item.baseline)); const candidate = totals(pairs.map(item => item.candidate));
            const qualityNonDecreasing = pairs.every(item => (!item.baseline.passed || item.candidate.passed) && item.candidate.regressions <= item.baseline.regressions);
            return {
                modelId, pairs: pairs.length, cases: new Set(pairs.map(item => item.caseId)).size,
                baseline, candidate, qualityNonDecreasing,
                eligibleForPilot: document.evidenceType === 'measured' && qualityNonDecreasing && candidate.passed === pairs.length,
                delta: Object.fromEntries(['totalTokens', 'toolCalls', 'durationMs'].map(metric => [metric, {
                    absolute: candidate[metric] - baseline[metric],
                    percent: baseline[metric] ? Math.round((candidate[metric] / baseline[metric] - 1) * 10000) / 100 : null
                }])),
                runs: pairs.map(item => ({ caseId: item.caseId, repeat: item.repeat, baseline: item.baseline.id, candidate: item.candidate.id }))
            };
        })
    };
}

module.exports = { compareCodeReviewRuns };
