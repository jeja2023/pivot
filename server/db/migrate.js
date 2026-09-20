/** PostgreSQL 主数据库版本化迁移编排。 */
const { logger } = require('../logger');

async function runMigrationsPg() {
    const { getPgPool } = require('./pg-connection');
    const migrations = require('./migrations');
    const { ensurePgMigrationTable, hasPgMigration, recordPgMigration } = require('./migrations/runner');
    const client = await getPgPool().connect();
    try {
        await ensurePgMigrationTable(client);
        const applied = [];
        for (const migration of migrations.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
            if (!migration?.id || await hasPgMigration(client, migration.id)) continue;
            // schema 快照已经覆盖历史建表/补列；只执行 PostgreSQL 专属的
            // 数据回填和约束收敛迁移。不存在 SQLite baseline 或执行路径。
            if (typeof migration.upPg !== 'function') continue;
            await client.query('BEGIN');
            try {
                await migration.upPg(client, { logger });
                await recordPgMigration(client, migration.id, migration.description || '');
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw new Error(`[PG] 迁移 ${migration.id} 执行失败: ${error.message}`);
            }
            applied.push(migration.id);
        }
        if (applied.length) logger.info({ applied }, '[PG] 已应用版本化迁移');
        return applied;
    } finally {
        client.release();
    }
}

module.exports = { runMigrationsPg };
