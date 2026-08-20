/* Automated maintenance service */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { dataDir } = require('../db');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { parsePositiveInt } = require('../number');
const { cleanupSoftDeletedStorage } = require('./storage-gc');
const { cleanupAnalysisWorkspace } = require('./data-analysis');
const { cleanupExpiredDocumentProcessingFiles } = require('./document-processing/cleanup');

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
        operation: 'ANALYZE'
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

function getPgDumpBin() {
    const configured = String(process.env.PG_DUMP_BIN || '').trim();
    if (configured && configured !== 'pg_dump') {
        return configured;
    }
    if (process.platform === 'win32') {
        const commonWinPaths = [
            'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
            'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
            'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
            'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
            'C:\\Program Files\\PostgreSQL\\14\\bin\\pg_dump.exe',
            'C:\\Program Files (x86)\\PostgreSQL\\18\\bin\\pg_dump.exe',
            'C:\\Program Files (x86)\\PostgreSQL\\17\\bin\\pg_dump.exe',
            'C:\\Program Files (x86)\\PostgreSQL\\16\\bin\\pg_dump.exe'
        ];
        for (const binPath of commonWinPaths) {
            try {
                if (fs.existsSync(binPath)) return binPath;
            } catch (e) {
                // ignore
            }
        }
    }
    return configured || 'pg_dump';
}

function getPgDumpTimeoutMs() {
    return parsePositiveInt(process.env.PG_DUMP_TIMEOUT_MS || '900000', 900000);
}

