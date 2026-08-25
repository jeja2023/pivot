/* PostgreSQL staging drill. It never mutates production data; pass an explicit
 * staging DATABASE_URL and --confirm-staging to run the checks. */
const { getPgPool } = require('../server/db/pg-connection');

async function main() {
    if (process.env.NODE_ENV === 'production' || process.argv.includes('--confirm-staging') !== true) throw new Error('需要在非 production 环境显式传入 --confirm-staging。');
    const pool = getPgPool();
    const checks = [];
    const requiredTables = ['agent_goals', 'agent_skill_versions', 'agent_skill_validations', 'agent_skill_releases', 'agent_workflow_releases', 'agent_channel_deliveries', 'agent_inbox_events'];
    for (const table of requiredTables) {
        const result = await pool.query('SELECT to_regclass($1) AS table_name', [`public.${table}`]);
        checks.push({ table, present: Boolean(result.rows[0]?.table_name) });
    }
    const replay = await pool.query('SELECT COUNT(*)::int AS count FROM agent_channel_deliveries WHERE status = \'dead_letter\'');
    const outbox = await pool.query("SELECT COUNT(*)::int AS count FROM agent_event_outbox WHERE status IN ('pending', 'claimed')");
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), checks, deadLetters: replay.rows[0].count, pendingOutbox: outbox.rows[0].count }, null, 2));
    await pool.end();
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { main };
