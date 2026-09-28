'use strict';

const { execute, query } = require('../db/client');
const { readTypedEnv } = require('../config/env-registry');
const { getDecisionOperationalMetrics } = require('./decision-observability');
const { logger } = require('../logger');

const READINESS_SQL = [
    'SELECT d.tenant_id, d.scenario,',
    'COUNT(*) FILTER (WHERE o.is_verified = TRUE) AS verified_samples,',
    "COUNT(*) FILTER (WHERE o.event_type = 'feedback') AS user_feedback_events,",
    "COUNT(*) FILTER (WHERE o.event_type = 'execution' AND o.status = 'failure') AS execution_failures,",
    'MAX(o.occurred_at) AS last_outcome_at',
    'FROM decision_records d',
    'LEFT JOIN decision_outcomes o ON o.decision_id = d.decision_id',
    'LEFT JOIN users u ON u.id = d.user_id',
    "WHERE d.created_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 day')",
    "AND d.user_id IS NOT NULL AND u.deleted_at IS NULL AND COALESCE(u.status, 'active') <> 'disabled'",
    'GROUP BY d.tenant_id, d.scenario ORDER BY d.tenant_id NULLS LAST, d.scenario'
].join(' ');

const ERROR_BREAKDOWN_SQL = [
    'SELECT d.tenant_id, d.scenario, o.status,',
    "COALESCE(NULLIF(o.reason_code, ''), 'unspecified') AS reason_code, COUNT(*) AS count",
    'FROM decision_outcomes o JOIN decision_records d ON d.decision_id = o.decision_id',
    "WHERE o.occurred_at >= CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 day')",
    "AND ((o.event_type = 'execution' AND o.status IN ('failure', 'partial')) OR o.event_type = 'feedback')",
    "GROUP BY d.tenant_id, d.scenario, o.status, COALESCE(NULLIF(o.reason_code, ''), 'unspecified')",
    'ORDER BY count DESC, d.tenant_id NULLS LAST, d.scenario, reason_code LIMIT 500'
].join(' ');


function getDecisionMaintenanceConfig(env = process.env) {
    return {
        enabled: readTypedEnv('PIVOT_DECISION_MAINTENANCE_ENABLED', env),
        intervalMs: readTypedEnv('PIVOT_DECISION_MAINTENANCE_INTERVAL_MS', env),
        lookbackDays: readTypedEnv('PIVOT_DECISION_MAINTENANCE_LOOKBACK_DAYS', env),
        minimumVerifiedSamples: readTypedEnv('PIVOT_DECISION_MIN_VERIFIED_SAMPLES', env),
        retentionDays: readTypedEnv('PIVOT_DECISION_RECORD_RETENTION_DAYS', env)
    };
}
const CLEANUP_EXPIRED_DECISIONS_SQL = "DELETE FROM decision_records WHERE created_at < CURRENT_TIMESTAMP - (?::integer * INTERVAL '1 day')";

async function cleanupExpiredDecisionRecords({ retentionDays } = {}, deps = {}) {
    const safeRetentionDays = Math.max(1, Math.min(Number.parseInt(retentionDays, 10) || 180, 3650));
    const deleted = await (deps.execute || execute)(CLEANUP_EXPIRED_DECISIONS_SQL, [safeRetentionDays]);
    // decision_outcomes 通过外键 ON DELETE CASCADE 清除；模型制品与冻结评测审计永不在此任务中删除。
    return { retentionDays: safeRetentionDays, deletedRecords: Math.max(0, Number(deleted) || 0) };
}


async function getDecisionMaintenanceReport(options = {}, deps = {}) {
    const config = { ...getDecisionMaintenanceConfig(options.env), ...options };
    const lookbackDays = Math.max(1, Math.min(Number.parseInt(config.lookbackDays, 10) || 30, 3650));
    const minimumVerifiedSamples = Math.max(1, Math.min(Number.parseInt(config.minimumVerifiedSamples, 10) || 30, 100000));
    try {
        const [rows, operations, errorRows] = await Promise.all([
            (deps.query || query)(READINESS_SQL, [lookbackDays]),
            (deps.getDecisionOperationalMetrics || getDecisionOperationalMetrics)({ minutes: lookbackDays * 24 * 60 }, deps),
            (deps.query || query)(ERROR_BREAKDOWN_SQL, [lookbackDays])
        ]);
        const readiness = (rows || []).map(row => ({
            tenantId: row.tenant_id ? Number(row.tenant_id) : null,
            scenario: row.scenario,
            verifiedSamples: Number(row.verified_samples || 0),
            userFeedbackEvents: Number(row.user_feedback_events || 0),
            executionFailures: Number(row.execution_failures || 0),
            readyForTraining: Number(row.verified_samples || 0) >= minimumVerifiedSamples,
            lastOutcomeAt: row.last_outcome_at || null
        }));
        return { unavailable: false, lookbackDays, minimumVerifiedSamples, readiness, errorBreakdown: (errorRows || []).map(row => ({ tenantId: row.tenant_id ? Number(row.tenant_id) : null, scenario: row.scenario, status: row.status, reasonCode: row.reason_code, count: Number(row.count || 0) })), operations };
    } catch (error) {
        return { unavailable: true, lookbackDays, minimumVerifiedSamples, readiness: [], operations: null, errorCode: String(error?.code || 'maintenance_unavailable').slice(0, 80) };
    }
}

function startDecisionLearningMaintenanceRunner(options = {}) {
    const config = { ...getDecisionMaintenanceConfig(options.env), ...options };
    if (config.enabled !== true) return null;
    const log = options.logger || logger;
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const cleanup = await (options.cleanupExpiredDecisionRecords || cleanupExpiredDecisionRecords)({
                retentionDays: config.retentionDays
            }, options);
            const report = await (options.getDecisionMaintenanceReport || getDecisionMaintenanceReport)({
                lookbackDays: config.lookbackDays,
                minimumVerifiedSamples: config.minimumVerifiedSamples,
                env: options.env
            });
            if (report.unavailable) log.warn({ errorCode: report.errorCode }, '决策学习维护巡检暂不可用');
            else log.info({ readiness: report.readiness, providerCount: report.operations?.providers?.length || 0, cleanup }, '决策学习维护巡检完成');
        } catch (error) {
            log.warn({ err: error.message }, '决策学习维护巡检失败');
        } finally {
            running = false;
        }
    };
    const initial = setTimeout(() => { void tick(); }, 15000);
    initial.unref?.();
    const timer = setInterval(() => { void tick(); }, Math.max(60000, Number(config.intervalMs) || 6 * 60 * 60 * 1000));
    timer.unref?.();
    return timer;
}

module.exports = {
    cleanupExpiredDecisionRecords,
    getDecisionMaintenanceReport,
    startDecisionLearningMaintenanceRunner
};
