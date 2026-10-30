/* 模型业务逻辑层 Model Service Layer */
const { query, queryOne } = require('../db/client');
const { decryptSecret } = require('../security');
const { normalizeTokenUsage } = require('./token-accounting');
const { normalizePriceCurrency, normalizePriceValue } = require('./model-costs');
const { getBeijingTimestamp } = require('../time');
const { normalizeToolCallMode } = require('./model-tool-call-capabilities');
const {
    enqueueModelUsageEvent,
    getPendingModelUsageTotal
} = require('./db-write-queue');

const modelListFields = "id, user_id, name, url, model_name, is_default, status, daily_token_limit, allowed_units, monitor_url, max_input_tokens, max_tokens, max_concurrent, supports_vision, supports_reasoning, chat_thinking_enabled, supports_tool_calls, tool_call_mode, tool_call_probe_status, tool_call_probe_protocol, tool_call_probe_error, tool_call_probed_at, input_price_per_million, output_price_per_million, price_currency, created_at, (CASE WHEN api_key IS NOT NULL AND length(api_key) > 0 THEN '********' ELSE '' END) AS api_key";

const normalizeTags = (value) => String(value || '')
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(',');

function normalizeBooleanFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

// 单个 token 上限字段的范围校验：留空 -> null（不限）；其余必须是 0~上限 的整数。
// 0 视为"不设"（与上下文预算把 0 当无界一致）。非法值返回 { error }，由路由转 400。
// 严格数字校验：拒绝 "123abc" 等部分数字（与前端 parseTokenAmount 的宽松解析拉齐后端防护标准）。
const MAX_MODEL_TOKEN_LIMIT = 20000000;
function normalizeModelTokenLimit(raw, label) {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const parsed = Number.parseInt(raw, 10);
    // 严格校验：parseInt("123abc")=123 但我们要求纯数字，所以加 String(parsed) !== String(raw).trim() 防御
    if (!Number.isFinite(parsed) || String(parsed) !== String(raw).trim()) {
        return { error: `${label}必须是数字` };
    }
    if (parsed < 0) return { error: `${label}不能为负数` };
    if (parsed === 0) return { value: null };
    if (parsed > MAX_MODEL_TOKEN_LIMIT) return { error: `${label}超出允许范围（最大 ${MAX_MODEL_TOKEN_LIMIT}）` };
    return { value: parsed };
}

// 统一校验模型的三项 token 设置，含范围与相互关系（输入/输出上限须小于上下文窗口）。
// 返回 { values: { maxInputTokens, maxTokens, contextWindowTokens } } 或 { error }。
function validateModelTokenSettings(body = {}) {
    const input = normalizeModelTokenLimit(body.max_input_tokens, '输入 Token 上限');
    if (input.error) return { error: input.error };
    const output = normalizeModelTokenLimit(body.max_tokens, '输出 Token 上限');
    if (output.error) return { error: output.error };
    const window = normalizeModelTokenLimit(body.context_window_tokens, '上下文窗口');
    if (window.error) return { error: window.error };

    if (window.value !== null) {
        if (input.value !== null && input.value >= window.value) {
            return { error: '输入 Token 上限应小于上下文窗口' };
        }
        if (output.value !== null && output.value >= window.value) {
            return { error: '输出 Token 上限应小于上下文窗口' };
        }
    }
    return {
        values: {
            maxInputTokens: input.value,
            maxTokens: output.value,
            contextWindowTokens: window.value
        }
    };
}

function modelSupportsVision(model) {
    return normalizeBooleanFlag(model?.supports_vision) === 1;
}

function modelSupportsReasoning(model) {
    return normalizeBooleanFlag(model?.supports_reasoning) === 1;
}

function shouldDisableChatThinking(model) {
    return modelSupportsReasoning(model) && normalizeBooleanFlag(model?.chat_thinking_enabled) !== 1;
}

