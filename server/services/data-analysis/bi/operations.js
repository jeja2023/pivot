'use strict';

const { performance } = require('node:perf_hooks');
const repository = require('../../../repositories/analysis-operations');
const { readTypedEnv } = require('../../../config/env-registry');
const { resolveAnalysisUser } = require('../shared');
const { hasPermissionCapability } = require('../../../permissions');
const { LATENCIES, classify, operation } = require('./operation-classification');
const { biError } = require('./errors');

async function requireOperator(user) {
    const actor = await resolveAnalysisUser(Number(user?.id), { maintenance: true });
    if (!actor || actor.status !== 'active' || actor.deleted_at || !hasPermissionCapability(actor, 'manageGlobalSettings')) throw biError('ANALYSIS_OPERATIONS_FORBIDDEN', '仅系统管理员可查看和维护数据建模运行监测。', 403);
    return actor;
}

function controlMiddleware(req, res, next) {
    const route = String(req.path || req.url || '').split('?')[0];
    if (!/^\/(?:models|model-reviews|async-queries|ingestions|model-migrations|model-transfers|ownership-transfers)(?:\/|$)/.test(route)) return next();
    const started = performance.now();
    res.once('finish', () => {
        void repository.control({ operation: operation(req.method, route), outcome: classify({ status: res.statusCode, code: res.locals?.analysisErrorCode }), durationMs: performance.now() - started })
            .catch(error => require('../../../logger').logger.warn({ err: error.message }, '数据建模控制接口监测记录失败'));
    });
    next();
}

function aggregate(samples, domain) {
    const rows = samples.filter(row => row.domain === domain), counts = Object.fromEntries(['success', 'platform_failure', 'auth_denied', 'invalid', 'cancelled', 'quota_exceeded'].map(name => [name, 0]));
    const histogram = LATENCIES.map(() => 0); let qualityFailures = 0;
    for (const row of rows) {
        counts[row.outcome] += Number(row.count); qualityFailures += Number(row.quality_failures);
        if (['success', 'platform_failure'].includes(row.outcome)) row.latency_counts.forEach((count, i) => { histogram[i] += Number(count); });
    }
    const eligible = counts.success + counts.platform_failure, allowedFailures = eligible * 0.001;
    let cumulative = 0, p95UpperBoundMs = null;
    if (eligible) for (let i = 0; i < histogram.length; i++) { cumulative += histogram[i]; if (cumulative >= Math.ceil(eligible * 0.95)) { p95UpperBoundMs = i === histogram.length - 1 ? null : LATENCIES[i]; break; } }
    return { counts, eligible, availability: eligible ? counts.success / eligible : null, target: 0.999, allowedFailures, remainingFailureBudget: allowedFailures - counts.platform_failure,
        exhausted: eligible > 0 && counts.platform_failure > allowedFailures, qualityFailures, p95UpperBoundMs, latencyHistogram: { upperBoundsMs: LATENCIES.slice(0, -1).concat(null), counts: histogram } };
}

async function snapshot() {
    const [samples, state, health, storage, security] = await Promise.all([repository.samples(), repository.state(), repository.health(), require('./readiness').storageState({ write: false }), require('./security-journal').health()]);
    const { getPgPool } = require('../../../db/pg-connection'), pool = getPgPool();
    const observedSeconds = Math.max(0, Math.min(30 * 86400, (Date.now() - new Date(state.monitoring_started_at).getTime()) / 1000));
    return { observedSince: state.monitoring_started_at, observedSeconds, complete30DayWindow: observedSeconds >= 30 * 86400, control: aggregate(samples, 'control'), tasks: aggregate(samples, 'task'),
        health, storage, security, databasePool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }, probe: { configured: Boolean(state.probe_config_json.enabled), revision: Number(state.probe_revision), outcome: state.probe_outcome, startedAt: state.probe_started_at, finishedAt: state.probe_finished_at, error: state.probe_error },
        accessFenced: state.access_fenced, fenceReason: state.fence_reason, lastTickAt: state.last_tick_at, lastWorkerPollAt: state.last_worker_poll_at, lastError: state.last_error };
}

