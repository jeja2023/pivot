'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { cleanupOldLogs, getAuditLogRetentionDays, getMaintenanceStatus } = require('../server/services/maintenance');

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

test('审计保留期默认一年，异常值不能缩短为零天或截断的小数', () => {
    const previous = process.env.AUDIT_LOG_RETENTION_DAYS;
    try {
        delete process.env.AUDIT_LOG_RETENTION_DAYS;
        assert.equal(getAuditLogRetentionDays(), 365);
        for (const value of ['', 'bad', '0', '-1', '1.5', '180days', 'Infinity']) {
            process.env.AUDIT_LOG_RETENTION_DAYS = value;
            assert.equal(getAuditLogRetentionDays(), 365, value);
        }
        for (const days of [180, 365, 730]) {
            process.env.AUDIT_LOG_RETENTION_DAYS = String(days);
            assert.equal(getAuditLogRetentionDays(), days);
        }
        process.env.AUDIT_LOG_RETENTION_DAYS = '999999';
        assert.equal(getAuditLogRetentionDays(), 36500);
    } finally {
        restoreEnv('AUDIT_LOG_RETENTION_DAYS', previous);
    }
});

test('到期审计默认一年后删除，保全及异常开关阻止删除，解除后恢复', {
    skip: !/^pivot_test_[a-z0-9_]+$/.test(process.env.PG_TEST_SCHEMA || '')
}, async () => {
    const previousDays = process.env.AUDIT_LOG_RETENTION_DAYS;
    const previousPause = process.env.AUDIT_LOG_CLEANUP_PAUSED;
    const action = `审计保全回归-${process.pid}-${Date.now()}`;
    const insert = days => execute(`INSERT INTO audit_logs (action, details, timestamp)
        VALUES (?, '审计保全回归记录', now() AT TIME ZONE 'Asia/Shanghai' - (? || ' days')::interval)`, [action, String(days)]);
    const countLogs = async () => Number((await queryOne('SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?', [action])).count);
    try {
        delete process.env.AUDIT_LOG_RETENTION_DAYS;
        process.env.AUDIT_LOG_CLEANUP_PAUSED = 'false';
        await insert(400);
        await insert(200);
        await insert(7);
        assert.ok(await cleanupOldLogs() >= 1);
        assert.equal(await countLogs(), 2, '默认清理不能删除仍在一年保留期内的记录');
        const successAt = getMaintenanceStatus().auditCleanup.lastSuccessAt;
        const totalChanges = getMaintenanceStatus().auditCleanup.totalChanges;

        await insert(450);
        process.env.AUDIT_LOG_CLEANUP_PAUSED = 'true';
        assert.equal(getMaintenanceStatus().auditCleanup.paused, true);
        assert.equal(await cleanupOldLogs(1), 0, '直接调用删除入口也必须遵守保全开关');
        await insert(0);
        assert.equal(await countLogs(), 4, '保全期间仍可写入和读取新日志');
        const paused = getMaintenanceStatus().auditCleanup;
        assert.equal(paused.paused, true);
        assert.equal(paused.lastChanges, 0);
        assert.equal(paused.totalChanges, totalChanges);
        assert.equal(paused.lastSuccessAt, successAt, '跳过清理不能伪造成功时间');
        assert.ok(paused.lastSkippedAt);
        const { renderPrometheusMetrics } = require('../server/metrics');
        assert.match(await renderPrometheusMetrics(), /pivot_audit_log_cleanup_paused 1/);

        process.env.AUDIT_LOG_CLEANUP_PAUSED = 'flase';
        assert.equal(await cleanupOldLogs(), 0);
        assert.equal(await countLogs(), 4);

        process.env.AUDIT_LOG_CLEANUP_PAUSED = 'false';
        assert.ok(await cleanupOldLogs(0) >= 1);
        assert.equal(await countLogs(), 3, '非法零天参数回退一年，不能删除全部日志');
        assert.equal(getMaintenanceStatus().auditCleanup.retentionDays, 365);
        assert.equal(getMaintenanceStatus().auditCleanup.paused, false);
        const metrics = await renderPrometheusMetrics();
        assert.match(metrics, /pivot_audit_log_cleanup_paused 0/);
        assert.match(metrics, /pivot_audit_log_retention_days 365/);

        process.env.AUDIT_LOG_RETENTION_DAYS = '180';
        assert.ok(await cleanupOldLogs() >= 1);
        assert.equal(await countLogs(), 2, '继续支持已确认的部署自定义保留期');
        assert.equal(getMaintenanceStatus().retentionDays, 180);
        assert.ok(await queryOne('SELECT id FROM audit_logs WHERE action = ?', [action]));
    } finally {
        restoreEnv('AUDIT_LOG_RETENTION_DAYS', previousDays);
        restoreEnv('AUDIT_LOG_CLEANUP_PAUSED', previousPause);
        await execute('DELETE FROM audit_logs WHERE action = ?', [action]);
    }
});

test.after(async () => require('../server/db/pg-connection').closePgPool());
