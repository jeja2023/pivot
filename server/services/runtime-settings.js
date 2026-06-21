const { db } = require('../db/connection');
const { getBeijingTimestamp } = require('../time');
const {
    RUNTIME_SETTING_DEFINITION_BY_KEY,
    RUNTIME_SETTING_DEFINITIONS,
    RUNTIME_SETTING_KEYS,
    getRuntimeDefaultValue,
    normalizeRuntimeSettingValue
} = require('./runtime-settings-defs');

function getSettingRow(key) {
    try {
        return db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key) || null;
    } catch (e) {
        if (/no such table/i.test(e.message || '')) return null;
        throw e;
    }
}

function getRuntimeSettingValue(key) {
    const definition = RUNTIME_SETTING_DEFINITION_BY_KEY[key];
    if (!definition) return 0;
    const row = getSettingRow(key);
    const sourceValue = row?.value ?? getRuntimeDefaultValue(definition);
    const normalized = normalizeRuntimeSettingValue(key, sourceValue);
    if (normalized.error) return getRuntimeDefaultValue(definition);
    return normalized.value;
}

function buildRuntimeConfigSnapshot() {
    const values = {};
    const items = RUNTIME_SETTING_DEFINITIONS.map(definition => {
        const row = getSettingRow(definition.key);
        const defaultValue = getRuntimeDefaultValue(definition);
        const value = getRuntimeSettingValue(definition.key);
        values[definition.prop] = value;
        return {
            key: definition.key,
            prop: definition.prop,
            label: definition.label,
            group: definition.group,
            unit: definition.unit || '',
            env: definition.env,
            min: definition.min,
            max: definition.max,
            value,
            defaultValue,
            source: row ? 'settings' : 'env',
            updatedAt: row?.updated_at || null,
            updatedBy: row?.updated_by || null
        };
    });
    return { values, items };
}

function saveRuntimeConfig(updates = {}, userId = null) {
    const entries = [];
    for (const definition of RUNTIME_SETTING_DEFINITIONS) {
        const candidates = [definition.key, definition.prop];
        const rawKey = candidates.find(key => Object.prototype.hasOwnProperty.call(updates, key));
        if (!rawKey) continue;
        const normalized = normalizeRuntimeSettingValue(definition.key, updates[rawKey]);
        if (normalized.error) return { error: normalized.error };
        entries.push({ key: definition.key, value: normalized.value, label: definition.label });
    }

    if (entries.length === 0) {
        return { changed: [], config: buildRuntimeConfigSnapshot() };
    }

    const now = getBeijingTimestamp();
    const stmt = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
    `);

    const transaction = db.transaction(() => {
        entries.forEach(entry => stmt.run(entry.key, String(entry.value), now, userId || null));
    });
    transaction();

    return {
        changed: entries.map(entry => `${entry.key}=${entry.value}`),
        config: buildRuntimeConfigSnapshot()
    };
}

function getGlobalAiConcurrencyConfig() {
    return {
        maxConcurrent: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.maxConcurrentAiRequests),
        maxQueueSize: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.maxAiQueueSize),
        queueTimeoutMs: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.aiQueueTimeoutMs)
    };
}

function getModelEndpointRuntimeConfig() {
    return {
        defaultConcurrency: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.modelEndpointDefaultConcurrency),
        queueSize: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.modelEndpointQueueSize),
        queueTimeoutMs: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.modelEndpointQueueTimeoutMs)
    };
}

function getAgentConcurrencyConfig() {
    return {
        maxConcurrentRuns: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.agentMaxConcurrentRuns),
        dagNodeConcurrency: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.agentDagNodeConcurrency)
    };
}

function getBackgroundRuntimeConfig() {
    return {
        ragIndexMaxConcurrent: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.ragIndexMaxConcurrent),
        memoryCompressionMaxConcurrent: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.memoryCompressionMaxConcurrent)
    };
}

function getGlobalContextRuntimeConfig() {
    return {
        modelContextWindowTokens: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.modelContextWindowTokens),
        contextReservedOutputTokens: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.contextReservedOutputTokens)
    };
}

function getGlobalSamplingRuntimeConfig() {
    return {
        temperature: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.samplingTemperature),
        topP: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.samplingTopP),
        presencePenalty: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.samplingPresencePenalty),
        frequencyPenalty: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.samplingFrequencyPenalty)
    };
}

function getUploadRuntimeConfig() {
    return {
        attachmentMaxBytes: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.uploadAttachmentMaxBytes),
        knowledgeMaxBytes: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.knowledgeUploadMaxBytes),
        imageUploadMaxBytes: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.imageUploadMaxBytes),
        imageContextMaxBytes: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.imageContextMaxBytes),
        maxAttachmentsPerMessage: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.maxAttachmentsPerMessage),
        maxImagesPerMessage: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.maxImagesPerMessage)
    };
}

function getAttachmentRuntimeConfig() {
    return {
        contextMaxChars: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.attachmentContextMaxChars)
    };
}

function getKnowledgeRuntimeConfig() {
    return {
        uploadMaxBytes: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.knowledgeUploadMaxBytes),
        extractMaxChars: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.knowledgeExtractMaxChars)
    };
}

function getRagRuntimeConfig() {
    return {
        topKMax: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.ragTopKMax),
        candidateLimitMax: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.ragCandidateLimitMax),
        chunkSizeMax: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.ragChunkSizeMax),
        contextBudgetPercent: getRuntimeSettingValue(RUNTIME_SETTING_KEYS.ragContextBudgetPercent)
    };
}

module.exports = {
    RUNTIME_SETTING_DEFINITIONS,
    RUNTIME_SETTING_KEYS,
    buildRuntimeConfigSnapshot,
    getAttachmentRuntimeConfig,
    getAgentConcurrencyConfig,
    getBackgroundRuntimeConfig,
    getGlobalAiConcurrencyConfig,
    getGlobalContextRuntimeConfig,
    getGlobalSamplingRuntimeConfig,
    getKnowledgeRuntimeConfig,
    getModelEndpointRuntimeConfig,
    getRagRuntimeConfig,
    getRuntimeSettingValue,
    getUploadRuntimeConfig,
    saveRuntimeConfig
};
