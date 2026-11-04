'use strict';

const { parseJsonObject } = require('./agent-validators');
const { mergeKnowledgeEvidence } = require('./knowledge-evidence-lineage');
const { revalidateKnowledgeToolEvidence, presentKnowledgeResult } = require('./knowledge-tool-results');

async function captureChatKnowledgeEvidence(sources, user, deps = {}) {
    const citations = [];
    for (const source of sources) {
        const citation = await (deps.getCitation || require('./knowledge-content').getCitationForUser)(source.citationKey, user);
        if (!citation?.chunkId || citation.document?.isCurrentVersion === false) throw new Error('知识来源已不可用。');
        citations.push(citation);
    }
    const rows = await (deps.read || require('../repositories/knowledge').readSourceChunks)(citations.map(item => item.chunkId), user);
    if (!sources.every((source, index) => source.excerpts?.length && source.excerpts.every(excerpt =>
        rows.some(row => Number(row.chunk_id) === Number(citations[index].chunkId) && require('./rag-index/retrieval-context').normalizeInjectedKnowledgeText(row.content).includes(String(excerpt)))))) throw new Error('知识来源与本轮检索片段不一致。');
    const result = presentKnowledgeResult('', { evidence: citations.map(item => ({ chunkId: item.chunkId })) }, rows);
    if (result.sources.length !== citations.length || !await revalidateKnowledgeToolEvidence([{ output: result }], user, deps.knowledge || {})) throw new Error('知识来源已变化。');
    return { knowledgeSourceVersion: 1, sources: result.sources };
}

async function presentKnowledgeMessages(rows, user, deps = {}) {
    const runs = new Map();
    let sourceBlocked = false;
    const presented = [];
    for (const message of rows) {
        const metadata = parseJsonObject(message.route_metadata) || {};
        const manifest = metadata.knowledgeEvidence || metadata.rag?.knowledgeEvidence;
        let current = true, evidence = manifest;
        if (message.agent_run_id) {
            if (!runs.has(message.agent_run_id)) runs.set(message.agent_run_id, await (deps.inspectRun || require('./knowledge-run-access').inspectRunKnowledgeAccess)(message.agent_run_id, user));
            const access = runs.get(message.agent_run_id); current = access.current; evidence = access.knowledgeEvidence;
        } else if (manifest) {
            try { current = await (deps.revalidate || revalidateKnowledgeToolEvidence)([{ knowledgeEvidence: manifest }], user); } catch (_) { current = false; }
        } else if (metadata.rag?.grounding?.accepted && metadata.rag.grounding.sourceCount > 0) current = false;
        if (!current && (message.role === 'assistant' || Number(message.is_summary))) {
            sourceBlocked = true;
            presented.push({ ...message, content: '资料来源已变化或无法确认，请重新检索。', route_metadata: '{}', knowledge_evidence: null, knowledge_access: { current: false } });
        } else presented.push({ ...message, ...(evidence ? { knowledge_evidence: evidence } : {}) });
    }
    return sourceBlocked ? presented.map(message => Number(message.is_summary) ? { ...message, content: '此前资料来源已变化，请依据本轮有效资料继续。', route_metadata: '{}', knowledge_evidence: null } : message) : presented;
}

function collectMessageKnowledgeEvidence(messages) {
    return mergeKnowledgeEvidence(messages.map(message => {
        const metadata = parseJsonObject(message.route_metadata) || {};
        return message.knowledge_evidence || metadata.knowledgeEvidence || metadata.rag?.knowledgeEvidence;
    }));
}

async function inspectSessionKnowledgeAccess(sessionId, user, deps = {}) {
    const rows = await (deps.read || require('../repositories/sessions').listMessageKnowledgeMetadata)(sessionId, user.id);
    const messages = await presentKnowledgeMessages(rows, user, deps);
    return { current: !messages.some(message => message.knowledge_access?.current === false) };
}

async function presentKnowledgeSessions(sessions, user, { hideUnavailable = false } = {}) {
    const output = [];
    for (const session of sessions) {
        const access = await inspectSessionKnowledgeAccess(session.id, user);
        if (access.current) output.push(session);
        else if (!hideUnavailable) output.push({ ...session, title: '资料来源不可用的会话', tags: '', snippet: '', system_prompt: '', knowledge_access: access });
    }
    return output;
}

module.exports = { captureChatKnowledgeEvidence, collectMessageKnowledgeEvidence, inspectSessionKnowledgeAccess, presentKnowledgeMessages, presentKnowledgeSessions };
