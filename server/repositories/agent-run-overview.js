'use strict';

const { query } = require('../db/client');
const { parseJsonObject } = require('../services/agent-validators');
const { unpackKnowledgeOutput } = require('../services/knowledge-evidence-lineage');

function presentOverviewRow(row) {
    const restored = unpackKnowledgeOutput(row.output);
    return { ...row, input: parseJsonObject(row.input) || {}, output: row.output_deferred ? { deferred: true, message: '该步骤输出较长，请加载完整记录查看。' } : restored.value, knowledge_evidence: restored.knowledgeEvidence,
        depends_on: parseJsonObject(row.depends_on) || [], error_info: parseJsonObject(row.error_info) || {}, contract_issues: [] };
}

async function readRunOverviewRows(runId) {
    const [steps, nodes] = await Promise.all([
        query(`SELECT * FROM (SELECT id,step_index,type,title,tool_name,status,duration_ms,created_at,error_message,
            CASE WHEN LENGTH(input) <= 8000 THEN input ELSE '{}' END AS input,
            LENGTH(output) > 16000 AS output_deferred,CASE WHEN LENGTH(output) <= 16000 THEN output ELSE NULL END AS output
            FROM agent_steps WHERE run_id = ? ORDER BY id DESC LIMIT 101) recent ORDER BY step_index,id`, [runId]),
        query(`SELECT id,node_key,title,tool_name,status,duration_ms,depends_on,"condition",attempt_count,created_at,
            error_message,error_info,CASE WHEN LENGTH(input) <= 8000 THEN input ELSE '{}' END AS input,
            LENGTH(output) > 16000 AS output_deferred,CASE WHEN LENGTH(output) <= 16000 THEN output ELSE NULL END AS output
            FROM agent_dag_nodes WHERE run_id = ? ORDER BY id LIMIT 101`, [runId])
    ]);
    return { steps: steps.slice(-100).map(presentOverviewRow), dagNodes: nodes.slice(0, 100).map(presentOverviewRow), truncated: steps.length > 100 || nodes.length > 100 };
}

module.exports = { readRunOverviewRows };
