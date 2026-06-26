const { db } = require('../connection');

function ensureLegacyColumnBeforeSchema(table, column, definition) {
    const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!tableRow) return;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some(col => col.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const PRE_SCHEMA_COLUMNS = [
    ['users', 'status', "TEXT DEFAULT 'active'"],
    ['sessions', 'is_pinned', 'INTEGER DEFAULT 0'],
    ['sessions', 'is_archived', 'INTEGER DEFAULT 0'],
    ['sessions', 'created_at', 'DATETIME'],
    ['prompts', 'user_id', 'INTEGER'],
    ['prompts', 'scope', "TEXT DEFAULT 'global'"],
    ['prompts', 'created_at', 'DATETIME'],
    ['prompts', 'updated_at', 'DATETIME'],
    ['prompts', 'description', "TEXT DEFAULT ''"],
    ['prompts', 'type', "TEXT DEFAULT 'role'"],
    ['prompts', 'category', "TEXT DEFAULT ''"],
    ['prompts', 'target_surfaces', "TEXT DEFAULT 'chat,agent,workflow'"],
    ['attachments', 'user_id', 'INTEGER'],
    ['attachments', 'session_id', 'TEXT'],
    ['attachments', 'access_token', 'TEXT'],
    ['attachments', 'created_at', 'DATETIME'],
    ['knowledge_docs', 'user_id', 'INTEGER'],
    ['knowledge_docs', 'collection_id', 'INTEGER'],
    ['knowledge_docs', 'status', "TEXT DEFAULT 'processing'"],
    ['knowledge_docs', 'created_at', 'DATETIME'],
    ['knowledge_chunks', 'doc_id', 'INTEGER'],
    ['knowledge_chunks', 'search_content', 'TEXT'],
    ['models', 'user_id', 'INTEGER'],
    ['models', 'status', "TEXT DEFAULT 'active'"],
    ['audit_logs', 'user_id', 'INTEGER'],
    ['audit_logs', 'timestamp', 'DATETIME'],
    ['api_keys', 'user_id', 'INTEGER'],
    ['model_usage_events', 'user_id', 'INTEGER'],
    ['model_usage_events', 'model_id', 'INTEGER'],
    ['model_usage_events', 'created_at', 'DATETIME'],
    ['api_call_logs', 'user_id', 'INTEGER'],
    ['api_call_logs', 'api_key_id', 'INTEGER'],
    ['api_call_logs', 'created_at', 'DATETIME']
];

function applyLegacySchemaPreflight() {
    PRE_SCHEMA_COLUMNS.forEach(([table, column, definition]) => {
        ensureLegacyColumnBeforeSchema(table, column, definition);
    });
}

module.exports = { applyLegacySchemaPreflight, ensureLegacyColumnBeforeSchema };
