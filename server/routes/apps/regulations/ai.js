const { asyncHandler } = require('../../../http');
const {
    buildRegulationAiContext,
    normalizeRegulationId,
    recordRegulationAccess
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
        const limit = Number.parseInt(body.limit, 10) || 12;
        const built = buildRegulationAiContext({ query, documentId, limit, expandLinks: true });
        recordRegulationAccess({ userId: req.user.id, documentId, action: 'ai_query', detail: query.slice(0, 200) });
        const context = built.context || '当前检索没有命中条文。';
        // 把命中条文的来源精简后随回答一并返回，便于前端展示「依据条文」并可点击跳转
        const sources = (built.sources || []).map(source => ({
            index: source.index,
            documentId: source.documentId,
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
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是法规查询助手，回答必须基于给定的法规条文依据。',
                        '依据分为「直接命中条文」和「经引用关联的条文」两组：前者是与问题直接相关的条文，后者是被前者引用或引用前者的关联法条。',
                        '请按以下结构组织回答：',
                        '1. 【核心法条】：列出与问题直接相关的关键条文及其要点；',
                        '2. 【关联法条】：列出经引用关联的条文，并说明其与核心法条的引用关系（如“第三条依照第一条”）；若无关联条文则说明“无”；',
                        '3. 【适用建议】：基于上述条文给出简洁、可执行的建议。',
                        '关联法条必须基于提供的引用关系，不得臆造未给出的条文或引用关系。',
                        '如果依据不足，请明确说明当前检索没有找到足够依据，不要编造条文。',
                        '可以结合上文对话进行追问式回答，但仍以本轮提供的条文依据为准。',
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
