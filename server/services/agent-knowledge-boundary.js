'use strict';

const { assertKnowledgeNodeOutput } = require('./agent-dag-knowledge');
const { knowledgeEvidenceManifest } = require('./knowledge-tool-results');
const { mergeKnowledgeEvidence } = require('./knowledge-evidence-lineage');
const { knowledgeScopeRevision, isPriorKnowledgeObservation, projectKnowledgeObservation } = require('./chat-knowledge-revision');

function unavailable() { return Object.assign(new Error('任务资料来源已变化或不可访问，请重新选择资料并重新检索。'), { code: 'KNOWLEDGE_SOURCE_UNAVAILABLE', status: 403, category: 'policy' }); }

async function prepareAgentKnowledgeBoundary(run, user, deps = {}) {
    if (!deps.inspectRunKnowledgeAccess) return;
    const access = await deps.inspectRunKnowledgeAccess(run.id, user, { knowledge: deps.knowledge || {} });
    if (!access.current) throw unavailable();
    run.knowledgeBoundaryEvidence = access.knowledgeEvidence || null;
}

/** 模型读取历史观察、执行后续工具及发布答案前，均重新确认资料仍可用。 */
async function assertAgentKnowledgeCurrent({ run = {}, user, observations = [] }, deps = {}) {
    await require('./agent-skill-resources').assertSkillResourceEvidence(run,user);
    const oldRevision = knowledgeScopeRevision(run);
    let metadata = require('./agent-validators').parseJsonObject(run.metadata) || {};
    if (run.id && user?.id && metadata.chatBridge && metadata.capabilityConstraints) {
        const fresh = await (deps.currentExecutionScope || require('../repositories/chat-conversation-turns').currentExecutionScope)(run.id, user.id);
        if (!fresh || fresh.source_active === false) throw unavailable();
        metadata = require('./agent-validators').parseJsonObject(fresh.metadata) || {};
        run.metadata = metadata;
    }
    const manifests = [run.knowledgeBoundaryEvidence];
    for (const item of observations) {
        if (item.knowledgeScopeSuperseded === true) continue;
        if (item.output?.knowledgeContextVersion === 1) continue;
        const evidence = knowledgeEvidenceManifest(item.output);
        if (item.error && !evidence && !item.knowledgeEvidence) continue;
        if (!evidence && !item.knowledgeEvidence && !(item.output && ['rag.search', 'knowledge.graph.query'].includes(item.tool))) continue;
        if (!evidence && !item.knowledgeEvidence) throw unavailable();
        manifests.push(item.knowledgeEvidence, evidence);
    }
    const merged = mergeKnowledgeEvidence(manifests);
    if (merged) {
        try {
            if (knowledgeScopeRevision(run)) {
                if (!await require('./knowledge-tool-results').revalidateKnowledgeToolEvidence([{ knowledgeEvidence: merged }], user, deps.knowledge || {})) throw unavailable();
                const currentSources = merged.sources.filter(source => !isPriorKnowledgeObservation({ knowledgeEvidence: { knowledgeSourceVersion: 1, sources: [source] } }, run));
                if (currentSources.length) await assertKnowledgeNodeOutput({ tool: 'agent.history', knowledgeEvidence: { ...merged, sources: currentSources } }, user, run, deps);
            } else await assertKnowledgeNodeOutput({ tool: 'agent.history', knowledgeEvidence: merged }, user, run, deps);
        }
        catch (_) { throw unavailable(); }
        // 恢复上下文和压缩观察不能让较早的来源退出后续边界检查。
        run.knowledgeBoundaryEvidence = merged;
    }
    if (metadata.parentHistory?.sourceRunId || metadata.goalContinuation || metadata.resumeContext?.sourceRunId || metadata.chatBridge?.ragContext || observations.some(item => item.output?.knowledgeContextVersion === 1)) {
        const access = await (deps.inspectRunKnowledgeAccess || require('./knowledge-run-access').inspectRunKnowledgeAccess)(run.id, user, { knowledge: deps.knowledge || {} });
        if (!access.current) throw Object.assign(new Error('资料来源已变化或不可访问，请重新选择资料后继续。'), { code: 'KNOWLEDGE_SOURCE_UNAVAILABLE', status: 403, category: 'policy' });
    }
    for (let index = 0; index < observations.length; index++) observations[index] = projectKnowledgeObservation(observations[index], run);
    return oldRevision !== knowledgeScopeRevision(run);
}

module.exports = { assertAgentKnowledgeCurrent, prepareAgentKnowledgeBoundary };
