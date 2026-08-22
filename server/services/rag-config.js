const { getAppSettingValue } = require('./app-settings');
const { decryptSecret, encryptSecret } = require('../security');
const { getRagLimits } = require('./resource-limits');
const {
    getUserSettingValue,
    getUserSettingValueAsync
} = require('./user-settings');

const RAG_CONFIG_KEYS = {
    scoreThreshold: 'rag_score_threshold',
    topK: 'rag_top_k',
    candidateLimit: 'rag_candidate_limit',
    chunkSize: 'rag_chunk_size',
    chunkOverlap: 'rag_chunk_overlap',
    embeddingMode: 'rag_embedding_mode',
    embeddingApiUrl: 'rag_embedding_api_url',
    embeddingApiKey: 'rag_embedding_api_key',
    embeddingModel: 'rag_embedding_model'
};

const EMBEDDING_MODES = {
    http: 'http'
};

function clampNumber(value, fallback, min, max) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function getSettingValue(key) {
    return getAppSettingValue(key);
}

function normalizeEmbeddingMode(_value) {
    return EMBEDDING_MODES.http;
}

function getEmbeddingConfig(userId = null) {
    const userMode = getUserSettingValue(userId, RAG_CONFIG_KEYS.embeddingMode);
    const userUrl = getUserSettingValue(userId, RAG_CONFIG_KEYS.embeddingApiUrl);
    const userKey = getUserSettingValue(userId, RAG_CONFIG_KEYS.embeddingApiKey);
    const userModel = getUserSettingValue(userId, RAG_CONFIG_KEYS.embeddingModel);
    const storedMode = getSettingValue(RAG_CONFIG_KEYS.embeddingMode);
    const storedUrl = getSettingValue(RAG_CONFIG_KEYS.embeddingApiUrl);
    const storedKey = getSettingValue(RAG_CONFIG_KEYS.embeddingApiKey);
    const storedModel = getSettingValue(RAG_CONFIG_KEYS.embeddingModel);
    const mode = normalizeEmbeddingMode(userMode || storedMode || process.env.EMBEDDING_MODE || 'http');
    const http = {
        url: userUrl || storedUrl || process.env.EMBEDDING_API_URL || '',
        apiKey: '',
        model: userModel || storedModel || process.env.EMBEDDING_MODEL || 'nomic-embed-text'
    };
    let apiKey = '';
    try {
        apiKey = userKey ? decryptSecret(userKey)
            : storedKey ? decryptSecret(storedKey)
            : (process.env.EMBEDDING_API_KEY || '');
    } catch (_) {
        apiKey = '';
    }
    http.apiKey = apiKey;
    return {
        mode,
        http,
        // 迁移期间为旧调用方和测试保留向后兼容别名。
        cloud: http,
        source: {
            mode: userMode ? 'user' : (storedMode ? 'settings' : 'env'),
            url: userUrl ? 'user' : (storedUrl ? 'settings' : (process.env.EMBEDDING_API_URL ? 'env' : 'empty')),
            apiKey: userKey ? 'user' : (storedKey ? 'settings' : (process.env.EMBEDDING_API_KEY ? 'env' : 'empty')),
            model: userModel ? 'user' : (storedModel ? 'settings' : (process.env.EMBEDDING_MODEL ? 'env' : 'default'))
        }
    };
}

function getPublicEmbeddingConfig(userId = null) {
    const config = getEmbeddingConfig(userId);
    return {
        mode: config.mode,
        apiUrl: config.http.url,
        model: config.http.model,
        hasApiKey: Boolean(config.http.apiKey),
        isPersonal: config.source.url === 'user' || config.source.model === 'user' || config.source.apiKey === 'user',
        source: config.source
    };
}

function getRagConfig(overrides = {}, userId = null) {
    const ragLimits = getRagLimits();
    const defaultScoreThreshold = clampNumber(process.env.RAG_SCORE_THRESHOLD, 0.4, 0, 1);
    const defaultTopK = clampInteger(process.env.RAG_TOP_K, 3, 1, ragLimits.topKMax || 10);
    const defaultCandidateLimit = clampInteger(process.env.RAG_CANDIDATE_LIMIT, 300, 20, ragLimits.candidateLimitMax || 1000);
    const defaultChunkSize = clampInteger(process.env.RAG_CHUNK_SIZE, 500, 200, ragLimits.chunkSizeMax || 2000);
    const defaultChunkOverlap = clampInteger(process.env.RAG_CHUNK_OVERLAP, 100, 0, Math.floor(defaultChunkSize / 2));

    const scoreThreshold = clampNumber(
        overrides.scoreThreshold ?? getUserSettingValue(userId, RAG_CONFIG_KEYS.scoreThreshold) ?? getSettingValue(RAG_CONFIG_KEYS.scoreThreshold),
        defaultScoreThreshold,
        0,
        1
    );
    const topK = clampInteger(
        overrides.topK ?? getUserSettingValue(userId, RAG_CONFIG_KEYS.topK) ?? getSettingValue(RAG_CONFIG_KEYS.topK),
        defaultTopK,
        1,
        ragLimits.topKMax || 10
    );
    const candidateLimit = clampInteger(
        overrides.candidateLimit ?? getUserSettingValue(userId, RAG_CONFIG_KEYS.candidateLimit) ?? getSettingValue(RAG_CONFIG_KEYS.candidateLimit),
        defaultCandidateLimit,
        Math.max(topK, 20),
        ragLimits.candidateLimitMax || 1000
    );
    const chunkSize = clampInteger(
        overrides.chunkSize ?? getUserSettingValue(userId, RAG_CONFIG_KEYS.chunkSize) ?? getSettingValue(RAG_CONFIG_KEYS.chunkSize),
        defaultChunkSize,
        200,
        ragLimits.chunkSizeMax || 2000
    );
    const chunkOverlap = clampInteger(
        overrides.chunkOverlap ?? getUserSettingValue(userId, RAG_CONFIG_KEYS.chunkOverlap) ?? getSettingValue(RAG_CONFIG_KEYS.chunkOverlap),
        defaultChunkOverlap,
        0,
        Math.floor(chunkSize / 2)
    );

    return {
        scoreThreshold,
        topK,
        candidateLimit,
        chunkSize,
        chunkOverlap
    };
}

