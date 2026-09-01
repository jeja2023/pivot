/**
 * server/services/agent-skill-rollout.js
 * 灰度分桶与熔断阈值
 *
 * 落地方案 v1.2 §6.3、阶段 0.5（修复 B8）：
 * 1. 分桶必须对「当前候选 Release」独立计算，不能用 candidates[0].id 给所有候选算同一个桶；
 * 2. 使用租户级密钥做 HMAC-SHA256，使桶位不可被外部预测（原实现为裸 SHA-256，
 *    userId 与 releaseId 均可预测）；
 * 3. 密钥版本记入 rollout_secret_version，轮换只影响新建 release，已发布 release 桶位保持稳定；
 * 4. 目标用户与目标团队为显式 allow-list，百分比只在命中受众后生效。
 */
const crypto = require('crypto');

/** 熔断阈值默认值。发布时冻结并写入 agent_skill_releases.breaker_thresholds。 */
const DEFAULT_BREAKER_THRESHOLDS = Object.freeze({
    minSamples: 20,
    policyDenyRate: 0.3,
    toolErrorRate: 0.2,
    timeoutRate: 0.1,
    negativeFeedbackRate: 0.2
});

function baseRolloutSecret(env = process.env) {
    const secret = String(env.PIVOT_SKILL_ROLLOUT_SECRET || '').trim();
    if (secret) return secret;
    // 未单独配置时回退到既有服务端密钥，保证同一部署内桶位稳定且不可被外部预测。
    return String(env.DATA_ENCRYPTION_KEY || env.JWT_SECRET || 'pivot-skill-rollout').trim();
}

/** 派生租户级灰度密钥。同一租户同一密钥版本恒定，跨租户互不可推断。 */
function resolveTenantRolloutSecret(tenantId, secretVersion = 1, env = process.env) {
    const version = Math.max(Number.parseInt(secretVersion, 10) || 1, 1);
    const tenant = Number.parseInt(tenantId, 10) || 0;
    return crypto.createHmac('sha256', baseRolloutSecret(env))
        .update(`skill-rollout:tenant:${tenant}:v${version}`)
        .digest();
}

/** 计算某个候选 Release 对某个用户的桶位（0-99）。 */
function computeRolloutBucket({ tenantId = 0, releaseId, userId, secretVersion = 1, env = process.env } = {}) {
    const secret = resolveTenantRolloutSecret(tenantId, secretVersion, env);
    return crypto.createHmac('sha256', secret)
        .update(`${Number.parseInt(userId, 10) || 0}:${String(releaseId ?? '')}`)
        .digest()
        .readUInt32BE(0) % 100;
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function toIntSet(value) {
    return new Set(parseJsonArray(value)
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0));
}

/**
 * 在候选 Release 中选择命中的一条。
 * @param {Array} releases 已按 published_at DESC 排序的候选行
 * @param {Object} user 当前用户
 * @param {Object} options.teamIds 当前用户的团队 id 列表（由调用方经 team_members 实时校验后传入）
 */
function chooseRolloutRelease(releases, user, options = {}) {
    const candidates = (releases || []).filter(item => item.status === 'published');
    if (!candidates.length) return null;
    const userId = Number.parseInt(user?.id, 10) || 0;
    const teamIds = new Set((Array.isArray(options.teamIds) ? options.teamIds : [])
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0));
    for (const candidate of candidates) {
        const targetUserIds = toIntSet(candidate.target_user_ids);
        const targetTeamIds = toIntSet(candidate.target_units);
        if (targetUserIds.size && !targetUserIds.has(userId)) continue;
        if (targetTeamIds.size && ![...targetTeamIds].some(id => teamIds.has(id))) continue;
        const percent = Math.max(Math.min(Number.parseInt(candidate.rollout_percent, 10) || 0, 100), 0);
        if (percent <= 0) continue;
        if (percent >= 100) return candidate;
        // 每个候选独立分桶：hash 在循环内按 candidate.id 计算，修复 B8。
        const bucket = computeRolloutBucket({
            tenantId: candidate.tenant_id,
            releaseId: candidate.id,
            userId,
            secretVersion: candidate.rollout_secret_version || 1,
            env: options.env
        });
        if (bucket < percent) return candidate;
    }
    return null;
}

/** 规范化并冻结熔断阈值快照。 */
function normalizeBreakerThresholds(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const clampRate = (value, fallback) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(Math.max(parsed, 0), 1);
    };
    return {
        minSamples: Math.max(Number.parseInt(source.minSamples ?? source.min_samples, 10) || DEFAULT_BREAKER_THRESHOLDS.minSamples, 1),
        policyDenyRate: clampRate(source.policyDenyRate ?? source.policy_deny_rate, DEFAULT_BREAKER_THRESHOLDS.policyDenyRate),
        toolErrorRate: clampRate(source.toolErrorRate ?? source.tool_error_rate, DEFAULT_BREAKER_THRESHOLDS.toolErrorRate),
        timeoutRate: clampRate(source.timeoutRate ?? source.timeout_rate, DEFAULT_BREAKER_THRESHOLDS.timeoutRate),
        negativeFeedbackRate: clampRate(source.negativeFeedbackRate ?? source.negative_feedback_rate, DEFAULT_BREAKER_THRESHOLDS.negativeFeedbackRate)
    };
}

/**
 * 依据冻结阈值判定是否应当自动暂停。样本量不足时不触发，避免小样本抖动导致误熔断。
 * @param {Object} metrics { samples, policyDenied, toolErrors, timeouts, negativeFeedback }
 */
function evaluateBreaker(thresholds, metrics = {}) {
    const limits = normalizeBreakerThresholds(thresholds);
    const samples = Math.max(Number.parseInt(metrics.samples, 10) || 0, 0);
    if (samples < limits.minSamples) return { tripped: false, reason: '', samples, limits };
    const rate = value => (Math.max(Number(value) || 0, 0) / samples);
    const checks = [
        ['policy_deny_rate', rate(metrics.policyDenied), limits.policyDenyRate],
        ['tool_error_rate', rate(metrics.toolErrors), limits.toolErrorRate],
        ['timeout_rate', rate(metrics.timeouts), limits.timeoutRate],
        ['negative_feedback_rate', rate(metrics.negativeFeedback), limits.negativeFeedbackRate]
    ];
    const hit = checks.find(([, actual, limit]) => actual > limit);
    if (!hit) return { tripped: false, reason: '', samples, limits };
    return { tripped: true, reason: hit[0], actual: hit[1], limit: hit[2], samples, limits };
}

module.exports = {
    DEFAULT_BREAKER_THRESHOLDS,
    chooseRolloutRelease,
    computeRolloutBucket,
    evaluateBreaker,
    normalizeBreakerThresholds,
    resolveTenantRolloutSecret
};
