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

// 可写性探针文件名必须是「固定」的：早期实现用 pid+时间戳命名，一旦 unlinkSync 因
// 磁盘瞬时异常失败，残留文件就永久堆积（生产已实测 data/ 残留 73 个、uploads/ 残留
// 333 个 .pivot-health-*.tmp），使目录条目数单调增长并拖慢目录遍历类操作。
const PROBE_FILE_NAME = '.pivot-health-probe.tmp';
const LEGACY_PROBE_PATTERN = /^\.pivot-health-\d+-\d+\.tmp$/;
const sweptProbeDirs = new Set();

/** 清理历史残留探针文件：每个目录每进程只异步执行一次，不阻塞请求链路。 */
function sweepLegacyProbeFiles(resolvedDir) {
    if (sweptProbeDirs.has(resolvedDir)) return;
    sweptProbeDirs.add(resolvedDir);
    fs.promises.readdir(resolvedDir)
        .then(names => Promise.all(
            names
                .filter(name => LEGACY_PROBE_PATTERN.test(name))
                .map(name => fs.promises.unlink(path.join(resolvedDir, name)).catch(() => {}))
        ))
        .catch(() => {});
}

function checkWritableDirectory(label, dir) {
    const resolved = path.resolve(dir);
    const probe = path.join(resolved, PROBE_FILE_NAME);
    try {
        fs.mkdirSync(resolved, { recursive: true });
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        sweepLegacyProbeFiles(resolved);
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

function checkWriteQueue() {
    try {
        const { getQueueDiagnostics } = require('./db-write-queue');
        const queues = getQueueDiagnostics();
        const pending = Object.values(queues).reduce((sum, item) => sum + Number(item.pending || 0), 0);
        const dropped = Object.values(queues).reduce((sum, item) => sum + Number(item.dropped || 0), 0);
        const failed = Object.entries(queues).filter(([, item]) => item.lastError);
        const firstError = failed[0]?.[1]?.lastError;
        const status = dropped > 0 || failed.length > 0 ? 'degraded' : 'ok';
        return {
            status,
            pending,
            dropped,
            queues,
            message: dropped > 0
                ? `写入队列累计丢弃 ${dropped} 条记录`
                : failed.length > 0
                    ? `写入队列最近一次写入失败：${firstError?.message || '未知错误'}`
                    : `写入队列待处理 ${pending} 条记录`
        };
    } catch (e) {
        return { status: 'error', message: e.message };
    }
}

function checkDeployment() {
    try {
        const { getDeploymentProfile } = require('./deployment-profile');
        const profile = getDeploymentProfile();
        const requestedMultiNode = profile.requestedMode === 'multi_node';
        const ready = profile.capabilities?.multiNodeReady === true;
        return {
            status: requestedMultiNode && !ready ? 'error' : 'ok',
            requestedMode: profile.requestedMode,
            effectiveMode: profile.effectiveMode,
            message: requestedMultiNode && !ready
                ? `多节点部署预检未通过：${profile.warnings.join(', ') || '缺少共享基础设施'}`
                : `部署模式：${profile.effectiveMode}`
        };
    } catch (error) {
        return { status: 'error', message: error.message };
    }
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
        { name: 'disk', ...checkDiskUsage(dataDir) },
        { name: 'writeQueue', ...checkWriteQueue() },
        { name: 'deployment', ...checkDeployment() }
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
    checkDeployment,
    checkDiskUsage,
    checkMemory,
    checkWriteQueue,
    checkWritableDirectory,
    getPublicSystemHealthSnapshot,
    getSystemHealthSnapshot,
    overallStatus
};
