/**
 * server/services/agent-skill-breaker.js
 * 技能发布熔断巡检与自动回滚
 *
 * 落地方案 v1.2 §6.3 第 5 条、阶段 4.3：
 * 1. 生产版本必须设置自动暂停阈值（策略拒绝率、工具错误率、超时率、用户负反馈率），
 *    阈值与最小样本量在发布时冻结并写入 agent_skill_releases.breaker_thresholds；
 * 2. 指标来源复用 agent_tool_calls 与 agent_feedback，不新建采集链路；
 * 3. 熔断触发后有上一版本则自动回滚，没有则暂停发布，两种情况都发通知。
 *
 * 巡检是系统行为，不代表某个用户的意图，因此走 agent-releases 的系统级动作，
 * 不复用面向请求的权限判定路径。
 */
const { query } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const { evaluateBreaker } = require('./agent-skill-rollout');
const { pauseSkillReleaseBySystem, rollbackSkillReleaseBySystem } = require('./agent-releases');
const { isMissingRelationError } = require('./agent-control-plane-state');

const DEFAULT_WINDOW_MINUTES = 30;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function parseThresholds(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '{}')) || {}; } catch (_) { return {}; }
}

function windowStart(minutes) {
    const safeMinutes = Math.max(1, Math.min(Number.parseInt(minutes, 10) || DEFAULT_WINDOW_MINUTES, 24 * 60));
    return getBeijingTimestamp(new Date(Date.now() - safeMinutes * 60 * 1000));
}

/**
 * 采集某个 release 在观察窗口内的运行指标。
 * run 与 release 的关联来自 agent_runs.metadata 中服务端写入的 skillReleaseId。
 */
async function collectReleaseMetrics(releaseId, since) {
    const toolRows = await query(`
        SELECT
            COUNT(*) AS samples,
            COALESCE(SUM(CASE WHEN c.policy_decision = 'denied' THEN 1 ELSE 0 END), 0) AS policy_denied,
            COALESCE(SUM(CASE WHEN c.status <> 'success' THEN 1 ELSE 0 END), 0) AS tool_errors,
            COALESCE(SUM(CASE WHEN c.error_category = 'timeout' THEN 1 ELSE 0 END), 0) AS timeouts
        FROM agent_tool_calls c
        JOIN agent_runs r ON r.id = c.run_id
        WHERE r.metadata->>'skillReleaseId' = ?
          AND c.created_at >= ?
    `, [String(releaseId), since]);
    const feedbackRows = await query(`
        SELECT COALESCE(SUM(CASE WHEN f.outcome = 'rejected' OR COALESCE(f.rating, 3) <= 2 THEN 1 ELSE 0 END), 0) AS negative_feedback
        FROM agent_feedback f
        JOIN agent_runs r ON r.id = f.run_id
        WHERE r.metadata->>'skillReleaseId' = ?
          AND f.created_at >= ?
    `, [String(releaseId), since]);
    const metrics = toolRows?.[0] || {};
    return {
        samples: Number(metrics.samples || 0),
        policyDenied: Number(metrics.policy_denied || 0),
        toolErrors: Number(metrics.tool_errors || 0),
        timeouts: Number(metrics.timeouts || 0),
        negativeFeedback: Number(feedbackRows?.[0]?.negative_feedback || 0)
    };
}

/**
 * 巡检所有已发布 release，超过冻结阈值的自动回滚或暂停。
 * 返回本轮的评估结果，便于管理端展示与测试断言。
 */
async function sweepSkillReleaseBreakers(options = {}) {
    const since = windowStart(options.windowMinutes);
    let releases = [];
    try {
        releases = await query(`
            SELECT id, name, tenant_id, owner_key, rollout_scope, previous_release_id, breaker_thresholds, published_by
            FROM agent_skill_releases
            WHERE status = 'published'
            ORDER BY published_at DESC
            LIMIT 200
        `);
    } catch (error) {
        if (isMissingRelationError(error)) return { evaluated: 0, tripped: 0, actions: [] };
        throw error;
    }
    const actions = [];
    for (const release of releases || []) {
        const thresholds = parseThresholds(release.breaker_thresholds);
        // 未冻结阈值的历史 release 不参与自动熔断，避免用默认值误伤存量发布。
        if (!Object.keys(thresholds).length) continue;
        const metrics = await collectReleaseMetrics(release.id, since);
        const decision = evaluateBreaker(thresholds, metrics);
        if (!decision.tripped) continue;
        const reason = `${decision.reason} 实际 ${(decision.actual * 100).toFixed(1)}% 超过阈值 ${(decision.limit * 100).toFixed(1)}%（样本 ${decision.samples}）`;
        try {
            const action = release.previous_release_id
                ? await rollbackSkillReleaseBySystem(release, reason)
                : await pauseSkillReleaseBySystem(release, reason);
            actions.push({ releaseId: release.id, name: release.name, action: action.action, reason });
            logger.warn({ releaseId: release.id, name: release.name, reason, action: action.action }, '技能发布触发熔断');
        } catch (error) {
            logger.error({ releaseId: release.id, err: error.message }, '技能发布熔断处置失败');
        }
    }
    return { evaluated: (releases || []).length, tripped: actions.length, actions };
}

/** 周期性巡检器。间隔由 PIVOT_SKILL_BREAKER_INTERVAL_MS 控制，默认 5 分钟。 */
function createSkillReleaseBreakerRunner(options = {}) {
    const intervalMs = Math.max(
        60 * 1000,
        Number.parseInt(options.intervalMs ?? process.env.PIVOT_SKILL_BREAKER_INTERVAL_MS, 10) || DEFAULT_INTERVAL_MS
    );
    let timer = null;
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await sweepSkillReleaseBreakers(options);
        } catch (error) {
            logger.warn({ err: error.message }, '技能发布熔断巡检失败');
        } finally {
            running = false;
        }
    };
    return {
        start() {
            if (timer) return timer;
            timer = setInterval(tick, intervalMs);
            timer.unref?.();
            return timer;
        },
        stop() {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        },
        tick,
        intervalMs
    };
}

module.exports = {
    DEFAULT_INTERVAL_MS,
    DEFAULT_WINDOW_MINUTES,
    collectReleaseMetrics,
    createSkillReleaseBreakerRunner,
    sweepSkillReleaseBreakers
};