function isChatThinkingEnabled(model) {
    return modelSupportsReasoning(model) && !shouldDisableChatThinking(model);
}

// Qwen3 系列的思考模式默认开启，而 /no_think 软开关只在部分版本的 chat template 中生效。
// 软开关失效时模型会在思考里先写完答案、再正式输出一遍：输出 token 翻倍、首字延迟翻倍，
// 输出预算紧的场景（标题 32 tokens、记忆抽取 800 tokens）还会被思考整段吃掉而彻底失效。
// 这里按 vLLM / SGLang 的约定显式关闭。
//
// 函数自带模型判定，调用方无需再包条件：只对 Qwen3 / QwQ 这类自部署模型返回非空，
// 其他厂商（如 OpenAI）会因未知字段直接返回 400，因此一律返回空对象。
// 需要保留思维链的路径（对话的第三档配置、Agent 规划）不要调用它。
function buildThinkingControlPayload(model) {
    if (String(process.env.MODEL_THINKING_TEMPLATE_KWARGS || '1') === '0') return {};
    // 管理员可能只在显示名里写明 Qwen3，因此模型名和显示名一起参与匹配。
    const name = `${model?.model_name || ''} ${model?.name || ''}`;
    if (!/qwen-?3|qwq/i.test(name)) return {};
    return { chat_template_kwargs: { enable_thinking: false } };
}

function contentContainsVisionInput(content) {
    if (Array.isArray(content)) {
        return content.some(part => {
            if (!part || typeof part !== 'object') return false;
            if (part.type === 'image_url' || part.type === 'input_image') return true;
            if (part.image_url) return true;
            return contentContainsVisionInput(part.content);
        });
    }
    return /!\[[^\]]*]\((?:\/uploads\/(?:[^()]|\([^)]*\))+|data:image\/[^)]+|https?:\/\/[^)\s]+\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^)\s]*)?)?\)/i.test(String(content || ''));
}

function messagesContainVisionInput(messages) {
    return Array.isArray(messages) && messages.some(message => contentContainsVisionInput(message?.content));
}

// ──────────────────────────────────────────────────────────────────────────
// 解密工具
// ──────────────────────────────────────────────────────────────────────────
function _decryptApiKey(model) {
    if (!model) return model;
    if (model.api_key) {
        try {
            model.api_key = decryptSecret(model.api_key, 'models.api_key');
        } catch (e) {
            model.api_key = '';
            model.secret_error = e.message || '模型密钥解密失败';
        }
    }
    return model;
}

// ──────────────────────────────────────────────────────────────────────────
// getAccessibleModel — PostgreSQL 异步
// ──────────────────────────────────────────────────────────────────────────

async function getAccessibleModelAsync(modelId, user) {
    let model;
    if (modelId) {
        const isNumeric = /^\d+$/.test(String(modelId));
        const sql = isNumeric
            ? "SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND (id = ? OR model_name = ?) AND (user_id IS NULL OR user_id = ?)"
            : "SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND model_name = ? AND (user_id IS NULL OR user_id = ?)";
        const params = isNumeric ? [modelId, modelId, user.id] : [modelId, user.id];
        model = await queryOne(sql, params);
    } else {
        model = await queryOne("SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND COALESCE(is_default, 0) != 0 AND user_id IS NULL");
    }
    if (!model) return null;
    _decryptApiKey(model);
    if (model.user_id === user.id) return model;
    if (!model.user_id && model.allowed_units) {
        const units = model.allowed_units.split(',').map(u => u.trim()).filter(Boolean);
        const userUnit = (user.unit || '').trim();
        if (!userUnit || !units.includes(userUnit)) return null;
    }
    return model;
}

const getAccessibleModel = getAccessibleModelAsync;

// ──────────────────────────────────────────────────────────────────────────
// getUserRunnableModels — PostgreSQL 异步
// ──────────────────────────────────────────────────────────────────────────

