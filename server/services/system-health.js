const fs = require('fs');
const os = require('os');
const path = require('path');
const { db } = require('../db');

function checkDatabase() {
    try {
        db.prepare('SELECT 1').get();
        const integrity = db.prepare('PRAGMA quick_check').get();
        const value = integrity ? Object.values(integrity)[0] : 'unknown';
        return {
            status: value === 'ok' ? 'ok' : 'degraded',
            message: value === 'ok' ? 'Database reachable' : `SQLite quick_check: ${value}`
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
        return { label, path: resolved, status: 'ok', message: 'Writable' };
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
        total,
        free,
        message: `${Math.round(usedRatio * 100)}% system memory used`
    };
}

function checkDiskUsage(dir) {
    const resolved = path.resolve(dir);
    try {
        const usage = fs.statfsSync(resolved);
        const total = Number(usage.blocks) * Number(usage.bsize);
        const free = Number(usage.bavail) * Number(usage.bsize);
        const usedRatio = total > 0 ? (total - free) / total : 0;
        const status = usedRatio >= 0.95 ? 'error' : (usedRatio >= 0.85 ? 'degraded' : 'ok');
        return {
            status,
            path: resolved,
            total,
            free,
            usedRatio,
            message: `${Math.round(usedRatio * 100)}% disk used`
        };
    } catch (e) {
        return { status: 'unknown', path: resolved, message: e.message };
    }
}

function overallStatus(checks) {
    const statuses = checks.map(item => item.status);
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('degraded')) return 'degraded';
    return 'ok';
}

function getSystemHealthSnapshot() {
    const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../../data');
    const uploadDir = path.resolve(__dirname, '../../uploads');
    const checks = [
        { name: 'database', ...checkDatabase() },
        { name: 'dataDir', ...checkWritableDirectory('Data directory', dataDir) },
        { name: 'uploadsDir', ...checkWritableDirectory('Uploads directory', uploadDir) },
        { name: 'memory', ...checkMemory() },
        { name: 'disk', ...checkDiskUsage(dataDir) }
    ];

    return {
        status: overallStatus(checks),
        timestamp: new Date().toISOString(),
        checks
    };
}

module.exports = {
    checkDatabase,
    checkDiskUsage,
    checkMemory,
    checkWritableDirectory,
    getSystemHealthSnapshot,
    overallStatus
};
