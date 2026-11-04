'use strict';

const { assertKnowledgeNodeOutput } = require('./agent-dag-knowledge');
const { knowledgeEvidenceManifest } = require('./knowledge-tool-results');
const { mergeKnowledgeEvidence } = require('./knowledge-evidence-lineage');

function unavailable() { return Object.assign(new Error('任务资料来源已变化或不可访问，请重新选择资料并重新检索。'), { code: 'KNOWLEDGE_SOURCE_UNAVAILABLE', status: 403, category: 'policy' }); }

async function prepareAgentKnowledgeBoundary(run, user, deps = {}) {
    if (!deps.inspectRunKnowledgeAccess) return;
    const access = await deps.inspectRunKnowledgeAccess(run.id, user, { knowledge: deps.knowledge || {} });
    if (!access.current) throw unavailable();
    run.knowledgeBoundaryEvidence = access.knowledgeEvidence || null;
}

/** 模型读取历史观察、执行后续工具及发布答案前，均重新确认资料仍可用。 */
async function assertAgentKnowledgeCurrent({ run = {}, user, observations = [] }, deps = {}) {
    const manifests = [run.knowledgeBoundaryEvidence];
    for (const item of observations) {
        if (item.output?.knowledgeContextVersion === 1) continue;
        const evidence = knowledgeEvidenceManifest(item.output);
        if (item.error && !evidence && !item.knowledgeEvidence) continue;
        if (!evidence && !item.knowledgeEvidence && !(item.output && ['rag.search', 'knowledge.graph.query'].includes(item.tool))) continue;
        if (!evidence && !item.knowledgeEvidence) throw unavailable();
        manifests.push(item.knowledgeEvidence, evidence);
    }
    const merged = mergeKnowledgeEvidence(manifests);
    if (merged) {
        try { await assertKnowledgeNodeOutput({ tool: 'agent.history', knowledgeEvidence: merged }, user, run, deps); }
        catch (_) { throw unavailable(); }
        // 恢复上下文和压缩观察不能让较早的来源退出后续边界检查。
        run.knowledgeBoundaryEvidence = merged;
    }
    const metadata = require('./agent-validators').parseJsonObject(run.metadata) || {};
    if (metadata.chatBridge?.ragContext || observations.some(item => item.output?.knowledgeContextVersion === 1)) {
        const access = await (deps.inspectRunKnowledgeAccess || require('./knowledge-run-access').inspectRunKnowledgeAccess)(run.id, user, { knowledge: deps.knowledge || {} });
        if (!access.current) throw Object.assign(new Error('资料来源已变化或不可访问，请重新选择资料后继续。'), { code: 'KNOWLEDGE_SOURCE_UNAVAILABLE', status: 403, category: 'policy' });
    }
}

module.exports = { assertAgentKnowledgeCurrent, prepareAgentKnowledgeBoundary };
