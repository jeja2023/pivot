'use strict';

// 目标 PostgreSQL 环境的发布后验收：确认两批知识派生迁移、关键表和索引均已
// 生效。脚本只读，不修改数据库；适合作为部署流水线或人工升级后的证据采集。
require('dotenv').config();
const { getPgPool, closePgPool } = require('../server/db/pg-connection');

const MIGRATIONS = [
    '202610100001_knowledge_derived_governance',
    '202610100002_knowledge_derived_quality',
    '202610100003_knowledge_derived_quality_repair'
];
const TABLES = [
    'knowledge_graph_claims', 'knowledge_graph_claim_evidence', 'knowledge_graph_merge_audits',
    'knowledge_wiki_compile_inputs', 'knowledge_source_lifecycle_outbox', 'knowledge_entity_aliases'
];
const INDEXES = [
    'idx_kg_claim_evidence_source', 'idx_wiki_compile_inputs_run',
    'idx_knowledge_source_lifecycle_outbox_claim', 'idx_knowledge_entity_aliases_lookup'
];
const COLUMNS = [
    ['knowledge_graph_claim_evidence', 'stance'],
    ['knowledge_graph_claim_evidence', 'excerpt_text'],
    ['knowledge_graph_claims', 'confidence_reason_json']
];

async function main() {
    if (!String(process.env.DATABASE_URL || '').trim()) {
        throw new Error('需要 DATABASE_URL 才能验证目标 PostgreSQL 的知识派生治理迁移。');
    }
    const pool = getPgPool();
    try {
        const [migrationRows, tableRows, indexRows, columnRows] = await Promise.all([
            pool.query('SELECT id FROM schema_migrations WHERE id = ANY($1::text[])', [MIGRATIONS]),
            pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])', [TABLES]),
            pool.query('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])', [INDEXES]),
            pool.query(`
                SELECT table_name, column_name
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND (table_name, column_name) IN (${COLUMNS.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(', ')})
            `, COLUMNS.flat())
        ]);
        const presentMigrations = new Set(migrationRows.rows.map(row => row.id));
        const presentTables = new Set(tableRows.rows.map(row => row.table_name));
        const presentIndexes = new Set(indexRows.rows.map(row => row.indexname));
        const presentColumns = new Set(columnRows.rows.map(row => `${row.table_name}.${row.column_name}`));
        const missing = [
            ...MIGRATIONS.filter(id => !presentMigrations.has(id)).map(id => `迁移 ${id}`),
            ...TABLES.filter(name => !presentTables.has(name)).map(name => `表 ${name}`),
            ...INDEXES.filter(name => !presentIndexes.has(name)).map(name => `索引 ${name}`),
            ...COLUMNS.filter(([table, column]) => !presentColumns.has(`${table}.${column}`)).map(([table, column]) => `字段 ${table}.${column}`)
        ];
        if (missing.length) throw new Error(`知识派生治理验收未通过：缺少 ${missing.join('；')}`);
        console.log(JSON.stringify({ ok: true, migrations: MIGRATIONS, tables: TABLES, indexes: INDEXES, columns: COLUMNS }, null, 2));
    } finally {
        await closePgPool();
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