function toBackupTimestamp(date = new Date()) {
    const base = getBeijingTimestamp(date).replace(' ', '_').replace(/:/g, '-');
    return `${base}-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function _buildBackupPath(backupDir) {
    const timestamp = toBackupTimestamp();
    let backupPath = path.join(backupDir, `pivot_backup_${timestamp}.dump`);
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
        backupPath = path.join(backupDir, `pivot_backup_${timestamp}_${suffix}.dump`);
        suffix += 1;
    }
    return backupPath;
}

function listManagedBackupFiles(backupDir = getBackupDir()) {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir, { withFileTypes: true })
        .filter(item => item.isFile() && /^(?:pivot_backup_.+\.dump|chat_backup_.+\.db)$/.test(item.name))
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
            logger.warn({ err: e.message, filePath }, '旧数据库备份清理已跳过文件');
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

const { execute } = require('../db/client');

async function cleanupOldLogs(days = getAuditLogRetentionDays()) {
    maintenanceState.auditCleanup.lastRunAt = getBeijingTimestamp();
    try {
        const res = await execute("DELETE FROM audit_logs WHERE timestamp < (now() AT TIME ZONE 'Asia/Shanghai' - (? || ' days')::interval)", [String(days)]);
        const changes = Number(res || 0);
        maintenanceState.auditCleanup.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.auditCleanup.lastError = '';
        maintenanceState.auditCleanup.lastChanges = changes;
        maintenanceState.auditCleanup.totalChanges += changes;
        if (changes > 0) {
            logger.info({ changes, days }, '旧审计日志已清理');
        }
        return changes;
    } catch (e) {
        maintenanceState.auditCleanup.lastError = e.message;
        logger.error({ err: e.message }, '审计日志清理失败');
        return 0;
    }
}

async function cleanupApiCallLogs(days = getApiCallLogRetentionDays()) {
    maintenanceState.apiCallLogCleanup.lastRunAt = getBeijingTimestamp();
    maintenanceState.apiCallLogCleanup.retentionDays = days;
    try {
        const res = await execute("DELETE FROM api_call_logs WHERE created_at < (now() AT TIME ZONE 'Asia/Shanghai' - (? || ' days')::interval)", [String(days)]);
        const changes = Number(res || 0);
        maintenanceState.apiCallLogCleanup.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.apiCallLogCleanup.lastError = '';
        maintenanceState.apiCallLogCleanup.lastChanges = changes;
        maintenanceState.apiCallLogCleanup.totalChanges += changes;
        if (changes > 0) {
            logger.info({ changes, days }, '旧 API 调用日志已清理');
        }
        return changes;
    } catch (e) {
        maintenanceState.apiCallLogCleanup.lastError = e.message;
        logger.error({ err: e.message }, 'API 调用日志清理失败');
        return 0;
    }
}

async function cleanupExpiredRefreshTokens() {
    maintenanceState.refreshTokenCleanup.lastRunAt = getBeijingTimestamp();
    try {
        const res = await execute("DELETE FROM refresh_tokens WHERE expires_at < (now() AT TIME ZONE 'Asia/Shanghai')");
        const changes = Number(res || 0);
        maintenanceState.refreshTokenCleanup.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.refreshTokenCleanup.lastError = '';
        maintenanceState.refreshTokenCleanup.lastChanges = changes;
        maintenanceState.refreshTokenCleanup.totalChanges += changes;
        if (changes > 0) {
            logger.info({ changes }, '过期刷新令牌已清理');
        }
        return changes;
    } catch (e) {
        maintenanceState.refreshTokenCleanup.lastError = e.message;
        logger.error({ err: e.message }, '刷新令牌清理失败');
        return 0;
    }
}

async function cleanupSoftDeletedStorageJob(days = getStorageGcRetentionDays()) {
    maintenanceState.storageGc.lastRunAt = getBeijingTimestamp();
    maintenanceState.storageGc.retentionDays = days;
    try {
        const result = await cleanupSoftDeletedStorage({ retentionDays: days });
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
        logger.error({ err: e.message }, '软删除存储清理失败');
        return { retentionDays: days, attachmentRows: 0, knowledgeDocRows: 0, messageRows: 0 };
    }
}

async function optimizeDatabase() {
    maintenanceState.optimize.lastRunAt = getBeijingTimestamp();
    try {
        await execute('ANALYZE');
        maintenanceState.optimize.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.optimize.lastError = '';
        return true;
    } catch (e) {
        maintenanceState.optimize.lastError = e.message;
        logger.error({ err: e.message }, '数据库优化失败');
        return false;
    }
}

function buildPgDumpEnvironment(databaseUrl) {
    let parsed;
    try {
        parsed = new URL(databaseUrl);
    } catch (_error) {
        throw new Error('DATABASE_URL 不是有效的 PostgreSQL 连接地址');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new Error('DATABASE_URL 必须使用 postgres:// 或 postgresql:// 协议');
    }

    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    if (!parsed.hostname || !databaseName) {
        throw new Error('DATABASE_URL 必须包含 PostgreSQL 主机和数据库名');
    }

    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.TEST_DATABASE_URL;
    env.PGHOST = parsed.hostname;
    env.PGPORT = parsed.port || '5432';
    env.PGDATABASE = databaseName;
    if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
    if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);

    const optionMap = {
        sslmode: 'PGSSLMODE',
        sslcert: 'PGSSLCERT',
        sslkey: 'PGSSLKEY',
        sslrootcert: 'PGSSLROOTCERT',
        sslcrl: 'PGSSLCRL',
        target_session_attrs: 'PGTARGETSESSIONATTRS'
    };
    Object.entries(optionMap).forEach(([parameter, envName]) => {
        const value = parsed.searchParams.get(parameter);
        if (value) env[envName] = value;
    });
    return env;
}

function runPgDump({ backupPath, databaseUrl, pgDumpBin = getPgDumpBin(), timeoutMs = getPgDumpTimeoutMs() }) {
    if (!databaseUrl) throw new Error('DATABASE_URL 未配置，无法执行 PostgreSQL 备份');
    const env = buildPgDumpEnvironment(databaseUrl);
    const schema = String(process.env.DB_BACKUP_SCHEMA || 'public').trim() || 'public';
    const args = [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--schema=${schema}`,
        `--file=${backupPath}`
    ];

    return new Promise((resolve, reject) => {
        const child = spawn(pgDumpBin, args, {
            env,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        timer.unref?.();

        child.stderr.on('data', chunk => {
            if (stderr.length < 8192) stderr += chunk.toString('utf8');
        });
        child.once('error', error => {
            clearTimeout(timer);
            if (error.code === 'ENOENT') {
                const hint = process.platform === 'win32'
                    ? '未找到 pg_dump 可执行程序。请确保已安装 PostgreSQL 客户端工具，并在 .env 中配置 PG_DUMP_BIN 路径（例如 PG_DUMP_BIN="C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe"）或将其加入系统 PATH 环境变量。'
                    : '未找到 pg_dump 可执行程序。请安装 postgresql-client 软件包或在 .env 中配置 PG_DUMP_BIN。';
                reject(new Error(`${hint}（原始错误: ${error.message}）`));
            } else {
                reject(error);
            }
        });
        child.once('close', code => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`pg_dump 执行超时（${timeoutMs}ms）`));
            } else if (code !== 0) {
                reject(new Error(`pg_dump 执行失败（退出码 ${code}）：${stderr.trim() || '无错误输出'}`));
            } else {
                resolve();
            }
        });
    });
}

