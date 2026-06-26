const axios = require('axios');
const { EMBEDDING_MODES, normalizeEmbeddingMode, getEmbeddingConfig } = require('../rag-config');
const { assertSafeOutboundUrl, createSafeHttpAgentsForUser } = require('../../security');
const { getOrCreateEmbeddingUsageModel, recordModelTokenUsage } = require('../models');
const { estimateEmbeddingTokens } = require('../token-accounting');
const { estimateTokens } = require('../../llm');
const { logger } = require('../../logger');

const DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RAG_INDEX_EMBEDDING_TIMEOUT_MS = 120000;
const MAX_EMBEDDING_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const KEYWORD_FALLBACK_MIN_SCORE = 0.12;

function normalizeTimeoutMs(value, fallback, min = 1000, max = MAX_EMBEDDING_REQUEST_TIMEOUT_MS) {
    const parsed = Number.parseInt(value, 10);
    const safeFallback = Math.min(Math.max(Number.parseInt(fallback, 10) || min, min), max);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return safeFallback;
    return Math.min(Math.max(parsed, min), max);
}

function getEmbeddingRequestTimeoutMs(timeoutMs = null) {
    return normalizeTimeoutMs(
        timeoutMs ?? process.env.EMBEDDING_REQUEST_TIMEOUT_MS,
        DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS
    );
}

function getRagIndexEmbeddingTimeoutMs(timeoutMs = null) {
    return normalizeTimeoutMs(
        timeoutMs ?? process.env.RAG_INDEX_EMBEDDING_TIMEOUT_MS ?? process.env.EMBEDDING_REQUEST_TIMEOUT_MS,
        DEFAULT_RAG_INDEX_EMBEDDING_TIMEOUT_MS
    );
}

function formatDurationMs(ms) {
    if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} 秒`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)} 秒`;
    return `${ms}ms`;
}

function wrapEmbeddingRequestError(error, timeoutMs) {
    const message = String(error?.message || '');
    const code = String(error?.code || '');
    if (code === 'ECONNABORTED' || /timeout|timed\s*out/i.test(message)) {
        const wrapped = new Error(`向量服务请求超时（已等待 ${formatDurationMs(timeoutMs)}）。请检查检索配置中的向量服务地址、模型名称和服务负载后重试。`);
        wrapped.code = 'EMBEDDING_TIMEOUT';
        wrapped.cause = error;
        return wrapped;
    }
    return error;
}

function normalizeVectorValues(vector) {
    if (!Array.isArray(vector) || vector.length === 0) {
        return null;
    }
    const normalized = vector.map(Number);
    if (normalized.some(value => !Number.isFinite(value))) {
        return null;
    }
    return normalized;
}

function normalizeEmbeddingVectors(data) {
    if (Array.isArray(data?.data)) {
        const vectors = data.data
            .slice()
            .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
            .map(item => normalizeVectorValues(item?.embedding))
            .filter(Boolean);
        if (vectors.length > 0) return vectors;
    }

    if (Array.isArray(data?.embeddings)) {
        const embeddings = data.embeddings;
        const vectors = Array.isArray(embeddings[0])
            ? embeddings.map(normalizeVectorValues).filter(Boolean)
            : [normalizeVectorValues(embeddings)].filter(Boolean);
        if (vectors.length > 0) return vectors;
    }

    const vector = data?.data?.[0]?.embedding
        || data?.embedding
        || data?.response?.embedding;
    const normalized = normalizeVectorValues(vector);
    if (normalized) return [normalized];

    throw new Error('Embedding 服务响应中未找到有效向量');
}

function normalizeEmbeddingVector(data) {
    const vectors = normalizeEmbeddingVectors(data);
    if (!vectors[0]) {
        throw new Error('Embedding 服务响应中未找到有效向量');
    }
    return vectors[0];
}

