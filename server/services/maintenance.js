/* Automated maintenance service */
const fs = require('fs');
const path = require('path');

const { db, dataDir } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { parsePositiveInt, parseNonNegativeInt } = require('../number');
const { cleanupSoftDeletedStorage } = require('./storage-gc');
const { cleanupAnalysisWorkspace } = require('./data-analysis');

const DAY_MS = 24 * 60 * 60 * 1000;

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
    storageGc: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: '',
        lastAttachmentRows: 0,
        lastKnowledgeDocRows: 0,
        lastMessageRows: 0,
        totalAttachmentRows: 0,
        totalKnowledgeDocRows: 0,
        totalMessageRows: 0,
        retentionDays: 30
    },
    optimize: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: '',
        vacuumPages: 200
    },
    backup: {
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: '',
        lastPath: '',
        lastSizeBytes: 0,
        lastDeletedFiles: 0,
        totalDeletedFiles: 0,
        retentionDays: 7,
        maxVersions: 7,
        backupDir: '',
        running: false
    }
};

function getAuditLogRetentionDays() {
    return parsePositiveInt(process.env.AUDIT_LOG_RETENTION_DAYS || '180', 180);
}

function getApiCallLogRetentionDays() {
    return parsePositiveInt(process.env.API_CALL_LOG_RETENTION_DAYS || '30', 30);
}

function getStorageGcRetentionDays() {
    return parsePositiveInt(process.env.STORAGE_GC_RETENTION_DAYS || '30', 30);
}

function getIncrementalVacuumPages() {
    return parseNonNegativeInt(process.env.SQLITE_INCREMENTAL_VACUUM_PAGES || '200', 200);
}

function getBackupRetentionDays() {
    return parsePositiveInt(process.env.DB_BACKUP_RETENTION_DAYS || '7', 7);
}

function getBackupMaxVersions() {
    return parsePositiveInt(process.env.DB_BACKUP_MAX_VERSIONS || '7', 7);
}

function getBackupDir() {
    return process.env.DB_BACKUP_DIR
        ? path.resolve(process.env.DB_BACKUP_DIR)
        : path.join(dataDir, 'backups');
}

