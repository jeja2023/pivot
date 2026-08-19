/**
 * server/db/pg-connection.js
 * PostgreSQL 连接池管理（懒加载单例）
 * 通过 PIVOT_DB_DIALECT=postgres + DATABASE_URL 激活
 *
 * ── 类型解析对齐（关键）────────────────────────────────────────────────────
 * node-postgres 的默认行为与 better-sqlite3 不一致，若不校正会击穿应用层：
 *   1. BIGINT (int8, OID 20) 默认返回「字符串」→ row.id === 1 恒为 false、
 *      COUNT(*) 得到 "5" 而非 5。故统一解析为 Number。
 *   2. NUMERIC (OID 1700) 默认返回「字符串」→ 统一解析为 Number。
 *   3. TIMESTAMPTZ/TIMESTAMP 默认返回 JS Date 对象，而 SQLite 返回
 *      'YYYY-MM-DD HH:mm:ss' 字符串。应用层大量代码直接做字符串比较、
 *      startsWith(datePrefix)、字面拼接，故统一归一化为北京时间字符串。
 *
 * 配套要求：每个连接建立时 SET timezone = 'Asia/Shanghai'，使 PG 的
 * timestamptz 文本输出即为北京时间，归一化只需裁剪时区后缀与小数秒。
 */
const { Pool, types: pgTypes } = require('pg');
const { logger } = require('../logger');

const PG_TIMEZONE = process.env.PG_TIMEZONE || 'Asia/Shanghai';

// ── OID 常量 ───────────────────────────────────────────────────────────────
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_TIMESTAMP = 1114;   // timestamp without time zone
const OID_TIMESTAMPTZ = 1184; // timestamp with time zone
const OID_DATE = 1082;

/**
 * 将 PG 的 timestamp 文本输出归一化为 SQLite 同构的 'YYYY-MM-DD HH:mm:ss'。
 * PG 在 timezone=Asia/Shanghai 下输出形如：
 *   '2026-08-17 10:00:00+08'  /  '2026-08-17 10:00:00.123456+08'
 * 裁掉小数秒与时区后缀即为北京时间字符串。
 */
function normalizePgTimestamp(raw) {
    if (raw === null || raw === undefined) return raw;
    const text = String(raw).trim();
    if (!text) return null;
    // 去掉 ISO 的 'T' 分隔符，裁掉小数秒，裁掉尾部时区偏移（+08 / +08:00 / Z）
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(text);
    if (match) return `${match[1]} ${match[2]}`;
    // 仅日期（DATE 列）原样返回
    return text;
}

let typeParsersApplied = false;

function applyPgTypeParsers() {
    if (typeParsersApplied) return;
    typeParsersApplied = true;

    // BIGINT / NUMERIC → Number（避免字符串化破坏 === 与算术）
    pgTypes.setTypeParser(OID_INT8, val => (val === null ? null : Number(val)));
    pgTypes.setTypeParser(OID_NUMERIC, val => (val === null ? null : Number(val)));

    // 时间列 → 北京时间字符串（与 SQLite 存储格式一致）
    pgTypes.setTypeParser(OID_TIMESTAMPTZ, normalizePgTimestamp);
    pgTypes.setTypeParser(OID_TIMESTAMP, normalizePgTimestamp);
    pgTypes.setTypeParser(OID_DATE, normalizePgTimestamp);
}

let pgPool = null;

function getPgPool() {
    if (!pgPool) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('[PG] DATABASE_URL 未配置，无法初始化 PostgreSQL 连接池');
        }
        applyPgTypeParsers();
        const statementTimeout = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '60000', 10);
        pgPool = new Pool({
            connectionString,
            max: parseInt(process.env.PG_POOL_MAX || '10', 10),
            idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
            connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT_MS || '5000', 10),
            statement_timeout: statementTimeout > 0 ? statementTimeout : undefined,
            // 连接级会话参数：确保 timestamptz 文本输出即北京时间
            options: `-c timezone=${PG_TIMEZONE}`,
        });
        pgPool.on('error', (err) => {
            logger.error({ err: err.message }, '[PG] 连接池后台错误');
        });
        logger.info({ max: pgPool.options.max, timezone: PG_TIMEZONE }, '[PG] PostgreSQL 连接池已初始化');
    }
    return pgPool;
}

async function closePgPool() {
    if (pgPool) {
        await pgPool.end();
        pgPool = null;
        logger.info('[PG] PostgreSQL 连接池已关闭');
    }
}

async function checkPgConnection() {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
        await client.query('SELECT 1');
        return true;
    } finally {
        client.release();
    }
}

module.exports = {
    getPgPool,
    closePgPool,
    checkPgConnection,
    normalizePgTimestamp,
    applyPgTypeParsers,
    PG_TIMEZONE,
};
