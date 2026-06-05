const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { logger } = require('../logger');

const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '../../data');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'chat.db');
const db = new Database(dbPath);
logger.info({ dbPath }, 'SQLite database connected');

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('auto_vacuum = INCREMENTAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// 性能调优 PRAGMA：均为进程级会话设置，不改变磁盘格式与查询行为，
// 仅影响 SQLite 内部的缓存/内存映射/临时表与 WAL 检查点策略。
// 通过环境变量可覆盖默认值，便于在内存受限的内网机器上下调。
function parsePragmaInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

// 负数表示以 KiB 为单位（SQLite 约定），默认 -16000 ≈ 16MB 页缓存。
const cacheSizeKib = parsePragmaInt(process.env.PIVOT_SQLITE_CACHE_SIZE_KIB, 16000);
db.pragma(`cache_size = -${Math.max(2000, cacheSizeKib)}`);

// WAL 自动检查点页数（默认 1000 页 ≈ 4MB）。设为更大值可减少检查点频率，
// 也避免 WAL 文件长期无限增长；0 会关闭自动检查点，这里强制为正数。
const walAutocheckpoint = parsePragmaInt(process.env.PIVOT_SQLITE_WAL_AUTOCHECKPOINT, 1000);
db.pragma(`wal_autocheckpoint = ${Math.max(100, walAutocheckpoint)}`);

// 临时索引/排序结果放内存，减少磁盘临时文件 IO。
db.pragma('temp_store = MEMORY');

// 内存映射 IO，减少 read() 系统调用；默认 64MB，设为 0 可关闭。
const mmapBytes = parsePragmaInt(process.env.PIVOT_SQLITE_MMAP_BYTES, 64 * 1024 * 1024);
if (mmapBytes > 0) {
    db.pragma(`mmap_size = ${mmapBytes}`);
}

try {
    const effective = {
        cache_size: db.pragma('cache_size', { simple: true }),
        wal_autocheckpoint: db.pragma('wal_autocheckpoint', { simple: true }),
        temp_store: db.pragma('temp_store', { simple: true }),
        mmap_size: db.pragma('mmap_size', { simple: true })
    };
    logger.info(effective, 'SQLite performance pragmas applied');
} catch (e) {
    logger.debug?.({ err: e.message }, 'SQLite pragma readback skipped');
}

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
                        logger.debug?.({ err: e.message }, 'Slow SQL recording skipped');
                    }
                }
            }
        };
    });
    return stmt;
};

module.exports = { db, dataDir, dbPath };
