/**
 * scripts/diff_schema_sqlite_pg.js
 * SQLite ↔ PostgreSQL Schema 对账工具
 *
 * 迁移工程中最危险的失败模式是「PG 侧静默漏列」：生产 SQLite 库经过多年
 * legacy 迁移演化，物理列集合可能超出建表 DDL 的描述；一旦 PG 缺列，
 * migrate_sqlite_to_pg.js 的 `SELECT *` 抽取会在批量 INSERT 时才炸，
 * 且已迁移的表已提交，排查成本极高。
 *
 * 本工具在迁移「之前」把差异全部暴露出来：
 *   - 缺表 / 多表
 *   - 缺列 / 多列
 *   - 类型映射是否符合预期（INTEGER→BIGINT、DATETIME→TIMESTAMPTZ 等）
 *
 * 用法：
 *   node scripts/diff_schema_sqlite_pg.js
 *   SQLITE_DB_PATH=./data/chat.db DATABASE_URL=postgresql://... node scripts/diff_schema_sqlite_pg.js
 *
 * 退出码：0 = 无阻断性差异；1 = 存在缺表/缺列（禁止迁移）
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const sqlitePath = process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../data/chat.db');
const pgUrl = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/pivot';

// SQLite FTS5 影子表在 PG 侧由 pg_trgm GIN 索引替代，不参与对账
const IGNORED_TABLE_PATTERNS = [
    /_fts$/,
    /_fts_(data|idx|content|docsize|config)$/,
    /^sqlite_/,
];

// SQLite 声明类型 → 期望的 PG 类型（information_schema.data_type 取值）
const EXPECTED_TYPE_MAP = {
    'INTEGER': ['bigint'],
    'TEXT': ['text', 'character varying'],
    'REAL': ['double precision'],
    'DATETIME': ['timestamp with time zone'],
    'BLOB': ['bytea'],
    '': ['text'], // SQLite 无类型声明列
};

function isIgnoredTable(name) {
    return IGNORED_TABLE_PATTERNS.some(pattern => pattern.test(name));
}

function normalizeSqliteType(declared) {
    const type = String(declared || '').trim().toUpperCase();
    if (!type) return '';
    if (type.startsWith('INT')) return 'INTEGER';
    if (type.startsWith('VARCHAR') || type.startsWith('CHAR') || type === 'TEXT' || type.startsWith('CLOB')) return 'TEXT';
    if (type === 'REAL' || type.startsWith('DOUBLE') || type.startsWith('FLOAT') || type.startsWith('NUMERIC') || type.startsWith('DECIMAL')) return 'REAL';
    if (type === 'DATETIME' || type === 'DATE' || type === 'TIMESTAMP') return 'DATETIME';
    if (type === 'BLOB') return 'BLOB';
    if (type === 'BOOLEAN') return 'INTEGER';
    return type;
}

function readSqliteSchema() {
    if (!fs.existsSync(sqlitePath)) {
        throw new Error(`未找到 SQLite 数据库文件: ${sqlitePath}`);
    }
    const db = new Database(sqlitePath, { readonly: true });
    try {
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map(row => row.name)
            .filter(name => !isIgnoredTable(name));

        const schema = new Map();
        for (const table of tables) {
            const columns = new Map();
            for (const col of db.prepare(`PRAGMA table_info("${table}")`).all()) {
                columns.set(col.name, {
                    declaredType: col.type,
                    normalizedType: normalizeSqliteType(col.type),
                    notNull: col.notnull === 1,
                });
            }
            schema.set(table, columns);
        }
        return schema;
    } finally {
        db.close();
    }
}

async function readPgSchema(pool) {
    const tablesResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);
    const columnsResult = await pool.query(`
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
    `);

    const schema = new Map();
    for (const row of tablesResult.rows) {
        if (isIgnoredTable(row.table_name)) continue;
        schema.set(row.table_name, new Map());
    }
    for (const row of columnsResult.rows) {
        const columns = schema.get(row.table_name);
        if (!columns) continue;
        columns.set(row.column_name, {
            dataType: row.data_type,
            notNull: row.is_nullable === 'NO',
        });
    }
    return schema;
}

function pad(text, width) {
    const value = String(text);
    return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

async function main() {
    console.log('====================================================');
    console.log('   SQLite ↔ PostgreSQL Schema 对账');
    console.log('====================================================');
    console.log(`   SQLite : ${sqlitePath}`);
    console.log(`   PG     : ${pgUrl.replace(/:[^:@]*@/, ':****@')}`);
    console.log('');

    const sqliteSchema = readSqliteSchema();
    const pool = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 10000 });

    let pgSchema;
    try {
        pgSchema = await readPgSchema(pool);
    } catch (err) {
        console.error(`❌ 无法读取 PostgreSQL Schema: ${err.message}`);
        await pool.end();
        process.exit(1);
    }

    const blocking = [];
    const warnings = [];

    // ── 表级对账 ───────────────────────────────────────────────────────────
    const missingTables = [...sqliteSchema.keys()].filter(t => !pgSchema.has(t));
    const extraTables = [...pgSchema.keys()].filter(t => !sqliteSchema.has(t));

    console.log(`【表】SQLite ${sqliteSchema.size} 张 / PG ${pgSchema.size} 张`);
    if (missingTables.length) {
        blocking.push(`PG 缺少 ${missingTables.length} 张表`);
        console.log(`  ❌ PG 缺表 (${missingTables.length}): ${missingTables.join(', ')}`);
    }
    if (extraTables.length) {
        warnings.push(`PG 多出 ${extraTables.length} 张表`);
        console.log(`  ⚠️  PG 多表 (${extraTables.length}): ${extraTables.join(', ')}`);
    }
    if (!missingTables.length && !extraTables.length) {
        console.log('  ✅ 表集合完全一致');
    }
    console.log('');

    // ── 列级对账 ───────────────────────────────────────────────────────────
    console.log('【列】逐表比对');
    let cleanTables = 0;
    for (const [table, sqliteColumns] of sqliteSchema) {
        const pgColumns = pgSchema.get(table);
        if (!pgColumns) continue;

        const missingColumns = [];
        const typeMismatches = [];

        for (const [column, meta] of sqliteColumns) {
            const pgColumn = pgColumns.get(column);
            if (!pgColumn) {
                missingColumns.push(`${column} (${meta.declaredType || 'untyped'})`);
                continue;
            }
            const expected = EXPECTED_TYPE_MAP[meta.normalizedType];
            if (expected && !expected.includes(pgColumn.dataType)) {
                typeMismatches.push(
                    `${column}: SQLite ${meta.declaredType || 'untyped'} → PG ${pgColumn.dataType} (期望 ${expected.join('/')})`
                );
            }
        }

        const extraColumns = [...pgColumns.keys()].filter(c => !sqliteColumns.has(c));

        if (!missingColumns.length && !typeMismatches.length && !extraColumns.length) {
            cleanTables++;
            continue;
        }

        console.log(`  ${pad(table, 38)}`);
        if (missingColumns.length) {
            blocking.push(`${table} 缺 ${missingColumns.length} 列`);
            console.log(`    ❌ PG 缺列: ${missingColumns.join(', ')}`);
        }
        if (typeMismatches.length) {
            warnings.push(`${table} 有 ${typeMismatches.length} 处类型偏差`);
            typeMismatches.forEach(m => console.log(`    ⚠️  类型: ${m}`));
        }
        if (extraColumns.length) {
            console.log(`    ℹ️  PG 多列: ${extraColumns.join(', ')}`);
        }
    }
    console.log(`  ✅ ${cleanTables} 张表列集合完全一致`);
    console.log('');

    await pool.end();

    // ── 结论 ───────────────────────────────────────────────────────────────
    console.log('====================================================');
    if (blocking.length) {
        console.error('❌ 存在阻断性差异，严禁执行数据迁移：');
        blocking.forEach(item => console.error(`   • ${item}`));
        console.error('');
        console.error('   修复方式：在 server/db/schema/base.js 补齐列定义后，');
        console.error('   重新运行 initSchemaPg()（或 node scripts/pg_schema.js）。');
        process.exit(1);
    }
    if (warnings.length) {
        console.log('⚠️  存在非阻断差异，请人工确认后再迁移：');
        warnings.forEach(item => console.log(`   • ${item}`));
    } else {
        console.log('🎉 Schema 完全对齐，允许执行数据迁移。');
    }
    console.log('====================================================');
}

main().catch(err => {
    console.error('❌ 对账失败:', err.message);
    process.exit(1);
});
