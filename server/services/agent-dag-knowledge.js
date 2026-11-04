'use strict';

const { parseJsonObject } = require('./agent-validators');
const { resolveKnowledgeToolScope, knowledgeEvidenceManifest, revalidateKnowledgeToolEvidence } = require('./knowledge-tool-results');
const { unpackKnowledgeOutput, mergeKnowledgeEvidence } = require('./knowledge-evidence-lineage');

function knowledgeOutput(value) { return typeof value === 'string' ? parseJsonObject(value) : value; }
function isKnowledgeNode(tool, output) { return ['rag.search', 'knowledge.graph.query'].includes(tool) || output?.knowledgeSourceVersion === 1 || Boolean(output?.knowledgeEvidence); }
function sourceUnavailable() {
    return Object.assign(new Error('工作流资料来源已变化或不可访问，请重新选择资料并重新运行检索节点。'), { code: 'KNOWLEDGE_SOURCE_UNAVAILABLE', status: 403, category: 'policy' });
}

function collectDagKnowledgeObservations(nodes, states) {
    return nodes.flatMap(node => {
        const state = states.get(node.id);
        if (!['completed', 'continued_error'].includes(state?.status)) return [];
        const unpacked = unpackKnowledgeOutput(state.output), output = knowledgeOutput(unpacked.value);
        const evidence = mergeKnowledgeEvidence(state.knowledgeEvidence, state.knowledge_evidence, unpacked.knowledgeEvidence, output);
        if (!isKnowledgeNode(node.tool, output) && !evidence) return [];
        return [{ node: node.id, tool: node.tool, input: state.input || {}, output, knowledgeEvidence: evidence }];
    });
}

async function assertKnowledgeNodeOutput(observation, user, run, deps = {}) {
    const output = knowledgeOutput(observation.output);
    if (!isKnowledgeNode(observation.tool, output) && !observation.knowledgeEvidence) return;
    if (!knowledgeEvidenceManifest(output) && !output?.knowledgeEvidence && !observation.knowledgeEvidence) throw sourceUnavailable();
    try {
        const scope = await resolveKnowledgeToolScope(user, observation.input || {}, { run }, deps.knowledge || {});
        if (!await revalidateKnowledgeToolEvidence([{ ...observation, output }], user, { ...deps.knowledge, scope })) throw sourceUnavailable();
    } catch (_) { throw sourceUnavailable(); }
}

async function assertDagKnowledgeCurrent(nodes, states, user, run, deps = {}) {
    for (const observation of collectDagKnowledgeObservations(nodes, states)) await assertKnowledgeNodeOutput(observation, user, run, deps);
}

module.exports = { collectDagKnowledgeObservations, assertKnowledgeNodeOutput, assertDagKnowledgeCurrent };