async function getUserRunnableModelsAsync(user) {
    if (!user?.id) return [];
    const rows = await query(`
        SELECT *
        FROM models
        WHERE COALESCE(status, 'active') = 'active'
          AND (user_id IS NULL OR user_id = ?)
        ORDER BY is_default DESC, id ASC
    `, [user.id]);

    return rows.filter(model => {
        if (model.user_id === user.id) return true;
        if (model.user_id) return false;
        if (!model.allowed_units) return true;
        const units = model.allowed_units.split(',').map(unit => unit.trim()).filter(Boolean);
        const userUnit = (user.unit || '').trim();
        return Boolean(userUnit && units.includes(userUnit));
    });
}

const getUserRunnableModels = getUserRunnableModelsAsync;

// 应用内未显式选模型时，沿用用户默认模型，再找系统默认和其余已授权模型。
async function resolveAccessibleAnswerModelAsync(modelId, user, { getModel = getAccessibleModelAsync, listModels = getUserRunnableModelsAsync } = {}) {
    if (modelId) return await getModel(modelId, user);
    for (const preferredId of [user?.default_model_id, null]) {
        const model = await getModel(preferredId, user);
        if (model) return model;
    }
    const available = await listModels(user);
    return available.length ? await getModel(available[0].id, user) : null;
}

// ──────────────────────────────────────────────────────────────────────────
// getRunnableModelForUser — PostgreSQL 异步
// ──────────────────────────────────────────────────────────────────────────

async function getRunnableModelForUserAsync(modelId, user) {
    if (!modelId || !user?.id) return null;
    const isNumeric = /^\d+$/.test(String(modelId));
    const sql = isNumeric
        ? `SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND (id = ? OR model_name = ?) AND (user_id IS NULL OR user_id = ?)`
        : `SELECT * FROM models WHERE COALESCE(status, 'active') = 'active' AND model_name = ? AND (user_id IS NULL OR user_id = ?)`;
    const params = isNumeric ? [modelId, modelId, user.id] : [modelId, user.id];
    const model = await queryOne(sql, params);
    if (!model) return null;
    if (model.user_id && model.user_id !== user.id) return null;
    if (!model.user_id && model.allowed_units) {
        const units = model.allowed_units.split(',').map(unit => unit.trim()).filter(Boolean);
        const userUnit = (user.unit || '').trim();
        if (!userUnit || !units.includes(userUnit)) return null;
    }
    return _decryptApiKey(model);
}

const getRunnableModelForUser = getRunnableModelForUserAsync;

// ──────────────────────────────────────────────────────────────────────────
// getModelDailyUsage — PostgreSQL 异步
// ──────────────────────────────────────────────────────────────────────────

async function getModelDailyUsageAsync(userId, modelId) {
    const todayPrefix = getBeijingTimestamp().slice(0, 10);
    const msgRow = await queryOne(`
        SELECT COALESCE(SUM(token_count), 0) AS tokens
        FROM messages
        WHERE user_id = ? AND model_id = ? AND deleted_at IS NULL
          AND (created_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date
    `, [userId, modelId]);
    const evtRow = await queryOne(`
        SELECT COALESCE(SUM(token_count), 0) AS tokens
        FROM model_usage_events
        WHERE user_id = ? AND model_id = ?
          AND (created_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date
    `, [userId, modelId]);
    const messageTokens = Number(msgRow?.tokens || 0);
    const eventTokens = Number(evtRow?.tokens || 0);
    return messageTokens + eventTokens + getPendingModelUsageTotal(userId, modelId, todayPrefix);
}

const getModelDailyUsage = getModelDailyUsageAsync;

// ──────────────────────────────────────────────────────────────────────────
// recordModelTokenUsage — 走写队列
// ──────────────────────────────────────────────────────────────────────────

