/* 自动化维护服务 Maintenance Service */
const { db } = require('../db');
const { logger } = require('../logger');

/**
 * 自动清理陈旧的审计日志 (默认保留 180 天)
 */
function getAuditLogRetentionDays() {
    const days = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '180', 10);
    return Number.isFinite(days) && days > 0 ? days : 180;
}

async function cleanupOldLogs(days = getAuditLogRetentionDays()) {
    try {
        const info = db.prepare("DELETE FROM audit_logs WHERE timestamp < datetime('now', '+8 hours', ?)").run(`-${days} days`);
        
        if (info.changes > 0) {
            logger.info({ changes: info.changes, days }, '已清理陈旧审计日志');
        }
    } catch (e) {
        logger.error({ err: e.message }, '审计日志清理失败');
    }
}

/**
 * 启动定时维护任务
 */
function startMaintenanceTasks() {
    // 启动时立即运行一次清理
    const retentionDays = getAuditLogRetentionDays();
    cleanupOldLogs(retentionDays).catch(() => {});

    // 每 24 小时执行一次
    setInterval(() => {
        cleanupOldLogs(retentionDays).catch(() => {});
    }, 24 * 60 * 60 * 1000).unref();

    logger.info({ retentionDays }, '系统维护服务已启动 (日志清理周期: 24h)');
}

module.exports = {
    startMaintenanceTasks,
    cleanupOldLogs,
    getAuditLogRetentionDays
};
