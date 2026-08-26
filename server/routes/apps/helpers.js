const { extractModelText } = require('../../services/chat-route-helpers');
const { getAccessibleModelAsync, modelSupportsReasoning, buildThinkingControlPayload } = require('../../services/models');

function stripThinkTags(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}

// 解析非流式补全响应中的正文：复用聊天侧的健壮解析（兼容字符串/数组 content、
// Responses 风格 output_text/output[]），再剥离思考块。
// 不把 reasoning_content 当作正文返回——它是思考过程而非成稿，空正文交由上层给出明确提示。
function extractCompletionContent(data) {
    return stripThinkTags(extractModelText(data));
}

// 从模型文本中尽力解析一个 JSON 对象：剥离 ```json 代码围栏后取首个 { 到末个 }。
// 解析失败返回 null（调用方据此把整段文本当作普通回答兜底）。
function parseJsonObject(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    try {
        const direct = JSON.parse(raw);
        return direct && typeof direct === 'object' && !Array.isArray(direct) ? direct : null;
    } catch (_e) { /* fall through to brace extraction */ }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(raw.slice(start, end + 1));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (_e2) { /* not JSON */ }
    }
    return null;
}

function clampText(value, max = 4000) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

// 判断是否应为该模型关闭“思考”模式：公文起草/润色/审校属工具型任务，无需思维链。
// 依据管理员设置的 supports_reasoning，或常见推理型模型名（Qwen3 / QwQ / DeepSeek-R1）兜底识别。
function shouldDisableThinking(modelCfg) {
    if (modelSupportsReasoning(modelCfg)) return true;
    const name = String(modelCfg?.model_name || modelCfg?.name || '');
    return /qwen-?3|qwq|deepseek-?r1/i.test(name);
}

// 对推理型模型在最后一条 user 消息追加 /no_think 软开关（Qwen3 等的 chat template 原生支持）。
function applyNoThinkSoftSwitch(messages) {
    const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
    if (lastUserIndex < 0) return messages;
    return messages.map((message, index) => {
        if (index !== lastUserIndex || typeof message.content !== 'string') return message;
        return { ...message, content: `${message.content}\n/no_think` };
    });
}

// Qwen3 的思考模式控制实现在 services/models.js，那里是模型能力判定的归属地；
// 聊天流式路径与后台文本调用共用同一份实现，避免模型名匹配范围出现两套口径。

// 解析公文写作可用模型：优先显式选择，其次个人默认模型，最后系统默认模型。
async function resolveOfficialWritingModel(requestedModel, user) {
    if (requestedModel) {
        const selected = await getAccessibleModelAsync(requestedModel, user);
        if (selected) return selected;
    }
    if (user?.default_model_id) {
        const personal = await getAccessibleModelAsync(user.default_model_id, user);
        if (personal) return personal;
    }
    return await getAccessibleModelAsync(null, user);
}

async function resolveAppsModel(requestedModel, user) {
    return await resolveOfficialWritingModel(requestedModel, user);
}


module.exports = {
    stripThinkTags,
    extractCompletionContent,
    parseJsonObject,
    clampText,
    shouldDisableThinking,
    applyNoThinkSoftSwitch,
    buildThinkingControlPayload,
    resolveOfficialWritingModel,
    resolveAppsModel
};
