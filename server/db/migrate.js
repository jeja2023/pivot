/**
 * server/db/migrate.js
 * 数据库迁移编排入口（PostgreSQL）
 *
 * SQLite 同步迁移函数仅服务于历史快照测试/一次性旧库升级，不再属于应用运行模式。
 */
const { logger } = require('../logger');

function requireLegacySqliteDb() {
    const { db } = require('./connection');
    if (!db || typeof db.prepare !== 'function') {
        throw new Error('[DB] 当前版本已切换为 PostgreSQL-only；SQLite 迁移入口仅允许历史旧库升级工具显式注入 SQLite 连接后调用。');
    }
    return db;
}

// ── Legacy SQLite upgrade helpers ─────────────────────────────────────────

function recordMigration(key, value = 'done') {
    requireLegacySqliteDb();
    const legacyMigrations = require('./migrations/legacy');
    return legacyMigrations.recordMigration(key, value);
}

function ensureMigrationTable() {
    const db = requireLegacySqliteDb();
    const { ensureSchemaMigrationTable } = require('./migrations/runner');
    ensureSchemaMigrationTable(db);
}

function recordSchemaMigration(id, description = '') {
    const db = requireLegacySqliteDb();
    const { recordMigration: recordVersionedMigration } = require('./migrations/runner');
    ensureMigrationTable();
    recordVersionedMigration(db, id, description);
    recordMigration(id);
}

function runSchemaMigration(id, description, fn) {
    const db = requireLegacySqliteDb();
    const { hasMigration, recordMigration: recordVersionedMigration } = require('./migrations/runner');
    ensureMigrationTable();
    if (hasMigration(db, id)) return false;
    const migrate = db.transaction(() => {
        fn(db);
        recordVersionedMigration(db, id, description || '');
        recordMigration(id);
    });
    migrate();
    logger.info({ id }, '版本化数据库迁移已应用');
    return true;
}

function runMigrations() {
    const db = requireLegacySqliteDb();
    const legacyMigrations = require('./migrations/legacy');
    const versionedMigrations = require('./migrations');
    const { runVersionedMigrations } = require('./migrations/runner');
    ensureMigrationTable();
    legacyMigrations.runMigrations();
    const applied = runVersionedMigrations(db, versionedMigrations, { logger });
    applied.forEach(id => recordMigration(id));
    return applied;
}

// ── PostgreSQL 异步模式 ─────────────────────────────────────────────────────

/**
 * PG 侧迁移策略：历史基线 + 新迁移严格执行
 *
 * 历史版本化迁移（migrations/index.js、migrations/legacy.js、regulations.js）
 * 全部是 SQLite 方言实现（PRAGMA table_info、db.prepare 同步 API），传入 pg
 * client 会直接抛错；而它们的最终效果——所有补列与新表——已经完整体现在
 * schema/base.js 的建表 DDL 里，由 initSchemaPg() 一次性建出。
 *
 * 因此 PG 库的正确做法是把这些历史迁移标记为「已应用」而不执行（baseline），
 * 后续新增迁移若需在 PG 生效，必须提供 `upPg(client, options)` 方法；仅有
 * `up` 的迁移只有登记在 pg-baseline.js 的历史项才允许标记，否则启动失败。
 */
async function runMigrationsPg() {
    const { getPgPool } = require('./pg-connection');
    const versionedMigrations = require('./migrations');
    const {
        ensurePgMigrationTable,
        hasPgMigration,
        recordPgMigration,
    } = require('./migrations/runner');
    const { PG_SCHEMA_BASELINE } = require('./migrations/pg-baseline');

    const client = await getPgPool().connect();
    try {
        await ensurePgMigrationTable(client);

        const sorted = versionedMigrations
            .slice()
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));

        const applied = [];
        const baselined = [];

        for (const migration of sorted) {
            if (!migration || !migration.id) continue;
            if (await hasPgMigration(client, migration.id)) continue;

            if (typeof migration.upPg === 'function') {
                await client.query('BEGIN');
                try {
                    await migration.upPg(client, { logger });
                    await recordPgMigration(client, migration.id, migration.description || '');
                    await client.query('COMMIT');
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw new Error(`[PG] 迁移 ${migration.id} 执行失败: ${err.message}`);
                }
                applied.push(migration.id);
                continue;
            }

            if (!PG_SCHEMA_BASELINE.has(migration.id)) {
                throw new Error(`[PG] 迁移 ${migration.id} 缺少 upPg(client)，且未登记为已验证的 schema 基线。`);
            }
            // 已验证由 initSchemaPg 的建表 DDL 覆盖的历史 SQLite 迁移，才允许标记基线。
            await recordPgMigration(
                client,
                migration.id,
                `${migration.description || ''} [baseline: schema 已内置]`.trim()
            );
            baselined.push(migration.id);
        }

        if (applied.length > 0) logger.info({ applied }, '[PG] 已应用版本化迁移');
        if (baselined.length > 0) {
            logger.info({ count: baselined.length }, '[PG] 历史迁移已基线标记（schema 已内置，无需执行）');
        }
        return applied;
    } finally {
        client.release();
    }
}

module.exports = {
    runMigrations,
    runMigrationsPg,
    recordMigration,
    recordSchemaMigration,
    runSchemaMigration,
};
