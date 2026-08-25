/* Bounded staging pressure drill: read-only control-plane queries plus
 * deterministic retry calculations. It never creates Agent Runs or sends mail. */
require('dotenv').config();
const { getPgPool } = require('../server/db/pg-connection');
const { backoff } = require('../server/services/agent-channel-adapters');

async function main() {
    if (process.env.NODE_ENV === 'production' || !process.argv.includes('--confirm-staging')) throw new Error('需要在非 production 环境显式传入 --confirm-staging。');
    const pool = getPgPool();
    const started = Date.now();
    const samples = await Promise.all(Array.from({ length: Math.min(Number(process.env.AGENT_DRILL_CONCURRENCY || 20), 100) }, () => pool.query("SELECT COUNT(*)::int AS goals FROM agent_goals; SELECT COUNT(*)::int AS inbox FROM agent_inbox_events; SELECT COUNT(*)::int AS deliveries FROM agent_channel_deliveries;")));
    const elapsedMs = Date.now() - started;
    console.log(JSON.stringify({ concurrency: samples.length, elapsedMs, maxRetryDelayMs: backoff(100), healthy: samples.every(result => result[0].rows[0].goals >= 0) }, null, 2));
    await pool.end();
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { main };