function resolveEmbeddingUrl(url) {
    const rawUrl = String(url || '').trim();
    const lowerUrl = rawUrl.toLowerCase();
    if (!rawUrl) return '';
    if (
        lowerUrl.endsWith('/embeddings') ||
        lowerUrl.endsWith('/api/embed') ||
        lowerUrl.endsWith('/api/embeddings')
    ) {
        return rawUrl;
    }
    if (lowerUrl.endsWith('/v1')) {
        return `${rawUrl.replace(/\/+$/, '')}/embeddings`;
    }
    return `${rawUrl.replace(/\/+$/, '')}/v1/embeddings`;
}

function buildEmbeddingPayload(text, model, mode, url) {
    const endpoint = String(url || '').toLowerCase();
    if (endpoint.includes('/api/embeddings')) {
        return { model, prompt: text };
    }
    if (endpoint.includes('/api/embed')) {
        return { model, input: text };
    }
    return { input: text, model };
}

function usesUserEmbeddingConfig(config = {}) {
    const source = config.source || {};
    return source.url === 'user' || source.model === 'user' || source.apiKey === 'user';
}

function getEmbeddingRuntimeGuardUser(config = null, user = null) {
    if (config && !usesUserEmbeddingConfig(config)) return { role: 'admin' };
    return user || {};
}

