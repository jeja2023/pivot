'use strict';

const { redactRoutingText } = require('./decision-provider');
const REASONS = Object.freeze({
    source_revoked: '原始资料已变化或不可访问', source_not_fully_read: '尚未读取完整资料',
    artifact_not_materialized: '尚未生成要求的文件', artifact_format_missing: '缺少用户要求的文件格式',
    artifact_integrity_failed: '生成文件未通过完整性检查', verifier_unavailable: '交付核验模型或服务不可用',
    verifier_timeout: '交付核验调用超时', verifier_invalid_response: '核验模型返回格式无效',
    budget_exceeded: '核验时任务预算已耗尽', deliverables_missing: '交付内容遗漏要求', verification_rejected: '交付核验未通过',
    verification_not_recorded: '未记录交付核验报告', historical_details_unavailable: '历史失败细节未保存，当前报告已通过'
});
const RULES = Object.freeze({ final_answer_non_empty: '未生成有效答案', evidence: '缺少可核验来源', required_phrase: '缺少要求的内容',
    forbidden_phrase: '包含禁止的内容', min_length: '答复长度不足', valid_json: '结果不是有效JSON', output_schema: '结果结构不符合要求',
    artifact_required: '尚未生成要求的文件', required_artifact: '缺少指定文件', deliverables_verified: '交付内容未通过独立核验', knowledge_sources_current: '资料来源已失效' });
function verificationText(value, limit = 500) { return redactRoutingText(String(value || '')).replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>"|；;]+/g, '[路径已隐藏]').slice(0, limit); }
function verificationStrings(value, max = 12) { return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, max).map(item => verificationText(item)).filter(Boolean) : []; }
function verificationDetails(report, { historical = false } = {}) {
    if (!report || typeof report !== 'object') return { reasonCode: 'verification_not_recorded', label: REASONS.verification_not_recorded, missing: [], ruleFailures: [] };
    if (historical && report.outcomeStatus === 'verified') return { reasonCode: 'historical_details_unavailable', label: REASONS.historical_details_unavailable, missing: [], ruleFailures: [] };
    const semantic = report.semanticVerification || {};
    const missing = verificationStrings(semantic.missing);
    const failures = verificationStrings(report.hardFailures).map(key => ({ key, label: RULES[key] || '未通过验收条件',
        detail: verificationText((Array.isArray(report.rules) ? report.rules : []).find(rule => rule.key === key && !rule.passed)?.actual, 300) }));
    const reasonCode = verificationText(semantic.reason || (missing.length ? 'deliverables_missing' : failures[0]?.key || 'verification_rejected'), 100);
    return { reasonCode, label: REASONS[reasonCode] || RULES[reasonCode] || '核验未通过，详见缺失项', missing,
        ruleFailures: failures, executionReason: verificationText(report.reason, 500), verifier: verificationText(semantic.verifier, 100), checkedAt: verificationText(report.verifiedAt, 64) };
}
module.exports = { verificationDetails, verificationReasonLabel: code => REASONS[code] || RULES[code] || '交付核验未通过' };