function toBackupTimestamp(date = new Date()) {
    const base = getBeijingTimestamp(date).replace(' ', '_').replace(/:/g, '-');
    return `${base}-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function buildBackupPath(backupDir) {
    let backupPath = path.join(backupDir, `chat_backup_${toBackupTimestamp()}.db`);
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
        backupPath = path.join(backupDir, `chat_backup_${toBackupTimestamp()}_${suffix}.db`);
        suffix += 1;
    }
    return backupPath;
}

function listManagedBackupFiles(backupDir = getBackupDir()) {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir, { withFileTypes: true })
        .filter(item => item.isFile() && /^chat_backup_.+\.db$/.test(item.name))
        .map(item => {
            const fullPath = path.join(backupDir, item.name);
            const stat = fs.statSync(fullPath);
            return {
                name: item.name,
                path: fullPath,
                mtimeMs: stat.mtimeMs,
                size: stat.size
            };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function cleanupOldBackups(options = {}) {
    const backupDir = options.backupDir || getBackupDir();
    const retentionDays = options.retentionDays || getBackupRetentionDays();
    const maxVersions = options.maxVersions || getBackupMaxVersions();
    const nowMs = options.nowMs || Date.now();
    const cutoffMs = nowMs - retentionDays * DAY_MS;
    const files = listManagedBackupFiles(backupDir);
    const deleteSet = new Set();

    files.forEach((file, index) => {
        if (file.mtimeMs < cutoffMs || index >= maxVersions) {
            deleteSet.add(file.path);
        }
    });

    let deletedFiles = 0;
    deleteSet.forEach(filePath => {
        try {
            fs.unlinkSync(filePath);
            deletedFiles += 1;
        } catch (e) {
            logger.warn({ err: e.message, filePath }, 'Old database backup cleanup skipped file');
        }
    });

    return {
        backupDir,
        retentionDays,
        maxVersions,
        totalFiles: files.length,
        deletedFiles,
        remainingFiles: listManagedBackupFiles(backupDir).length
    };
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

async function cleanupSoftDeletedStorageJob(days = getStorageGcRetentionDays()) {
    maintenanceState.storageGc.lastRunAt = getBeijingTimestamp();
    maintenanceState.storageGc.retentionDays = days;
    try {
        const result = cleanupSoftDeletedStorage({ retentionDays: days });
        maintenanceState.storageGc.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.storageGc.lastError = '';
        maintenanceState.storageGc.lastAttachmentRows = result.attachmentRows;
        maintenanceState.storageGc.lastKnowledgeDocRows = result.knowledgeDocRows;
        maintenanceState.storageGc.lastMessageRows = result.messageRows;
        maintenanceState.storageGc.totalAttachmentRows += result.attachmentRows;
        maintenanceState.storageGc.totalKnowledgeDocRows += result.knowledgeDocRows;
        maintenanceState.storageGc.totalMessageRows += result.messageRows;
        return result;
    } catch (e) {
        maintenanceState.storageGc.lastError = e.message;
        logger.error({ err: e.message }, 'Soft-deleted storage cleanup failed');
        return { retentionDays: days, attachmentRows: 0, knowledgeDocRows: 0, messageRows: 0 };
    }
}

async function optimizeDatabase() {
    maintenanceState.optimize.lastRunAt = getBeijingTimestamp();
    const vacuumPages = getIncrementalVacuumPages();
    maintenanceState.optimize.vacuumPages = vacuumPages;
    try {
        db.exec('PRAGMA optimize;');
        if (vacuumPages > 0) {
            db.exec(`PRAGMA incremental_vacuum(${vacuumPages});`);
        }
        maintenanceState.optimize.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.optimize.lastError = '';
        return true;
    } catch (e) {
        maintenanceState.optimize.lastError = e.message;
        logger.error({ err: e.message }, 'SQLite optimize failed');
        return false;
    }
}

async function backupDatabase(options = {}) {
    if (maintenanceState.backup.running) {
        logger.warn('Database backup skipped because another backup is still running');
        return { skipped: true, reason: 'running' };
    }

    const backupDir = options.backupDir || getBackupDir();
    const retentionDays = options.retentionDays || getBackupRetentionDays();
    const maxVersions = options.maxVersions || getBackupMaxVersions();
    maintenanceState.backup.lastRunAt = getBeijingTimestamp();
    maintenanceState.backup.retentionDays = retentionDays;
    maintenanceState.backup.maxVersions = maxVersions;
    maintenanceState.backup.backupDir = backupDir;
    maintenanceState.backup.running = true;

    try {
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = buildBackupPath(backupDir);
        await db.backup(backupPath);
        const stat = fs.statSync(backupPath);
        const cleanup = cleanupOldBackups({ backupDir, retentionDays, maxVersions });

        maintenanceState.backup.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.backup.lastError = '';
        maintenanceState.backup.lastPath = backupPath;
        maintenanceState.backup.lastSizeBytes = stat.size;
        maintenanceState.backup.lastDeletedFiles = cleanup.deletedFiles;
        maintenanceState.backup.totalDeletedFiles += cleanup.deletedFiles;

        logger.info({
            backupPath,
            sizeBytes: stat.size,
            deletedFiles: cleanup.deletedFiles,
            retentionDays,
            maxVersions
        }, 'SQLite database backup completed');

        return {
            backupPath,
            sizeBytes: stat.size,
            cleanup
        };
    } catch (e) {
        maintenanceState.backup.lastError = e.message;
        logger.error({ err: e.message }, 'SQLite database backup failed');
        return null;
    } finally {
        maintenanceState.backup.running = false;
    }
}

function getMaintenanceStatus() {
    return {
        ...maintenanceState,
        running: Boolean(maintenanceState.startedAt)
    };
}

// 清理数据分析工作区的过期导出/临时文件（同步、best-effort，异常不影响其他维护任务）。
function runAnalysisWorkspaceCleanup() {
    try {
        cleanupAnalysisWorkspace();
    } catch (err) {
        logger.warn({ err: err.message }, '数据分析工作区清理失败');
    }
}

function startMaintenanceTasks() {
    const retentionDays = getAuditLogRetentionDays();
    const apiCallLogRetentionDays = getApiCallLogRetentionDays();
    const storageGcRetentionDays = getStorageGcRetentionDays();
    const backupRetentionDays = getBackupRetentionDays();
    const backupMaxVersions = getBackupMaxVersions();
    const backupDir = getBackupDir();
    maintenanceState.startedAt = getBeijingTimestamp();
    maintenanceState.retentionDays = retentionDays;
    maintenanceState.apiCallLogCleanup.retentionDays = apiCallLogRetentionDays;
    maintenanceState.storageGc.retentionDays = storageGcRetentionDays;
    maintenanceState.backup.retentionDays = backupRetentionDays;
    maintenanceState.backup.maxVersions = backupMaxVersions;
    maintenanceState.backup.backupDir = backupDir;

    cleanupOldLogs(retentionDays).catch(() => {});
    cleanupApiCallLogs(apiCallLogRetentionDays).catch(() => {});
    cleanupExpiredRefreshTokens().catch(() => {});
    cleanupSoftDeletedStorageJob(storageGcRetentionDays).catch(() => {});
    runAnalysisWorkspaceCleanup();
    backupDatabase({ backupDir, retentionDays: backupRetentionDays, maxVersions: backupMaxVersions }).catch(() => {});
    optimizeDatabase().catch(() => {});

    setInterval(() => {
        cleanupOldLogs(retentionDays).catch(() => {});
        cleanupApiCallLogs(apiCallLogRetentionDays).catch(() => {});
        cleanupExpiredRefreshTokens().catch(() => {});
        cleanupSoftDeletedStorageJob(storageGcRetentionDays).catch(() => {});
        runAnalysisWorkspaceCleanup();
        backupDatabase({ backupDir, retentionDays: backupRetentionDays, maxVersions: backupMaxVersions }).catch(() => {});
        optimizeDatabase().catch(() => {});
    }, DAY_MS).unref();

    logger.info({
        retentionDays,
        apiCallLogRetentionDays,
        storageGcRetentionDays,
        backupRetentionDays,
        backupMaxVersions,
        backupDir
    }, 'Maintenance service started');
}

module.exports = {
    startMaintenanceTasks,
    cleanupOldLogs,
    cleanupApiCallLogs,
    cleanupExpiredRefreshTokens,
    cleanupSoftDeletedStorageJob,
    backupDatabase,
    cleanupOldBackups,
    optimizeDatabase,
    getAuditLogRetentionDays,
    getApiCallLogRetentionDays,
    getStorageGcRetentionDays,
    getIncrementalVacuumPages,
    getBackupRetentionDays,
    getBackupMaxVersions,
    getBackupDir,
    getMaintenanceStatus
};
