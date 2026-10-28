'use strict';

const { callModelTextWithBudget } = require('./model-text-call');
const { verifyKnowledgeAnswerWithRepair } = require('./knowledge-grounding');
const { recordKnowledgeAiAnswer } = require('./knowledge-ai-audit');

// RAG 回答必须在原始流完全结束后再公开；先释放生成连接，再进行独立复核，
// 避免端点并发上限为 1 时等待自身释放造成死锁。
async function groundChatRagAnswer({
    assistantContent,
    contextResult,
    modelCfg,
    user,
    releaseSemaphore,
    emitContentSse,
    writeSse,
    routePlan,
    question
} = {}) {
    if (!contextResult?.ragGrounding?.required) return { assistantContent, ragGrounding: null };
    releaseSemaphore?.();
    const ragGrounding = await verifyKnowledgeAnswerWithRepair({
        answer: assistantContent,
        ragContext: contextResult.ragContext,
        question,
        modelCfg,
        user,
        callModel: callModelTextWithBudget
    });
    const groundedAnswer = contextResult.ragGrounding.overview && ragGrounding.grounding.accepted && ragGrounding.grounding.status !== 'insufficient_evidence'
        ? `以下内容基于部分文档的开头片段，不能代表文档或专题的全部内容。\n\n${ragGrounding.answer}`
        : ragGrounding.answer;
    emitContentSse?.(groundedAnswer);
    writeSse?.(JSON.stringify({
        type: 'rag_grounding',
        status: ragGrounding.grounding.status,
        accepted: ragGrounding.grounding.accepted,
        sourceCount: ragGrounding.grounding.sourceCount,
        citedSourceIndexes: ragGrounding.grounding.citedSourceIndexes,
        invalidSourceIndexes: ragGrounding.grounding.invalidSourceIndexes
    }));
    if (routePlan?.rag) routePlan.rag.grounding = ragGrounding.grounding;
    return { assistantContent: groundedAnswer, ragGrounding };
}

async function recordChatRagAnswerAudit({
    ragGrounding,
    contextResult,
    routePlan,
    userId,
    sessionId,
    question,
    answer,
    modelCfg,
    usage,
    log
} = {}) {
    if (!contextResult?.ragGrounding?.required) return null;
    try {
        return await recordKnowledgeAiAnswer({
            userId,
            sessionId,
            surface: 'chat',
            question,
            rewrittenQuery: contextResult.retrievalQuery || question,
            answer,
            modelName: modelCfg?.name || modelCfg?.model_name || '',
            retrieval: {
                retrievalMode: routePlan?.rag?.mode || '',
                retrievalPlan: contextResult.retrievalPlan || null,
                sourceSummary: contextResult.ragSourceSummary || null,
                scope: routePlan?.rag?.scope || {}
            },
            grounding: ragGrounding?.grounding || {},
            usage: usage || {}
        });
    } catch (error) {
        log?.warn({ err: error.message, sessionId, userId }, '知识库回答审计写入失败');
        return null;
    }
}

function createChatRagResponseFlow(options = {}) {
    const required = Boolean(options.contextResult?.ragGrounding?.required);
    const emitContent = content => {
        const chunks = typeof options.splitStreamTextForDisplay === 'function'
            ? options.splitStreamTextForDisplay(content)
            : [content];
        (Array.isArray(chunks) ? chunks : [content]).forEach(chunk => options.writeSse?.(JSON.stringify({ content: chunk })));
    };
    return {
        writeContent(content) {
            if (!required) emitContent(content);
        },
        async ground(answer) {
            return await groundChatRagAnswer({ ...options, assistantContent: answer, emitContentSse: emitContent });
        },
        async audit(answer, ragGrounding, usage) {
            return await recordChatRagAnswerAudit({ ...options, answer, ragGrounding, usage });
        }
    };
}

module.exports = { createChatRagResponseFlow };
