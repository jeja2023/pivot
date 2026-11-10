'use strict';

const { resolveChatKnowledgeSelection } = require('./chat-knowledge-selection');
const { resolveKnowledgeToolScope } = require('./knowledge-tool-results');
const { normalizeToolAllowlist, parseJsonObject } = require('./agent-validators');

const KNOWLEDGE_TOOLS = ['rag.search', 'knowledge.list', 'knowledge.graph.query'];

async function prepareContinuationKnowledgeScope({ decision, routeOverrides, requestScope, run, user, sessionId, userMessageId }, deps = {}) {
    const selection = await resolveChatKnowledgeSelection({ sessionId, routeOverrides, ragScope: decision.knowledgeScope,
        requestScope, ...(decision.knowledgeScope?.cleared ? { ragEnabled: false } : {}) }, user, userMessageId, deps);
    if (!selection || selection.scope.cleared) return selection;
    // 只替换会话选择；项目或运行配置中的上限仍与新选择求交集，权限不因续接扩大。
    return { ...selection, scope: await resolveKnowledgeToolScope(user, {}, {
        run: { context_config: run.context_config, metadata: { chatBridge: { ragScope: selection.scope } } }
    }, deps) };
}

function applyContinuationKnowledgeScope(metadata, selection, { run, userMessageId }) {
    if (!selection) return metadata;
    const previousMessageId = Number(metadata.chatKnowledgeScope?.sourceMessageId || 0);
    if (previousMessageId > Number(userMessageId)) throw Object.assign(new Error('资料范围已由更新的消息修改，请重新确认当前任务。'), { code: 'CHAT_KNOWLEDGE_SCOPE_STALE' });
    const cleared = selection.scope.cleared === true || metadata.capabilityConstraints?.excludeKnowledge === true;
    const scope = cleared ? { collectionIds: [], tagNames: [], cleared: true } : selection.scope;
    const currentTools = metadata.chatToolScope || { toolPolicy: run.tool_policy, toolAllowlist: normalizeToolAllowlist(run.tool_allowlist), networkPolicy: parseJsonObject(run.network_policy) || {} };
    const allowlist = normalizeToolAllowlist(currentTools.toolAllowlist);
    // 空白名单表示沿用全部受治理工具；不能把它误收窄为仅知识工具。
    const toolScope = allowlist.length ? { ...currentTools, sourceMessageId: Math.max(Number(currentTools.sourceMessageId || 0), Number(userMessageId)),
        toolAllowlist: cleared ? allowlist.filter(name => !KNOWLEDGE_TOOLS.includes(name)) : [...new Set([...allowlist, ...KNOWLEDGE_TOOLS])] } : null;
    // 清除后的空白名单不能被执行层解释为无限制；原文读取仍受任务来源与账号校验。
    if (toolScope && !toolScope.toolAllowlist.length) toolScope.toolAllowlist = ['chat.read_source'];
    const capabilities = metadata.capabilityConstraints?.capabilities || [];
    const normalizeScope = require('./rag-index/retrieval-scope-builder').normalizeRetrievalScope;
    const changed = Boolean(metadata.chatBridge?.ragScope?.cleared) !== cleared
        || JSON.stringify(normalizeScope(metadata.chatBridge?.ragScope || {})) !== JSON.stringify(normalizeScope(scope));
    return { ...metadata,
        chatKnowledgeScope: { sourceMessageId: userMessageId, scope, revision: Number(metadata.chatKnowledgeScope?.revision || 0) + (changed ? 1 : 0) },
        chatBridge: { ...metadata.chatBridge, ragEnabled: !cleared, ragScope: scope, ragContext: '' },
        ...(changed && metadata.workingState ? { workingState: { ...metadata.workingState, evidence: [], decisions: [] } } : {}),
        ...(metadata.capabilityConstraints ? { capabilityConstraints: { ...metadata.capabilityConstraints,
            ...(cleared ? { excludeKnowledge: true } : {}), capabilities: cleared ? capabilities.filter(cap => !cap.startsWith('knowledge.'))
                : [...new Set([...capabilities, 'knowledge.search'])] } } : {}),
        ...(toolScope ? { chatToolScope: toolScope } : {})
    };
}

function currentKnowledgeControlMessage(message, metadata) {
    if (message.from_run_id || message.payload?.source !== 'chat' || !message.payload.knowledgeScope
        || !(Number(message.payload.sourceMessageId) < Number(metadata.chatKnowledgeScope?.sourceMessageId || 0))) return message;
    return { ...message, payload: { source: 'chat', sourceMessageId: message.payload.sourceMessageId, knowledgeScopeSuperseded: true,
        instruction: '先前的资料范围要求已由较新的消息替代，请以当前资料范围为准。' } };
}

module.exports = { prepareContinuationKnowledgeScope, applyContinuationKnowledgeScope, currentKnowledgeControlMessage };
