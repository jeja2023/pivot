const RUNTIME_SETTING_KEYS = Object.freeze({
    maxConcurrentAiRequests: 'max_concurrent_ai_requests',
    maxAiQueueSize: 'max_ai_queue_size',
    aiQueueTimeoutMs: 'ai_queue_timeout_ms',
    modelEndpointDefaultConcurrency: 'model_endpoint_default_concurrency',
    modelEndpointQueueSize: 'model_endpoint_queue_size',
    modelEndpointQueueTimeoutMs: 'model_endpoint_queue_timeout_ms',
    agentMaxConcurrentRuns: 'agent_max_concurrent_runs',
    agentDagNodeConcurrency: 'agent_dag_node_concurrency',
    ragIndexMaxConcurrent: 'rag_index_max_concurrent',
    memoryCompressionMaxConcurrent: 'memory_compression_max_concurrent',
    modelContextWindowTokens: 'model_context_window_tokens',
    contextReservedOutputTokens: 'context_reserved_output_tokens'
});

const RUNTIME_SETTING_DEFINITIONS = Object.freeze([
    {
        key: RUNTIME_SETTING_KEYS.maxConcurrentAiRequests,
        prop: 'maxConcurrentAiRequests',
        label: '全局 AI 并发请求数',
        env: 'MAX_CONCURRENT_AI_REQUESTS',
        defaultValue: 1,
        min: 1,
        max: 256,
        group: 'concurrency'
    },
    {
        key: RUNTIME_SETTING_KEYS.maxAiQueueSize,
        prop: 'maxAiQueueSize',
        label: '全局 AI 排队长度',
        env: 'MAX_AI_QUEUE_SIZE',
        defaultValue: 20,
        min: 0,
        max: 10000,
        group: 'concurrency'
    },
    {
        key: RUNTIME_SETTING_KEYS.aiQueueTimeoutMs,
        prop: 'aiQueueTimeoutMs',
        label: '全局 AI 排队超时',
        env: 'AI_QUEUE_TIMEOUT_MS',
        defaultValue: 300000,
        min: 1000,
        max: 24 * 60 * 60 * 1000,
        group: 'concurrency',
        unit: 'ms'
    },
    {
        key: RUNTIME_SETTING_KEYS.modelEndpointDefaultConcurrency,
        prop: 'modelEndpointDefaultConcurrency',
        label: '模型端点默认并发',
        env: 'MODEL_ENDPOINT_DEFAULT_CONCURRENCY',
        defaultValue: 1,
        min: 1,
        max: 256,
        group: 'concurrency'
    },
    {
        key: RUNTIME_SETTING_KEYS.modelEndpointQueueSize,
        prop: 'modelEndpointQueueSize',
        label: '模型端点排队长度',
        env: 'MODEL_ENDPOINT_QUEUE_SIZE',
        defaultValue: 20,
        min: 0,
        max: 10000,
        group: 'concurrency'
    },
    {
        key: RUNTIME_SETTING_KEYS.modelEndpointQueueTimeoutMs,
        prop: 'modelEndpointQueueTimeoutMs',
        label: '模型端点排队超时',
        env: 'MODEL_ENDPOINT_QUEUE_TIMEOUT_MS',
        defaultValue: 300000,
        min: 1000,
        max: 24 * 60 * 60 * 1000,
        group: 'concurrency',
        unit: 'ms'
    },
    {
        key: RUNTIME_SETTING_KEYS.agentMaxConcurrentRuns,
        prop: 'agentMaxConcurrentRuns',
        label: '智能体任务并发',
        env: 'AGENT_MAX_CONCURRENT_RUNS',
        defaultValue: 2,
        min: 1,
        max: 256,
        group: 'agent'
    },
    {
        key: RUNTIME_SETTING_KEYS.agentDagNodeConcurrency,
        prop: 'agentDagNodeConcurrency',
        label: '工作流节点并发',
        env: 'AGENT_DAG_NODE_CONCURRENCY',
        defaultValue: 4,
        min: 1,
        max: 256,
        group: 'agent'
    },
    {
        key: RUNTIME_SETTING_KEYS.ragIndexMaxConcurrent,
        prop: 'ragIndexMaxConcurrent',
        label: '知识库索引并发',
        env: 'RAG_INDEX_MAX_CONCURRENT',
        defaultValue: 1,
        min: 1,
        max: 64,
        group: 'background'
    },
    {
        key: RUNTIME_SETTING_KEYS.memoryCompressionMaxConcurrent,
        prop: 'memoryCompressionMaxConcurrent',
        label: '记忆压缩并发',
        env: 'MEMORY_COMPRESSION_MAX_CONCURRENT',
        defaultValue: 2,
        min: 1,
        max: 64,
        group: 'background'
    },
    {
        key: RUNTIME_SETTING_KEYS.modelContextWindowTokens,
        prop: 'modelContextWindowTokens',
        label: '全局上下文窗口',
        env: ['MODEL_CONTEXT_WINDOW_TOKENS', 'CONTEXT_WINDOW_TOKENS'],
        defaultValue: 0,
        min: 0,
        max: 10000000,
        group: 'context',
        unit: 'tokens'
    },
    {
        key: RUNTIME_SETTING_KEYS.contextReservedOutputTokens,
        prop: 'contextReservedOutputTokens',
        label: '上下文预留输出',
        env: 'CONTEXT_RESERVED_OUTPUT_TOKENS',
        defaultValue: 2048,
        min: 512,
        max: 10000000,
        group: 'context',
        unit: 'tokens'
    }
]);

