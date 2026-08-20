/**
 * server/db/schema/pg.js
 * PostgreSQL Schema 初始化 —— 基于 SQLite 权威 DDL 的方言转换器
 *
 * 设计原则：不手写第二份建表脚本。schema/base.js 的 baseTablesSql() 是唯一
 * 数据源，本模块读取该文本并做机械转换，因此新增表/列只改 base.js 一处，
 * 两种方言永不漂移，从根本上杜绝「PG 漏列」类事故。
 *
 * 转换规则：
 *   INTEGER PRIMARY KEY AUTOINCREMENT → BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
 *   INTEGER                           → BIGINT（布尔语义列仍是 0/1 整型，与 SQLite 完全一致）
 *   REAL                              → DOUBLE PRECISION
 *   DATETIME                          → TIMESTAMPTZ
 *   datetime('now', '+8 hours')       → (NOW() AT TIME ZONE 'Asia/Shanghai')
 *   FOREIGN KEY 子句                  → 建表时剥离，全部表建完后统一 ALTER 补回
 *                                       （规避 SQLite 允许、PG 不允许的前向引用）
 *   FTS5 虚拟表 + 触发器              → 不建，改用 pg_trgm GIN 索引
 *
 * 向量列（embedding）本轮仍保持 TEXT：应用层现有 `embedding != ''` 判断与
 * JS 端余弦计算依赖字符串语义。原生 vector 化属 RAG 专项，另行推进。
 */
const { getPgPool } = require('../pg-connection');
const { baseTablesSql, baseIndexesSql } = require('./base');
const { buildPgCommentStatements } = require('./comments');
const { logger } = require('../../logger');

const PG_NOW = `(NOW() AT TIME ZONE 'Asia/Shanghai')`;

/**
 * 生产 SQLite 库中物理存在、但当前代码已不再引用的历史遗留列。
 * 全量数据迁移使用 `SELECT *` 抽取，PG 侧缺列会直接导致 INSERT 失败，
 * 故必须显式保留。清理需等历史数据归档后另行决策。
 */
const LEGACY_RESIDUAL_COLUMNS = [
    ['models', 'disable_chat_thinking', 'BIGINT DEFAULT 0'],
    ['analysis_datasets', 'active_version', "TEXT DEFAULT ''"],
];

// ──────────────────────────────────────────────────────────────────────────
// DDL 文本转换
// ──────────────────────────────────────────────────────────────────────────

/**
 * 把 SQLite 列定义片段转换为 PG 方言
 */
function convertColumnTypes(text) {
    return text
        // 自增主键（必须先于通用 INTEGER 替换）
        .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
                 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY')
        // 时间函数默认值：DEFAULT (datetime('now', '+8 hours')) → DEFAULT (NOW() AT TIME ZONE ...)
        .replace(/datetime\(\s*'now'\s*,\s*'\+8 hours'\s*\)/gi, `NOW() AT TIME ZONE 'Asia/Shanghai'`)
        // 标量类型
        .replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ')
        .replace(/\bINTEGER\b/gi, 'BIGINT')
        .replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
}

/**
 * 将 baseTablesSql() 文本切分为独立 CREATE TABLE 语句。
 * 表定义内部不含分号（无触发器），可安全按 `);` 边界切分。
 */
function splitCreateTableStatements(sql) {
    return sql
        .split(/;\s*(?=\n|$)/)
        .map(part => part.trim())
        .filter(part => /^CREATE\s+TABLE/i.test(part));
}

/**
 * 从建表语句中剥离 FOREIGN KEY 子句。
 * @returns {{ ddl: string, foreignKeys: Array<{table, column, refTable, refColumn, onDelete}> }}
 */
function stripForeignKeys(statement) {
    const tableMatch = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/i.exec(statement);
    if (!tableMatch) throw new Error(`[PG Schema] 无法解析表名: ${statement.slice(0, 80)}`);
    const table = tableMatch[1];

    const foreignKeys = [];
    const keptLines = [];

    for (const rawLine of statement.split('\n')) {
        const line = rawLine.trim();
        const fk = /^FOREIGN\s+KEY\s*\(\s*(\w+)\s*\)\s*REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)\s*(ON\s+DELETE\s+[A-Z ]+?)?\s*,?$/i.exec(line);
        if (fk) {
            foreignKeys.push({
                table,
                column: fk[1],
                refTable: fk[2],
                refColumn: fk[3],
                onDelete: (fk[4] || '').trim(),
            });
            continue;
        }
        keptLines.push(rawLine);
    }

    // 剥离后可能留下悬空逗号（原最后一个列定义带逗号，因其后是 FK 行）
    let ddl = keptLines.join('\n');
    ddl = ddl.replace(/,(\s*)\)\s*$/, '$1)');

    return { ddl, foreignKeys };
}

