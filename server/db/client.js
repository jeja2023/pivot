/**
 * server/db/client.js
 * 统一异步数据库查询接口（PostgreSQL 与 SQLite 双模式）
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
 * 占位符兼容：? (SQLite 风格) 在 PG 模式下自动转换为 $1, $2, ...
 * 调用方无需关心底层方言差异。
 */
const { isPostgres } = require('./dialect');

// ──────────────────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────────────────

/**
 * 将 ? 占位符转换为 PostgreSQL 的 $1, $2, ... 格式
 */
function toPostgresParams(sql) {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
}

// ──────────────────────────────────────────────────────────────────────────
// PostgreSQL 实现
// ──────────────────────────────────────────────────────────────────────────

async function pgQuery(sql, params = []) {
    const { getPgPool } = require('./pg-connection');
    const result = await getPgPool().query(toPostgresParams(sql), params);
    return result.rows;
}

async function pgQueryOne(sql, params = []) {
    const rows = await pgQuery(sql, params);
    return rows[0] ?? null;
}

async function pgExecute(sql, params = []) {
    const { getPgPool } = require('./pg-connection');
    const result = await getPgPool().query(toPostgresParams(sql), params);
    return result.rowCount ?? 0;
}

async function pgTransaction(fn) {
    const { getPgPool } = require('./pg-connection');
    const client = await getPgPool().connect();
    try {
        await client.query('BEGIN');
        const trx = {
            query: async (sql, params = []) => {
                const result = await client.query(toPostgresParams(sql), params);
                return result.rows;
            },
            queryOne: async (sql, params = []) => {
                const result = await client.query(toPostgresParams(sql), params);
                return result.rows[0] ?? null;
            },
            execute: async (sql, params = []) => {
                const result = await client.query(toPostgresParams(sql), params);
                return result.rowCount ?? 0;
            },
        };
        const result = await fn(trx);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ──────────────────────────────────────────────────────────────────────────
// SQLite 实现（同步包装为 Promise，保持接口一致）
// ──────────────────────────────────────────────────────────────────────────

function sqliteQuery(sql, params = []) {
    const { db } = require('./connection');
    return Promise.resolve(db.prepare(sql).all(...params));
}

function sqliteQueryOne(sql, params = []) {
    const { db } = require('./connection');
    return Promise.resolve(db.prepare(sql).get(...params) ?? null);
}

function sqliteExecute(sql, params = []) {
    const { db } = require('./connection');
    const info = db.prepare(sql).run(...params);
    return Promise.resolve(info.changes ?? 0);
}

async function sqliteTransaction(fn) {
    // SQLite 的 db.transaction() 是同步的，无法真正包裹异步 fn
    // 退化为不带事务保障的顺序执行（仅用于开发 / 测试环境）
    const trx = {
        query: sqliteQuery,
        queryOne: sqliteQueryOne,
        execute: sqliteExecute,
    };
    return await fn(trx);
}

// ──────────────────────────────────────────────────────────────────────────
// 对外导出（根据方言自动路由）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 查询多行
 * @param {string} sql   支持 ? 或 $N 占位符
 * @param {any[]}  params 参数数组
 * @returns {Promise<any[]>}
 */
function query(sql, params = []) {
    return isPostgres() ? pgQuery(sql, params) : sqliteQuery(sql, params);
}

/**
 * 查询单行（无结果返回 null）
 * @param {string} sql
 * @param {any[]}  params
 * @returns {Promise<any|null>}
 */
function queryOne(sql, params = []) {
    return isPostgres() ? pgQueryOne(sql, params) : sqliteQueryOne(sql, params);
}

/**
 * 执行写操作（INSERT / UPDATE / DELETE），返回影响行数
 * @param {string} sql
 * @param {any[]}  params
 * @returns {Promise<number>}
 */
function execute(sql, params = []) {
    return isPostgres() ? pgExecute(sql, params) : sqliteExecute(sql, params);
}

/**
 * 事务执行（PG：真实事务；SQLite：顺序执行）
 * @param {(trx: {query, queryOne, execute}) => Promise<any>} fn
 * @returns {Promise<any>}
 */
function transaction(fn) {
    return isPostgres() ? pgTransaction(fn) : sqliteTransaction(fn);
}

module.exports = { query, queryOne, execute, transaction, toPostgresParams };
