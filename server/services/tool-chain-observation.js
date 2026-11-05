'use strict';

function toolResultReasonCodes(data) {
    const output = data.output;
    const codes = [];
    if (Array.isArray(output?.candidates) && data.toolName === 'tools.search') codes.push(output.candidates.length ? 'TOOL_DISCOVERY_MATCHED' : 'TOOL_DISCOVERY_EMPTY');
    if (output?.knowledgeSourceVersion === 1 && /^KNOWLEDGE_[A-Z_]+$/.test(output.retrieval?.reasonCode || '')) codes.push(output.retrieval.reasonCode);
    if (output?.artifactId && output?.renditionId) codes.push('ARTIFACT_REGISTERED');
    return codes;
}

function trackArtifactResponse(response, rendition, user, kind) {
    let recorded = false;
    const record = complete => {
        if (recorded) return;
        recorded = true;
        const succeeded = complete && response.statusCode >= 200 && response.statusCode < 300;
        require('./agent-artifact-delivery').recordDeliveryEvent({ tenantId: rendition.tenant_id, renditionId: rendition.id,
            runId: rendition.run_id, toolCallId: rendition.tool_call_id, actorType: 'user', actorId: String(user.id),
            eventType: `${kind}_${succeeded ? 'responded' : 'failed'}`, contentDigest: rendition.content_digest,
            decisionReason: succeeded ? 'HTTP_RESPONSE_FINISHED' : 'HTTP_RESPONSE_FAILED' }).catch(() => {});
    };
    require('./http-response-lifecycle').onResponseSettled(response, record);
}

module.exports = { toolResultReasonCodes, trackArtifactResponse };