/**
 * 生成幂等的外键补建语句（约束名与 PG 默认命名一致，避免重复添加）
 */
function buildAddForeignKeySql(fk) {
    const constraintName = `${fk.table}_${fk.column}_fkey`;
    const onDelete = fk.onDelete ? ` ${fk.onDelete.toUpperCase()}` : '';
    return `
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = '${constraintName}'
            ) THEN
                BEGIN
                    ALTER TABLE "${fk.table}"
                        ADD CONSTRAINT "${constraintName}"
                        FOREIGN KEY ("${fk.column}") REFERENCES "${fk.refTable}"("${fk.refColumn}")${onDelete};
                EXCEPTION WHEN foreign_key_violation OR others THEN
                    -- 若历史存量数据存在孤儿关联，使用 NOT VALID 挂载约束，保障后续新增数据受控
                    ALTER TABLE "${fk.table}"
                        ADD CONSTRAINT "${constraintName}"
                        FOREIGN KEY ("${fk.column}") REFERENCES "${fk.refTable}"("${fk.refColumn}")${onDelete}
                        NOT VALID;
                END;
            END IF;
        END $$`;
}

/**
 * 索引 DDL 的 PG 方言修正：
 *  - SQLite 允许对不存在的表建索引前不校验，PG 无差异，直接复用
 *  - 逐条切分以便单条失败可精确报错
 */
function splitIndexStatements(sql) {
    return sql
        .split(/;\s*(?=\n|$)/)
        .map(part => part.replace(/^\s*--.*$/gm, '').trim())
        .filter(part => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(part));
}

/**
 * PostgreSQL 专属：替代 SQLite FTS5 的全文检索索引（pg_trgm GIN）
 */
const PG_FULLTEXT_INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING gin (content gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_content_trgm ON knowledge_chunks USING gin (content gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_search_trgm ON knowledge_chunks USING gin (search_content gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_articles_content_trgm ON regulation_articles USING gin (content gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_regulation_articles_search_trgm ON regulation_articles USING gin (search_content gin_trgm_ops)`,
];

/**
 * PostgreSQL 专属：容错 JSON 提取函数。
 *
 * 业务表中 metadata / config 等字段是 TEXT 列，历史数据可能含非法 JSON。
 * SQLite 侧靠 json_valid() 前置守卫规避，PG 侧 `::jsonb` 转换失败会直接
 * 中断整条查询，故封装为带异常捕获的 IMMUTABLE 函数，非法输入返回 NULL。
 * 标记 IMMUTABLE 使其可用于表达式索引。
 */
const PG_HELPER_FUNCTIONS = [
    `
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE p.proname = 'pivot_json_extract'
              AND n.nspname = current_schema()
        ) THEN
            CREATE FUNCTION pivot_json_extract(payload text, path text[])
            RETURNS text
            LANGUAGE plpgsql
            IMMUTABLE
            PARALLEL SAFE
            AS $fn$
            BEGIN
                IF payload IS NULL OR payload = '' THEN
                    RETURN NULL;
                END IF;
                RETURN payload::jsonb #>> path;
            EXCEPTION WHEN others THEN
                RETURN NULL;
            END
            $fn$;
        END IF;
    END $$;`,
];

// ──────────────────────────────────────────────────────────────────────────
// 初始化入口
// ──────────────────────────────────────────────────────────────────────────

/**
 * 生成完整的 PG 初始化语句列表（可单独调用用于对账/演练，不触库）
 */
function buildPgSchemaStatements() {
    const tableStatements = splitCreateTableStatements(baseTablesSql());
    const tables = [];
    const foreignKeys = [];

    for (const statement of tableStatements) {
        const { ddl, foreignKeys: fks } = stripForeignKeys(statement);
        tables.push(convertColumnTypes(ddl));
        foreignKeys.push(...fks);
    }

    const residualColumns = LEGACY_RESIDUAL_COLUMNS.map(
        ([table, column, def]) => `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${def}`
    );

    return {
        extensions: [
            `CREATE EXTENSION IF NOT EXISTS vector`,
            `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
        ],
        helperFunctions: PG_HELPER_FUNCTIONS,
        tables,
        residualColumns,
        foreignKeys: foreignKeys.map(buildAddForeignKeySql),
        indexes: splitIndexStatements(baseIndexesSql()),
        fulltextIndexes: PG_FULLTEXT_INDEXES,
        comments: buildPgCommentStatements(),
        foreignKeyMeta: foreignKeys,
    };
}

