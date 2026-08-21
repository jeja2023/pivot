const path = require('path');
const fs = require('fs');

const os = require('os');
function resolveSafeDataDir() {
    if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
    const candidate = path.join(__dirname, '../../data');
    if (candidate.includes('.asar')) {
        return path.join(os.tmpdir(), 'pivot-data');
    }
    return candidate;
}
const dataDir = resolveSafeDataDir();

try {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
} catch (_err) {
    // 忽略只读或虚拟文件系统路径下的创建失败
}

// PostgreSQL runtime 不暴露同步 db。测试启动器可显式开启同步兼容 facade，
// 让遗留测试夹具逐步迁移到 PG，而不把 better-sqlite3 带回生产路径。
const db = process.env.PIVOT_TEST_DB_SYNC === 'postgres'
    ? require('./test-sync-db').createTestDb()
    : null;
const dbPath = null;

module.exports = { db, dataDir, dbPath };