// 混合检索（RRF 融合 + MMR 去重）参数。env 优先，否则用默认值。
// - rrfK：RRF 平滑常数（越大越弱化高名次的优势）。
// - wDense / wFts：稠密向量通道与 FTS(BM25) 词项通道在融合中的权重。
// - mmrLambda：MMR 相关性 vs 多样性的平衡（1=纯相关，0=纯多样）。
// - ftsRankFloor：FTS 命中前列即视为精确匹配、软门控放行的名次阈值。
function getHybridRetrievalConfig() {
    return {
        rrfK: clampInteger(process.env.RAG_RRF_K, 60, 1, 1000),
        wDense: clampNumber(process.env.RAG_RRF_W_DENSE, 1.0, 0, 10),
        wFts: clampNumber(process.env.RAG_RRF_W_FTS, 0.6, 0, 10),
        mmrLambda: clampNumber(process.env.RAG_MMR_LAMBDA, 0.7, 0, 1),
        ftsRankFloor: clampInteger(process.env.RAG_FTS_RANK_FLOOR, 5, 0, 100)
    };
}

// 按文档类型解析切片字符数：法规放大以容纳整条，prose 适度放大，
// 表格/markdown 沿用基础 chunkSize。结果受运行时 chunkSizeMax 上限约束。
function getChunkSizeForDocType(docType, baseChunkSize, userId = null) {
    const ragLimits = getRagLimits();
    const max = ragLimits.chunkSizeMax || 4000;
    if (docType === 'legal') {
        return clampInteger(
            getUserSettingValue(userId, RAG_CONFIG_KEYS.chunkSize) ? baseChunkSize : process.env.RAG_CHUNK_SIZE_LEGAL,
            Math.min(Math.max(baseChunkSize, 1100), max),
            200,
            max
        );
    }
    if (docType === 'prose') {
        return clampInteger(
            getUserSettingValue(userId, RAG_CONFIG_KEYS.chunkSize) ? baseChunkSize : process.env.RAG_CHUNK_SIZE_PROSE,
            Math.min(Math.max(baseChunkSize, 800), max),
            200,
            max
        );
    }
    return clampInteger(baseChunkSize, baseChunkSize, 200, max);
}

function toRagSettingValue(key, value) {
    const ragLimits = getRagLimits();
    if (key === RAG_CONFIG_KEYS.scoreThreshold) {
        return String(clampNumber(value, 0.4, 0, 1));
    }
    if (key === RAG_CONFIG_KEYS.topK) {
        return String(clampInteger(value, 3, 1, ragLimits.topKMax || 10));
    }
    if (key === RAG_CONFIG_KEYS.candidateLimit) {
        return String(clampInteger(value, 300, 20, ragLimits.candidateLimitMax || 1000));
    }
    if (key === RAG_CONFIG_KEYS.chunkSize) {
        return String(clampInteger(value, 500, 200, ragLimits.chunkSizeMax || 2000));
    }
    if (key === RAG_CONFIG_KEYS.chunkOverlap) {
        return String(clampInteger(value, 100, 0, Math.max(1000, Math.floor((ragLimits.chunkSizeMax || 2000) / 2))));
    }
    if (key === RAG_CONFIG_KEYS.embeddingMode) {
        return normalizeEmbeddingMode(value);
    }
    if (key === RAG_CONFIG_KEYS.embeddingApiUrl) {
        return String(value || '').trim();
    }
    if (key === RAG_CONFIG_KEYS.embeddingModel) {
        return String(value || '').trim() || 'nomic-embed-text';
    }
    if (key === RAG_CONFIG_KEYS.embeddingApiKey) {
        return encryptSecret(String(value || '').trim());
    }
    return String(value ?? '');
}

module.exports = {
    EMBEDDING_MODES,
    RAG_CONFIG_KEYS,
    getEmbeddingConfig,
    getPublicEmbeddingConfig,
    getRagConfig,
    getHybridRetrievalConfig,
    getChunkSizeForDocType,
    getUserSettingValue,
    getUserSettingValueAsync,
    normalizeEmbeddingMode,
    toRagSettingValue
};
