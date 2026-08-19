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
    const result = await getPgPool().query(toPostgresParams(sql), params);
    return result.rows;
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
    const result = await getPgPool().query(toPostgresParams(sql), params);
    return result.rowCount ?? 0;
}

/**
 * 事务执行
 * @param {(trx: {query, queryOne, execute}) => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function transaction(fn) {
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

module.exports = {
    query,
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
