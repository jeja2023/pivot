const assert = require('node:assert/strict');
const test = require('node:test');
const { db } = require('./security-helpers');
const { refreshAppSettingsCache } = require('../server/services/app-settings');
const {
    RAG_CONFIG_KEYS,
    getPublicRerankConfig,
    getRerankConfig,
    toRagSettingValue
} = require('../server/services/rag-config');

const rerankKeys = [
    RAG_CONFIG_KEYS.rerankEnabled,
    RAG_CONFIG_KEYS.rerankApiUrl,
    RAG_CONFIG_KEYS.rerankApiKey,
    RAG_CONFIG_KEYS.rerankModel,
    RAG_CONFIG_KEYS.rerankCandidateLimit,
    RAG_CONFIG_KEYS.rerankTimeoutMs
];

test('系统重排序配置会加密密钥、限制候选和超时，并且不向浏览器泄露密钥', async () => {
    const prior = rerankKeys.map(key => db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = ?').get(key));
    const upsert = db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, datetime('now', '+8 hours'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    try {
        upsert.run(RAG_CONFIG_KEYS.rerankEnabled, toRagSettingValue(RAG_CONFIG_KEYS.rerankEnabled, true));
        upsert.run(RAG_CONFIG_KEYS.rerankApiUrl, toRagSettingValue(RAG_CONFIG_KEYS.rerankApiUrl, 'https://rerank.example/v1'));
        upsert.run(RAG_CONFIG_KEYS.rerankApiKey, toRagSettingValue(RAG_CONFIG_KEYS.rerankApiKey, 'rerank-secret'));
        upsert.run(RAG_CONFIG_KEYS.rerankModel, toRagSettingValue(RAG_CONFIG_KEYS.rerankModel, 'BAAI/bge-reranker-v2-m3'));
        upsert.run(RAG_CONFIG_KEYS.rerankCandidateLimit, toRagSettingValue(RAG_CONFIG_KEYS.rerankCandidateLimit, '500'));
        upsert.run(RAG_CONFIG_KEYS.rerankTimeoutMs, toRagSettingValue(RAG_CONFIG_KEYS.rerankTimeoutMs, '10'));
        await refreshAppSettingsCache();
        const config = getRerankConfig();
        assert.equal(config.enabled, true);
        assert.equal(config.http.apiKey, 'rerank-secret');
        assert.equal(config.http.candidateLimit, 100);
        assert.equal(config.http.timeoutMs, 200);
        const publicConfig = getPublicRerankConfig();
        assert.equal(publicConfig.hasApiKey, true);
        assert.equal(Object.hasOwn(publicConfig, 'apiKey'), false);
    } finally {
        prior.forEach((row, index) => {
            if (row) {
                db.prepare(`
                    INSERT INTO app_settings (key, value, updated_at, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
                `).run(row.key, row.value, row.updated_at, row.updated_by);
            } else {
                db.prepare('DELETE FROM app_settings WHERE key = ?').run(rerankKeys[index]);
            }
        });
        await refreshAppSettingsCache();
    }
});
