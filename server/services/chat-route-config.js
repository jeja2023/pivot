const { readTypedEnv } = require('../config/env-registry');

function getChatAutoRouteConfig(env = process.env) {
    const ragThreshold = readTypedEnv('PIVOT_CHAT_ROUTE_RAG_THRESHOLD', env);
    const ragGrayThreshold = Math.min(
        ragThreshold,
        readTypedEnv('PIVOT_CHAT_ROUTE_RAG_GRAY_THRESHOLD', env)
    );
    return {
        enabled: readTypedEnv('PIVOT_CHAT_AUTO_ROUTE_ENABLED', env),
        autoRagEnabled: readTypedEnv('PIVOT_CHAT_AUTO_RAG_ENABLED', env),
        autoToolDiscoveryEnabled: readTypedEnv('PIVOT_CHAT_AUTO_TOOL_DISCOVERY_ENABLED', env),
        shadowMode: readTypedEnv('PIVOT_CHAT_ROUTE_SHADOW_MODE', env),
        maxToolCandidates: readTypedEnv('PIVOT_CHAT_ROUTE_MAX_TOOL_CANDIDATES', env),
        maxCollections: readTypedEnv('PIVOT_CHAT_ROUTE_MAX_COLLECTIONS', env),
        ragThreshold,
        ragGrayThreshold,
        toolThreshold: readTypedEnv('PIVOT_CHAT_ROUTE_TOOL_THRESHOLD', env),
        embeddingTimeoutMs: readTypedEnv('PIVOT_CHAT_ROUTE_EMBEDDING_TIMEOUT_MS', env),
        promptCacheEnabled: readTypedEnv('PIVOT_CHAT_PROMPT_CACHE_ENABLED', env),
        promptCacheTtl: readTypedEnv('PIVOT_CHAT_PROMPT_CACHE_TTL', env)
    };
}

module.exports = { getChatAutoRouteConfig };
