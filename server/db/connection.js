const path = require('path');
const fs = require('fs');
const { logger } = require('../logger');
const { isPostgres } = require('./dialect');

const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '../../data');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = isPostgres() ? null : path.join(dataDir, 'chat.db');

// PG 模式：db 为 null，所有查询应通过 server/db/client.js 进行
let db = null;

if (!isPostgres()) {
    const Database = require('better-sqlite3');
    db = new Database(dbPath);
    logger.info({ dbPath }, 'SQLite 数据库已连接');

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('auto_vacuum = INCREMENTAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');

    // 性能调优 PRAGMA：均为进程级会话设置，不改变磁盘格式与查询行为，
    // 仅影响 SQLite 内部的缓存/内存映射/临时表与 WAL 检查点策略。
    function parsePragmaInt(value, fallback) {
        const n = Number.parseInt(value, 10);
        return Number.isFinite(n) ? n : fallback;
    }
    const cacheSizeKib = parsePragmaInt(process.env.PIVOT_SQLITE_CACHE_SIZE_KIB, 16000);
    db.pragma(`cache_size = -${Math.max(2000, cacheSizeKib)}`);
    const walAutocheckpoint = parsePragmaInt(process.env.PIVOT_SQLITE_WAL_AUTOCHECKPOINT, 1000);
    db.pragma(`wal_autocheckpoint = ${Math.max(100, walAutocheckpoint)}`);
    db.pragma('temp_store = MEMORY');
    const mmapBytes = parsePragmaInt(process.env.PIVOT_SQLITE_MMAP_BYTES, 64 * 1024 * 1024);
    if (mmapBytes > 0) db.pragma(`mmap_size = ${mmapBytes}`);

    try {
        logger.info({
            cache_size: db.pragma('cache_size', { simple: true }),
            wal_autocheckpoint: db.pragma('wal_autocheckpoint', { simple: true }),
            temp_store: db.pragma('temp_store', { simple: true }),
            mmap_size: db.pragma('mmap_size', { simple: true })
        }, 'SQLite 性能参数已应用');
    } catch (e) {
        logger.debug?.({ err: e.message }, 'SQLite 性能参数读取回显已跳过');
    }

    // 慢查询监控：包裹 prepare 方法记录执行耗时
    const rawPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
        const stmt = rawPrepare(sql);
        ['get', 'all', 'run', 'iterate'].forEach(method => {
            if (typeof stmt[method] !== 'function') return;
            const original = stmt[method].bind(stmt);
            stmt[method] = (...params) => {
                const startedAt = process.hrtime.bigint();
                try {
                    return original(...params);
                } finally {
                    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
                    if (durationMs >= Number(process.env.PIVOT_SLOW_SQL_MS || 500)) {
                        try {
                            require('../services/observability').recordSlowSql(sql, durationMs, params);
                        } catch (e) {
                            logger.debug?.({ err: e.message }, '慢 SQL 记录已跳过');
                        }
                    }
                }
            };
        });
        return stmt;
    };
}

module.exports = { db, dataDir, dbPath };
