const LEGACY_MIGRATION_ID_MAP = {
    '027-workflow-templates': '202610140002_agent_workflow_templates',
    '028-streaming-events': '202610140003_agent_streaming_events',
    '029-agent-evaluation': '202610140004_agent_evaluation',
    '030-tool-usage-stats': '202610140005_agent_tool_usage_stats',
    '031-enhanced-planning': '202610140006_agent_enhanced_planning',
    '032-artifacts': '202610140007_agent_artifacts',
    '033-orchestration-dsl': '202610140008_agent_orchestration_dsl'
};

/** PostgreSQL 版本化迁移记录器。 */
async function ensurePgMigrationTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT,
            applied_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
        )
    `);

    // 平滑升级历史开发阶段临时迁移 ID 到规范版本化格式
    for (const [legacyId, unifiedId] of Object.entries(LEGACY_MIGRATION_ID_MAP)) {
        await client.query(`
            UPDATE schema_migrations
            SET id = $1
            WHERE id = $2
              AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = $1)
        `, [unifiedId, legacyId]);
    }
}

async function hasPgMigration(client, id) {
    const legacyIds = Object.entries(LEGACY_MIGRATION_ID_MAP)
        .filter(([, unifiedId]) => unifiedId === id)
        .map(([oldId]) => oldId);
    const queryIds = [id, ...legacyIds];
    const result = await client.query('SELECT id FROM schema_migrations WHERE id = ANY($1)', [queryIds]);
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

module.exports = { ensurePgMigrationTable, hasPgMigration, recordPgMigration, LEGACY_MIGRATION_ID_MAP };
