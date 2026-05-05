const { db } = require('./connection');
const { initSchema } = require('./schema');
const { runMigrations } = require('./migrate');
const { runSeeds } = require('./seed');
const { getBeijingTimestamp } = require('../time');

// 1. 初始化表结构
initSchema();

// 2. 运行自动迁移
runMigrations();

// 3. 运行默认数据填充
runSeeds();

// --- 高频 SQL 预编译 (Performance Optimization) ---
const stmts = {
    insertLog: db.prepare('INSERT INTO audit_logs (user_id, action, details, ip_address, timestamp) VALUES (?, ?, ?, ?, ?)'),
    getUserById: db.prepare('SELECT id, username, nickname, unit, role, status, default_model_id FROM users WHERE id = ?'),
    getSettings: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
    // 会话与消息
    getSessions: db.prepare('SELECT * FROM sessions WHERE user_id = ? AND is_archived = ? ORDER BY is_pinned DESC, updated_at DESC'),
    getSessionById: db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?'),
    getMessages: db.prepare('SELECT * FROM messages WHERE session_id = ? AND user_id = ? ORDER BY id ASC'),
    updateSessionTitle: db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?'),
    // 模型
    getAllModels: db.prepare('SELECT id, name, url, model_name, daily_token_limit, allowed_units, monitor_url, max_concurrent, user_id, status, created_at FROM models ORDER BY id DESC'),
    getAccessibleModels: db.prepare("SELECT id, name, url, model_name, daily_token_limit, allowed_units, monitor_url, max_concurrent, user_id, status FROM models WHERE status = 'active' AND (user_id IS NULL OR user_id = ?) ORDER BY id DESC"),
    getUserPasswordHash: db.prepare('SELECT password_hash FROM users WHERE id = ?'),
    // 刷新令牌
    insertRefreshToken: db.prepare('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'),
    getRefreshToken: db.prepare('SELECT * FROM refresh_tokens WHERE token = ?'),
    deleteRefreshToken: db.prepare('DELETE FROM refresh_tokens WHERE token = ?'),
    deleteUserRefreshTokens: db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?')
};

const ensureSetting = (key, value) => {
    db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO NOTHING
    `).run(key, String(value), getBeijingTimestamp());
};

ensureSetting('rag_enabled', process.env.ENABLE_RAG === 'true' ? 'true' : 'false');

module.exports = { db, stmts };
