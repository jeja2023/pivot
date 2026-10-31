const { getAppSettingValue } = require('./app-settings');
const { decryptSecret, encryptSecret } = require('../security');
const { getRagLimits } = require('./resource-limits');
const {
    getUserSettingsAsync,
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
    embeddingModel: 'rag_embedding_model',
    rerankEnabled: 'rag_rerank_enabled',
    rerankApiUrl: 'rag_rerank_api_url',
    rerankApiKey: 'rag_rerank_api_key',
    rerankModel: 'rag_rerank_model',
    rerankProtocol: 'rag_rerank_protocol',
    rerankCandidateLimit: 'rag_rerank_candidate_limit',
    rerankTimeoutMs: 'rag_rerank_timeout_ms'
};

const EMBEDDING_MODES = {
    http: 'http'
};

const RAG_USER_KEYS = [
    RAG_CONFIG_KEYS.scoreThreshold, RAG_CONFIG_KEYS.topK, RAG_CONFIG_KEYS.candidateLimit,
    RAG_CONFIG_KEYS.chunkSize, RAG_CONFIG_KEYS.chunkOverlap, RAG_CONFIG_KEYS.embeddingMode,
    RAG_CONFIG_KEYS.embeddingApiUrl, RAG_CONFIG_KEYS.embeddingApiKey, RAG_CONFIG_KEYS.embeddingModel
];

function userSetting(settings, key) { return settings?.[key]?.value; }
async function loadRagUserSettings(userId) {
    return userId ? getUserSettingsAsync(userId, RAG_USER_KEYS) : null;
}

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

