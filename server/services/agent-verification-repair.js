'use strict';

const REPAIRABLE_RULES = new Set(['final_answer_non_empty', 'required_phrase', 'forbidden_phrase', 'min_length', 'valid_json', 'output_schema', 'artifact_required', 'required_artifact', 'deliverables_verified']);
const REPAIRABLE_REASONS = new Set(['source_not_fully_read', 'artifact_not_materialized']);

function canAttemptVerificationRepair(report, { allowed = false, remainingSteps = 0, budget = null } = {}) {
    if (!allowed || remainingSteps < 2 || report.outcomeStatus !== 'needs_input' || Number(report.taskContract?.repairAttempts || 0) >= 2) return false;
    const reason = report.semanticVerification?.reason;
    if (reason && !REPAIRABLE_REASONS.has(reason)) return false;
    const failures = report.hardFailures || [];
    if (!reason && (!failures.length || !failures.every(rule => REPAIRABLE_RULES.has(rule)))) return false;
    if (!reason && failures.includes('deliverables_verified')
        && !report.semanticVerification?.missing?.some(item => String(item || '').trim())) return false;
    if (budget) {
        const { counts, limits } = budget;
        const needsTool = REPAIRABLE_REASONS.has(reason) || failures.some(rule => ['artifact_required', 'required_artifact', 'deliverables_verified'].includes(rule));
        if (counts.tokens_total >= limits.max_tokens_total || (needsTool && counts.tool_calls >= limits.max_tool_calls) || counts.steps + 2 > limits.max_steps) return false;
        try { budget.assertWithin(); } catch (_) { return false; }
    }
    return true;
}

function buildVerificationRepairMessage(report) {
    return `任务验收发现仍可继续处理的内部缺口：${JSON.stringify({ hardFailures: report.hardFailures, reason: report.semanticVerification?.reason,
        missing: report.semanticVerification?.missing || [],
        rules: (report.rules || []).filter(rule => rule.passed === false).map(rule => ({ key: rule.key, actual: rule.actual })) })}。
请在当前授权、预算和剩余轮次内修复后再提交最终结果。资料未读完时使用 chat.read_source 分页读取；文件未生成时先创建真实文件。
保留已完成的业务结果，不重复发送、写入或提交外部动作；不得声称 executed:false 的契约读取完成了业务操作。只有确实缺少用户才能提供的业务事实时才询问用户。`;
}

module.exports = { buildVerificationRepairMessage, canAttemptVerificationRepair };
