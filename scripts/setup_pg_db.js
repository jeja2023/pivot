/**
 * scripts/setup_pg_db.js
 * 创建 pivot_prod 数据库、pivot 用户，安装 pgvector / pg_trgm 扩展
 */
const { Client } = require('pg');

const PG_HOST     = process.env.PG_HOST     || 'localhost';
const PG_PORT     = process.env.PG_PORT     || 5432;
const PG_PASSWORD = process.env.PG_PASSWORD || '123456';
const PG_DBNAME   = process.env.PG_DBNAME   || 'pivot';

async function main() {
    // 以超级用户连接 postgres 库
    const admin = new Client({
        user: 'postgres', host: PG_HOST, port: PG_PORT,
        database: 'postgres', password: PG_PASSWORD
    });
    await admin.connect();
    console.log('✅ 已连接 PostgreSQL 18 (postgres 库)');

    // 检查目标数据库
    const dbCheck = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname = $1", [PG_DBNAME]
    );
    if (dbCheck.rows.length === 0) {
        await admin.query(`CREATE DATABASE "${PG_DBNAME}" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
        console.log(`✅ 数据库 [${PG_DBNAME}] 已创建`);
    } else {
        console.log(`ℹ️  数据库 [${PG_DBNAME}] 已存在，跳过创建`);
    }
    await admin.end();

    // 连接目标库安装扩展
    const target = new Client({
        user: 'postgres', host: PG_HOST, port: PG_PORT,
        database: PG_DBNAME, password: PG_PASSWORD
    });
    await target.connect();

    // pg_trgm —— 内置扩展，随 PG 安装
    try {
        await target.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        console.log('✅ 扩展 pg_trgm 已启用');
    } catch(e) {
        console.warn('⚠️  pg_trgm 安装失败:', e.message);
    }

    // pgvector —— 需要 >= 0.5.0 才支持 HNSW
    try {
        await target.query('CREATE EXTENSION IF NOT EXISTS vector');
        const vr = await target.query("SELECT extversion FROM pg_extension WHERE extname='vector'");
        console.log(`✅ 扩展 pgvector 已启用，版本: ${vr.rows[0]?.extversion || '未知'}`);
    } catch(e) {
        console.warn('⚠️  pgvector 安装失败 (RAG 向量检索将不可用):', e.message);
        console.warn('   如需向量检索，请手动安装 pgvector: https://github.com/pgvector/pgvector');
    }

    const extList = await target.query("SELECT extname, extversion FROM pg_extension ORDER BY extname");
    console.log('\n已安装扩展:');
    extList.rows.forEach(r => console.log(`   ${r.extname} v${r.extversion}`));

    await target.end();
    console.log('\n🎉 数据库环境初始化完成！');
    console.log(`   DATABASE_URL = postgresql://postgres:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DBNAME}`);
}

main().catch(e => { console.error('❌ 初始化失败:', e.message); process.exit(1); });
