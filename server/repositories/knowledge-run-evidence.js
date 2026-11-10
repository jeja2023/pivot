'use strict';

const { query, queryOne } = require('../db/client');

async function readRunKnowledgeEvidence(runId, userId) {
    const run = await queryOne('SELECT id,user_id,metadata,context_config,deleted_at FROM agent_runs WHERE id = ? AND user_id = ?', [runId, userId]);
    if (!run || run.deleted_at) return null;
    const actor = await queryOne('SELECT id,role,unit,status,deleted_at FROM users WHERE id = ?', [userId]);
    const rows = await query(`SELECT tool_name,output,status,NULL::text AS artifact_id FROM agent_steps WHERE run_id = ?
            AND (tool_name IN ('rag.search','knowledge.graph.query') OR output LIKE '%knowledgeSourceVersion%' OR output LIKE '%knowledgeEvidence%')
        UNION ALL SELECT tool_name,output,status,NULL::text AS artifact_id FROM agent_dag_nodes WHERE run_id = ?
            AND (tool_name IN ('rag.search','knowledge.graph.query') OR output LIKE '%knowledgeSourceVersion%' OR output LIKE '%knowledgeEvidence%')
        UNION ALL SELECT 'checkpoint:' || tool_name AS tool_name,state AS output,status,NULL::text AS artifact_id FROM agent_run_checkpoints
            WHERE run_id=? AND checkpoint_type IN ('tool','dag')
                AND (tool_name IN ('rag.search','knowledge.graph.query') OR state LIKE '%knowledgeSourceVersion%' OR state LIKE '%knowledgeEvidence%' OR state LIKE '%outputRef%')
        UNION ALL SELECT 'presentation.analysis' AS tool_name,content AS output,'completed' AS status,id::text AS artifact_id FROM agent_artifacts
            WHERE run_id=? AND type LIKE 'presentation%' AND status<>'deleted' AND content LIKE '%analysisBinding%'
        UNION ALL SELECT 'policy.review_report' AS tool_name,content AS output,'completed' AS status,id::text AS artifact_id FROM agent_artifacts
            WHERE run_id=? AND type='policy_review_report' AND status<>'deleted' LIMIT 2001`, [runId, runId, runId, runId, runId]);
    return { run, actor, rows, incomplete: rows.length > 2000 };
}

module.exports = { readRunKnowledgeEvidence };