function recordModelTokenUsage(userId, modelId, tokenCount, source = 'api', inputTokens = 0, outputTokens = 0, cache = {}) {
    const uid = typeof userId === 'number' ? userId : Number.parseInt(userId, 10);
    const mid = typeof modelId === 'number' ? modelId : Number.parseInt(modelId, 10);
    if (!uid || Number.isNaN(uid) || !mid || Number.isNaN(mid)) return;

    const usage = normalizeTokenUsage({ inputTokens, outputTokens, totalTokens: tokenCount });
    if (usage.totalTokens <= 0) return;
    enqueueModelUsageEvent({
        userId: uid,
        modelId: mid,
        source: String(source || 'api').slice(0, 40),
        tokenCount: usage.totalTokens,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: Math.max(0, Number(cache.cacheReadTokens ?? cache.cache_read_tokens ?? 0) || 0),
        cacheCreationTokens: Math.max(0, Number(cache.cacheCreationTokens ?? cache.cache_creation_tokens ?? 0) || 0),
        cacheObserved: cache.cacheObserved === true || cache.cache_observed === true,
        createdAt: getBeijingTimestamp()
    });
}

function normalizePromptCacheDays(value) {
    return Math.max(1, Math.min(Number.parseInt(value, 10) || 30, 90));
}

function serializePromptCacheMetric(row = {}) {
    const totalCalls = Number(row.total_calls || 0);
    const observedCalls = Number(row.observed_calls || 0);
    return {
        source: String(row.source || ''),
        modelId: Number(row.model_id || 0) || null,
        modelName: String(row.model_name || row.model_id || '未知模型'),
        totalCalls,
        observedCalls,
        observationRate: totalCalls > 0 ? observedCalls / totalCalls : null,
        cacheReadTokens: Number(row.cache_read_tokens || 0),
        cacheCreationTokens: Number(row.cache_creation_tokens || 0),
        lastObservedAt: row.last_observed_at || null
    };
}

/**
 * 返回当前用户的提供方 Prompt Cache 原始观测，不把“未返回该字段”误判为未命中。
 * 用量事件目前按用户而非租户写入，因而此接口刻意只返回调用者自身的数据；租户
 * 汇总必须等待事件携带可验证 tenant_id 后再开放，不能以用户名或模型归属猜测。
 */
async function getPromptCacheTelemetry(user, options = {}) {
    if (!user?.id) return { days: normalizePromptCacheDays(options.days), scope: 'user', totalCalls: 0, observedCalls: 0, observationRate: null, cacheReadTokens: 0, cacheCreationTokens: 0, lastObservedAt: null, byModel: [] };
    const days = normalizePromptCacheDays(options.days);
    const cutoff = getBeijingTimestamp(new Date(Date.now() - days * 86400000));
    const [summary, rows] = await Promise.all([
        queryOne(`
            SELECT COUNT(*) AS total_calls,
                COUNT(*) FILTER (WHERE cache_observed = TRUE) AS observed_calls,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                MAX(created_at) FILTER (WHERE cache_observed = TRUE) AS last_observed_at
            FROM model_usage_events
            WHERE user_id = ? AND created_at >= ?
        `, [user.id, cutoff]),
        query(`
            SELECT e.source, e.model_id, COALESCE(m.name, m.model_name, '') AS model_name,
                COUNT(*) AS total_calls,
                COUNT(*) FILTER (WHERE e.cache_observed = TRUE) AS observed_calls,
                COALESCE(SUM(e.cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(e.cache_creation_tokens), 0) AS cache_creation_tokens,
                MAX(e.created_at) FILTER (WHERE e.cache_observed = TRUE) AS last_observed_at
            FROM model_usage_events e
            LEFT JOIN models m ON m.id = e.model_id
            WHERE e.user_id = ? AND e.created_at >= ?
            GROUP BY e.source, e.model_id, m.name, m.model_name
            ORDER BY last_observed_at DESC NULLS LAST, total_calls DESC, e.source ASC
            LIMIT 30
        `, [user.id, cutoff])
    ]);
    const metric = serializePromptCacheMetric(summary);
    return {
        days,
        scope: 'user',
        totalCalls: metric.totalCalls,
        observedCalls: metric.observedCalls,
        observationRate: metric.observationRate,
        cacheReadTokens: metric.cacheReadTokens,
        cacheCreationTokens: metric.cacheCreationTokens,
        lastObservedAt: metric.lastObservedAt,
        byModel: rows.map(serializePromptCacheMetric)
    };
}

