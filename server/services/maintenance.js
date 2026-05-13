/* Automated maintenance service */
const { db } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');

const maintenanceState = {
    startedAt: null,
    retentionDays: null,
    auditCleanup: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: '',
        lastChanges: 0,
        totalChanges: 0
    },
    apiCallLogCleanup: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: '',
        lastChanges: 0,
        totalChanges: 0,
        retentionDays: 30
    },
    refreshTokenCleanup: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: '',
        lastChanges: 0,
        totalChanges: 0
    },
    optimize: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: ''
    }
};

function getAuditLogRetentionDays() {
    const days = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '180', 10);
    return Number.isFinite(days) && days > 0 ? days : 180;
}

function getApiCallLogRetentionDays() {
    const days = parseInt(process.env.API_CALL_LOG_RETENTION_DAYS || '30', 10);
    return Number.isFinite(days) && days > 0 ? days : 30;
}

async function cleanupOldLogs(days = getAuditLogRetentionDays()) {
    maintenanceState.auditCleanup.lastRunAt = getBeijingTimestamp();
    try {
        const info = db.prepare("DELETE FROM audit_logs WHERE timestamp < datetime('now', '+8 hours', ?)").run(`-${days} days`);
        const changes = info.changes || 0;
        maintenanceState.auditCleanup.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.auditCleanup.lastError = '';
        maintenanceState.auditCleanup.lastChanges = changes;
        maintenanceState.auditCleanup.totalChanges += changes;
        if (changes > 0) {
            logger.info({ changes, days }, 'Old audit logs cleaned');
        }
        return changes;
    } catch (e) {
        maintenanceState.auditCleanup.lastError = e.message;
        logger.error({ err: e.message }, 'Audit log cleanup failed');
        return 0;
    }
}

async function cleanupApiCallLogs(days = getApiCallLogRetentionDays()) {
    maintenanceState.apiCallLogCleanup.lastRunAt = getBeijingTimestamp();
    maintenanceState.apiCallLogCleanup.retentionDays = days;
    try {
        const info = db.prepare("DELETE FROM api_call_logs WHERE created_at < datetime('now', '+8 hours', ?)").run(`-${days} days`);
        const changes = info.changes || 0;
        maintenanceState.apiCallLogCleanup.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.apiCallLogCleanup.lastError = '';
        maintenanceState.apiCallLogCleanup.lastChanges = changes;
        maintenanceState.apiCallLogCleanup.totalChanges += changes;
        if (changes > 0) {
            logger.info({ changes, days }, 'Old API call logs cleaned');
        }
        return changes;
    } catch (e) {
        maintenanceState.apiCallLogCleanup.lastError = e.message;
        logger.error({ err: e.message }, 'API call log cleanup failed');
        return 0;
    }
}

async function cleanupExpiredRefreshTokens() {
    maintenanceState.refreshTokenCleanup.lastRunAt = getBeijingTimestamp();
    try {
        const info = db.prepare("DELETE FROM refresh_tokens WHERE expires_at < datetime('now', '+8 hours')").run();
        const changes = info.changes || 0;
        maintenanceState.refreshTokenCleanup.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.refreshTokenCleanup.lastError = '';
        maintenanceState.refreshTokenCleanup.lastChanges = changes;
        maintenanceState.refreshTokenCleanup.totalChanges += changes;
        if (changes > 0) {
            logger.info({ changes }, 'Expired refresh tokens cleaned');
        }
        return changes;
    } catch (e) {
        maintenanceState.refreshTokenCleanup.lastError = e.message;
        logger.error({ err: e.message }, 'Refresh token cleanup failed');
        return 0;
    }
}

async function optimizeDatabase() {
    maintenanceState.optimize.lastRunAt = getBeijingTimestamp();
    try {
        db.exec('PRAGMA optimize;');
        maintenanceState.optimize.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.optimize.lastError = '';
        return true;
    } catch (e) {
        maintenanceState.optimize.lastError = e.message;
        logger.error({ err: e.message }, 'SQLite optimize failed');
        return false;
    }
}

function getMaintenanceStatus() {
    return {
        ...maintenanceState,
        running: Boolean(maintenanceState.startedAt)
    };
}

function startMaintenanceTasks() {
    const retentionDays = getAuditLogRetentionDays();
    const apiCallLogRetentionDays = getApiCallLogRetentionDays();
    maintenanceState.startedAt = getBeijingTimestamp();
    maintenanceState.retentionDays = retentionDays;
    maintenanceState.apiCallLogCleanup.retentionDays = apiCallLogRetentionDays;

    cleanupOldLogs(retentionDays).catch(() => {});
    cleanupApiCallLogs(apiCallLogRetentionDays).catch(() => {});
    cleanupExpiredRefreshTokens().catch(() => {});
    optimizeDatabase().catch(() => {});

    setInterval(() => {
        cleanupOldLogs(retentionDays).catch(() => {});
        cleanupApiCallLogs(apiCallLogRetentionDays).catch(() => {});
        cleanupExpiredRefreshTokens().catch(() => {});
        optimizeDatabase().catch(() => {});
    }, 24 * 60 * 60 * 1000).unref();

    logger.info({ retentionDays, apiCallLogRetentionDays }, 'Maintenance service started');
}

module.exports = {
    startMaintenanceTasks,
    cleanupOldLogs,
    cleanupApiCallLogs,
    cleanupExpiredRefreshTokens,
    optimizeDatabase,
    getAuditLogRetentionDays,
    getApiCallLogRetentionDays,
    getMaintenanceStatus
};