function getEmbeddingConfig(userId = null, { allowUserSettings = true, userSettings = null } = {}) {
    // 个人向量配置适合个人知识库；共享法规库必须由唯一的系统配置生成和检索，
    // 否则不同管理员会把同一批条文写入不兼容的向量空间。
    const useUserSettings = allowUserSettings && Boolean(userId);
    if (useUserSettings && !userSettings) throw new Error('个人向量配置必须异步加载');
    const userMode = useUserSettings ? userSetting(userSettings, RAG_CONFIG_KEYS.embeddingMode) : undefined;
    const userUrl = useUserSettings ? userSetting(userSettings, RAG_CONFIG_KEYS.embeddingApiUrl) : undefined;
    const userKey = useUserSettings ? userSetting(userSettings, RAG_CONFIG_KEYS.embeddingApiKey) : undefined;
    const userModel = useUserSettings ? userSetting(userSettings, RAG_CONFIG_KEYS.embeddingModel) : undefined;
    const storedMode = getSettingValue(RAG_CONFIG_KEYS.embeddingMode);
    const storedUrl = getSettingValue(RAG_CONFIG_KEYS.embeddingApiUrl);
    const storedKey = getSettingValue(RAG_CONFIG_KEYS.embeddingApiKey);
    const storedModel = getSettingValue(RAG_CONFIG_KEYS.embeddingModel);
    const mode = normalizeEmbeddingMode(userMode || storedMode || process.env.EMBEDDING_MODE || 'http');
    const http = {
        url: userUrl || storedUrl || process.env.EMBEDDING_API_URL || '',
        apiKey: '',
        model: userModel || storedModel || process.env.EMBEDDING_MODEL || 'Alibaba-NLP/gte-Qwen2-1.5B-instruct'
    };
    let apiKey = '';
    try {
        apiKey = userKey ? decryptSecret(userKey, 'rag.embedding_api_key')
            : storedKey ? decryptSecret(storedKey, 'rag.embedding_api_key')
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

async function getEmbeddingConfigAsync(userId = null, options = {}) {
    const userSettings = options.allowUserSettings === false ? null : await loadRagUserSettings(userId);
    return getEmbeddingConfig(userId, { ...options, userSettings });
}

function getSystemEmbeddingConfig() {
    return getEmbeddingConfig(null, { allowUserSettings: false });
}

function getEmbeddingProfile(config = {}) {
    const http = config?.http || config?.cloud || {};
    const mode = normalizeEmbeddingMode(config?.mode || EMBEDDING_MODES.http);
    const model = String(http.model || 'embedding').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 120) || 'embedding';
    return `${mode}:${model}`;
}

function publicEmbeddingConfig(config) {
    return {
        mode: config.mode,
        apiUrl: config.http.url,
        model: config.http.model,
        hasApiKey: Boolean(config.http.apiKey),
        isPersonal: config.source.url === 'user' || config.source.model === 'user' || config.source.apiKey === 'user',
        source: config.source
    };
}

function getPublicEmbeddingConfig(userId = null) { return publicEmbeddingConfig(getEmbeddingConfig(userId)); }
async function getPublicEmbeddingConfigAsync(userId = null) {
    return publicEmbeddingConfig(await getEmbeddingConfigAsync(userId));
}

function normalizeBoolean(value, fallback = false) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeRerankProtocol(value) {
    return String(value || '').trim().toLowerCase() === 'llama_cpp' ? 'llama_cpp' : 'tei';
}

function getRerankConfig() {
    const storedKey = getSettingValue(RAG_CONFIG_KEYS.rerankApiKey);
    let apiKey = '';
    try {
        apiKey = storedKey ? decryptSecret(storedKey, 'rag.rerank_api_key') : (process.env.RERANK_API_KEY || '');
    } catch (_) {
        apiKey = '';
    }
    const enabled = normalizeBoolean(
        getSettingValue(RAG_CONFIG_KEYS.rerankEnabled) ?? process.env.RERANK_ENABLED,
        false
    );
    const http = {
        url: String(getSettingValue(RAG_CONFIG_KEYS.rerankApiUrl) || process.env.RERANK_API_URL || '').trim(),
        apiKey,
        model: String(getSettingValue(RAG_CONFIG_KEYS.rerankModel) || process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3').trim(),
        protocol: normalizeRerankProtocol(getSettingValue(RAG_CONFIG_KEYS.rerankProtocol) || process.env.RERANK_PROTOCOL),
        candidateLimit: clampInteger(
            getSettingValue(RAG_CONFIG_KEYS.rerankCandidateLimit) ?? process.env.RERANK_CANDIDATE_LIMIT,
            20,
            1,
            100
        ),
        timeoutMs: clampInteger(
            getSettingValue(RAG_CONFIG_KEYS.rerankTimeoutMs) ?? process.env.RERANK_TIMEOUT_MS,
            5000,
            200,
            30000
        )
    };
    return {
        enabled: enabled && Boolean(http.url),
        configured: Boolean(http.url),
        http
    };
}

function getPublicRerankConfig() {
    const config = getRerankConfig();
    return {
        enabled: config.enabled,
        configured: config.configured,
        apiUrl: config.http.url,
        model: config.http.model,
        protocol: config.http.protocol,
        candidateLimit: config.http.candidateLimit,
        timeoutMs: config.http.timeoutMs,
        hasApiKey: Boolean(config.http.apiKey)
    };
}

function getRerankProfile(config = getRerankConfig()) {
    const http = config?.http || {};
    return [
        config?.enabled ? 'enabled' : 'disabled',
        String(http.model || '').trim().toLowerCase(),
        String(http.protocol || '').trim().toLowerCase(),
        String(http.url || '').trim().toLowerCase(),
        Number(http.candidateLimit || 0),
        Number(http.timeoutMs || 0)
    ].join(':');
}

function getRagConfig(overrides = {}, userId = null, userSettings = null) {
    if (userId && !userSettings) throw new Error('个人检索配置必须异步加载');
    const ragLimits = getRagLimits();
    const defaultScoreThreshold = clampNumber(process.env.RAG_SCORE_THRESHOLD, 0.4, 0, 1);
    const defaultTopK = clampInteger(process.env.RAG_TOP_K, 3, 1, ragLimits.topKMax || 10);
    const defaultCandidateLimit = clampInteger(process.env.RAG_CANDIDATE_LIMIT, 300, 20, ragLimits.candidateLimitMax || 1000);
    const defaultChunkSize = clampInteger(process.env.RAG_CHUNK_SIZE, 500, 200, ragLimits.chunkSizeMax || 2000);
    const defaultChunkOverlap = clampInteger(process.env.RAG_CHUNK_OVERLAP, 100, 0, Math.floor(defaultChunkSize / 2));
    const defaultRerankThreshold = clampNumber(process.env.RAG_RERANK_THRESHOLD, 0.30, 0, 1);
    const defaultCitationConfidenceThreshold = clampNumber(process.env.RAG_CITATION_CONFIDENCE_THRESHOLD, 0.42, 0, 1);

    const scoreThreshold = clampNumber(
        overrides.scoreThreshold ?? userSetting(userSettings, RAG_CONFIG_KEYS.scoreThreshold) ?? getSettingValue(RAG_CONFIG_KEYS.scoreThreshold),
        defaultScoreThreshold,
        0,
        1
    );
    const topK = clampInteger(
        overrides.topK ?? userSetting(userSettings, RAG_CONFIG_KEYS.topK) ?? getSettingValue(RAG_CONFIG_KEYS.topK),
        defaultTopK,
        1,
        ragLimits.topKMax || 10
    );
    const candidateLimit = clampInteger(
        overrides.candidateLimit ?? userSetting(userSettings, RAG_CONFIG_KEYS.candidateLimit) ?? getSettingValue(RAG_CONFIG_KEYS.candidateLimit),
        defaultCandidateLimit,
        Math.max(topK, 20),
        ragLimits.candidateLimitMax || 1000
    );
    const chunkSize = clampInteger(
        overrides.chunkSize ?? userSetting(userSettings, RAG_CONFIG_KEYS.chunkSize) ?? getSettingValue(RAG_CONFIG_KEYS.chunkSize),
        defaultChunkSize,
        200,
        ragLimits.chunkSizeMax || 2000
    );
    const chunkOverlap = clampInteger(
        overrides.chunkOverlap ?? userSetting(userSettings, RAG_CONFIG_KEYS.chunkOverlap) ?? getSettingValue(RAG_CONFIG_KEYS.chunkOverlap),
        defaultChunkOverlap,
        0,
        Math.floor(chunkSize / 2)
    );

    return {
        scoreThreshold,
        topK,
        candidateLimit,
        chunkSize,
        chunkOverlap,
        rerankThreshold: clampNumber(overrides.rerankThreshold ?? defaultRerankThreshold, defaultRerankThreshold, 0, 1),
        citationConfidenceThreshold: clampNumber(overrides.citationConfidenceThreshold ?? defaultCitationConfidenceThreshold, defaultCitationConfidenceThreshold, 0, 1)
    };
}

async function getRagConfigAsync(overrides = {}, userId = null) {
    return getRagConfig(overrides, userId, await loadRagUserSettings(userId));
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
        wGraph: clampNumber(process.env.RAG_RRF_W_GRAPH, 0.8, 0, 10),
        mmrLambda: clampNumber(process.env.RAG_MMR_LAMBDA, 0.7, 0, 1),
        ftsRankFloor: clampInteger(process.env.RAG_FTS_RANK_FLOOR, 5, 0, 100)
    };
}

// 按文档类型解析切片字符数：法规放大以容纳整条，prose 适度放大，
// 表格/markdown 沿用基础 chunkSize。结果受运行时 chunkSizeMax 上限约束。
function getChunkSizeForDocType(docType, baseChunkSize, userId = null, userSettings = null) {
    if (userId && !userSettings) throw new Error('个人切片配置必须异步加载');
    const ragLimits = getRagLimits();
    const max = ragLimits.chunkSizeMax || 4000;
    if (docType === 'legal') {
        return clampInteger(
            userSetting(userSettings, RAG_CONFIG_KEYS.chunkSize) ? baseChunkSize : process.env.RAG_CHUNK_SIZE_LEGAL,
            Math.min(Math.max(baseChunkSize, 1100), max),
            200,
            max
        );
    }
    if (docType === 'prose') {
        return clampInteger(
            userSetting(userSettings, RAG_CONFIG_KEYS.chunkSize) ? baseChunkSize : process.env.RAG_CHUNK_SIZE_PROSE,
            Math.min(Math.max(baseChunkSize, 800), max),
            200,
            max
        );
    }
    return clampInteger(baseChunkSize, baseChunkSize, 200, max);
}

async function getChunkSizeForDocTypeAsync(docType, baseChunkSize, userId = null) {
    return getChunkSizeForDocType(docType, baseChunkSize, userId, await loadRagUserSettings(userId));
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
        return String(value || '').trim() || 'Alibaba-NLP/gte-Qwen2-1.5B-instruct';
    }
    if (key === RAG_CONFIG_KEYS.embeddingApiKey) {
        return encryptSecret(String(value || '').trim(), 'rag.embedding_api_key');
    }
    if (key === RAG_CONFIG_KEYS.rerankEnabled) {
        return normalizeBoolean(value) ? 'true' : 'false';
    }
    if (key === RAG_CONFIG_KEYS.rerankApiUrl) {
        return String(value || '').trim();
    }
    if (key === RAG_CONFIG_KEYS.rerankModel) {
        return String(value || '').trim() || 'BAAI/bge-reranker-v2-m3';
    }
    if (key === RAG_CONFIG_KEYS.rerankProtocol) {
        return normalizeRerankProtocol(value);
    }
    if (key === RAG_CONFIG_KEYS.rerankCandidateLimit) {
        return String(clampInteger(value, 20, 1, 100));
    }
    if (key === RAG_CONFIG_KEYS.rerankTimeoutMs) {
        return String(clampInteger(value, 5000, 200, 30000));
    }
    if (key === RAG_CONFIG_KEYS.rerankApiKey) {
        return encryptSecret(String(value || '').trim(), 'rag.rerank_api_key');
    }
    return String(value ?? '');
}

module.exports = {
    EMBEDDING_MODES,
    RAG_CONFIG_KEYS,
    getEmbeddingConfig,
    getEmbeddingConfigAsync,
    getSystemEmbeddingConfig,
    getEmbeddingProfile,
    getPublicEmbeddingConfig,
    getPublicEmbeddingConfigAsync,
    getPublicRerankConfig,
    getRagConfig,
    getRagConfigAsync,
    getRerankConfig,
    getRerankProfile,
    getHybridRetrievalConfig,
    getChunkSizeForDocType,
    getChunkSizeForDocTypeAsync,
    getUserSettingValueAsync,
    normalizeEmbeddingMode,
    toRagSettingValue
};
