const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '../../data');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// PostgreSQL runtime 不暴露同步 db。测试启动器可显式开启同步兼容 facade，
// 让遗留测试夹具逐步迁移到 PG，而不把 better-sqlite3 带回生产路径。
const db = process.env.PIVOT_TEST_DB_SYNC === 'postgres'
    ? require('./test-sync-db').createTestDb()
    : null;
const dbPath = null;

module.exports = { db, dataDir, dbPath };

