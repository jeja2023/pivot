/**
 * server/db/index.js
 * 数据库初始化入口（双模式）
 *
 * SQLite 模式：同步初始化（模块加载时自动执行）
 * PG 模式：需在应用启动时调用 await initPostgresDatabase()
 */
const { isPostgres } = require('./dialect');
const { db, dataDir, dbPath } = require('./connection');

let stmts = {};
exports.db = db;
exports.dataDir = dataDir;
exports.dbPath = dbPath;
exports.stmts = stmts;
exports.initPostgresDatabase = initPostgresDatabase;

if (!isPostgres()) {
    const { initSchema } = require('./schema');
    const { runMigrations } = require('./migrate');
    const { runSeeds } = require('./seed');
    const { ensureAppSetting } = require('../services/app-settings');
    const { RUNTIME_SETTING_DEFINITIONS, getRuntimeDefaultValue } = require('../services/runtime-settings-defs');
    const { sql } = require('./statements');

    initSchema();
    runMigrations();
    runSeeds();

    // 高频 SQL 预编译（仅 SQLite 模式）
    stmts = {
        insertLog: sql('INSERT INTO audit_logs (user_id, action, details, ip_address, timestamp) VALUES (?, ?, ?, ?, ?)'),
        getUserById: sql('SELECT id, username, nickname, unit, role, status, default_model_id FROM users WHERE id = ? AND deleted_at IS NULL'),
        getSettings: sql(`
            SELECT value FROM app_settings
            WHERE key = ?
            ORDER BY
                CASE WHEN updated_at IS NULL OR updated_at = '' THEN 0 ELSE 1 END DESC,
                updated_at DESC,
                rowid DESC
            LIMIT 1
        `),
        getSessions: sql('SELECT * FROM sessions WHERE user_id = ? AND is_archived = ? AND deleted_at IS NULL ORDER BY is_pinned DESC, updated_at DESC'),
        getSessionById: sql('SELECT * FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'),
        updateSessionTitle: sql('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?'),
        getAllModels: sql('SELECT id, name, url, model_name, daily_token_limit, allowed_units, monitor_url, max_concurrent, supports_vision, supports_reasoning, chat_thinking_enabled, user_id, status, created_at FROM models ORDER BY id DESC'),
        getAccessibleModels: sql("SELECT id, name, url, model_name, daily_token_limit, allowed_units, monitor_url, max_concurrent, supports_vision, supports_reasoning, chat_thinking_enabled, user_id, status FROM models WHERE status = 'active' AND (user_id IS NULL OR user_id = ?) ORDER BY id DESC"),
        getUserPasswordHash: sql('SELECT password_hash FROM users WHERE id = ?'),
        insertRefreshToken: sql('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'),
        getRefreshToken: sql('SELECT * FROM refresh_tokens WHERE token = ?'),
        deleteRefreshToken: sql('DELETE FROM refresh_tokens WHERE token = ?'),
        deleteUserRefreshTokens: sql('DELETE FROM refresh_tokens WHERE user_id = ?'),
        getMessages: sql(`
            SELECT m.*, COALESCE(md.name, md.model_name, '') AS model_name, md.model_name AS model_api_name
            FROM messages m
            LEFT JOIN models md ON md.id = m.model_id
            WHERE m.session_id = ? AND m.user_id = ? AND m.deleted_at IS NULL
            ORDER BY m.id ASC
        `),
    };
    stmts.getMessagesForContext = stmts.getMessages;

    const ensureSetting = (key, value) => ensureAppSetting(key, value);
    ensureSetting('rag_enabled', 'true');
    ensureSetting('rag_score_threshold', process.env.RAG_SCORE_THRESHOLD || '0.4');
    ensureSetting('rag_top_k', process.env.RAG_TOP_K || '3');
    ensureSetting('rag_candidate_limit', process.env.RAG_CANDIDATE_LIMIT || '300');
    ensureSetting('rag_chunk_size', process.env.RAG_CHUNK_SIZE || '500');
    ensureSetting('rag_chunk_overlap', process.env.RAG_CHUNK_OVERLAP || '100');
    ensureSetting('rag_embedding_mode', 'http');
    ensureSetting('rag_embedding_api_url', process.env.EMBEDDING_API_URL || '');
    ensureSetting('rag_embedding_model', process.env.EMBEDDING_MODEL || 'nomic-embed-text');
    ensureSetting('allow_public_registration', process.env.ALLOW_PUBLIC_REGISTRATION === 'true' ? 'true' : 'false');
    ensureSetting('api_access_enabled', process.env.API_ACCESS_ENABLED === 'false' ? 'false' : 'true');
    ensureSetting('memory_threshold', process.env.MEMORY_THRESHOLD || '12000');
    RUNTIME_SETTING_DEFINITIONS.forEach(definition => {
        ensureSetting(definition.key, getRuntimeDefaultValue(definition));
    });
}

/**
 * PostgreSQL 模式异步初始化
 * 在应用启动时（server.js / app.js）调用：await initPostgresDatabase()
 */
async function initPostgresDatabase() {
    if (!isPostgres()) return;
    const { initSchemaPg } = require('./schema');
    const { runMigrationsPg } = require('./migrate');
    const { runSeedsPg } = require('./seed');
    const { ensureAppSettingAsync } = require('../services/app-settings');
    const { RUNTIME_SETTING_DEFINITIONS, getRuntimeDefaultValue } = require('../services/runtime-settings-defs');

    await initSchemaPg();
    await runMigrationsPg();
    await runSeedsPg();

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
