'use strict';

const { query } = require('../db/client');

async function readToolChainMetrics(user, cutoff) {
    return query(`SELECT e.source,e.tool_name,e.definition_digest,COALESCE(r.chosen_model_id,r.model_id) AS model_id,
        COUNT(*) AS total,COUNT(*) FILTER (WHERE e.status = 'success') AS succeeded,
        COUNT(*) FILTER (WHERE e.status IN ('error','failed')) AS failed,
        COUNT(*) FILTER (WHERE e.policy_decision = 'denied') AS denied,
        COUNT(*) FILTER (WHERE e.status = 'pending_approval') AS waiting_approval,
        COUNT(*) FILTER (WHERE e.error_class = 'timeout') AS timeouts,
        COUNT(*) FILTER (WHERE e.error_code = 'MCP_TOOL_EXECUTION_ERROR') AS business_failures,
        COUNT(*) FILTER (WHERE e.cancelled) AS cancelled,
        COUNT(*) FILTER (WHERE e.policy_reason_codes @> '["TOOL_DISCOVERY_MATCHED"]'::jsonb) AS discovery_matched,
        COUNT(*) FILTER (WHERE e.policy_reason_codes @> '["TOOL_DISCOVERY_EMPTY"]'::jsonb) AS discovery_empty,
        COUNT(*) FILTER (WHERE e.policy_reason_codes @> '["KNOWLEDGE_MATCHED"]'::jsonb) AS knowledge_matched,
        COUNT(*) FILTER (WHERE e.policy_reason_codes @> '["KNOWLEDGE_NO_RELIABLE_MATCH"]'::jsonb) AS knowledge_empty,
        COUNT(*) FILTER (WHERE e.policy_reason_codes @> '["ARTIFACT_REGISTERED"]'::jsonb) AS artifact_registered,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e.total_ms) AS p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY e.total_ms) AS p95_ms,
        SUM(e.input_tokens + e.output_tokens) AS tokens,SUM(e.estimated_cost) AS estimated_cost
        FROM tool_invocation_events e LEFT JOIN agent_runs r ON r.id = e.run_id
        WHERE e.actor_id = ? AND e.created_at >= ?
        GROUP BY e.source,e.tool_name,e.definition_digest,COALESCE(r.chosen_model_id,r.model_id)
        ORDER BY COUNT(*) DESC LIMIT 500`, [user.id, cutoff]);
}

async function readDeliveryChainMetrics(user, cutoff) {
    return query(`SELECT event_type,COUNT(*) AS samples FROM agent_artifact_delivery_events
        WHERE actor_id = ? AND created_at >= ? GROUP BY event_type ORDER BY event_type`, [String(user.id), cutoff]);
}

module.exports = { readToolChainMetrics, readDeliveryChainMetrics };