async function requestEmbedding(text, httpConfig, options = {}) {
    const { url, apiKey, model } = httpConfig;
    if (!url) {
        throw new Error('未配置 Embedding HTTP 服务地址');
    }
    const targetUrl = resolveEmbeddingUrl(url);
    const timeoutMs = getEmbeddingRequestTimeoutMs(options.timeoutMs);
    try {
        await assertSafeOutboundUrl(targetUrl, options.user || {});
        const agents = createSafeHttpAgentsForUser(options.user || {});
        const res = await axios.post(targetUrl, buildEmbeddingPayload(text, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
            headers: {
                Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: timeoutMs,
            proxy: false,
            ...agents
        });
        return normalizeEmbeddingVector(res.data);
    } catch (e) {
        throw wrapEmbeddingRequestError(e, timeoutMs);
    }
}

async function requestEmbeddings(inputs, httpConfig, options = {}) {
    const safeInputs = Array.isArray(inputs) ? inputs : [inputs];
    const { url, apiKey } = httpConfig;
    const model = options.model || httpConfig.model;
    if (!url) {
        throw new Error('未配置 Embedding HTTP 服务地址');
    }
    const targetUrl = resolveEmbeddingUrl(url);
    const endpoint = targetUrl.toLowerCase();
    const timeoutMs = getEmbeddingRequestTimeoutMs(options.timeoutMs);
    const requestOne = async (input) => {
        try {
            await assertSafeOutboundUrl(targetUrl, options.user || {});
            const agents = createSafeHttpAgentsForUser(options.user || {});
            const res = await axios.post(targetUrl, buildEmbeddingPayload(input, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
                headers: {
                    Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                    'Content-Type': 'application/json'
                },
                timeout: timeoutMs,
                proxy: false,
                ...agents
            });
            return normalizeEmbeddingVector(res.data);
        } catch (e) {
            throw wrapEmbeddingRequestError(e, timeoutMs);
        }
    };

    if (safeInputs.length === 1 || endpoint.includes('/api/embeddings')) {
        const vectors = [];
        for (const input of safeInputs) {
            vectors.push(await requestOne(input));
        }
        return vectors;
    }

    let res;
    try {
        await assertSafeOutboundUrl(targetUrl, options.user || {});
        const agents = createSafeHttpAgentsForUser(options.user || {});
        res = await axios.post(targetUrl, buildEmbeddingPayload(safeInputs, model || 'nomic-embed-text', EMBEDDING_MODES.http, targetUrl), {
            headers: {
                Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
                'Content-Type': 'application/json'
            },
            timeout: timeoutMs,
            proxy: false,
            ...agents
        });
    } catch (e) {
        throw wrapEmbeddingRequestError(e, timeoutMs);
    }
    const vectors = normalizeEmbeddingVectors(res.data);
    if (vectors.length !== safeInputs.length) {
        throw new Error(`Embedding 服务返回向量数量不匹配: expected ${safeInputs.length}, got ${vectors.length}`);
    }
    return vectors;
}

function recordEmbeddingUsage({ userId, config, httpConfig, inputs, source }) {
    if (!userId) return;
    try {
        const model = String(httpConfig?.model || config?.http?.model || '').trim() || 'embedding';
        const url = String(httpConfig?.url || config?.http?.url || '').trim();
        const usageModelId = getOrCreateEmbeddingUsageModel({
            userId: config?.source?.url === 'user' || config?.source?.model === 'user' || config?.source?.apiKey === 'user' ? userId : null,
            url,
            model
        });
        const inputTokens = estimateEmbeddingTokens(inputs, estimateTokens);
        recordModelTokenUsage(userId, usageModelId, inputTokens, source, inputTokens, 0);
    } catch (e) {
        logger.warn({ err: e.message }, '向量模型用量统计写入失败');
    }
}

async function generateEmbedding(text, mode = null, embeddingConfig = null, userId = null, options = {}) {
    const config = getEmbeddingConfig(userId);
    const targetMode = normalizeEmbeddingMode(mode || config.mode);

    if (targetMode === EMBEDDING_MODES.http) {
        const targetHttpConfig = embeddingConfig || config.http || config.cloud;
        const vector = await requestEmbedding(text, targetHttpConfig, {
            timeoutMs: options.timeoutMs,
            user: getEmbeddingRuntimeGuardUser(config, options.user)
        });
        recordEmbeddingUsage({
            userId,
            config,
            httpConfig: targetHttpConfig,
            inputs: [text],
            source: options.source || 'rag_embedding'
        });
        return vector;
    }

    throw new Error(`不支持的 Embedding 模式: ${targetMode}`);
}

async function generateEmbeddings(inputs, mode = null, embeddingConfig = null, userId = null, options = {}) {
    const safeInputs = Array.isArray(inputs) ? inputs : [inputs];
    const config = getEmbeddingConfig(userId);
    const targetMode = normalizeEmbeddingMode(mode || config.mode);

    if (targetMode === EMBEDDING_MODES.http) {
        const targetHttpConfig = embeddingConfig || config.http || config.cloud;
        const vectors = await requestEmbeddings(safeInputs, targetHttpConfig, {
            timeoutMs: options.timeoutMs,
            user: getEmbeddingRuntimeGuardUser(config, options.user)
        });
        recordEmbeddingUsage({
            userId,
            config,
            httpConfig: targetHttpConfig,
            inputs: safeInputs,
            source: options.source || 'rag_embedding'
        });
        return vectors;
    }

    throw new Error(`不支持的 Embedding 模式: ${targetMode}`);
}
function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i += 1) {
        if (!Number.isFinite(vecA[i]) || !Number.isFinite(vecB[i])) return 0;
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}


module.exports = {
    DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS,
    DEFAULT_RAG_INDEX_EMBEDDING_TIMEOUT_MS,
    MAX_EMBEDDING_REQUEST_TIMEOUT_MS,
    KEYWORD_FALLBACK_MIN_SCORE,
    normalizeTimeoutMs,
    getEmbeddingRequestTimeoutMs,
    getRagIndexEmbeddingTimeoutMs,
    formatDurationMs,
    wrapEmbeddingRequestError,
    normalizeVectorValues,
    normalizeEmbeddingVectors,
    normalizeEmbeddingVector,
    resolveEmbeddingUrl,
    buildEmbeddingPayload,
    usesUserEmbeddingConfig,
    getEmbeddingRuntimeGuardUser,
    requestEmbedding,
    requestEmbeddings,
    generateEmbedding,
    generateEmbeddings,
    cosineSimilarity,
    recordEmbeddingUsage
};