async function backupDatabase(options = {}) {
    if (maintenanceState.backup.running) return { skipped: true, reason: 'backup_running' };

    const backupDir = path.resolve(options.backupDir || getBackupDir());
    const retentionDays = options.retentionDays || getBackupRetentionDays();
    const maxVersions = options.maxVersions || getBackupMaxVersions();
    const backupPath = _buildBackupPath(backupDir);
    const dumpRunner = options.dumpRunner || runPgDump;

    maintenanceState.backup.running = true;
    maintenanceState.backup.lastRunAt = getBeijingTimestamp();
    maintenanceState.backup.retentionDays = retentionDays;
    maintenanceState.backup.maxVersions = maxVersions;
    maintenanceState.backup.backupDir = backupDir;

    try {
        fs.mkdirSync(backupDir, { recursive: true });
        await dumpRunner({
            backupPath,
            databaseUrl: options.databaseUrl || process.env.DATABASE_URL,
            pgDumpBin: options.pgDumpBin || getPgDumpBin(),
            timeoutMs: options.timeoutMs || getPgDumpTimeoutMs()
        });
        const stat = fs.statSync(backupPath);
        if (!stat.isFile() || stat.size <= 0) throw new Error('pg_dump 未生成有效的备份文件');

        const cleanup = cleanupOldBackups({ backupDir, retentionDays, maxVersions });
        maintenanceState.backup.lastSuccessAt = getBeijingTimestamp();
        maintenanceState.backup.lastError = '';
        maintenanceState.backup.lastPath = backupPath;
        maintenanceState.backup.lastSizeBytes = stat.size;
        maintenanceState.backup.lastDeletedFiles = cleanup.deletedFiles;
        maintenanceState.backup.totalDeletedFiles += cleanup.deletedFiles;
        logger.info({ backupPath, sizeBytes: stat.size, deletedFiles: cleanup.deletedFiles }, 'PostgreSQL 数据库备份完成');
        return {
            path: backupPath,
            sizeBytes: stat.size,
            deletedFiles: cleanup.deletedFiles,
            remainingFiles: cleanup.remainingFiles
        };
    } catch (error) {
        maintenanceState.backup.lastError = error.message;
        try {
            if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        } catch (cleanupError) {
            logger.warn({ err: cleanupError.message, backupPath }, '失败的数据库备份文件清理失败');
        }
        logger.error({ err: error.message }, 'PostgreSQL 数据库备份失败');
        throw error;
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

function runDocumentProcessingCleanup() {
    try {
        cleanupExpiredDocumentProcessingFiles();
    } catch (err) {
        logger.warn({ err: err.message }, '文档处理输出清理失败');
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
    runDocumentProcessingCleanup();
    backupDatabase({ backupDir, retentionDays: backupRetentionDays, maxVersions: backupMaxVersions }).catch(() => {});
    optimizeDatabase().catch(() => {});

    setInterval(() => {
        cleanupOldLogs(retentionDays).catch(() => {});
        cleanupApiCallLogs(apiCallLogRetentionDays).catch(() => {});
        cleanupExpiredRefreshTokens().catch(() => {});
        cleanupSoftDeletedStorageJob(storageGcRetentionDays).catch(() => {});
        runAnalysisWorkspaceCleanup();
    runDocumentProcessingCleanup();
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
    }, '后台维护服务已启动');
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
    getBackupRetentionDays,
    getBackupMaxVersions,
    getBackupDir,
    getPgDumpBin,
    getPgDumpTimeoutMs,
    buildPgDumpEnvironment,
    runPgDump,
    getMaintenanceStatus
};
