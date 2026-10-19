/** PostgreSQL 主数据库版本化迁移编排。 */
const { logger } = require('../logger');

async function runMigrationsPg(options = {}) {
    const { getPgPool } = require('./pg-connection');
    const migrations = options.migrations || require('./migrations');
    const { ensurePgMigrationTable, hasPgMigration, recordPgMigration } = require('./migrations/runner');
    const client = await (options.pool || getPgPool()).connect();
    try {
        await ensurePgMigrationTable(client);
        const applied = [];
        for (const migration of migrations.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
            if (!migration?.id) continue;
            const recorded = await hasPgMigration(client, migration.id);
            if (recorded && (typeof migration.checkPg !== 'function' || await migration.checkPg(client))) continue;
            // schema 快照已经覆盖历史建表/补列；只执行 PostgreSQL 专属的
            // 数据回填和约束收敛迁移。不存在 SQLite baseline 或执行路径。
            if (typeof migration.upPg !== 'function') continue;
            logger.info({ id: migration.id }, '[PG] 开始执行数据库迁移');
            if (recorded) logger.warn({ id: migration.id }, '[PG] 迁移记录与实际结构不一致，重新执行受控幂等修复');
            await client.query('BEGIN; SET LOCAL statement_timeout = 0');
            try {
                await migration.upPg(client, { logger });
                if (typeof migration.checkPg === 'function' && !await migration.checkPg(client)) {
                    throw new Error('迁移后的数据库结构校验未通过，请检查字段、外键和索引。');
                }
                await recordPgMigration(client, migration.id, migration.description || '');
                await client.query('COMMIT');
                logger.info({ id: migration.id }, '[PG] 数据库迁移执行成功');
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