async function syncIdentitySequences(client) {
    try {
        const seqs = await client.query(`
            SELECT table_name, column_name, pg_get_serial_sequence('"' || table_name || '"', column_name) AS seq_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND column_name = 'id'
              AND pg_get_serial_sequence('"' || table_name || '"', column_name) IS NOT NULL
        `);
        for (const row of seqs.rows) {
            if (!row.seq_name) continue;
            try {
                await client.query(`
                    SELECT setval($1, COALESCE((SELECT MAX("id") FROM "${row.table_name}"), 1), true)
                `, [row.seq_name]);
            } catch (_) {}
        }
    } catch (err) {
        logger.warn({ err: err.message }, '[PG] 自增序列自愈校准跳过');
    }
}

async function initSchemaPg() {
    const plan = buildPgSchemaStatements();
    const client = await getPgPool().connect();

    try {
        // 扩展安装可能因权限不足失败，单独处理且不阻断建表
        for (const sql of plan.extensions) {
            try {
                await client.query(sql);
            } catch (err) {
                logger.warn({ sql, err: err.message }, '[PG] 扩展安装失败，相关能力将不可用');
            }
        }

        for (const sql of plan.helperFunctions) {
            try {
                await client.query(sql);
            } catch (err) {
                if (err.code === '42501' || String(err.message).includes('pivot_json_extract')) {
                    logger.warn({ err: err.message }, '[PG] 函数已存在且非属主，跳过函数更新');
                } else {
                    throw err;
                }
            }
        }

        for (const sql of plan.tables) {
            try {
                await client.query(sql);
            } catch (err) {
                if (err.code === '42501' || err.code === '42P07' || String(err.message).includes('already exists')) {
                    logger.warn({ err: err.message }, '[PG] 表已存在或权限受限，跳过建表');
                } else {
                    throw new Error(`[PG Schema] 建表失败: ${err.message}\nDDL: ${sql.slice(0, 400)}`);
                }
            }
        }

        for (const sql of plan.residualColumns) {
            try {
                await client.query(sql);
            } catch (err) {
                if (err.code === '42501' || err.code === '42701') {
                    logger.warn({ sql, err: err.message }, '[PG] 当前用户非表属主或列已存在，跳过遗留列补齐');
                } else {
                    throw err;
                }
            }
        }

        for (const sql of plan.foreignKeys) {
            try {
                await client.query(sql);
            } catch (err) {
                if (err.code === '42501' || err.code === '42710') {
                    logger.warn({ sql: sql.trim().slice(0, 200), err: err.message }, '[PG] 当前用户非表属主或外键已存在，跳过外键补建');
                } else {
                    throw new Error(`[PG Schema] 外键补建失败: ${err.message}\nSQL: ${sql.trim().slice(0, 300)}`);
                }
            }
        }

        for (const sql of plan.indexes) {
            try {
                await client.query(sql);
            } catch (err) {
                if (err.code === '42501' || err.code === '42P07') {
                    logger.warn({ sql: sql.slice(0, 200), err: err.message }, '[PG] 当前用户非属主或索引已存在，跳过索引补建');
                } else {
                    throw new Error(`[PG Schema] 建索引失败: ${err.message}\nSQL: ${sql.slice(0, 300)}`);
                }
            }
        }

        for (const sql of plan.comments || []) {
            try {
                await client.query(sql);
            } catch (err) {
                logger.warn({ sql, err: err.message }, '[PG] 添加表或字段注释失败');
            }
        }

        // 全文索引依赖 pg_trgm，扩展缺失或非属主时降级跳过而非中断启动
        for (const sql of plan.fulltextIndexes) {
            try {
                await client.query(sql);
            } catch (err) {
                logger.warn({ err: err.message }, '[PG] pg_trgm 全文索引创建失败，全文检索将退化为顺序扫描');
            }
        }

        // 自动自愈校准全量主键自增序列，彻底杜绝数据迁移或备份还原后主键冲突
        await syncIdentitySequences(client);
    } finally {
        client.release();
    }

    logger.info({
        tables: plan.tables.length,
        foreignKeys: plan.foreignKeys.length,
        indexes: plan.indexes.length,
    }, '[PG] Schema 初始化完成');
}

module.exports = {
    initSchemaPg,
    buildPgSchemaStatements,
    convertColumnTypes,
    stripForeignKeys,
    PG_NOW,
};
