const { getAccessibleModelAsync, getModelDailyUsageAsync } = require('./models');
const {
    ContextLengthExceededError,
    buildContextLengthExceededPayload,
    fitMessagesToContextBudget
} = require('./context-budget');
const { normalizeRegenerateFlag } = require('./chat-route-helpers');
const sessionsRepository = require('../repositories/sessions');

function buildChatRequestState(req) {
    const body = req.body || {};
    const content = body.content;
    const displayContent = body.displayContent;
    const modelContent = String(content || '').trim();
    const mcpToolAllowlist = Array.isArray(body.mcpToolAllowlist)
        ? [...new Set(body.mcpToolAllowlist
            .map(value => String(value || '').trim())
            .filter(value => value && value.length <= 240))]
            .slice(0, 300)
        : null;
    return {
        content,
        displayContent,
        regenerate: normalizeRegenerateFlag(body.regenerate),
        mcpEnabled: Boolean(body.mcpEnabled) && Boolean(body.mcpConfirmed),
        mcpToolAllowlist,
        ragEnabled: body.ragEnabled !== false,
        ragScope: body.ragScope && typeof body.ragScope === 'object' ? body.ragScope : {},
        sessionId: String(body.sessionId || '').trim(),
        modelId: body.modelId ? parseInt(body.modelId, 10) : null,
        userId: req.user.id,
        modelContent,
        visibleContent: String(displayContent || modelContent).trim()
    };
}

async function validateChatPreflight({ state, user, req, logAction }) {
    const { sessionId, userId, modelId, modelContent } = state;
    const session = await sessionsRepository.getSessionById(sessionId, userId);
    if (!session) {
        return { error: { error: '无权访问或会话不存在', code: 'FORBIDDEN' } };
    }

    const modelCfg = await getAccessibleModelAsync(modelId, user);
    if (!modelCfg) {
        return { error: { error: '未找到可用的模型配置', code: 'MODEL_NOT_FOUND' } };
    }

    if (modelCfg.secret_error) {
        return { error: { error: `${modelCfg.secret_error}，请重新保存该模型的 API Key`, code: 'API_KEY_ERROR' }, modelCfg };
    }

    try {
        fitMessagesToContextBudget([{ role: 'user', content: modelContent }], modelCfg);
    } catch (e) {
        if (e instanceof ContextLengthExceededError || e.code === 'CONTEXT_LENGTH_EXCEEDED') {
            req?.log?.warn?.({
                sessionId,
                userId,
                modelId: modelCfg.id,
                contentLength: modelContent.length,
                contextBudget: e.metadata
            }, '聊天请求因当前输入超限被拦截');
            return { error: buildContextLengthExceededPayload(e), modelCfg };
        }
        throw e;
    }

    if (modelCfg.daily_token_limit && modelCfg.daily_token_limit > 0) {
        const usedToday = await getModelDailyUsageAsync(userId, modelCfg.id);
        if (usedToday >= modelCfg.daily_token_limit) {
            logAction?.(req, '模型额度拦截', `模型: ${modelCfg.name}，今日已用 ${usedToday}/${modelCfg.daily_token_limit}`);
            return {
                error: {
                    error: `该模型今日额度已用完（${usedToday}/${modelCfg.daily_token_limit} Tokens）`,
                    code: 'QUOTA_EXCEEDED'
                },
                modelCfg
            };
        }
    }

    return { session, modelCfg };
}

module.exports = {
    buildChatRequestState,
    validateChatPreflight
};