// ──────────────────────────────────────────────────────────────────────────
// getOrCreateEmbeddingUsageModel — PostgreSQL 异步
// ──────────────────────────────────────────────────────────────────────────

async function getOrCreateEmbeddingUsageModelAsync({ userId = null, url = '', model = '' } = {}) {
    const ownerId = userId ? Number.parseInt(userId, 10) || null : null;
    const safeUrl = String(url || '').trim() || 'embedding://未配置';
    const safeModel = String(model || '').trim() || 'embedding';
    const existing = ownerId
        ? await queryOne("SELECT id FROM models WHERE status = 'usage_only' AND user_id = ? AND url = ? AND model_name = ?", [ownerId, safeUrl, safeModel])
        : await queryOne("SELECT id FROM models WHERE status = 'usage_only' AND user_id IS NULL AND url = ? AND model_name = ?", [safeUrl, safeModel]);
    if (existing) return existing.id;

    const row = await queryOne(`
        INSERT INTO models (user_id, name, url, api_key, model_name, status, created_at)
        VALUES (?, ?, ?, '', ?, 'usage_only', now() AT TIME ZONE 'Asia/Shanghai')
        RETURNING id
    `, [ownerId, `向量模型: ${safeModel}`, safeUrl, safeModel]);
    return row?.id;
}

const getOrCreateEmbeddingUsageModel = getOrCreateEmbeddingUsageModelAsync;

function migrateModelSecrets() {
    // PG 模式下密钥迁移由独立脚本完成
}

// ──────────────────────────────────────────────────────────────────────────
// getUserAccessibleModels — PostgreSQL 异步
// ──────────────────────────────────────────────────────────────────────────

async function getUserAccessibleModelsAsync(user) {
    const models = await query("SELECT * FROM models WHERE status = 'active' AND (user_id IS NULL OR user_id = ?)", [user.id]);

    return models.filter(m => {
        if (m.user_id === user.id) return true;
        if (!m.user_id && m.allowed_units) {
            const units = m.allowed_units.split(',').map(u => u.trim()).filter(Boolean);
            const userUnit = (user.unit || '').trim();
            if (!userUnit || !units.includes(userUnit)) return false;
        }
        return true;
    });
}

const getUserAccessibleModels = getUserAccessibleModelsAsync;

module.exports = {
    modelListFields,
    normalizeTags,
    normalizeBooleanFlag,
    normalizeToolCallMode,
    normalizeModelTokenLimit,
    validateModelTokenSettings,
    MAX_MODEL_TOKEN_LIMIT,
    normalizePriceCurrency,
    normalizePriceValue,
    modelSupportsVision,
    modelSupportsReasoning,
    shouldDisableChatThinking,
    isChatThinkingEnabled,
    buildThinkingControlPayload,
    contentContainsVisionInput,
    messagesContainVisionInput,
    getAccessibleModel,
    getRunnableModelForUser,
    getUserRunnableModels,
    getModelDailyUsage,
    getOrCreateEmbeddingUsageModel,
    getUserAccessibleModels,
    getAccessibleModelAsync,
    resolveAccessibleAnswerModelAsync,
    getRunnableModelForUserAsync,
    getUserRunnableModelsAsync,
    getModelDailyUsageAsync,
    getOrCreateEmbeddingUsageModelAsync,
    getUserAccessibleModelsAsync,
    getPromptCacheTelemetry,
    recordModelTokenUsage,

    migrateModelSecrets
};
