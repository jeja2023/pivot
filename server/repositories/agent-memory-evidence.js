'use strict';
const { query, queryOne } = require('../db/client');

async function injectedRunMemoryReferences(runId, userId) {
    const run = await queryOne('SELECT metadata FROM agent_runs WHERE id = ? AND user_id = ?', [runId, userId]);
    if (!run) return [];
    const metadata = typeof run.metadata === 'string' ? JSON.parse(run.metadata) : run.metadata || {};
    const references = Array.isArray(metadata.memoryUsage?.references) ? metadata.memoryUsage.references : [];
    if (!references.length) return [];
    const events = await query(`SELECT DISTINCT memory_id FROM memory_usage_events
        WHERE run_id = ? AND user_id = ? AND event_type = 'injected' LIMIT 20`, [runId, userId]);
    const injected = new Set(events.map(event => Number(event.memory_id)));
    return references.filter(reference => injected.has(Number(reference.id))).slice(0, 20);
}

module.exports = { injectedRunMemoryReferences };
