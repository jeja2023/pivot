const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { estimateTokens } = require('../llm');
const { getRunnableModelForUserAsync } = require('./models');
const { saveAssistantMessage, touchSession, updateAssistantStats } = require('./chat-messages');
const { maybeGenerateTitle } = require('./chat-title');
const {
    buildLongTermMemoryContextMessage,
    retrieveLongTermMemories,
    scheduleMemoryExtraction
} = require('./long-term-memory');
const { summarizeRagContextSources } = require('./chat-rag-context');
const { getModelContextBudget } = require('./context-budget');
const { parseJsonObject } = require('./agent-validators');
const { logger } = require('../logger');

const CHAT_AGENT_BRIDGE_VERSION = 1;
const CHAT_AGENT_HISTORY_LIMIT = 24;
const CHAT_AGENT_HISTORY_ITEM_CHARS = 8000;
const CHAT_AGENT_CONTEXT_CHARS = 24000;
const CHAT_AGENT_ACTIVE_STATUSES = new Set([
    'queued', 'planning', 'executing', 'observing', 'diagnosing', 'replanning',
    'running', 'approval_required', 'waiting_approval', 'awaiting_approval', 'resuming'
]);
const CHAT_AGENT_TERMINAL_STATUSES = new Set([
    'completed', 'completed_with_errors', 'error', 'failed', 'cancelled', 'deleted'
]);

