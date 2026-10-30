/**
 * server/db/client.js
 * 统一异步数据库查询接口（PostgreSQL）
 *
 * 用法：
 *   const { query, queryOne, execute, transaction } = require('./client');
 *
 *   const rows  = await query('SELECT * FROM users WHERE status = ?', ['active']);
 *   const row   = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
 *   const count = await execute('UPDATE users SET status = ? WHERE id = ?', ['inactive', id]);
 *   await transaction(async trx => {
 *       await trx.execute('INSERT INTO sessions ...', [...]);
 *       await trx.execute('INSERT INTO messages ...', [...]);
 *   });
 *
 * 占位符兼容：? (参数占位符) 在发送给 PostgreSQL 时自动转换为 $1, $2, ...
 */
const { getPgPool } = require('./pg-connection');
const { getScopedSession } = require('./scoped-session');
const { LruCache } = require('../cache');

const SLOW_SQL_THRESHOLD_MS = Math.max(Number.parseInt(process.env.PIVOT_SLOW_SQL_MS || '500', 10) || 500, 100);
let cachedSlowSqlRecorder = null;

function notifySlowSql(sql, durationMs, params) {
    if (durationMs < SLOW_SQL_THRESHOLD_MS) return;
    try {
        if (!cachedSlowSqlRecorder) {
            cachedSlowSqlRecorder = require('../services/observability').recordSlowSql;
        }
        cachedSlowSqlRecorder(sql, durationMs, params);
    } catch (_) {}
}

const sqlParamsCache = new LruCache({ max: 512 });

function getPostgresSql(sql) {
    const raw = String(sql);
    let cached = sqlParamsCache.get(raw);
    if (cached !== undefined) return cached;
    cached = toPostgresParams(raw);
    sqlParamsCache.set(raw, cached);
    return cached;
}

/**
 * 将普通 SQL 语境中的 ? 占位符转换为 PostgreSQL 的 $1, $2, ... 格式。
 * 字符串、标识符、美元引用和注释中的问号必须原样保留。
 */
function toPostgresParams(sql) {
    const source = String(sql);
    let result = '';
    let parameterIndex = 0;
    let state = 'normal';
    let dollarTag = '';
    let blockCommentDepth = 0;

    for (let index = 0; index < source.length; index += 1) {
        const current = source[index];
        const next = source[index + 1];

        if (state === 'single-quote') {
            result += current;
            if (current === '\\' && next) {
                result += next;
                index += 1;
            } else if (current === "'" && next === "'") {
                result += next;
                index += 1;
            } else if (current === "'") {
                state = 'normal';
            }
            continue;
        }

        if (state === 'double-quote') {
            result += current;
            if (current === '"' && next === '"') {
                result += next;
                index += 1;
            } else if (current === '"') {
                state = 'normal';
            }
            continue;
        }

        if (state === 'line-comment') {
            result += current;
            if (current === '\n' || current === '\r') state = 'normal';
            continue;
        }

        if (state === 'block-comment') {
            if (current === '/' && next === '*') {
                result += '/*';
                blockCommentDepth += 1;
                index += 1;
            } else if (current === '*' && next === '/') {
                result += '*/';
                blockCommentDepth -= 1;
                index += 1;
                if (blockCommentDepth === 0) state = 'normal';
            } else {
                result += current;
            }
            continue;
        }

        if (state === 'dollar-quote') {
            if (source.startsWith(dollarTag, index)) {
                result += dollarTag;
                index += dollarTag.length - 1;
                state = 'normal';
                dollarTag = '';
            } else {
                result += current;
            }
            continue;
        }

        if (current === "'") {
            result += current;
            state = 'single-quote';
        } else if (current === '"') {
            result += current;
            state = 'double-quote';
        } else if (current === '-' && next === '-') {
            result += '--';
            state = 'line-comment';
            index += 1;
        } else if (current === '/' && next === '*') {
            result += '/*';
            state = 'block-comment';
            blockCommentDepth = 1;
            index += 1;
        } else if (current === '$') {
            const match = source.slice(index).match(/^(\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/);
            if (match) {
                dollarTag = match[1];
                result += dollarTag;
                index += dollarTag.length - 1;
                state = 'dollar-quote';
            } else {
                result += current;
            }
        } else if (current === '?') {
            parameterIndex += 1;
            result += `$${parameterIndex}`;
        } else {
            result += current;
        }
    }

    return result;
}

/**
 * 查询多行
 * @param {string} sql   支持 ? 或 $N 占位符
 * @param {any[]}  params 参数数组
 * @returns {Promise<any[]>}
 */
async function query(sql, params = []) {
    const startedAt = Date.now();
    const result = await (getScopedSession() || getPgPool()).query(getPostgresSql(sql), params);
    const duration = Date.now() - startedAt;
    if (duration >= SLOW_SQL_THRESHOLD_MS) {
        notifySlowSql(sql, duration, params);
    }
    return result.rows;
}

async function acquirePgClientWithin(pool, timeoutMs) {
    const safeTimeout = Math.max(1, Math.min(Number(timeoutMs) || 1, 60_000));
    let timer = null;
    let timedOut = false;
    const connection = pool.connect();
    // The connection promise can settle after the local deadline. Attach a
    // handler now so it is never an unhandled rejection, and release a late
    // client immediately rather than silently consuming a pool slot.
    connection.catch(() => {});
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            const error = new Error(`等待数据库连接超过 ${safeTimeout}ms。`);
            error.code = 'PG_POOL_ACQUIRE_TIMEOUT';
            reject(error);
        }, safeTimeout);
        timer.unref?.();
    });
    try {
        return await Promise.race([connection, deadline]);
    } catch (error) {
        if (timedOut) void connection.then(client => client.release()).catch(() => {});
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Execute one read query with a transaction-local PostgreSQL statement limit.
 *
 * Pool-wide `statement_timeout` protects the database, but optional UI
 * enhancements (such as semantic recall) need a much shorter deadline so
 * their ordinary fallback can still complete before the HTTP watchdog fires.
 * SET LOCAL is scoped to this transaction and cannot leak to another pooled
 * request after the client is released.
 */
async function queryWithStatementTimeout(sql, params = [], timeoutMs = 0) {
    const parsedTimeout = Number.parseInt(timeoutMs, 10);
    const safeTimeout = Number.isSafeInteger(parsedTimeout) && parsedTimeout > 0
        ? Math.min(parsedTimeout, 600_000)
        : 0;
    if (!safeTimeout) return await query(sql, params);
    if (getScopedSession()) throw new Error('持锁任务不支持独立超时查询。');

    const startedAt = Date.now();
    // Optional UI enrichment must not queue behind a saturated pool for the
    // same duration as its query budget. Leave the request enough time to run
    // its safe fallback and return a normal response.
    const client = await acquirePgClientWithin(getPgPool(), Math.min(safeTimeout, 1_000));
    let transactionOpen = false;
    let releaseError = null;
    try {
        await client.query('BEGIN');
        transactionOpen = true;
        // safeTimeout is normalized as an integer above, so this command does
        // not interpolate user-controlled SQL.
        await client.query(`SET LOCAL statement_timeout = ${safeTimeout}`);
        const result = await client.query(getPostgresSql(sql), params);
        await client.query('COMMIT');
        transactionOpen = false;
        return result.rows;
    } catch (error) {
        if (transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                releaseError = rollbackError;
            }
        }
        throw error;
    } finally {
        const duration = Date.now() - startedAt;
        if (duration >= SLOW_SQL_THRESHOLD_MS) notifySlowSql(sql, duration, params);
        // Do not allow a client with a failed rollback to contaminate the pool.
        client.release(releaseError || undefined);
    }
}

