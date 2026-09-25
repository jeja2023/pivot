/**
 * PostgreSQL 主数据库 schema 初始化。
 *
 * 主库已正式收敛到 PostgreSQL。`pg-schema.snapshot.json` 是经审查的原生
 * PostgreSQL DDL 快照是主数据库唯一 schema 来源。
 */
const { getPgPool } = require('../pg-connection');
const snapshot = require('./pg-schema.snapshot.json');
const { buildPgCommentStatements } = require('./comments');
const { logger } = require('../../logger');

const PG_NOW = `(NOW() AT TIME ZONE 'Asia/Shanghai')`;
const PG_SCHEMA_VERSION = '20260926.5';
const PG_SCHEMA_RECONCILE_ENV = 'PIVOT_PG_SCHEMA_RECONCILE';

const PG_HELPER_FUNCTIONS = [
    `
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE p.proname = 'pivot_json_extract' AND n.nspname = current_schema()
        ) THEN
            CREATE FUNCTION pivot_json_extract(payload text, path text[])
            RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
            BEGIN
                IF payload IS NULL OR payload = '' THEN RETURN NULL; END IF;
                RETURN payload::jsonb #>> path;
            EXCEPTION WHEN others THEN RETURN NULL;
            END
            $fn$;
        END IF;
    END $$;`
];

function getPgSchemaName() {
    const testSchema = String(process.env.PG_TEST_SCHEMA || '').trim();
    return /^[a-z_][a-z0-9_]{0,62}$/i.test(testSchema) ? testSchema : 'public';
}

function quotePgIdentifier(value) {
    return `"${String(value || '').replace(/"/g, '""')}"`;
}

function qualifiedPgTable(tableName) {
    return `${quotePgIdentifier(getPgSchemaName())}.${quotePgIdentifier(tableName)}`;
}

async function isPgSchemaCurrent(pool) {
    if (String(process.env[PG_SCHEMA_RECONCILE_ENV] || '').toLowerCase() === 'true') return false;
    try {
        const result = await pool.query(`SELECT value FROM ${qualifiedPgTable('app_meta')} WHERE key = $1`, ['pg_schema_version']);
        return result.rows[0]?.value === PG_SCHEMA_VERSION;
    } catch (_) {
        return false;
    }
}

async function markPgSchemaCurrent(client) {
    await client.query(`
        INSERT INTO ${qualifiedPgTable('app_meta')} (key, value, updated_at)
        VALUES ($1, $2, ${PG_NOW})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `, ['pg_schema_version', PG_SCHEMA_VERSION]);
}

function tableNameFromDdl(ddl) {
    const match = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w]+)["`]?/i.exec(String(ddl || '').trim());
    if (!match) throw new Error(`[PG Schema] 无法解析表名: ${String(ddl || '').slice(0, 80)}`);
    return match[1];
}

function getPgSchemaTableNames() {
    return snapshot.tables.map(tableNameFromDdl);
}

function buildPgSchemaStatements() {
    return {
        extensions: [
            `DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid WHERE e.extname = 'vector' AND n.nspname <> 'public') THEN
                    ALTER EXTENSION vector SET SCHEMA public;
                END IF;
                IF EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid WHERE e.extname = 'pg_trgm' AND n.nspname <> 'public') THEN
                    ALTER EXTENSION pg_trgm SET SCHEMA public;
                END IF;
            END $$;`,
            'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public',
            'CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public'
        ],
        helperFunctions: PG_HELPER_FUNCTIONS,
        tables: snapshot.tables,
        residualColumns: snapshot.residualColumns,
        foreignKeys: snapshot.foreignKeys,
        indexes: snapshot.indexes,
        fulltextIndexes: snapshot.fulltextIndexes,
        comments: buildPgCommentStatements(),
        foreignKeyMeta: snapshot.foreignKeyMeta
    };
}

async function syncIdentitySequences(client) {
    try {
        const seqs = await client.query(`
            SELECT table_name, column_name, pg_get_serial_sequence('"' || table_name || '"', column_name) AS seq_name
            FROM information_schema.columns
            WHERE table_schema = current_schema() AND column_name = 'id'
              AND pg_get_serial_sequence('"' || table_name || '"', column_name) IS NOT NULL
        `);
        for (const row of seqs.rows) {
            if (!row.seq_name) continue;
            try {
                // 表为空时 setval 需指定 is_called=false，保证首次插入获取 id=1；存在记录时对齐 MAX(id) 且 is_called=true。
                await client.query(`SELECT CASE WHEN MAX("id") IS NOT NULL THEN setval($1, MAX("id"), true) ELSE setval($1, 1, false) END FROM "${row.table_name}"`, [row.seq_name]);
            } catch (_) {}
        }
    } catch (error) {
        logger.warn({ err: error.message }, '[PG] 自增序列自愈校准跳过');
    }
}

