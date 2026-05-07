const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const logger = require('../logger');
const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'chat.db');
const db = new Database(dbPath);
logger.info({ dbPath }, 'SQLite 数据库已连接');

// --- 系统级持久化性能优化 ---
db.pragma('journal_mode = WAL');       // 开启预写日志模式，提升并发并增强灾难恢复能力
db.pragma('synchronous = NORMAL');     // 在性能与安全性之间取得最佳平衡
db.pragma('auto_vacuum = INCREMENTAL');// 开启增量真空，防止数据库文件碎片化膨胀
db.pragma('busy_timeout = 5000');      // 设置忙等待超时，解决多进程竞争问题
db.pragma('foreign_keys = ON');

// --- 定期数据库维护 (每 24 小时执行一次优化) ---
setInterval(() => {
    try {
        db.exec('PRAGMA optimize;');
        logger.info('SQLite 数据库自动优化已执行');
    } catch (e) {
        logger.warn({ err: e.message }, '数据库自动优化失败');
    }
}, 1000 * 3600 * 24).unref();

module.exports = { db };
