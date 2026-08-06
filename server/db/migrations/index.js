const crypto = require('crypto');
const { buildRagSearchContent } = require('../../services/rag-tokenizer');
const regulationsMigrations = require('./regulations');
const { enterpriseSchemaSql } = require('../schema/enterprise');
const { archiveDeletedUsername } = require('../../services/user-identity');

const migrations = [
    {
        id: '202606260001_rag_search_content_backfill',
        description: 'Backfill RAG search_content and rebuild FTS from legacy chunks.',
        up(db) {
            db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
                    content,
                    tokenize='unicode61'
                );
            `);
            const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks'").get();
            if (!table) return;
            const columns = db.prepare('PRAGMA table_info(knowledge_chunks)').all();
            if (!columns.some(col => col.name === 'search_content')) {
                db.exec('ALTER TABLE knowledge_chunks ADD COLUMN search_content TEXT');
            }
            const rows = db.prepare(`
                SELECT id, content FROM knowledge_chunks
                WHERE search_content IS NULL OR search_content = ''
            `).all();
            if (rows.length > 0) {
                const update = db.prepare('UPDATE knowledge_chunks SET search_content = ? WHERE id = ?');
                rows.forEach(row => update.run(buildRagSearchContent(row.content), row.id));
            }
            db.exec('DELETE FROM knowledge_chunks_fts');
            db.exec('INSERT INTO knowledge_chunks_fts(rowid, content) SELECT id, COALESCE(search_content, content) FROM knowledge_chunks');
        }
    },
    {
        id: '202607030001_rag_debug_enterprise_contracts',
        description: 'Create RAG debug history and enterprise deployment contract tables.',
        up(db) {
            db.exec(enterpriseSchemaSql());
        }
    },
    {
        id: '202607150001_release_deleted_usernames',
        description: 'Preserve deleted usernames while releasing them for new registrations.',
        up(db) {
            const usersTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
            if (!usersTable) return;

            const columns = db.prepare('PRAGMA table_info(users)').all();
            if (!columns.some(column => column.name === 'deleted_username')) {
                db.exec('ALTER TABLE users ADD COLUMN deleted_username TEXT');
            }
            if (!columns.some(column => column.name === 'deleted_at')) return;

            const deletedUsers = db.prepare(`
                SELECT id
                FROM users
                WHERE deleted_at IS NOT NULL AND username != 'admin'
                ORDER BY id ASC
            `).all();
            deletedUsers.forEach(user => archiveDeletedUsername(db, user.id));
        }
    },
    {
        id: '202607310001_hash_refresh_tokens',
        description: 'Hash refresh tokens at rest while preserving active client sessions.',
        up(db) {
            const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'refresh_tokens'").get();
            if (!table) return;
            const rows = db.prepare('SELECT id, token FROM refresh_tokens').all();
            const update = db.prepare('UPDATE refresh_tokens SET token = ? WHERE id = ?');
            rows.forEach((row) => {
                const token = String(row.token || '');
                if (/^[0-9a-f]{64}$/i.test(token)) return;
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                update.run(tokenHash, row.id);
            });
        }
    },
    {
        id: '202608040001_workflow_unit_visibility',
        description: 'Add scope and allowed_units to agent workflows for department level sharing.',
        up(db) {
            const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_workflows'").get();
            if (!table) return;
            const columns = db.prepare('PRAGMA table_info(agent_workflows)').all();
            // 历史工作流默认落到"仅自己"，升级后可见性与升级前完全一致
            if (!columns.some(column => column.name === 'scope')) {
                db.exec("ALTER TABLE agent_workflows ADD COLUMN scope TEXT DEFAULT 'personal'");
            }
            if (!columns.some(column => column.name === 'allowed_units')) {
                db.exec("ALTER TABLE agent_workflows ADD COLUMN allowed_units TEXT DEFAULT ''");
            }
            db.exec("UPDATE agent_workflows SET scope = 'personal' WHERE scope IS NULL OR TRIM(scope) = ''");
            db.exec("UPDATE agent_workflows SET allowed_units = '' WHERE allowed_units IS NULL");
            // 补列完成后再建依赖新列的索引，避免旧库启动阶段报缺列
            db.exec('CREATE INDEX IF NOT EXISTS idx_agent_workflows_scope ON agent_workflows(scope, deleted_at, updated_at)');
        }
    },
    {
        id: '202608040002_schedule_cron_expression',
        description: 'Add cron_expression to agent schedules for minute level scheduling.',
        up(db) {
            const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_schedules'").get();
            if (!table) return;
            const columns = db.prepare('PRAGMA table_info(agent_schedules)').all();
            // 历史计划保持 daily/weekly 周期，cron 字段留空即可，行为与升级前一致
            if (!columns.some(column => column.name === 'cron_expression')) {
                db.exec("ALTER TABLE agent_schedules ADD COLUMN cron_expression TEXT DEFAULT ''");
            }
            db.exec("UPDATE agent_schedules SET cron_expression = '' WHERE cron_expression IS NULL");
        }
    },
    {
        id: '202608040003_workflow_triggers',
        description: 'Create workflow trigger table for inbound webhook, file and database triggers.',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS agent_workflow_triggers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    workflow_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    trigger_type TEXT DEFAULT 'webhook',
                    token_hash TEXT,
                    token_hint TEXT DEFAULT '',
                    status TEXT DEFAULT 'active',
                    config_json TEXT DEFAULT '{}',
                    watermark TEXT DEFAULT '',
                    last_triggered_at DATETIME,
                    last_run_id TEXT,
                    trigger_count INTEGER DEFAULT 0,
                    last_error TEXT,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    deleted_at DATETIME,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_user ON agent_workflow_triggers(user_id, deleted_at, updated_at);
                CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_workflow ON agent_workflow_triggers(workflow_id, deleted_at);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workflow_triggers_token ON agent_workflow_triggers(token_hash) WHERE token_hash IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_poll ON agent_workflow_triggers(trigger_type, status, deleted_at);
            `);
        }
    },
    {
        id: '202608040004_workflow_credentials',
        description: 'Create workflow credential vault with department scoped sharing and rotation support.',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS workflow_credentials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    secret_value TEXT NOT NULL,
                    scope TEXT DEFAULT 'personal',
                    allowed_units TEXT DEFAULT '',
                    version INTEGER DEFAULT 1,
                    previous_value TEXT,
                    previous_expires_at DATETIME,
                    last_used_at DATETIME,
                    use_count INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    deleted_at DATETIME,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_workflow_credentials_user ON workflow_credentials(user_id, deleted_at, updated_at);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_credentials_slug ON workflow_credentials(user_id, slug) WHERE deleted_at IS NULL;
                CREATE INDEX IF NOT EXISTS idx_workflow_credentials_scope ON workflow_credentials(scope, deleted_at);
            `);
        }
    },
    {
        id: '202608050001_agent_approval_requests',
        description: 'Create workflow approval request table for DAG approvals and delay checkpoints.',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS agent_approval_requests (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    request_type TEXT DEFAULT 'approval',
                    node_key TEXT DEFAULT '',
                    approval_key TEXT DEFAULT '',
                    title TEXT DEFAULT '',
                    summary TEXT DEFAULT '',
                    instructions TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    current_level INTEGER DEFAULT 1,
                    required_levels INTEGER DEFAULT 1,
                    levels_json TEXT DEFAULT '[]',
                    decisions_json TEXT DEFAULT '[]',
                    input_json TEXT DEFAULT '{}',
                    callback_token_hash TEXT,
                    callback_token_hint TEXT DEFAULT '',
                    callback_nonce TEXT DEFAULT '',
                    callback_credential_slug TEXT DEFAULT '',
                    callback_signature_required INTEGER DEFAULT 0,
                    timeout_action TEXT DEFAULT 'reject',
                    expires_at DATETIME,
                    decided_at DATETIME,
                    decided_by INTEGER,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
                );
                CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_run ON agent_approval_requests(run_id, request_type, status);
                CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_user ON agent_approval_requests(user_id, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_approval_requests_expires ON agent_approval_requests(status, expires_at);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approval_requests_callback_token ON agent_approval_requests(callback_token_hash) WHERE callback_token_hash IS NOT NULL;
            `);
        }
    },
    {
        id: '202608050002_agent_approval_request_callback_nonce',
        description: 'Add callback nonce for workflow approval callback signatures.',
        up(db) {
            const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_approval_requests'").get();
            if (!table) return;
            const columns = db.prepare('PRAGMA table_info(agent_approval_requests)').all();
            if (!columns.some(column => column.name === 'callback_nonce')) {
                db.exec("ALTER TABLE agent_approval_requests ADD COLUMN callback_nonce TEXT DEFAULT ''");
            }
            db.exec(`
                UPDATE agent_approval_requests
                SET callback_nonce = lower(hex(randomblob(16)))
                WHERE callback_signature_required = 1
                  AND (callback_nonce IS NULL OR TRIM(callback_nonce) = '')
            `);
            db.exec(`
                UPDATE agent_approval_requests
                SET callback_nonce = ''
                WHERE callback_signature_required = 0 AND callback_nonce IS NULL
            `);
        }
    },
    {
        id: '202608060001_knowledge_and_tool_unit_visibility',
        description: 'Add unit scoped sharing metadata to knowledge collections and MCP services.',
        up(db) {
            const knowledgeTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_collections'").get();
            if (knowledgeTable) {
                const columns = db.prepare('PRAGMA table_info(knowledge_collections)').all();
                if (!columns.some(column => column.name === 'scope')) {
                    db.exec("ALTER TABLE knowledge_collections ADD COLUMN scope TEXT DEFAULT 'personal'");
                }
                if (!columns.some(column => column.name === 'allowed_units')) {
                    db.exec("ALTER TABLE knowledge_collections ADD COLUMN allowed_units TEXT DEFAULT ''");
                }
                db.exec("UPDATE knowledge_collections SET scope = 'personal' WHERE scope IS NULL OR TRIM(scope) = ''");
                db.exec("UPDATE knowledge_collections SET allowed_units = '' WHERE allowed_units IS NULL");
                db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_collections_scope ON knowledge_collections(scope, deleted_at, updated_at)');
            }

            const mcpTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_servers'").get();
            if (mcpTable) {
                const columns = db.prepare('PRAGMA table_info(mcp_servers)').all();
                if (!columns.some(column => column.name === 'scope')) {
                    db.exec("ALTER TABLE mcp_servers ADD COLUMN scope TEXT DEFAULT 'personal'");
                }
                if (!columns.some(column => column.name === 'allowed_units')) {
                    db.exec("ALTER TABLE mcp_servers ADD COLUMN allowed_units TEXT DEFAULT ''");
                }
                db.exec("UPDATE mcp_servers SET scope = CASE WHEN user_id IS NULL THEN 'shared' ELSE 'personal' END WHERE scope IS NULL OR TRIM(scope) = ''");
                db.exec("UPDATE mcp_servers SET allowed_units = '' WHERE allowed_units IS NULL");
                db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope, status, updated_at)');
            }
        }
    },
    ...regulationsMigrations
];

module.exports = migrations;