/**
 * 查询单行（无结果返回 null）
 * @param {string} sql
 * @param {any[]}  params
 * @returns {Promise<any|null>}
 */
async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] ?? null;
}

/**
 * 执行写操作（INSERT / UPDATE / DELETE），返回影响行数
 * @param {string} sql
 * @param {any[]}  params
 * @returns {Promise<number>}
 */
async function execute(sql, params = []) {
    const startedAt = Date.now();
    const result = await (getScopedSession() || getPgPool()).query(getPostgresSql(sql), params);
    const duration = Date.now() - startedAt;
    if (duration >= SLOW_SQL_THRESHOLD_MS) {
        notifySlowSql(sql, duration, params);
    }
    return result.rowCount ?? 0;
}

/**
 * 事务执行
 * @param {(trx: {query, queryOne, execute}) => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function transaction(fn) {
    if (getScopedSession()) throw new Error('持锁任务不支持独立数据库事务。');
    const client = await getPgPool().connect();
    let releaseError = null;
    try {
        await client.query('BEGIN');
        const trx = {
            query: async (sql, params = []) => {
                const startedAt = Date.now();
                const result = await client.query(getPostgresSql(sql), params);
                const duration = Date.now() - startedAt;
                if (duration >= SLOW_SQL_THRESHOLD_MS) {
                    notifySlowSql(sql, duration, params);
                }
                return result.rows;
            },
            queryOne: async (sql, params = []) => {
                const startedAt = Date.now();
                const result = await client.query(getPostgresSql(sql), params);
                const duration = Date.now() - startedAt;
                if (duration >= SLOW_SQL_THRESHOLD_MS) {
                    notifySlowSql(sql, duration, params);
                }
                return result.rows[0] ?? null;
            },
            execute: async (sql, params = []) => {
                const startedAt = Date.now();
                const result = await client.query(getPostgresSql(sql), params);
                const duration = Date.now() - startedAt;
                if (duration >= SLOW_SQL_THRESHOLD_MS) {
                    notifySlowSql(sql, duration, params);
                }
                return result.rowCount ?? 0;
            },
        };
        const result = await fn(trx);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        // 回滚本身可能再次失败（连接已断、statement_timeout 触发、事务已中断）。
        // 此时连接可能仍停在未结束的事务里：若无参数 release()，pg-pool 会把它放回
        // 空闲池（pg-pool/index.js:392 仅在传入 err 时才 _remove），后续使用者都会拿到
        // "current transaction is aborted"，坏连接逐个累积直到池被占满——表现为全站
        // 接口不可用且只有重启进程才能恢复。所以回滚失败必须让连接池销毁该连接。
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            releaseError = rollbackError;
        }
        throw err;
    } finally {
        // 传入错误 => pg-pool 销毁连接；无错误 => 正常归还。
        client.release(releaseError || undefined);
    }
}

module.exports = {
    query,
    queryWithStatementTimeout,
    queryOne,
    execute,
    transaction,
    toPostgresParams,
    // 向后兼容导出
    pgQuery: query,
    pgQueryOne: queryOne,
    pgExecute: execute,
    pgTransaction: transaction
};