function alerts(snapshot) {
    const result = [], add = (code, severity, message, details = {}) => result.push({ code, severity, message, details });
    if (snapshot.control.exhausted || snapshot.tasks.exhausted) add('budget_exhausted', 'critical', '数据建模误差预算已耗尽，请暂停非修复性生产变更。', { control: snapshot.control.counts, tasks: snapshot.tasks.counts });
    if (snapshot.storage.usedPercent >= 70) add('storage_pressure', snapshot.storage.usedPercent >= 85 ? 'critical' : 'warning', '数据建模存储空间达到保护阈值，请检查容量与引用保留。', snapshot.storage);
    if (Number(snapshot.health.waiting)) add('queue_wait', 'warning', '数据建模存在等待超过三十秒的任务，请检查预算与公平调度。');
    if (Number(snapshot.health.orphan_slots)) add('orphan_executor', 'critical', '数据建模存在失联或终态占用的执行槽位，请先隔离执行器再回收。');
    if (Number(snapshot.health.integrity_findings)) add('integrity_findings', 'critical', '数据建模完整性巡检发现未处理异常，请恢复来源或对象。');
    if (Number(snapshot.health.stale_models)) add('stale_data', 'warning', '数据建模存在陈旧或刷新失败的模型，请检查刷新来源。');
    if (snapshot.health.recovery_age_seconds === null || Number(snapshot.health.recovery_age_seconds) > 900) add('recovery_point_lag', 'critical', '数据建模共同恢复点缺失或超过十五分钟，请检查独立备份链。');
    if (Number(snapshot.health.audit_lag_seconds) > 30) add('audit_delivery_lag', 'critical', '数据建模安全审计尚未完成独立持久确认，请检查日志副本与事件缺口。');
    if (Number(snapshot.health.memory_peak_bytes) > 2 * 1024 ** 3 || Number(snapshot.health.spill_peak_bytes) > 8 * 1024 ** 3) add('hard_resource_limit', 'critical', '数据建模执行资源超过硬上限，请立即隔离执行器并核对部署。');
    if (!snapshot.probe.configured) add('probe_unconfigured', 'warning', '数据建模尚未配置专用正向与反向合成监控。');
    else if (snapshot.probe.outcome === 'failed') add('probe_failed', 'critical', '数据建模合成监控未完成合同，请核对专用账号、任务和来源。');
    else if (!snapshot.probe.finishedAt || Date.now() - new Date(snapshot.probe.finishedAt).getTime() > 90000) add('probe_stale', 'critical', '数据建模合成监控结果超过九十秒，请检查监控账号与任务执行。');
    if (snapshot.accessFenced) add('correctness_fenced', 'critical', '数据建模统计或权限核对异常，业务分析已暂停。');
    if (snapshot.security && !snapshot.security.disabled && !snapshot.security.independentAvailable) add('security_journal_unavailable', 'critical', '独立安全记录不可验证，请核对日志副本、密钥和高水位。');
    if (snapshot.security?.mode === 'recovery_required') add('security_recovery_required', 'critical', '当前身份与授权尚未完成恢复签认，读取保持关闭。');
    if (!snapshot.lastWorkerPollAt || Date.now() - new Date(snapshot.lastWorkerPollAt).getTime() > 30000) add('worker_heartbeat_stale', 'critical', '数据建模调度心跳超过三十秒，请检查单活 API 与执行调度。');
    return result;
}

async function tick() {
    if (!readTypedEnv('DATA_ANALYSIS_MODEL_ENABLED')) return { disabled: true };
    try {
        await require('./operation-probe').tick();
        const current = await snapshot(), findings = alerts(current);
        for (const finding of await repository.alertsToEmit(findings)) await require('../../observability').recordObservabilityEvent({ type: 'system', source: `data-analysis.bi.${finding.code}`, severity: finding.severity, message: finding.message, details: finding.details });
        await repository.tick();
        return { ...current, alerts: findings };
    } catch (error) { await repository.tick(error.message).catch(() => {}); throw error; }
}

async function overview(user) { await requireOperator(user); const current = await snapshot(); return { ...current, alerts: alerts(current) }; }
async function fullPreflight(user) { await requireOperator(user); await repository.assertIdleForPreflight(); return require('./readiness').ensureReady({ force: true }); }
async function resume(user, reason) {
    const actor = await requireOperator(user);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw biError('ANALYSIS_OPERATIONS_INVALID', '恢复分析前请填写五百字以内的核对与修复原因。');
    return repository.resume(actor.id, reason.trim());
}

async function fence(user, reason) {
    const actor = await requireOperator(user);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw biError('ANALYSIS_OPERATIONS_INVALID', '暂停业务分析前请填写五百字以内的事故与核查原因。');
    await repository.fence(reason.trim(), { userId: actor.id, actor: 'operator' });
    return { accessFenced: true };
}

module.exports = { requireOperator, controlMiddleware, overview, fullPreflight, tick, resume, fence, aggregate, alerts };
