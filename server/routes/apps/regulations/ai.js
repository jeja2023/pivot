const { asyncHandler } = require('../../../http');
const {
    buildRegulationAiContext,
    getRegulationAiQualityMetrics,
    getRegulationDocumentById,
    recordRegulationAiAnswer,
    normalizeRegulationId,
    recordRegulationAccess,
    buildRegulationUnverifiedModelAnswer,
    validateRegulationAiGrounding
} = require('./helpers');
const { isAdmin } = require('../../../permissions');
const { regulationAiLimits } = require('../../../services/regulations/ai-planning');

function registerAiRoutes(router, deps) {
    const { authMiddleware, logAction, runAppsAiCompletion } = deps;

    router.get('/ai-metrics', authMiddleware, asyncHandler(async (req, res) => {
        if (!isAdmin(req.user)) {
            return res.status(403).json({ error: { message: '仅管理员可查看法规问答质量指标' } });
        }
        const metrics = await getRegulationAiQualityMetrics({
            userId: req.query.userId || req.query.user_id,
            documentId: req.query.documentId || req.query.document_id,
            days: req.query.days
        });
        res.json({ metrics });
    }));

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
        const versionId = normalizeRegulationId(body.versionId || body.version_id);
        const articleIds = body.articleIds || body.article_ids || body.selectedArticleIds || body.selected_article_ids || [];
        const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
        const aiLimits = regulationAiLimits();
        const built = await buildRegulationAiContext({
            query,
            documentId,
            versionId,
            articleIds,
            restrictToSelected: body.restrictToSelected === true || body.restrict_to_selected === true,
            category: body.category || '',
            issuingBody: body.issuingBody || body.issuing_body || '',
            jurisdiction: body.jurisdiction || '',
            status: body.status || '',
            effectiveAt: body.effectiveAt || body.effective_at || '',
            limit: Math.min(Math.max(Number.parseInt(body.limit, 10) || aiLimits.evidenceLimit, 4), 20),
            candidateLimit: Math.min(Math.max(Number.parseInt(body.candidateLimit, 10) || aiLimits.candidateLimit, 20), 150),
            history,
            userId: req.user.id,
            expandLinks: body.expandLinks !== false,
            includeArchived: isAdmin(req.user) && (body.includeArchived === true || body.include_archived === true)
        });
        await recordRegulationAccess({ userId: req.user.id, documentId, action: 'ai_query', detail: query.slice(0, 200) });
        const context = built.context || '当前检索没有命中条文。';
        const hasArticleEvidence = Boolean(built.sources?.length);
        // 候选条文独立返回给前端。它们是检索召回结果，不等同于已经被模型采纳的结论依据。
        const sources = (built.sources || []).map(source => ({
            index: source.index,
            documentId: source.documentId,
            versionId: source.versionId,
            articleId: source.articleId,
            label: source.label,
            excerpt: String(source.excerpt || '').slice(0, 200),
            contextExcerpt: String(source.contextExcerpt || '').slice(0, 2200),
            headingPath: source.headingPath || '',
            pageStart: source.pageStart || null,
            pageEnd: source.pageEnd || null,
            effectiveFrom: source.effectiveFrom || '',
            effectiveTo: source.effectiveTo || '',
            effectStatus: source.effectStatus || 'unverified',
            reviewStatus: source.reviewStatus || 'pending',
            retrieval: source.retrieval || '',
            selected: !!source.selected,
            viaLink: !!source.viaLink,
            relation: source.relation || ''
        }));
        // 多轮问答：把最近若干轮历史展开为对话消息，保持上下文连贯
        const historyMessages = [];
        history.forEach(turn => {
            const q = String(turn?.question || '').trim().slice(0, 3000);
            const a = String(turn?.answer || '').trim().slice(0, 6000);
            if (q) historyMessages.push({ role: 'user', content: q });
            if (a) historyMessages.push({ role: 'assistant', content: a });
        });
        return runAppsAiCompletion({
            req,
            res,
            logAction,
            source: 'regulations',
            auditAction: '法规查询 AI 问答',
            maxTokens: aiLimits.maxOutputTokens,
            temperature: 0.25,
            stream: !!body.stream,
            extraPayload: { sources, diagnostics: built.diagnostics || {}, queryPlan: built.plan || {} },
            transformCompletion: async answer => {
                if (!hasArticleEvidence) {
                    return {
                        content: buildRegulationUnverifiedModelAnswer(answer, { indexStatus: built.diagnostics?.indexStatus }),
                        metadata: { grounding: { status: 'model_general_unverified', accepted: false, candidateCount: 0, reasonCodes: ['no_candidates'] } },
                        extraPayload: { grounding: { status: 'model_general_unverified', accepted: false, candidateCount: 0, reasonCodes: ['no_candidates'] } }
                    };
                }
                const verified = validateRegulationAiGrounding({
                    answer,
                    sources: built.sources || [],
                    question: query
                });
                const formatOnly = !verified.grounding.accepted
                    && verified.grounding.reasonCodes?.length
                    && verified.grounding.reasonCodes.every(code => ['missing_source_citation', 'invalid_structured_output'].includes(code));
                if (formatOnly) {
                    const grounding = { ...verified.grounding, status: 'model_general_unverified' };
                    return {
                        content: buildRegulationUnverifiedModelAnswer(answer, { hasCandidates: true }),
                        metadata: { grounding },
                        extraPayload: { grounding }
                    };
                }
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
                    grounding: metadata?.grounding || {},
                    retrieval: built.diagnostics || {},
                    queryPlan: built.plan || {}
                }
            }),
            messages: hasArticleEvidence ? [
                {
                    role: 'system',
                    content: [
                        '你是法规查询助手，回答必须基于给定的法规条文依据。',
                        '先判断本轮依据是否足以回答；若不足，answerability 必须为 clarification，不得补写依据外的法规结论。',
                        '只输出合法 JSON，不要输出 Markdown 代码块，格式必须是：{"answerability":"adequate|clarification","claims":[{"text":"可核验的结论","sourceIds":[1],"quote":"依据中的原文短句"}],"answer":"适用条件、边界和建议","clarification":"需要补充的事实"}。',
                        '每个 claims 必须带 sourceIds 和 quote；quote 必须逐字来自对应依据片段。sourceIds 只能使用本轮依据中的编号。',
                        '依据分为「直接检索候选」和「经引用关联的候选」两组。候选仅代表检索召回，不天然等于可直接适用的法律依据。',
                        '最终展示由服务端生成结构化的【核心法条】、【关联法条】、【适用建议】；你只需返回 JSON。',
                        '不得引用本轮依据中不存在的法律、条号、罪名或量刑标准；关联法条必须基于提供的引用关系，不得臆造。',
                        '如果候选条文不足以回答，请明确说明“已检索到候选条文，但不足以支持具体法律结论”，并提出需要补充的事实；不得写成“未命中条文”。',
                        '可以使用上文对话理解用户意图，但上文对话不是法规依据，不能据此新增或引用法条。',
                        '不要输出与问题无关的免责声明。'
                    ].join('\n')
                },
                ...historyMessages,
                {
                    role: 'user',
                    content: `法规条文依据：\n${context}\n\n本轮检索规划：${JSON.stringify(built.plan || {})}\n\n问题：${query}`
                }
            ] : [
                { role: 'system', content: '你是法规查询助手。本轮法规库未返回可引用条文。请根据一般法律知识简洁回答，并明确说明具体法律适用、条号及刑罚需核对现行官方法条。不要伪造来源或声称已检索到法规依据。' },
                ...historyMessages,
                { role: 'user', content: query }
            ]
        });
    }));
}

module.exports = {
    registerAiRoutes
};
