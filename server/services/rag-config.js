const { db } = require('../db');
const { decryptSecret, encryptSecret } = require('../security');

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
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row?.value;
}

function getUserSettingValue(userId, key) {
    const normalizedUserId = Number.parseInt(userId, 10);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) return undefined;
    const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(normalizedUserId, key);
    return row?.value;
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
        // Backward-compatible alias for older callers/tests while the app migrates.
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

function getRagConfig(overrides = {}) {
    const defaultScoreThreshold = clampNumber(process.env.RAG_SCORE_THRESHOLD, 0.4, 0, 1);
    const defaultTopK = clampInteger(process.env.RAG_TOP_K, 3, 1, 10);
    const defaultCandidateLimit = clampInteger(process.env.RAG_CANDIDATE_LIMIT, 300, 20, 1000);
    const defaultChunkSize = clampInteger(process.env.RAG_CHUNK_SIZE, 500, 200, 2000);
    const defaultChunkOverlap = clampInteger(process.env.RAG_CHUNK_OVERLAP, 100, 0, Math.floor(defaultChunkSize / 2));

    const scoreThreshold = clampNumber(
        overrides.scoreThreshold ?? getSettingValue(RAG_CONFIG_KEYS.scoreThreshold),
        defaultScoreThreshold,
        0,
        1
    );
    const topK = clampInteger(
        overrides.topK ?? getSettingValue(RAG_CONFIG_KEYS.topK),
        defaultTopK,
        1,
        10
    );
    const candidateLimit = clampInteger(
        overrides.candidateLimit ?? getSettingValue(RAG_CONFIG_KEYS.candidateLimit),
        defaultCandidateLimit,
        Math.max(topK, 20),
        1000
    );
    const chunkSize = clampInteger(
        overrides.chunkSize ?? getSettingValue(RAG_CONFIG_KEYS.chunkSize),
        defaultChunkSize,
        200,
        2000
    );
    const chunkOverlap = clampInteger(
        overrides.chunkOverlap ?? getSettingValue(RAG_CONFIG_KEYS.chunkOverlap),
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

function toRagSettingValue(key, value) {
    if (key === RAG_CONFIG_KEYS.scoreThreshold) {
        return String(clampNumber(value, 0.4, 0, 1));
    }
    if (key === RAG_CONFIG_KEYS.topK) {
        return String(clampInteger(value, 3, 1, 10));
    }
    if (key === RAG_CONFIG_KEYS.candidateLimit) {
        return String(clampInteger(value, 300, 20, 1000));
    }
    if (key === RAG_CONFIG_KEYS.chunkSize) {
        return String(clampInteger(value, 500, 200, 2000));
    }
    if (key === RAG_CONFIG_KEYS.chunkOverlap) {
        return String(clampInteger(value, 100, 0, 1000));
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
    getUserSettingValue,
    normalizeEmbeddingMode,
    toRagSettingValue
};
