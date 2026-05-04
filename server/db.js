/* 数据库逻辑模块 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getBeijingTimestamp } = require('./time');

const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'chat.db'));

const recordMigration = (key, value = 'done') => {
    db.prepare('INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, getBeijingTimestamp());
};

// --- 企业级持久化性能优化 ---
db.pragma('journal_mode = WAL');       // 开启预写日志模式，提升并发并增强灾难恢复能力
db.pragma('synchronous = NORMAL');     // 在性能与安全性之间取得最佳平衡
db.pragma('auto_vacuum = INCREMENTAL');// 开启增量真空，防止数据库文件碎片化膨胀
db.pragma('busy_timeout = 5000');      // 设置忙等待超时，解决多进程竞争问题
db.pragma('foreign_keys = ON');

// 初始化数据库表
db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME,
        updated_by INTEGER,
        FOREIGN KEY (updated_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        nickname TEXT,
        unit TEXT,
        role TEXT DEFAULT 'user',
        status TEXT DEFAULT 'active',
        last_login_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        title TEXT,
        created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL, -- 'user', 'assistant', 'system', 'summary'
        content TEXT NOT NULL,
        token_count INTEGER DEFAULT 0,
        is_summary INTEGER DEFAULT 0,
        model_id INTEGER,
        created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,    -- NULL 表示全局模型，有值表示用户私有模型
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        api_key TEXT,
        model_name TEXT,
        is_default INTEGER DEFAULT 0,
        daily_token_limit INTEGER DEFAULT 0,
        allowed_units TEXT DEFAULT '',
        created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        timestamp DATETIME DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- RAG 知识库系统表
    CREATE TABLE IF NOT EXISTS knowledge_docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'processing', -- 'processing', 'ready', 'error'
        created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER,
        content TEXT NOT NULL,
        embedding TEXT, -- JSON array of floats
        FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE
    );

    -- 索引优化
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
    -- 附件管理表
    CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_id TEXT,
        file_name TEXT,
        file_path TEXT,
        file_type TEXT,
        file_size INTEGER,
        access_token TEXT,
        created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
`);

// --- 数据库热更新：自动补全缺失字段 ---
const ensureColumn = (table, column, definition) => {
    try {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some(col => col.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            console.log(`📦 数据库升级：已补全 ${table}.${column} 字段`);
        }
    } catch (e) {
        console.error(`❌ 数据库升级失败 (${table}.${column}):`, e.message);
    }
};

ensureColumn('users', 'nickname', 'TEXT');
ensureColumn('users', 'unit', 'TEXT');
ensureColumn('users', 'default_model_id', 'INTEGER');
ensureColumn('users', 'status', "TEXT DEFAULT 'active'");
ensureColumn('users', 'last_login_at', 'DATETIME');
ensureColumn('audit_logs', 'ip_address', 'TEXT');
ensureColumn('messages', 'model_id', 'INTEGER');
ensureColumn('messages', 'cost_time', 'REAL');
ensureColumn('messages', 'tokens_per_sec', 'REAL');
ensureColumn('attachments', 'access_token', 'TEXT');
ensureColumn('models', 'daily_token_limit', 'INTEGER DEFAULT 0');
ensureColumn('models', 'allowed_units', "TEXT DEFAULT ''");
ensureColumn('models', 'created_at', "DATETIME");
db.prepare('UPDATE models SET created_at = ? WHERE created_at IS NULL').run(getBeijingTimestamp());
ensureColumn('sessions', 'is_pinned', 'INTEGER DEFAULT 0');
ensureColumn('sessions', 'system_prompt', 'TEXT');
ensureColumn('sessions', 'is_archived', 'INTEGER DEFAULT 0');
ensureColumn('sessions', 'tags', "TEXT DEFAULT ''");



// 检测 sessions 表并补全（双重保障）
const sessionTableInfo = db.prepare("PRAGMA table_info(sessions)").all();
if (!sessionTableInfo.some(col => col.name === 'is_pinned')) {
    db.exec("ALTER TABLE sessions ADD COLUMN is_pinned INTEGER DEFAULT 0");
}


db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT DEFAULT '通用',
        scope TEXT DEFAULT 'global',
        created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
`);

ensureColumn('prompts', 'user_id', 'INTEGER');
ensureColumn('prompts', 'scope', "TEXT DEFAULT 'global'");
ensureColumn('prompts', 'created_at', 'DATETIME');

const promptTableInfo = db.prepare("PRAGMA table_info(prompts)").all();
if (!promptTableInfo.some(col => col.name === 'user_id')) {
    db.exec("ALTER TABLE prompts ADD COLUMN user_id INTEGER");
    console.log('📦 数据库升级：已补全 prompts.user_id 字段');
}
if (!promptTableInfo.some(col => col.name === 'scope')) {
    db.exec("ALTER TABLE prompts ADD COLUMN scope TEXT DEFAULT 'global'");
    console.log('📦 数据库升级：已补全 prompts.scope 字段');
}
if (!promptTableInfo.some(col => col.name === 'created_at')) {
    db.exec("ALTER TABLE prompts ADD COLUMN created_at DATETIME");
    db.prepare('UPDATE prompts SET created_at = ? WHERE created_at IS NULL').run(getBeijingTimestamp());
    console.log('📦 数据库升级：已补全 prompts.created_at 字段');
}

// 预置一些常用指令
const promptCount = db.prepare('SELECT COUNT(*) as count FROM prompts').get().count;
if (promptCount === 0) {
    const defaultPrompts = [
        ['中英文翻译官', '你是一个精通中英文翻译的助手，能够地道、准确地在两种语言间切换，并保持原有的语气。', '翻译'],
        ['代码助手', '你是一个资深的软件工程师，擅长编写简洁、高效、安全的代码，并能给出详尽的注释和优化建议。', '编程'],
        ['周报专家', '你擅长总结工作成果，能将零散的任务描述转化为结构清晰、重点突出的专业周报。', '办公'],
        ['文案润色', '你是一个文字大师，能对给出的文本进行修辞优化、逻辑理顺，使其更具感染力和专业性。', '创作']
    ];
    const stmt = db.prepare('INSERT INTO prompts (name, content, category) VALUES (?, ?, ?)');
    defaultPrompts.forEach(p => stmt.run(...p));
}

db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_user_created ON messages(session_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_archived ON sessions(user_id, is_archived, is_pinned, created_at);
    CREATE INDEX IF NOT EXISTS idx_prompts_scope_user ON prompts(scope, user_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_user_session ON attachments(user_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_token ON attachments(access_token);
    CREATE INDEX IF NOT EXISTS idx_knowledge_docs_user_status ON knowledge_docs(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(doc_id);
`);

const ensureSetting = (key, value) => {
    db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO NOTHING
    `).run(key, String(value), getBeijingTimestamp());
};

ensureSetting('rag_enabled', process.env.ENABLE_RAG === 'true' ? 'true' : 'false');

// --- 历史时间迁移：旧版本表默认 CURRENT_TIMESTAMP，实际存储 UTC，需要补正为东八区 ---
const timeMigrationKey = 'utc_timestamp_migrated_to_beijing_v1';
const timeMigration = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(timeMigrationKey);
if (!timeMigration) {
    const migrateTime = db.transaction(() => {
        db.prepare("UPDATE users SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
        db.prepare("UPDATE sessions SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
        db.prepare("UPDATE messages SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
        db.prepare("UPDATE audit_logs SET timestamp = datetime(timestamp, '+8 hours') WHERE timestamp IS NOT NULL").run();
        db.prepare("UPDATE attachments SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
        db.prepare("UPDATE knowledge_docs SET created_at = datetime(created_at, '+8 hours') WHERE created_at IS NOT NULL").run();
        db.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)')
          .run(timeMigrationKey, 'done', getBeijingTimestamp());
    });
    migrateTime();
    console.log('数据库升级：已将历史 UTC 时间补正为东八区时间');
}

// --- 自动填充默认管理员账号 (仅当用户表为空时) ---
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
if (userCount === 0) {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const { validatePassword } = require('./auth');
    const configuredAdminPassword = String(process.env.DEFAULT_ADMIN_PASSWORD || '').trim();
    if (configuredAdminPassword) validatePassword(configuredAdminPassword);
    const adminPassword = configuredAdminPassword || crypto.randomBytes(16).toString('base64url');
    const adminPasswordHash = bcrypt.hashSync(adminPassword, 10);
    db.prepare('INSERT INTO users (username, password_hash, nickname, unit, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('admin', adminPasswordHash, '系统管理员', '智枢科技', 'admin', getBeijingTimestamp());
    console.log(`系统初始化：已创建默认管理员账号 admin，初始密码为 ${adminPassword}`);
    recordMigration('initial_admin_created_v1', 'done');
}

module.exports = db;
