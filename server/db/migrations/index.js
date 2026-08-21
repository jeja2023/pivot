const crypto = require('crypto');
const { buildRagSearchContent } = require('../../services/rag-tokenizer');
const regulationsMigrations = require('./regulations');
const { enterpriseSchemaSql } = require('../schema/enterprise');

function archiveDeletedUsernameInSqlite(database, userId) {
    const normalizedUserId = Number.parseInt(userId, 10);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) return false;
    const user = database.prepare(
        'SELECT id, username, deleted_username, deleted_at FROM users WHERE id = ?'
    ).get(normalizedUserId);
    if (!user || !user.deleted_at) return false;

    const deletedUsername = String(user.deleted_username || user.username || '').trim();
    const base = `@deleted:${normalizedUserId}`;
    let candidate = base;
    let suffix = 0;

    while (database.prepare('SELECT COUNT(*) AS count FROM users WHERE username = ? AND id != ?').get(candidate, normalizedUserId)?.count > 0) {
        suffix += 1;
        candidate = `${base}:${suffix}`;
    }

    const result = database.prepare(
        'UPDATE users SET username = ?, deleted_username = ? WHERE id = ? AND deleted_at IS NOT NULL'
    ).run(candidate, deletedUsername, normalizedUserId);
    return Number(result?.changes || 0) > 0;
}

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
            deletedUsers.forEach(user => archiveDeletedUsernameInSqlite(db, user.id));
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
    {
        id: '202608070001_resource_user_visibility',
        description: 'Add individual user targets to workflow, knowledge collection, and MCP sharing.',
        up(db) {
            ['agent_workflows', 'knowledge_collections', 'mcp_servers'].forEach(table => {
                const columns = db.pragma(`table_info(${table})`);
                if (!columns.length) return;
                if (!columns.some(column => column.name === 'allowed_user_ids')) {
                    db.exec(`ALTER TABLE ${table} ADD COLUMN allowed_user_ids TEXT DEFAULT ''`);
                }
                db.exec(`UPDATE ${table} SET allowed_user_ids = '' WHERE allowed_user_ids IS NULL`);
            });
        }
    },
    {
        id: '202608070002_workflow_dependency_bindings',
        description: 'Create per-recipient workflow dependency bindings pinned to a published version.',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS agent_workflow_dependency_bindings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    workflow_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    published_version_id INTEGER NOT NULL,
                    bindings_json TEXT DEFAULT '{}',
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    UNIQUE(workflow_id, user_id),
                    FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (published_version_id) REFERENCES agent_workflow_versions(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_workflow_dependency_bindings_user
                    ON agent_workflow_dependency_bindings(user_id, updated_at);
            `);
        }
    },
    {
        id: '202608120001_agent_runtime_concurrency_guards',
        description: 'Add polling leases and allow dedupe keys to be reused after soft deletion.',
        up(db) {
            const triggerColumns = db.pragma('table_info(agent_workflow_triggers)');
            if (triggerColumns.length) {
                if (!triggerColumns.some(column => column.name === 'claim_token')) {
                    db.exec('ALTER TABLE agent_workflow_triggers ADD COLUMN claim_token TEXT');
                }
                if (!triggerColumns.some(column => column.name === 'claim_expires_at')) {
                    db.exec('ALTER TABLE agent_workflow_triggers ADD COLUMN claim_expires_at DATETIME');
                }
                db.exec('CREATE INDEX IF NOT EXISTS idx_agent_workflow_triggers_claim ON agent_workflow_triggers(status, trigger_type, claim_expires_at, deleted_at)');
            }
            const runColumns = db.pragma('table_info(agent_runs)');
            if (runColumns.length) {
                db.exec('DROP INDEX IF EXISTS idx_agent_runs_user_dedupe');
                db.exec('CREATE UNIQUE INDEX idx_agent_runs_user_dedupe ON agent_runs(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL');
            }
        }
    },
    {
        id: '202608120002_agent_approval_request_dedupe',
        description: 'Prevent concurrent duplicate pending approval and delay requests.',
        up(db) {
            const columns = db.pragma('table_info(agent_approval_requests)');
            if (!columns.length) return;
            db.exec(`
                UPDATE agent_approval_requests
                SET status = 'cancelled', updated_at = datetime('now', '+8 hours')
                WHERE status = 'pending'
                  AND rowid NOT IN (
                      SELECT MAX(rowid)
                      FROM agent_approval_requests
                      WHERE status = 'pending'
                      GROUP BY run_id, request_type, approval_key
                  );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_approval_requests_pending_key
                    ON agent_approval_requests(run_id, request_type, approval_key)
                    WHERE status = 'pending';
            `);
        }
    },
    {
        id: '202608060002_schedule_interval_minutes',
        description: 'Add first class minute intervals to agent schedules.',
        up(db) {
            const columns = db.pragma('table_info(agent_schedules)');
            if (!columns.length) return;
            if (!columns.some(column => column.name === 'interval_minutes')) {
                db.exec('ALTER TABLE agent_schedules ADD COLUMN interval_minutes INTEGER DEFAULT 0');
            }
            db.exec('UPDATE agent_schedules SET interval_minutes = 0 WHERE interval_minutes IS NULL');
        }
    },
    {
        id: '202608200001_analysis_dataset_scope_metadata',
        description: 'Record source size and truncation metadata for data analysis datasets.',
        up(db) {
            const columns = db.pragma('table_info(analysis_datasets)');
            if (!columns.length) return;
            const existing = new Set(columns.map(column => column.name));
            if (!existing.has('source_row_count')) {
                db.exec('ALTER TABLE analysis_datasets ADD COLUMN source_row_count INTEGER DEFAULT 0');
            }
            if (!existing.has('source_column_count')) {
                db.exec('ALTER TABLE analysis_datasets ADD COLUMN source_column_count INTEGER DEFAULT 0');
            }
            if (!existing.has('truncated')) {
                db.exec('ALTER TABLE analysis_datasets ADD COLUMN truncated INTEGER DEFAULT 0');
            }
            if (!existing.has('truncation_reason')) {
                db.exec("ALTER TABLE analysis_datasets ADD COLUMN truncation_reason TEXT DEFAULT ''");
            }
            db.exec("UPDATE analysis_datasets SET source_row_count = row_count WHERE source_row_count IS NULL OR source_row_count = 0");
            db.exec("UPDATE analysis_datasets SET source_column_count = column_count WHERE source_column_count IS NULL OR source_column_count = 0");
            db.exec("UPDATE analysis_datasets SET truncated = 2, truncation_reason = '历史数据：迁移前未记录来源范围，无法确认是否截断' WHERE truncated = 0 AND (source_row_count = row_count OR source_row_count IS NULL)");
            db.exec("UPDATE analysis_datasets SET truncated = 0 WHERE truncated IS NULL");
            db.exec("UPDATE analysis_datasets SET truncation_reason = '' WHERE truncation_reason IS NULL");
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE analysis_datasets
                    ADD COLUMN IF NOT EXISTS source_row_count INTEGER DEFAULT 0,
                    ADD COLUMN IF NOT EXISTS source_column_count INTEGER DEFAULT 0,
                    ADD COLUMN IF NOT EXISTS truncated INTEGER DEFAULT 0,
                    ADD COLUMN IF NOT EXISTS truncation_reason TEXT DEFAULT '';
                UPDATE analysis_datasets
                SET source_row_count = COALESCE(NULLIF(source_row_count, 0), row_count),
                    source_column_count = COALESCE(NULLIF(source_column_count, 0), column_count),
                    truncated = CASE WHEN COALESCE(truncated, 0) = 0 THEN 2 ELSE truncated END,
                    truncation_reason = CASE WHEN COALESCE(truncated, 0) = 0 THEN '历史数据：迁移前未记录来源范围，无法确认是否截断' ELSE COALESCE(truncation_reason, '') END
            `);
        }
    },
    {
        id: '202608210001_autonomous_agent_runtime_contracts',
        description: 'Add autonomous Agent budget, tool governance audit, and Skill registry contracts.',
        up(db) {
            const runColumns = db.pragma('table_info(agent_runs)');
            if (runColumns.length) {
                const existing = new Set(runColumns.map(column => column.name));
                if (!existing.has('budget_config')) db.exec("ALTER TABLE agent_runs ADD COLUMN budget_config TEXT DEFAULT '{}'");
                if (!existing.has('usage_stats')) db.exec("ALTER TABLE agent_runs ADD COLUMN usage_stats TEXT DEFAULT '{}'");
            }
            db.exec(`
                CREATE TABLE IF NOT EXISTS agent_tool_calls (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    step_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    capability TEXT DEFAULT 'agent.execute',
                    risk_level INTEGER DEFAULT 0,
                    policy_decision TEXT NOT NULL,
                    policy_version TEXT DEFAULT 'v1',
                    approval_id TEXT,
                    idempotent INTEGER DEFAULT 0,
                    input_payload TEXT DEFAULT '{}',
                    input_hash TEXT,
                    output_payload_ref TEXT,
                    output_hash TEXT,
                    status TEXT NOT NULL,
                    error_category TEXT,
                    error_message TEXT,
                    duration_ms INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run ON agent_tool_calls(run_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_tool ON agent_tool_calls(tool_name);
                CREATE TABLE IF NOT EXISTS agent_skills (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    version TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    publisher TEXT DEFAULT '',
                    digest TEXT NOT NULL,
                    manifest_yaml TEXT NOT NULL,
                    instructions_md TEXT DEFAULT '',
                    scope TEXT DEFAULT 'user',
                    user_id INTEGER,
                    status TEXT DEFAULT 'enabled',
                    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_skills_user ON agent_skills(user_id, status, updated_at);
            `);
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE agent_runs
                    ADD COLUMN IF NOT EXISTS budget_config JSONB DEFAULT '{}'::jsonb,
                    ADD COLUMN IF NOT EXISTS usage_stats JSONB DEFAULT '{}'::jsonb;
                CREATE TABLE IF NOT EXISTS agent_tool_calls (
                    id VARCHAR(64) PRIMARY KEY,
                    run_id VARCHAR(64) NOT NULL,
                    step_id VARCHAR(64) NOT NULL,
                    tool_name VARCHAR(128) NOT NULL,
                    capability VARCHAR(128) DEFAULT 'agent.execute',
                    risk_level INTEGER DEFAULT 0,
                    policy_decision VARCHAR(32) NOT NULL,
                    policy_version VARCHAR(32) DEFAULT 'v1',
                    approval_id VARCHAR(64),
                    idempotent BOOLEAN DEFAULT FALSE,
                    input_payload JSONB DEFAULT '{}'::jsonb,
                    input_hash VARCHAR(64),
                    output_payload_ref TEXT,
                    output_hash VARCHAR(64),
                    status VARCHAR(32) NOT NULL,
                    error_category VARCHAR(32),
                    error_message TEXT,
                    duration_ms INTEGER DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
                );
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run ON agent_tool_calls(run_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_tool ON agent_tool_calls(tool_name);
                CREATE TABLE IF NOT EXISTS agent_skills (
                    id VARCHAR(64) PRIMARY KEY,
                    name VARCHAR(128) UNIQUE NOT NULL,
                    version VARCHAR(32) NOT NULL,
                    title VARCHAR(255) NOT NULL,
                    description TEXT DEFAULT '',
                    publisher VARCHAR(128) DEFAULT '',
                    digest VARCHAR(64) NOT NULL,
                    manifest_yaml TEXT NOT NULL,
                    instructions_md TEXT DEFAULT '',
                    scope VARCHAR(32) DEFAULT 'user',
                    user_id VARCHAR(64),
                    status VARCHAR(32) DEFAULT 'enabled',
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
                );
                CREATE INDEX IF NOT EXISTS idx_agent_skills_user ON agent_skills(user_id, status, updated_at);
                COMMENT ON TABLE agent_tool_calls IS '智能体工具调用治理与执行审计表';
                COMMENT ON TABLE agent_skills IS '企业级 Skill 清单与供应链校验登记表';
            `);
        }
    },
    {
        id: '202608210002_agent_execution_ledger',
        description: 'Add idempotent tool execution ledger, network policy persistence, and Skill tenant ownership.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS network_policy JSONB DEFAULT '{}'::jsonb;
                CREATE TABLE IF NOT EXISTS agent_run_checkpoints (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    checkpoint_id VARCHAR(128) NOT NULL UNIQUE,
                    run_id VARCHAR(128) NOT NULL,
                    step_index INTEGER DEFAULT 0,
                    checkpoint_type VARCHAR(32) DEFAULT 'step',
                    status VARCHAR(32) DEFAULT 'completed',
                    state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
                );
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS operation_key VARCHAR(255);
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS tool_name VARCHAR(128) DEFAULT '';
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS input_hash VARCHAR(64) DEFAULT '';
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS idempotent BOOLEAN DEFAULT FALSE;
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;
                ALTER TABLE agent_run_checkpoints ADD COLUMN IF NOT EXISTS attempt INTEGER DEFAULT 1;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_checkpoints_operation_key ON agent_run_checkpoints(operation_key) WHERE operation_key IS NOT NULL;
                ALTER TABLE agent_skills DROP CONSTRAINT IF EXISTS agent_skills_name_key;
                UPDATE agent_skills SET user_id = NULL WHERE user_id IS NOT NULL AND TRIM(user_id) !~ '^[0-9]+$';
                ALTER TABLE agent_skills ALTER COLUMN user_id TYPE BIGINT USING NULLIF(TRIM(user_id), '')::bigint;
                ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS owner_key VARCHAR(255) DEFAULT '';
                UPDATE agent_skills SET owner_key = CASE WHEN scope IN ('global', 'shared') THEN 'scope:' || scope ELSE 'user:' || COALESCE(user_id::text, '') END WHERE owner_key IS NULL OR owner_key = '';
                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_owner_name ON agent_skills(owner_key, name);
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_skills_user_id_fkey') THEN
                        ALTER TABLE agent_skills ADD CONSTRAINT agent_skills_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
                    END IF;
                END $$;
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_tool_calls_run_id_fkey') THEN
                        ALTER TABLE agent_tool_calls ADD CONSTRAINT agent_tool_calls_run_id_fkey FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE;
                    END IF;
                END $$;
                ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS attempt INTEGER DEFAULT 1;
                ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS operation_key VARCHAR(255);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_operation ON agent_tool_calls(operation_key);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_input_gin ON agent_tool_calls USING gin(input_payload);
            `);
        }
    },
    ...regulationsMigrations
];

module.exports = migrations;
