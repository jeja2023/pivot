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