function clampText(value, max = CHAT_AGENT_HISTORY_ITEM_CHARS) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 36)).trimEnd()}\n...[聊天上下文已截断]`;
}

function normalizeChatContent(content, max = CHAT_AGENT_HISTORY_ITEM_CHARS) {
    if (!Array.isArray(content)) return clampText(content, max);
    return content.map(part => {
        if (!part || typeof part !== 'object') return null;
        if (part.type === 'text') {
            const text = clampText(part.text, max);
            return text ? { type: 'text', text } : null;
        }
        if (part.type === 'image_url' && part.image_url && typeof part.image_url === 'object') {
            const url = String(part.image_url.url || '').trim();
            if (!url) return null;
            return {
                type: 'image_url',
                image_url: {
                    url: clampText(url, max),
                    ...(part.image_url.detail ? { detail: String(part.image_url.detail).slice(0, 20) } : {})
                }
            };
        }
        return null;
    }).filter(Boolean);
}

function parseMetadata(value) {
    return parseJsonObject(value) || {};
}

function normalizeChatHistory(messages = []) {
    return (Array.isArray(messages) ? messages : [])
        .filter(message => ['user', 'assistant'].includes(String(message?.role || '').trim().toLowerCase()))
        .slice(-CHAT_AGENT_HISTORY_LIMIT)
        .map(message => ({
            role: String(message.role).trim().toLowerCase(),
            content: normalizeChatContent(message.content)
        }))
        .filter(message => Array.isArray(message.content) ? message.content.length > 0 : message.content);
}

function buildChatAgentMetadata({
    sessionId,
    userMessageId = null,
    visibleContent = '',
    history = [],
    source = 'chat',
    systemPrompt = '',
    mcpEnabled = false,
    mcpToolAllowlist = null,
    ragEnabled = false,
    ragScope = {},
    currentContent = '',
    memoryContext = '',
    ragContext = ''
} = {}) {
    const normalizedMcpToolAllowlist = Array.isArray(mcpToolAllowlist)
        ? [...new Set(mcpToolAllowlist.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 300)
        : null;
    return {
        chatBridge: {
            version: CHAT_AGENT_BRIDGE_VERSION,
            source,
            sessionId: String(sessionId || ''),
            userMessageId: Number(userMessageId || 0) || null,
            visibleContent: clampText(visibleContent, 12000),
            systemPrompt: clampText(systemPrompt, 12000),
            mcpEnabled: Boolean(mcpEnabled),
            mcpToolAllowlist: normalizedMcpToolAllowlist,
            ragEnabled: Boolean(ragEnabled),
            ragScope: ragScope && typeof ragScope === 'object' ? ragScope : {},
            currentMessage: {
                role: 'user',
                content: normalizeChatContent(currentContent)
            },
            memoryContext: clampText(memoryContext, CHAT_AGENT_CONTEXT_CHARS),
            ragContext: clampText(ragContext, CHAT_AGENT_CONTEXT_CHARS),
            createdAt: getBeijingTimestamp()
        },
        chatHistory: normalizeChatHistory(history)
    };
}

async function prepareChatAgentContext({
    userId,
    user,
    modelCfg,
    modelContent,
    ragEnabled = false,
    ragScope = {},
    retrieveContext,
    isRagEnabled
} = {}) {
    let memoryContext = '';
    let memoryCount = 0;
    let ragContext = '';
    let ragSummary = null;
    const queryText = String(modelContent || '').trim();

    if (queryText && Number(userId) > 0) {
        try {
            const matches = await retrieveLongTermMemories(userId, queryText, { user });
            memoryCount = Array.isArray(matches) ? matches.length : 0;
            memoryContext = buildLongTermMemoryContextMessage(matches, {
                inputBudget: modelCfg ? getModelContextBudget(modelCfg).inputBudget : 4000
            }) || '';
        } catch (error) {
            logger.warn({ userId, err: error.message }, '普通聊天 Agent 长期记忆检索失败');
        }
    }

    if (ragEnabled && queryText && typeof retrieveContext === 'function'
        && (typeof isRagEnabled !== 'function' || isRagEnabled())) {
        try {
            ragContext = await retrieveContext(userId, queryText, null, { user, scope: ragScope }) || '';
            ragSummary = summarizeRagContextSources(ragContext);
        } catch (error) {
            logger.warn({ userId, err: error.message }, '普通聊天 Agent 知识库检索失败');
        }
    }

    return {
        memoryContext: clampText(memoryContext, CHAT_AGENT_CONTEXT_CHARS),
        memoryCount,
        ragContext: clampText(ragContext, CHAT_AGENT_CONTEXT_CHARS),
        ragSummary
    };
}

function getChatBridgeMetadata(run) {
    const metadata = parseMetadata(run?.metadata);
    const bridge = metadata.chatBridge;
    if (!bridge || typeof bridge !== 'object' || Number(bridge.version || 0) !== CHAT_AGENT_BRIDGE_VERSION) return null;
    return { metadata, bridge };
}

function isChatAgentRun(run) {
    return Boolean(getChatBridgeMetadata(run));
}

async function markChatBridgeMessage(runId, metadata, messageId) {
    const nextMetadata = {
        ...metadata,
        chatBridge: {
            ...(metadata.chatBridge || {}),
            messageId: Number(messageId || 0) || null,
            persistedAt: getBeijingTimestamp()
        }
    };
    await execute('UPDATE agent_runs SET metadata = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(nextMetadata),
        getBeijingTimestamp(),
        runId
    ]);
}

async function persistAgentRunChatResult(runId) {
    const run = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [runId]);
    const bridgeInfo = getChatBridgeMetadata(run);
    if (!run || !bridgeInfo) return null;
    const { metadata, bridge } = bridgeInfo;
    if (Number(bridge.messageId || 0) > 0) return Number(bridge.messageId);

    const sessionId = String(run.session_id || bridge.sessionId || '').trim();
    const userId = Number(run.user_id || 0);
    if (!sessionId || !Number.isSafeInteger(userId) || userId <= 0) return null;

    // A terminal run is normally finalized once by updateRun. The linked message
    // column and metadata marker make retries/recovery idempotent.
    const userMessageId = Number(bridge.userMessageId || 0) || 0;
    const linkedExisting = await queryOne(`
        SELECT id FROM messages
        WHERE session_id = ? AND user_id = ? AND role = 'assistant'
          AND agent_run_id = ? AND deleted_at IS NULL
        ORDER BY id ASC LIMIT 1
    `, [sessionId, userId, String(run.id)]);
    if (linkedExisting?.id) {
        await markChatBridgeMessage(run.id, metadata, linkedExisting.id);
        return Number(linkedExisting.id);
    }
    const answer = String(run.final_answer || '').trim();
    const error = String(run.error_message || '').trim();
    const content = answer || (error ? `任务执行失败：${error}` : '任务未生成可用结果。');
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]).catch(() => ({ id: userId }));
    const modelCfg = await getRunnableModelForUserAsync(run.chosen_model_id || run.model_id, user).catch(() => null);
    const modelId = Number(run.chosen_model_id || run.model_id || 0) || null;
    const tokenCount = estimateTokens(content);
    const startedAt = Date.parse(String(run.started_at || run.created_at || '')) || Date.now();
    const completedAt = Date.parse(String(run.completed_at || '')) || Date.now();
    const costTime = Math.max((completedAt - startedAt) / 1000, 0.001);
    const tps = tokenCount > 0 ? tokenCount / costTime : 0;
    let result;
    try {
        result = await saveAssistantMessage({
            sessionId,
            userId,
            content,
            modelId,
            tokenCount,
            agentRunId: run.id
        });
    } catch (error) {
        // Two terminal callbacks can race before either metadata marker is visible.
        // The unique agent_run_id index makes the loser recover the winner's row.
        const concurrentMessage = await queryOne(`
            SELECT id FROM messages
            WHERE session_id = ? AND user_id = ? AND role = 'assistant'
              AND agent_run_id = ? AND deleted_at IS NULL
            ORDER BY id ASC LIMIT 1
        `, [sessionId, userId, String(run.id)]);
        if (!concurrentMessage?.id) throw error;
        await markChatBridgeMessage(run.id, metadata, concurrentMessage.id);
        return Number(concurrentMessage.id);
    }
    const messageId = Number(result?.lastInsertRowid || 0) || null;
    if (messageId) {
        await updateAssistantStats({ messageId, costTime, tps });
        await touchSession(sessionId);
        if (modelCfg) {
            await scheduleMemoryExtraction({
                userId,
                sessionId,
                messageIds: [userMessageId, messageId].filter(Boolean),
                user,
                modelCfg
            }).catch(error => logger.warn({ runId, err: error.message }, 'Agent 聊天结果记忆提取调度失败'));
            await maybeGenerateTitle(
                sessionId,
                userId,
                bridge.visibleContent || run.goal || '',
                content,
                modelCfg,
                user
            ).catch(error => logger.warn({ runId, err: error.message }, 'Agent 聊天会话标题生成失败'));
        }
        await markChatBridgeMessage(run.id, metadata, messageId);
    }
    return messageId;
}

async function listChatAgentRunsForSession(sessionId, userId, { limit = 20 } = {}) {
    const safeSessionId = String(sessionId || '').trim();
    const safeUserId = Number(userId || 0);
    if (!safeSessionId || !Number.isSafeInteger(safeUserId) || safeUserId <= 0) return [];
    const rows = await query(`
        SELECT r.*, COALESCE(cm.name, m.name) AS model_name
        FROM agent_runs r
        LEFT JOIN models m ON m.id = r.model_id
        LEFT JOIN models cm ON cm.id = r.chosen_model_id
        WHERE r.user_id = ? AND r.session_id = ? AND r.deleted_at IS NULL
        ORDER BY r.created_at DESC
        LIMIT ?
    `, [safeUserId, safeSessionId, Math.min(Math.max(Number(limit) || 20, 1), 50)]);
    const result = [];
    for (const row of rows) {
        const bridgeInfo = getChatBridgeMetadata(row);
        if (!bridgeInfo) continue;
        const linkedMessage = Number(bridgeInfo.bridge.messageId || 0) > 0
            ? bridgeInfo.bridge.messageId
            : null;
        if (linkedMessage) continue;
        if (CHAT_AGENT_ACTIVE_STATUSES.has(String(row.status || '').toLowerCase())) {
            result.push(row);
            continue;
        }
        if (CHAT_AGENT_TERMINAL_STATUSES.has(String(row.status || '').toLowerCase())) {
            const existing = await queryOne(`
                SELECT id FROM messages
                WHERE session_id = ? AND user_id = ? AND role = 'assistant'
                  AND agent_run_id = ? AND deleted_at IS NULL
                LIMIT 1
            `, [safeSessionId, safeUserId, String(row.id)]);
            if (!existing?.id) result.push(row);
        }
    }
    return result;
}

async function recoverChatAgentResults({ limit = 200 } = {}) {
    const rows = await query(`
        SELECT id, status
        FROM agent_runs
        WHERE session_id IS NOT NULL AND deleted_at IS NULL
          AND status IN ('completed', 'completed_with_errors', 'error', 'failed', 'cancelled')
        ORDER BY updated_at ASC
        LIMIT ?
    `, [Math.min(Math.max(Number(limit) || 200, 1), 500)]);
    let recovered = 0;
    let skipped = 0;
    for (const row of rows) {
        const run = await queryOne('SELECT * FROM agent_runs WHERE id = ?', [row.id]);
        if (!isChatAgentRun(run)) {
            skipped += 1;
            continue;
        }
        try {
            const messageId = await persistAgentRunChatResult(row.id);
            if (messageId) recovered += 1;
        } catch (error) {
            logger.error({ runId: row.id, err: error.message }, '普通聊天 Agent 结果恢复失败');
        }
    }
    return { scanned: rows.length, recovered, skipped };
}

module.exports = {
    CHAT_AGENT_BRIDGE_VERSION,
    CHAT_AGENT_HISTORY_LIMIT,
    buildChatAgentMetadata,
    getChatBridgeMetadata,
    isChatAgentRun,
    normalizeChatHistory,
    normalizeChatContent,
    prepareChatAgentContext,
    listChatAgentRunsForSession,
    persistAgentRunChatResult,
    recoverChatAgentResults
};
