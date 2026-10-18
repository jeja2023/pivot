'use strict';

/*
 * 评测发布门禁的纯策略层。
 *
 * 通过率本身不能证明发布安全：冒烟用例、无硬断言的结果、或遗漏对抗场景的
 * 100% 都不得作为组织灰度的证据。本模块只判定已经冻结的评测证据，不调用模型，
 * 也不允许评分替代安全/授权等硬失败。
 */
const EVALUATION_TIERS = Object.freeze(new Set(['contract', 'scenario', 'adversarial']));

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeEvaluationTier(value, fallback = 'legacy') {
    const tier = String(value || '').trim().toLowerCase();
    return EVALUATION_TIERS.has(tier) ? tier : fallback;
}

function resultSnapshot(result = {}) {
    return parseJson(result.case_snapshot || result.caseSnapshot, {});
}

function resultGrade(result = {}) {
    return parseJson(result.grader_results || result.graderResults, {});
}

function unique(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
}

function assessEvaluationReleaseGate(evaluation = {}, options = {}) {
    const run = evaluation?.run || {};
    const results = Array.isArray(evaluation?.results) ? evaluation.results : [];
    const minPassRate = Math.max(1, Math.min(Number(options.minPassRate || options.min_pass_rate || 80) || 80, 100));
    const minCases = Math.max(1, Math.min(Number(options.minCases || options.min_cases || 1) || 1, 1000));
    const targetVersionId = Number(options.targetVersionId || options.target_version_id || 0) || 0;
    const requiredTiers = unique(options.requiredTiers || options.required_tiers || ['contract', 'scenario'])
        .map(tier => normalizeEvaluationTier(tier, ''))
        .filter(Boolean);
    if (options.requireAdversarial === true || options.require_adversarial === true) requiredTiers.push('adversarial');
    const expectedTiers = unique(requiredTiers);
    const requiredJudgeCount = Math.max(0, Math.min(Number(options.requiredJudgeCount || options.required_judge_count || 0) || 0, 4));
    const judgeConsensus = Array.isArray(options.judgeConsensus || options.judge_consensus) ? (options.judgeConsensus || options.judge_consensus) : [];
    const blockers = [];
    const warnings = [];
    const targetSnapshot = parseJson(run.target_snapshot || run.targetSnapshot, {});
    const summary = parseJson(run.summary, run.summary || {});
    if (String(run.status || '') !== 'completed') blockers.push({ code: 'EVALUATION_NOT_COMPLETED', message: '评测批次尚未完成。' });
    if (targetVersionId && Number(targetSnapshot.workflowVersionId || 0) !== targetVersionId) {
        blockers.push({ code: 'EVALUATION_TARGET_VERSION_MISMATCH', message: '评测证据不属于拟发布的工作流版本。' });
    }
    if (results.length < minCases) blockers.push({ code: 'EVALUATION_CASE_COUNT_INSUFFICIENT', message: `至少需要 ${minCases} 条冻结评测用例。` });
    const passed = results.filter(result => result.passed === true || Number(result.passed || 0) === 1).length;
    const calculatedPassRate = results.length ? Math.round((passed / results.length) * 100) : 0;
    const passRate = Number(summary.passRate ?? summary.pass_rate ?? calculatedPassRate) || 0;
    if (passRate < minPassRate) blockers.push({ code: 'EVALUATION_PASS_RATE_TOO_LOW', message: `评测通过率 ${passRate}% 低于门槛 ${minPassRate}%。` });
    const coveredTiers = new Set();
    for (const result of results) {
        const snapshot = resultSnapshot(result);
        const assertions = snapshot.assertions && typeof snapshot.assertions === 'object' ? snapshot.assertions : {};
        const tier = normalizeEvaluationTier(assertions.evaluationTier || assertions.evaluation_tier, 'legacy');
        coveredTiers.add(tier);
        const grade = resultGrade(result);
        const name = String(snapshot.name || result.case_name || result.caseName || result.case_id || result.id || '未知用例').slice(0, 160);
        if (String(result.status || '') !== 'passed') {
            blockers.push({ code: 'EVALUATION_CASE_NOT_PASSED', case: name, message: `用例「${name}」未通过。` });
        }
        if (grade.smokeOnly === true || grade.qualityEligible === false) {
            blockers.push({ code: 'EVALUATION_SMOKE_ONLY', case: name, message: `用例「${name}」只是冒烟检查，不能作为发布质量证据。` });
        }
        const hardFailures = Array.isArray(grade.hardFailures) ? grade.hardFailures : [];
        if (hardFailures.length) {
            blockers.push({ code: 'EVALUATION_HARD_FAILURE', case: name, message: `用例「${name}」存在硬失败：${hardFailures.join('、')}。` });
        }
        if (tier === 'legacy') {
            blockers.push({ code: 'EVALUATION_TIER_UNDECLARED', case: name, message: `用例「${name}」未声明 contract/scenario/adversarial 层级。` });
        }
    }
    expectedTiers.forEach(tier => {
        if (!coveredTiers.has(tier)) blockers.push({ code: 'EVALUATION_TIER_MISSING', tier, message: `评测集缺少 ${tier} 层用例。` });
    });
    if (requiredJudgeCount > 0) {
        const consensusByResult = new Map(judgeConsensus.map(item => [Number(item.evalResultId || item.eval_result_id || 0), item]));
        for (const result of results) {
            const id = Number(result.id || 0);
            const consensus = consensusByResult.get(id);
            const name = String(resultSnapshot(result).name || result.case_name || id || '未知用例').slice(0, 160);
            if (!consensus || Number(consensus.judgeCount || 0) < requiredJudgeCount) {
                blockers.push({ code: 'JUDGE_EVIDENCE_MISSING', case: name, message: `用例「${name}」缺少 ${requiredJudgeCount} 名独立裁判的结论。` });
                continue;
            }
            if (consensus.requiresHumanReview === true || consensus.decision === 'needs_human_review') {
                blockers.push({ code: 'JUDGE_HUMAN_REVIEW_REQUIRED', case: name, message: `用例「${name}」的独立裁判存在分歧或低置信度，必须人工复核。` });
            } else if (consensus.decision !== 'pass') {
                blockers.push({ code: 'JUDGE_REJECTED', case: name, message: `用例「${name}」未获独立裁判放行。` });
            }
        }
    }
    if (!results.length) warnings.push('没有可用于发布门禁的结果明细。');
    return {
        passed: blockers.length === 0,
        blockers,
        warnings,
        evidence: {
            evaluationRunId: String(run.id || ''),
            targetVersionId: Number(targetSnapshot.workflowVersionId || 0) || null,
            caseCount: results.length,
            passedCases: passed,
            passRate,
            requiredTiers: expectedTiers,
            coveredTiers: [...coveredTiers].sort(),
            requiredJudgeCount
        }
    };
}

function requiresAdversarialCoverage(impact = {}) {
    const summary = impact?.summary || {};
    return Number(summary.sideEffectCount || 0) > 0
        || Number(summary.networkCount || 0) > 0
        || Number(summary.credentialCount || 0) > 0;
}

module.exports = {

    assessEvaluationReleaseGate,
    normalizeEvaluationTier,
    requiresAdversarialCoverage
};
