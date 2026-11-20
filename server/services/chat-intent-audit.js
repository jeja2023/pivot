'use strict';

const crypto = require('node:crypto');
const { recordDecision } = require('./decision-observability');
const { getPrimaryTenantId } = require('./enterprise-access');

function createChatIntentAudit({ user, userId = user?.id, sessionId, getTenantId, enqueueObservation = recordDecision }) {
    const id = 'chat_intent_' + crypto.randomUUID();
    let recorded = false;
    let tenantId = null;
    let tenantLookup;
    function resolveTenant() {
        return tenantLookup ??= Promise.resolve().then(() => user?.tenant_id || (getTenantId ? getTenantId() : getPrimaryTenantId(userId)))
            .then(value => { tenantId = value; return value; });
    }
    function record({ selected, suggested = selected, applied, mode, failure, failureStage, durationMs, timing, routingModelId, taskState, candidates, policyVersion }) {
        if (recorded || !userId || !sessionId) return;
        recorded = true;
        enqueueObservation({ decisionId: id, userId, tenantId, sessionId, context: { scenario: 'chat.execution', taskState, candidates },
            selectedActionId: selected.action,
            providerOutputs: [{ providerId: 'chat-intent', providerVersion: String(routingModelId || ''), selectedActionId: suggested.action, durationMs, error: failure,
                scores: { [suggested.action]: suggested.confidence || 0 }, metadata: { failureStage, timing } }],
            policy: { mode, policyVersion, selectedActionId: selected.action, suggestedActionId: suggested.action, applied, reasonCode: selected.reasonCode }
        });
    }
    return { id, resolveTenant, record };
}

module.exports = { createChatIntentAudit };