const RUNTIME_SETTING_DEFINITION_BY_KEY = Object.freeze(
    RUNTIME_SETTING_DEFINITIONS.reduce((acc, definition) => {
        acc[definition.key] = definition;
        return acc;
    }, {})
);

function parseHumanInt(value) {
    const text = String(value ?? '').trim();
    if (!text) return NaN;
    const match = text.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kKmMbB万亿]?)\s*(?:tokens?)?$/);
    if (!match) return Number.parseInt(text.replace(/[^\d]/g, ''), 10);
    const amount = Number(match[1]) || 0;
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'k' ? 1000
        : unit === '万' ? 10000
        : unit === 'm' ? 1000000
        : unit === '亿' ? 100000000
        : unit === 'b' ? 1000000000
        : 1;
    return Math.round(amount * multiplier);
}

function getRuntimeDefaultValue(definition) {
    const envNames = Array.isArray(definition.env) ? definition.env : [definition.env];
    for (const envName of envNames) {
        if (envName && process.env[envName] !== undefined && String(process.env[envName]).trim() !== '') {
            const parsed = parseHumanInt(process.env[envName]);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return definition.defaultValue;
}

function normalizeRuntimeSettingValue(key, value, options = {}) {
    const definition = RUNTIME_SETTING_DEFINITION_BY_KEY[key];
    if (!definition) return { error: `未知运行时配置项: ${key}` };
    const allowBlank = options.allowBlank === true;
    if (allowBlank && (value === null || value === undefined || String(value).trim() === '')) {
        return { value: getRuntimeDefaultValue(definition) };
    }
    const parsed = parseHumanInt(value);
    if (!Number.isFinite(parsed)) {
        return { error: `${definition.label} 必须是有效数字` };
    }
    const min = Number(definition.min);
    const max = Number(definition.max);
    if (parsed < min || parsed > max) {
        return { error: `${definition.label} 必须在 ${min} 到 ${max} 之间` };
    }
    return { value: parsed };
}

module.exports = {
    RUNTIME_SETTING_DEFINITION_BY_KEY,
    RUNTIME_SETTING_DEFINITIONS,
    RUNTIME_SETTING_KEYS,
    getRuntimeDefaultValue,
    normalizeRuntimeSettingValue,
    parseHumanInt
};
