'use strict';

const { clampText } = require('./agent-tool-runtime');
const { unpackKnowledgeOutput } = require('./knowledge-evidence-lineage');

function restoreDagStates(nodes, persistedNodes, reusedNodes = {}) {
    const states = new Map(nodes.map(node => {
        const existing = persistedNodes.get(node.id);
        if (existing && ['completed', 'continued_error', 'skipped'].includes(existing.status)) {
            const restored = unpackKnowledgeOutput(existing.output);
            return [node.id, { status: existing.status, input: existing.input || {}, output: restored.value, knowledgeEvidence: existing.knowledge_evidence || restored.knowledgeEvidence,
                compactOutput: clampText(existing.output, 12000), attemptCount: existing.attempt_count || 0, reused: false }];
        }
        return [node.id, { status: 'pending' }];
    }));
    Object.entries(reusedNodes).forEach(([nodeId, state]) => {
        const restored = unpackKnowledgeOutput(state?.output);
        states.set(nodeId, { status: state?.status || 'completed', input: state?.input || {}, output: restored.value, knowledgeEvidence: state?.knowledge_evidence || state?.knowledgeEvidence || restored.knowledgeEvidence,
            compactOutput: clampText(state?.output, 12000), error: state?.error || '', skipReason: state?.skipReason || '',
            reused: Boolean(state?.reusedFromRunId), reusedFromRunId: state?.reusedFromRunId || null });
    });
    return states;
}

module.exports = { restoreDagStates };
