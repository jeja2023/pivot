/** PostgreSQL 版本化迁移记录器。 */
async function ensurePgMigrationTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT,
            applied_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
        )
    `);
}

async function hasPgMigration(client, id) {
    const result = await client.query('SELECT id FROM schema_migrations WHERE id = $1', [id]);
    return result.rows.length > 0;
}

async function recordPgMigration(client, id, description = '') {
    await client.query(
        `INSERT INTO schema_migrations (id, description, applied_at)
         VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Shanghai'))
         ON CONFLICT (id) DO NOTHING`,
        [id, description]
    );
}

module.exports = { ensurePgMigrationTable, hasPgMigration, recordPgMigration };
