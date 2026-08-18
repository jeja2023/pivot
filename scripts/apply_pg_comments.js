/**
 * scripts/apply_pg_comments.js
 * 一键向 PostgreSQL 数据库应用全量 79 张表及全部字段的中文元数据注释
 *
 * 用法：
 *   DATABASE_URL="postgresql://user:pass@host:5432/dbname" node scripts/apply_pg_comments.js
 */
const { Pool } = require('pg');
const { buildPgCommentStatements } = require('../server/db/schema/comments');

const pgUrl = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/pivot';

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   PostgreSQL 数据字典元数据注释一键注入工具             ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const pool = new Pool({ connectionString: pgUrl });
    const client = await pool.connect();

    try {
        const statements = buildPgCommentStatements();
        console.log(`📦 共生成 ${statements.length} 条元数据注释语句（包含 79 张表及全量业务字段）`);
        console.log(`🔌 正在连接目标数据库: ${pgUrl.replace(/:[^:@]+@/, ':***@')}\n`);

        let tableSuccess = 0;
        let colSuccess = 0;
        let skipped = 0;

        await client.query('BEGIN');

        for (const sql of statements) {
            try {
                await client.query(sql);
                if (sql.startsWith('COMMENT ON TABLE')) tableSuccess++;
                else if (sql.startsWith('COMMENT ON COLUMN')) colSuccess++;
            } catch (err) {
                // 如果表或列尚不存在，跳过并记录
                skipped++;
            }
        }

        await client.query('COMMIT');

        console.log('✅ 元数据注释应用完成！统计结果:');
        console.log(`   - 成功应用表级注释: ${tableSuccess} 张表`);
        console.log(`   - 成功应用字段注释: ${colSuccess} 个字段`);
        if (skipped > 0) {
            console.log(`   - 跳过未存在的表/列: ${skipped} 项`);
        }
        console.log('\n🎉 现在打开 Navicat、DBeaver 或 DataGrip 即可直观查看完整的中文数据字典！');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ 执行失败:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
