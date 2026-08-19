/**
 * server/db/index.js
 * 数据库初始化入口（PostgreSQL）
 */
const { db, dataDir, dbPath } = require('./connection');
const { refreshUserSettingsCache } = require('../services/user-settings');

const stmts = {};

// Keep the small synchronous statement surface available to legacy tests while
// production PostgreSQL callers use the async client/repositories directly.
if (db?.prepare && process.env.PIVOT_TEST_DB_SYNC === 'postgres') {
    stmts.getMessages = db.prepare(`
        SELECT m.*, COALESCE(md.name, md.model_name, '') AS model_name, md.model_name AS model_api_name
        FROM messages m
        LEFT JOIN models md ON md.id = m.model_id
        WHERE m.session_id = ? AND m.user_id = ? AND m.deleted_at IS NULL
        ORDER BY m.id ASC
    `);
    stmts.getMessagesForContext = stmts.getMessages;
}

/**
 * PostgreSQL 模式异步初始化
 * 在应用启动时调用：await initPostgresDatabase()
 */
async function initPostgresDatabase() {
    const { initSchemaPg } = require('./schema');
    const { runMigrationsPg } = require('./migrate');
    const { runSeedsPg } = require('./seed');
    const { ensureAppSettingAsync } = require('../services/app-settings');
    const { RUNTIME_SETTING_DEFINITIONS, getRuntimeDefaultValue } = require('../services/runtime-settings-defs');

    await initSchemaPg();
    await runMigrationsPg();
    await runSeedsPg();
    await refreshUserSettingsCache();

    const ensureSetting = (key, value) => ensureAppSettingAsync(key, value);
    await ensureSetting('rag_enabled', 'true');
    await ensureSetting('rag_score_threshold', process.env.RAG_SCORE_THRESHOLD || '0.4');
    await ensureSetting('rag_top_k', process.env.RAG_TOP_K || '3');
    await ensureSetting('rag_candidate_limit', process.env.RAG_CANDIDATE_LIMIT || '300');
    await ensureSetting('rag_chunk_size', process.env.RAG_CHUNK_SIZE || '500');
    await ensureSetting('rag_chunk_overlap', process.env.RAG_CHUNK_OVERLAP || '100');
    await ensureSetting('rag_embedding_mode', 'http');
    await ensureSetting('rag_embedding_api_url', process.env.EMBEDDING_API_URL || '');
    await ensureSetting('rag_embedding_model', process.env.EMBEDDING_MODEL || 'nomic-embed-text');
    await ensureSetting('allow_public_registration', process.env.ALLOW_PUBLIC_REGISTRATION === 'true' ? 'true' : 'false');
    await ensureSetting('api_access_enabled', process.env.API_ACCESS_ENABLED === 'false' ? 'false' : 'true');
    await ensureSetting('memory_threshold', process.env.MEMORY_THRESHOLD || '12000');
    for (const definition of RUNTIME_SETTING_DEFINITIONS) {
        await ensureSetting(definition.key, getRuntimeDefaultValue(definition));
    }
}

module.exports = { db, dataDir, dbPath, stmts, initPostgresDatabase };
