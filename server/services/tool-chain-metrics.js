'use strict';

const { getBeijingTimestamp } = require('../time');

async function getToolChainMetrics(user, options = {}, deps = {}) {
    const days = Math.max(1, Math.min(Number.parseInt(options.days, 10) || 30, 365));
    const cutoff = getBeijingTimestamp(new Date(Date.now() - days * 86400000));
    const [rows, delivery] = await Promise.all([
        (deps.read || require('../repositories/tool-chain-metrics').readToolChainMetrics)(user, cutoff),
        (deps.readDeliveries || require('../repositories/tool-chain-metrics').readDeliveryChainMetrics)(user, cutoff)
    ]);
    const groups = rows.map(row => {
        const total = Number(row.total), succeeded = Number(row.succeeded);
        return { entrypoint: row.source, tool: row.tool_name, definitionDigest: row.definition_digest, modelId: row.model_id,
            sampleCount: total, succeeded, failed: Number(row.failed), denied: Number(row.denied), waitingApproval: Number(row.waiting_approval),
            timeouts: Number(row.timeouts), businessFailures: Number(row.business_failures), cancelled: Number(row.cancelled),
            invocationSuccessRate: total ? succeeded / total : null, denominator: total, p50Ms: Number(row.p50_ms), p95Ms: Number(row.p95_ms),
            tokens: Number(row.tokens), estimatedCost: Number(row.estimated_cost) };
    });
    groups.forEach((group, index) => Object.assign(group, { discoveryMatched: Number(rows[index].discovery_matched || 0), discoveryEmpty: Number(rows[index].discovery_empty || 0),
        knowledgeMatched: Number(rows[index].knowledge_matched || 0), knowledgeEmpty: Number(rows[index].knowledge_empty || 0), artifactRegistered: Number(rows[index].artifact_registered || 0) }));
    return { days, scope: 'current_user', groups, deliveryStages: delivery.map(row => ({ stage: row.event_type, samples: Number(row.samples) })), groupLimit: 500, possiblyTruncated: rows.length === 500,
        note: '分母为已记录调用；调用成功与知识依据、交付验收和下载成功分别统计。未设生产告警阈值。' };
}

module.exports = { getToolChainMetrics };
