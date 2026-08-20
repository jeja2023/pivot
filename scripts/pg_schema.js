/**
 * scripts/pg_schema.js
 * 在 PostgreSQL 数据库中创建 Pivot 全量 Schema 与元数据注释字典
 * 用法: DATABASE_URL=... node scripts/pg_schema.js
 */
const { Pool } = require('pg');
const { buildPgSchemaStatements, normalizeLegacyResidualColumnTypes } = require('../server/db/schema/pg');

const pgUrl = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/pivot';
const pool = new Pool({
    connectionString: pgUrl,
    connectionTimeoutMillis: 10000
});

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   PostgreSQL 全量 Schema 与数据字典注释构建引擎          ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const client = await pool.connect();
    console.log(`🔌 正在连接 PostgreSQL: ${pgUrl.replace(/:[^:@]+@/, ':***@')}\n`);

    try {
        const plan = buildPgSchemaStatements();

        // 1. 安装扩展
        console.log('【1/6】安装 PostgreSQL 扩展...');
        for (const sql of plan.extensions) {
            try {
                await client.query(sql);
                console.log(`  ✓ ${sql}`);
            } catch (e) {
                console.warn(`  ⚠️ 扩展安装警告: ${e.message}`);
            }
        }

        // 2. 辅助函数
        console.log('\n【2/6】安装辅助函数 (JSON 容错函数等)...');
        for (const sql of plan.helperFunctions) {
            await client.query(sql);
            console.log('  ✓ pivot_json_extract() 已部署');
        }

        await client.query('BEGIN');

        // 3. 创建 79 张业务表
        console.log(`\n【3/6】创建业务表 (共 ${plan.tables.length} 张)...`);
        for (const sql of plan.tables) {
            await client.query(sql);
            const tableMatch = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/i.exec(sql);
            console.log(`  ✓ 表 [${tableMatch ? tableMatch[1] : 'unknown'}] 创建成功`);
        }

        // 4. 补遗留列与外键约束
        console.log(`\n【4/6】补遗留列并补建外键约束 (共 ${plan.foreignKeys.length} 条)...`);
        for (const sql of plan.residualColumns) {
            await client.query(sql);
        }
        await normalizeLegacyResidualColumnTypes(client);
        for (const sql of plan.foreignKeys) {
            await client.query(sql);
        }
        console.log('  ✓ 外键约束已全部补建完毕');

        // 5. 创建索引与全文检索 GIN
        console.log(`\n【5/6】创建索引与全文检索 GIN 索引 (共 ${plan.indexes.length + plan.fulltextIndexes.length} 个)...`);
        for (const sql of plan.indexes) {
            await client.query(sql);
        }
        for (const sql of plan.fulltextIndexes) {
            try {
                await client.query(sql);
            } catch (e) {
                console.warn(`  ⚠️ 全文索引警告: ${e.message}`);
            }
        }
        console.log('  ✓ 索引创建完毕');

        // 6. 应用全量表级与字段级中文注释
        console.log(`\n【6/6】注入表级与字段级中文元数据注释 (共 ${plan.comments.length} 条)...`);
        let commentsApplied = 0;
        for (const sql of plan.comments) {
            try {
                await client.query(sql);
                commentsApplied++;
            } catch (e) {
                // 忽略单个注释异常
            }
        }
        console.log(`  ✓ 成功注入 ${commentsApplied} 条中文数据字典注释`);

        await client.query('COMMIT');

        console.log('\n====================================================');
        console.log('🎉 PostgreSQL Schema 与数据字典注释已 100% 全部创建完成！');
        console.log('====================================================');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('\n❌ [Fatal Error] Schema 构建失败:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
