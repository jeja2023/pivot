'use strict';

const { query, queryOne } = require('../db/client');

async function readRunKnowledgeEvidence(runId, userId) {
    const run = await queryOne('SELECT id,user_id,metadata,context_config,deleted_at FROM agent_runs WHERE id = ? AND user_id = ?', [runId, userId]);
    if (!run || run.deleted_at) return null;
    const actor = await queryOne('SELECT id,role,unit,status,deleted_at FROM users WHERE id = ?', [userId]);
    const rows = await query(`SELECT tool_name,output,status FROM agent_steps WHERE run_id = ?
            AND (tool_name IN ('rag.search','knowledge.graph.query') OR output LIKE '%knowledgeSourceVersion%' OR output LIKE '%knowledgeEvidence%')
        UNION ALL SELECT tool_name,output,status FROM agent_dag_nodes WHERE run_id = ?
            AND (tool_name IN ('rag.search','knowledge.graph.query') OR output LIKE '%knowledgeSourceVersion%' OR output LIKE '%knowledgeEvidence%') LIMIT 2001`, [runId, runId]);
    return { run, actor, rows, incomplete: rows.length > 2000 };
}

module.exports = { readRunKnowledgeEvidence };
