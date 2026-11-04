'use strict';

const { parseJsonObject } = require('./agent-validators');
const { unpackKnowledgeOutput, mergeKnowledgeEvidence } = require('./knowledge-evidence-lineage');
const { revalidateKnowledgeToolEvidence } = require('./knowledge-tool-results');

const BLOCKED_MESSAGE = '资料来源已变化或不可访问，请重新选择资料并重新运行。';
function blockedAccess() { return { current: false, reasonCode: 'KNOWLEDGE_SOURCE_UNAVAILABLE', message: BLOCKED_MESSAGE }; }

async function readRunKnowledgeAccess(runId, user, deps = {}) {
    if (!runId) return { current: true, tracked: false };
    try {
        const evidence = await (deps.read || require('../repositories/knowledge-run-evidence').readRunKnowledgeEvidence)(runId, user?.id);
        if (!evidence) return { current: false, notFound: true, reasonCode: 'RUN_NOT_FOUND', message: '智能体任务不存在或无权访问。' };
        if (!evidence.actor || evidence.actor.status === 'disabled' || evidence.actor.deleted_at || evidence.incomplete) return blockedAccess();
        const metadata = parseJsonObject(evidence.run.metadata) || {};
        const observations = [];
        for (const row of evidence.rows) {
            const parsed = unpackKnowledgeOutput(row.output);
            const manifest = mergeKnowledgeEvidence(parsed.knowledgeEvidence, parsed.value);
            if (manifest) observations.push({ output: parsed.value, knowledgeEvidence: manifest });
            else if (['rag.search', 'knowledge.graph.query'].includes(row.tool_name)
                && ['completed', 'continued_error', 'success'].includes(row.status)) return blockedAccess();
        }
        const snapshot = require('./chat-rag-context').buildChatRagEvidenceObservation(metadata.chatBridge || {});
        if (!snapshot && metadata.chatBridge?.ragEnabled && metadata.chatBridge.ragContext) return blockedAccess();
        if (snapshot) {
            const sources = require('./knowledge-grounding').extractKnowledgeSources(snapshot.output.content);
            for (const source of sources) {
                if (!source.citationKey) return blockedAccess();
                const citation = await (deps.getCitation || require('./knowledge-content').getCitationForUser)(source.citationKey, evidence.actor);
                if (!citation || citation.document?.isCurrentVersion === false || !source.excerpts.every(excerpt => require('./rag-index/retrieval-context').normalizeInjectedKnowledgeText(citation.quotedText).includes(excerpt))) return blockedAccess();
            }
        }
        const scope = observations.length ? await require('./knowledge-tool-results').resolveKnowledgeToolScope(evidence.actor, {}, { run: evidence.run }, deps.knowledge || {}) : {};
        if (!await (deps.revalidate || revalidateKnowledgeToolEvidence)(observations, evidence.actor, { ...deps.knowledge, scope })) return blockedAccess();
        return { current: true, tracked: observations.length > 0 || Boolean(snapshot), knowledgeEvidence: mergeKnowledgeEvidence(observations.map(item => item.knowledgeEvidence)) };
    } catch (_) { return blockedAccess(); }
}

function inspectRunKnowledgeAccess(runId, user, deps = {}) {
    const context = require('./request-context').getRequestContext();
    if (!context.requestId || Object.keys(deps).length) return readRunKnowledgeAccess(runId, user, deps);
    const checks = context.knowledgeAccessChecks ||= new Map();
    const key = `${user?.id}:${runId}`;
    if (!checks.has(key)) checks.set(key, Promise.resolve().then(async () => await readRunKnowledgeAccess(runId, user, deps)));
    return checks.get(key);
}

async function assertRunKnowledgeAccess(runId, user, deps = {}) {
    const access = await inspectRunKnowledgeAccess(runId, user, deps);
    if (!access.current) throw Object.assign(new Error(access.message || BLOCKED_MESSAGE), { code: access.reasonCode, status: access.notFound ? 404 : 403, category: 'policy' });
    return access;
}

function blockedRunDetail(run, access) {
    return { run: { id: run.id, status: run.status, run_mode: run.run_mode, title: '资料来源不可用的任务', goal: '', final_answer: access.message,
        error_message: access.message, metadata: '{}', created_at: run.created_at, updated_at: run.updated_at },
    steps: [], dagNodes: [], invocations: [], iterationItems: [], trace: null, checkpoints: null, verification: null,
    evidence: [], transactions: [], workingMemoryRevisions: [], promptInvocations: [], browserActionEvidence: [], browserSessions: [],
    knowledgeAccess: access, progress: { percent: 0 } };
}

function guardKnowledgeRunRead(req, res, next) {
    if (req.method !== 'GET' || req.path === '/' || !req.params.id || ['deleted', 'chat-active'].includes(req.params.id)) return next();
    inspectRunKnowledgeAccess(req.params.id, req.user).then(access => {
        if (access.notFound || access.current) return next();
        return res.status(403).json({ error: access.message, code: access.reasonCode });
    }).catch(next);
}

module.exports = { assertRunKnowledgeAccess, blockedRunDetail, guardKnowledgeRunRead, inspectRunKnowledgeAccess };