async function normalizeLegacyResidualColumnTypes(client) {
    try {
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'analysis_datasets'
                      AND column_name = 'active_version' AND data_type <> 'bigint'
                ) THEN
                    ALTER TABLE "analysis_datasets" ALTER COLUMN "active_version" DROP DEFAULT;
                    ALTER TABLE "analysis_datasets" ALTER COLUMN "active_version" TYPE BIGINT
                    USING CASE WHEN trim("active_version"::text) ~ '^[+-]?[0-9]+$'
                        THEN trim("active_version"::text)::bigint ELSE NULL END;
                    ALTER TABLE "analysis_datasets" ALTER COLUMN "active_version" SET DEFAULT 1;
                END IF;
            END $$;
        `);
    } catch (error) {
        if (error.code === '42501' || error.code === '57014') {
            logger.warn({ err: error.message, code: error.code }, '[PG] 遗留列类型校准受限或超时，保留现有列类型');
        } else {
            throw error;
        }
    }
}

async function applyPgSchemaComments() {
    const statements = buildPgCommentStatements();
    const pool = getPgPool();
    if (await isPgSchemaCurrent(pool)) return;
    const client = await pool.connect();
    let applied = 0;
    try {
        for (const sql of statements) {
            try { await client.query(sql); applied += 1; }
            catch (error) { logger.warn({ sql, err: error.message }, '[PG] 添加表或字段注释失败'); }
        }
    } finally {
        client.release();
    }
    const markerClient = await pool.connect();
    try { await markPgSchemaCurrent(markerClient); } finally { markerClient.release(); }
    logger.info({ applied, total: statements.length }, '[PG] 数据字典注释已应用');
}

async function initSchemaPg() {
    const pool = getPgPool();
    if (await isPgSchemaCurrent(pool)) {
        logger.debug({ version: PG_SCHEMA_VERSION }, '[PG] Schema 已完成收敛，跳过重复 DDL');
        return;
    }
    const plan = buildPgSchemaStatements();
    const client = await pool.connect();
    try {
        for (const sql of plan.extensions) {
            try { await client.query(sql); }
            catch (error) {
                if (sql.includes('CREATE EXTENSION IF NOT EXISTS vector')) throw new Error(`[PG Schema] pgvector 扩展安装失败，无法创建 embedding 列: ${error.message}`);
                logger.warn({ sql, err: error.message }, '[PG] 扩展安装失败，相关能力将不可用');
            }
        }
        for (const sql of plan.helperFunctions) {
            try { await client.query(sql); }
            catch (error) {
                if (error.code === '42501' || String(error.message).includes('pivot_json_extract')) logger.warn({ err: error.message }, '[PG] 函数已存在且非属主，跳过函数更新');
                else throw error;
            }
        }
        for (const sql of plan.tables) {
            try { await client.query(sql); }
            catch (error) {
                if (error.code === '42501' || error.code === '42P07' || String(error.message).includes('already exists')) logger.warn({ err: error.message }, '[PG] 表已存在或权限受限，跳过建表');
                else throw new Error(`[PG Schema] 建表失败: ${error.message}\nDDL: ${sql.slice(0, 400)}`);
            }
        }
        for (const sql of plan.residualColumns) {
            try { await client.query(sql); }
            catch (error) {
                if (error.code === '42501' || error.code === '42701') logger.warn({ sql, err: error.message }, '[PG] 当前用户非表属主或列已存在，跳过遗留列补齐');
                else throw error;
            }
        }
        await normalizeLegacyResidualColumnTypes(client);
        for (const sql of plan.foreignKeys) {
            try { await client.query(sql); }
            catch (error) {
                if (error.code === '42501' || error.code === '42710') logger.warn({ sql: sql.trim().slice(0, 200), err: error.message }, '[PG] 当前用户非表属主或外键已存在，跳过外键补建');
                else if (error.code === '42703') logger.warn({ sql: sql.trim().slice(0, 200), err: error.message }, '[PG] 外键依赖字段尚不存在，跳过当前初始化阶段外键补建（由版本迁移补齐）');
                else throw new Error(`[PG Schema] 外键补建失败: ${error.message}\nSQL: ${sql.trim().slice(0, 300)}`);
            }
        }
        for (const sql of plan.indexes) {
            try { await client.query(sql); }
            catch (error) {
                if (error.code === '42501' || error.code === '42P07') logger.warn({ sql: sql.slice(0, 200), err: error.message }, '[PG] 当前用户非属主或索引已存在，跳过索引补建');
                else if (error.code === '42703') logger.warn({ sql: sql.slice(0, 200), err: error.message }, '[PG] 索引依赖字段尚不存在，跳过当前初始化阶段索引建立（由版本迁移补齐）');
                else throw new Error(`[PG Schema] 建索引失败: ${error.message}\nSQL: ${sql.slice(0, 300)}`);
            }
        }
        for (const sql of plan.fulltextIndexes) {
            try { await client.query(sql); }
            catch (error) { logger.warn({ err: error.message }, '[PG] pg_trgm 全文索引创建失败，全文检索将退化为顺序扫描'); }
        }
        await syncIdentitySequences(client);
    } finally {
        client.release();
    }
    logger.info({ tables: plan.tables.length, foreignKeys: plan.foreignKeys.length, indexes: plan.indexes.length }, '[PG] Schema 初始化完成');
}

module.exports = {
    PG_NOW,
    PG_SCHEMA_VERSION,
    applyPgSchemaComments,
    buildPgSchemaStatements,
    getPgSchemaName,
    getPgSchemaTableNames,
    initSchemaPg,
    isPgSchemaCurrent,
    normalizeLegacyResidualColumnTypes
};
