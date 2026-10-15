const { asyncHandler } = require('../../../http');
const {
    buildRegulationAiContext,
    getRegulationDocumentById,
    recordRegulationAiAnswer,
    normalizeRegulationId,
    recordRegulationAccess,
    validateRegulationAiGrounding
} = require('./helpers');

function registerAiRoutes(router, deps) {
    const { authMiddleware, logAction, runAppsAiCompletion } = deps;

router.post('/ai', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const query = String(body.query || body.prompt || body.question || '').trim();
        if (!query) {
            return res.status(400).json({ error: { message: '请输入要咨询的问题', type: 'invalid_request_error' } });
        }
        const documentId = normalizeRegulationId(body.documentId || body.document_id);
        if (documentId && !(await getRegulationDocumentById(documentId))) {
            return res.status(404).json({ error: { message: '法规文档不存在或不可访问', type: 'invalid_request_error' } });
        }
        const limit = Number.parseInt(body.limit, 10) || 12;
        const built = await buildRegulationAiContext({ query, documentId, limit, userId: req.user.id, expandLinks: true });
        await recordRegulationAccess({ userId: req.user.id, documentId, action: 'ai_query', detail: query.slice(0, 200) });
        const context = built.context || '当前检索没有命中条文。';
        // 候选条文独立返回给前端。它们是检索召回结果，不等同于已经被模型采纳的结论依据。
        const sources = (built.sources || []).map(source => ({
            index: source.index,
            documentId: source.documentId,
            versionId: source.versionId,
            articleId: source.articleId,
            label: source.label,
            excerpt: String(source.excerpt || '').slice(0, 200),
            viaLink: !!source.viaLink,
            relation: source.relation || ''
        }));
        // 多轮问答：把最近若干轮历史展开为对话消息，保持上下文连贯
        const history = Array.isArray(body.history) ? body.history.slice(-4) : [];
        const historyMessages = [];
        history.forEach(turn => {
            const q = String(turn?.question || '').trim().slice(0, 2000);
            const a = String(turn?.answer || '').trim().slice(0, 4000);
            if (q) historyMessages.push({ role: 'user', content: q });
            if (a) historyMessages.push({ role: 'assistant', content: a });
        });
        return runAppsAiCompletion({
            req,
            res,
            logAction,
            source: 'regulations',
            auditAction: '法规查询 AI 问答',
            maxTokens: 1200,
            temperature: 0.25,
            stream: !!body.stream,
            extraPayload: { sources },
            transformCompletion: async answer => {
                const verified = validateRegulationAiGrounding({
                    answer,
                    sources: built.sources || [],
                    question: query
                });
                return {
                    content: verified.answer,
                    metadata: { grounding: verified.grounding },
                    extraPayload: { grounding: verified.grounding }
                };
            },
            onComplete: async (answer, metadata) => await recordRegulationAiAnswer({
                userId: req.user.id,
                documentId,
                question: query,
                answer,
                modelName: metadata?.model || '',
                contextSnapshot: context,
                sources,
                usage: {
                    ...(metadata?.usage || {}),
                    grounding: metadata?.grounding || {}
                }
            }),
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是法规查询助手，回答必须基于给定的法规条文依据。',
                        '依据分为「直接检索候选」和「经引用关联的候选」两组。候选仅代表检索召回，不天然等于可直接适用的法律依据。',
                        '请按以下结构组织回答：',
                        '1. 【核心法条】：仅列出足以支持本轮结论的条文及其要点；',
                        '2. 【关联法条】：仅列出经给定引用关系支持的关联条文，并说明其与核心法条的引用关系；若无已核验关联条文则说明“无”；',
                        '3. 【适用建议】：基于上述条文给出简洁、可执行的建议。',
                        '每一段包含事实判断、法律结论、条文名称或条号时，都必须在该段末尾添加给定来源编号，例如“……。[1]”。只能使用本轮依据中实际存在的编号。',
                        '不得引用本轮依据中不存在的法律、条号、罪名或量刑标准；关联法条必须基于提供的引用关系，不得臆造。',
                        '如果候选条文不足以回答，请明确说明“已检索到候选条文，但不足以支持具体法律结论”，并提出需要补充的事实；不得写成“未命中条文”。',
                        '可以使用上文对话理解用户意图，但上文对话不是法规依据，不能据此新增或引用法条。',
                        '不要输出与问题无关的免责声明。'
                    ].join('\n')
                },
                ...historyMessages,
                {
                    role: 'user',
                    content: `法规条文依据：\n${context}\n\n问题：${query}`
                }
            ]
        });
    }));
}

module.exports = {
    registerAiRoutes
};
