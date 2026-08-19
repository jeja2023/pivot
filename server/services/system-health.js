const fs = require('fs');
const os = require('os');
const path = require('path');
const { getBeijingTimestamp } = require('../time');

const DEFAULT_HEALTH_CACHE_TTL_MS = 10_000;
let cachedDetailedSnapshot = null;
let detailedSnapshotExpiresAt = 0;

function checkDatabase() {
    try {
        const { getPgPool } = require('../db/pg-connection');
        const pool = getPgPool();
        return {
            status: pool ? 'ok' : 'degraded',
            message: pool ? 'PostgreSQL 连接池运行正常' : 'PostgreSQL 连接池未初始化'
        };
    } catch (e) {
        return { status: 'error', message: e.message };
    }
}

function checkWritableDirectory(label, dir) {
    const resolved = path.resolve(dir);
    const probe = path.join(resolved, `.pivot-health-${process.pid}-${Date.now()}.tmp`);
    try {
        fs.mkdirSync(resolved, { recursive: true });
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return { label, path: resolved, status: 'ok', message: '目录正常可写' };
    } catch (e) {
        try {
            if (fs.existsSync(probe)) fs.unlinkSync(probe);
        } catch (_) {}
        return { label, path: resolved, status: 'error', message: e.message };
    }
}

function checkMemory() {
    const total = os.totalmem();
    const free = os.freemem();
    const usedRatio = total > 0 ? (total - free) / total : 0;
    const status = usedRatio >= 0.95 ? 'error' : (usedRatio >= 0.85 ? 'degraded' : 'ok');
    return {
        status,
        usedRatio,
        freeBytes: free,
        totalBytes: total,
        message: `${Math.round((1 - usedRatio) * 100)}% free (${Math.round(free / 1024 / 1024)} MB)`
    };
}

function checkDiskUsage(dir) {
    try {
        if (typeof fs.statfsSync === 'function') {
            const stats = fs.statfsSync(dir);
            const total = stats.bsize * stats.blocks;
            const free = stats.bsize * stats.bavail;
            const usedRatio = total > 0 ? (total - free) / total : 0;
            const status = usedRatio >= 0.95 ? 'error' : (usedRatio >= 0.9 ? 'degraded' : 'ok');
            return {
                status,
                path: path.resolve(dir),
                total,
                free,
                usedRatio,
                freeBytes: free,
                totalBytes: total,
                message: `${Math.round((1 - usedRatio) * 100)}% free (${Math.round(free / 1024 / 1024)} MB)`
            };
        }
    } catch (_) {}
    return {
        status: 'ok',
        path: path.resolve(dir),
        usedRatio: 0,
        freeBytes: null,
        totalBytes: null,
        message: '当前运行平台不支持 statfs 磁盘探针'
    };
}

function overallStatus(checks) {
    const statuses = checks.map(item => item.status);
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('degraded')) return 'degraded';
    return 'ok';
}

function getPublicSystemHealthSnapshot() {
    const checks = [];
    try {
        const { getPgPool } = require('../db/pg-connection');
        if (!getPgPool()) throw new Error('PostgreSQL 数据库连接池未初始化');
        checks.push({ name: 'database', status: 'ok' });
    } catch (_error) {
        checks.push({ name: 'database', status: 'error' });
    }
    const memory = checkMemory();
    checks.push({ name: 'memory', status: memory.status });
    return {
        status: overallStatus(checks),
        timestamp: getBeijingTimestamp(),
        checks
    };
}

function getSystemHealthSnapshot(options = {}) {
    if (options.public === true) return getPublicSystemHealthSnapshot();
    const cacheTtlMs = Math.max(0, Number(process.env.HEALTH_DETAIL_CACHE_TTL_MS) || DEFAULT_HEALTH_CACHE_TTL_MS);
    if (options.force !== true && cachedDetailedSnapshot && Date.now() < detailedSnapshotExpiresAt) {
        return cachedDetailedSnapshot;
    }
    const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../../data');
    const uploadDir = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
        ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
        : path.resolve(__dirname, '../../uploads');
    const checks = [
        { name: 'database', ...checkDatabase() },
        { name: 'dataDir', ...checkWritableDirectory('Data directory', dataDir) },
        { name: 'uploadsDir', ...checkWritableDirectory('Uploads directory', uploadDir) },
        { name: 'memory', ...checkMemory() },
        { name: 'disk', ...checkDiskUsage(dataDir) }
    ];

    const snapshot = {
        status: overallStatus(checks),
        timestamp: getBeijingTimestamp(),
        checks
    };
    cachedDetailedSnapshot = snapshot;
    detailedSnapshotExpiresAt = Date.now() + cacheTtlMs;
    return snapshot;
}

module.exports = {
    checkDatabase,
    checkDiskUsage,
    checkMemory,
    checkWritableDirectory,
    getPublicSystemHealthSnapshot,
    getSystemHealthSnapshot,
    overallStatus
};
