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
    contextReservedOutputTokens: 'context_reserved_output_tokens',
    samplingTemperature: 'sampling_temperature',
    samplingTopP: 'sampling_top_p',
    samplingPresencePenalty: 'sampling_presence_penalty',
    samplingFrequencyPenalty: 'sampling_frequency_penalty',
    uploadAttachmentMaxBytes: 'upload_attachment_max_bytes',
    knowledgeUploadMaxBytes: 'knowledge_upload_max_bytes',
    imageUploadMaxBytes: 'image_upload_max_bytes',
    imageContextMaxBytes: 'image_context_max_bytes',
    maxAttachmentsPerMessage: 'max_attachments_per_message',
    maxImagesPerMessage: 'max_images_per_message',
    attachmentContextMaxChars: 'attachment_context_max_chars',
    knowledgeExtractMaxChars: 'knowledge_extract_max_chars',
    ragTopKMax: 'rag_top_k_max',
    ragCandidateLimitMax: 'rag_candidate_limit_max',
    ragChunkSizeMax: 'rag_chunk_size_max',
    ragContextBudgetPercent: 'rag_context_budget_percent'
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
        label: '全局 AI 队列长度',
        env: 'MAX_AI_QUEUE_SIZE',
        defaultValue: 20,
        min: 0,
        max: 10000,
        group: 'concurrency'
    },
    {
        key: RUNTIME_SETTING_KEYS.aiQueueTimeoutMs,
        prop: 'aiQueueTimeoutMs',
        label: '全局 AI 队列超时',
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
        label: '模型端点队列长度',
        env: 'MODEL_ENDPOINT_QUEUE_SIZE',
        defaultValue: 20,
        min: 0,
        max: 10000,
        group: 'concurrency'
    },
    {
        key: RUNTIME_SETTING_KEYS.modelEndpointQueueTimeoutMs,
        prop: 'modelEndpointQueueTimeoutMs',
        label: '模型端点队列超时',
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
    },
    {
        key: RUNTIME_SETTING_KEYS.samplingTemperature,
        prop: 'samplingTemperature',
        label: '默认温度',
        env: 'SAMPLING_TEMPERATURE',
        defaultValue: 0.7,
        min: 0,
        max: 2,
        group: 'sampling',
        valueType: 'float'
    },
    {
        key: RUNTIME_SETTING_KEYS.samplingTopP,
        prop: 'samplingTopP',
        label: '默认采样概率上限',
        env: 'SAMPLING_TOP_P',
        defaultValue: 1,
        min: 0,
        max: 1,
        group: 'sampling',
        valueType: 'float'
    },
    {
        key: RUNTIME_SETTING_KEYS.samplingPresencePenalty,
        prop: 'samplingPresencePenalty',
        label: '默认重复惩罚',
        env: 'SAMPLING_PRESENCE_PENALTY',
        defaultValue: 0,
        min: -2,
        max: 2,
        group: 'sampling',
        valueType: 'float'
    },
    {
        key: RUNTIME_SETTING_KEYS.samplingFrequencyPenalty,
        prop: 'samplingFrequencyPenalty',
        label: '默认频率惩罚',
        env: 'SAMPLING_FREQUENCY_PENALTY',
        defaultValue: 0,
        min: -2,
        max: 2,
        group: 'sampling',
        valueType: 'float'
    },
    {
        key: RUNTIME_SETTING_KEYS.uploadAttachmentMaxBytes,
        prop: 'uploadAttachmentMaxBytes',
        label: '聊天附件上传大小',
        env: 'UPLOAD_ATTACHMENT_MAX_BYTES',
        defaultValue: 64 * 1024 * 1024,
        min: 1 * 1024 * 1024,
        max: 1024 * 1024 * 1024,
        group: 'upload',
        unit: 'bytes'
    },
    {
        key: RUNTIME_SETTING_KEYS.knowledgeUploadMaxBytes,
        prop: 'knowledgeUploadMaxBytes',
        label: '知识库上传大小',
        env: 'KNOWLEDGE_UPLOAD_MAX_BYTES',
        defaultValue: 128 * 1024 * 1024,
        min: 1 * 1024 * 1024,
        max: 2 * 1024 * 1024 * 1024,
        group: 'upload',
        unit: 'bytes'
    },
    {
        key: RUNTIME_SETTING_KEYS.imageUploadMaxBytes,
        prop: 'imageUploadMaxBytes',
        label: '图片上传大小',
        env: 'IMAGE_UPLOAD_MAX_BYTES',
        defaultValue: 32 * 1024 * 1024,
        min: 1 * 1024 * 1024,
        max: 512 * 1024 * 1024,
        group: 'upload',
        unit: 'bytes'
    },
    {
        key: RUNTIME_SETTING_KEYS.imageContextMaxBytes,
        prop: 'imageContextMaxBytes',
        label: '图片上下文大小',
        env: 'IMAGE_CONTEXT_MAX_BYTES',
        defaultValue: 8 * 1024 * 1024,
        min: 512 * 1024,
        max: 128 * 1024 * 1024,
        group: 'upload',
        unit: 'bytes'
    },
    {
        key: RUNTIME_SETTING_KEYS.maxAttachmentsPerMessage,
        prop: 'maxAttachmentsPerMessage',
        label: '单次附件数量',
        env: 'MAX_ATTACHMENTS_PER_MESSAGE',
        defaultValue: 5,
        min: 1,
        max: 50,
        group: 'upload'
    },
    {
        key: RUNTIME_SETTING_KEYS.maxImagesPerMessage,
        prop: 'maxImagesPerMessage',
        label: '单次图片数量',
        env: 'MAX_IMAGES_PER_MESSAGE',
        defaultValue: 4,
        min: 1,
        max: 16,
        group: 'upload'
    },
    {
        key: RUNTIME_SETTING_KEYS.attachmentContextMaxChars,
        prop: 'attachmentContextMaxChars',
        label: '附件注入字符上限',
        env: 'ATTACHMENT_CONTEXT_MAX_CHARS',
        defaultValue: 80000,
        min: 20000,
        max: 2000000,
        group: 'context',
        unit: 'chars'
    },
    {
        key: RUNTIME_SETTING_KEYS.knowledgeExtractMaxChars,
        prop: 'knowledgeExtractMaxChars',
        label: '知识库抽取字符上限',
        env: 'KNOWLEDGE_EXTRACT_MAX_CHARS',
        defaultValue: 600000,
        min: 100000,
        max: 10000000,
        group: 'rag',
        unit: 'chars'
    },
    {
        key: RUNTIME_SETTING_KEYS.ragTopKMax,
        prop: 'ragTopKMax',
        label: 'RAG 引用数量上限',
        env: 'RAG_TOP_K_MAX',
        defaultValue: 50,
        min: 1,
        max: 200,
        group: 'rag'
    },
    {
        key: RUNTIME_SETTING_KEYS.ragCandidateLimitMax,
        prop: 'ragCandidateLimitMax',
        label: 'RAG 候选片段上限',
        env: 'RAG_CANDIDATE_LIMIT_MAX',
        defaultValue: 5000,
        min: 20,
        max: 50000,
        group: 'rag'
    },
    {
        key: RUNTIME_SETTING_KEYS.ragChunkSizeMax,
        prop: 'ragChunkSizeMax',
        label: 'RAG 切片字符上限',
        env: 'RAG_CHUNK_SIZE_MAX',
        defaultValue: 4000,
        min: 500,
        max: 20000,
        group: 'rag',
        unit: 'chars'
    },
    {
        key: RUNTIME_SETTING_KEYS.ragContextBudgetPercent,
        prop: 'ragContextBudgetPercent',
        label: 'RAG 上下文预算占比',
        env: 'RAG_CONTEXT_BUDGET_PERCENT',
        defaultValue: 25,
        min: 5,
        max: 70,
        group: 'rag',
        unit: 'percent'
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
    const match = text.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kKmMbB万亿]?)\s*(?:tokens?|bytes?|chars?|percent)?$/);
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

function parseRuntimeSettingRawValue(definition, value) {
    if (definition?.valueType === 'float') {
        const parsed = Number.parseFloat(String(value ?? '').trim());
        return Number.isFinite(parsed) ? parsed : NaN;
    }
    return parseHumanInt(value);
}

function getRuntimeDefaultValue(definition) {
    const envNames = Array.isArray(definition.env) ? definition.env : [definition.env];
    for (const envName of envNames) {
        if (envName && process.env[envName] !== undefined && String(process.env[envName]).trim() !== '') {
            const parsed = parseRuntimeSettingRawValue(definition, process.env[envName]);
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
    const parsed = parseRuntimeSettingRawValue(definition, value);
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
