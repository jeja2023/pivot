/**
 * scripts/truncate_all_pg_tables.js
 * 迁移前清空 pivot 库所有表（禁用外键约束后逐表截断）
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/pivot'
});

async function main() {
    const client = await pool.connect();
    try {
        await client.query('SET session_replication_role = replica');
        const res = await client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        );
        if (res.rows.length > 0) {
            const tableList = res.rows.map(r => `"${r.tablename}"`).join(', ');
            await client.query(`TRUNCATE TABLE ${tableList} CASCADE`);
        }
        await client.query('SET session_replication_role = DEFAULT');
        console.log(`✅ 已清空所有 ${res.rows.length} 张表`);
    } finally {
        client.release();
        await pool.end();
    }
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
