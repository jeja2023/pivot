const crypto = require('crypto');
const { buildRagSearchContent } = require('../../services/rag-tokenizer');
const regulationsMigrations = require('./regulations');
const { enterpriseSchemaSql } = require('../schema/enterprise');
const personalAgentMigrations = require('./personal-agent');
const personalAgentControlPlaneMigrations = require('./personal-agent-control-plane');
const agentProductionControlPlaneMigrations = require('./agent-production-control-plane');
const agentSkillGovernanceMigrations = require('./agent-skill-governance');
const agentArtifactDeliveryMigrations = require('./agent-artifact-delivery');
const agentStandaloneArtifactMigrations = require('./agent-standalone-artifacts');
const agentArtifactCasRefcountMigrations = require('./agent-artifact-cas-refcounts');
const agentLocalConnectorMigrations = require('./agent-local-connector');

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
                    name VARCHAR(128) NOT NULL,
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
    {
        id: '202608210003_agent_harness_context_events',
        description: 'Add PostgreSQL AgentStepContext hashes, WorldState event sequencing, and append-only Agent events.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE agent_runs
                    ADD COLUMN IF NOT EXISTS event_seq BIGINT NOT NULL DEFAULT 0;
                ALTER TABLE agent_steps
                    ADD COLUMN IF NOT EXISTS context_hash VARCHAR(64) DEFAULT '';
                ALTER TABLE agent_trace_spans
                    ADD COLUMN IF NOT EXISTS context_hash VARCHAR(64) DEFAULT '';
                ALTER TABLE agent_tool_calls
                    ADD COLUMN IF NOT EXISTS context_hash VARCHAR(64) DEFAULT '';
                CREATE TABLE IF NOT EXISTS agent_events (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    run_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    event_seq BIGINT NOT NULL,
                    event_key VARCHAR(255) DEFAULT '',
                    event_type VARCHAR(80) NOT NULL,
                    turn_id VARCHAR(160) DEFAULT '',
                    step_index INTEGER DEFAULT 0,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    payload_hash VARCHAR(64) NOT NULL,
                    provider_visible BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    UNIQUE(run_id, event_seq),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_events_run_seq ON agent_events(run_id, event_seq);
                CREATE INDEX IF NOT EXISTS idx_agent_events_user_seq ON agent_events(user_id, event_seq);
                CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_steps_context_hash ON agent_steps(context_hash);
                CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_context_hash ON agent_trace_spans(context_hash);
                CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_context_hash ON agent_tool_calls(context_hash);
            `);
        }
    },
    {
        id: '202608220001_agent_control_mailbox',
        description: 'Add PostgreSQL parent-child AgentControl mailbox with scoped delivery and acknowledgements.',
        async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_control_messages (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    message_id VARCHAR(128) NOT NULL UNIQUE,
                    user_id BIGINT NOT NULL,
                    from_run_id VARCHAR(128),
                    to_run_id VARCHAR(128) NOT NULL,
                    message_type VARCHAR(40) NOT NULL DEFAULT 'steer',
                    status VARCHAR(24) NOT NULL DEFAULT 'pending',
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    payload_hash VARCHAR(64) NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    delivered_at TIMESTAMPTZ,
                    acknowledged_at TIMESTAMPTZ,
                    expires_at TIMESTAMPTZ,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (from_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (to_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_control_to_status ON agent_control_messages(to_run_id, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_control_user_created ON agent_control_messages(user_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_control_from_run ON agent_control_messages(from_run_id, created_at);
            `);
        }
    },
    {
        id: '202608220002_agent_world_state_windows',
        description: 'Persist PostgreSQL WorldState context windows, baselines, and replayable snapshots for Agent runs.',
        async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_context_windows (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    window_id VARCHAR(128) NOT NULL UNIQUE,
                    run_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    window_version INTEGER NOT NULL,
                    parent_window_id VARCHAR(128),
                    status VARCHAR(24) NOT NULL DEFAULT 'active',
                    opened_reason VARCHAR(64) NOT NULL DEFAULT 'initial',
                    initial_state_hash VARCHAR(64) NOT NULL DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    closed_at TIMESTAMPTZ,
                    UNIQUE(run_id, window_version),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS agent_world_state_snapshots (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    snapshot_id VARCHAR(128) NOT NULL UNIQUE,
                    run_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    window_id VARCHAR(128) NOT NULL,
                    snapshot_version INTEGER NOT NULL,
                    turn_id VARCHAR(160) DEFAULT '',
                    step_index INTEGER DEFAULT 0,
                    context_hash VARCHAR(64) NOT NULL DEFAULT '',
                    state_hash VARCHAR(64) NOT NULL,
                    base_state_hash VARCHAR(64) DEFAULT '',
                    injection_mode VARCHAR(16) NOT NULL DEFAULT 'full',
                    full_refresh_reason VARCHAR(64) DEFAULT '',
                    state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    patch JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    UNIQUE(run_id, snapshot_version),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (window_id) REFERENCES agent_context_windows(window_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_context_windows_run_version
                    ON agent_context_windows(run_id, window_version DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_context_windows_user_created
                    ON agent_context_windows(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_world_state_run_version
                    ON agent_world_state_snapshots(run_id, snapshot_version DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_world_state_window_version
                    ON agent_world_state_snapshots(window_id, snapshot_version ASC);
                CREATE INDEX IF NOT EXISTS idx_agent_world_state_context_hash
                    ON agent_world_state_snapshots(context_hash);
            `);
        }
    },
    {
        id: '202608220003_agent_event_outbox',
        description: 'Persist PostgreSQL Agent event notifications for retryable cross-process delivery and replay cursors.',
        async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_event_outbox (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    event_id BIGINT NOT NULL UNIQUE,
                    run_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    event_seq BIGINT NOT NULL,
                    event_type VARCHAR(80) NOT NULL,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    status VARCHAR(24) NOT NULL DEFAULT 'pending',
                    delivery_attempts INTEGER NOT NULL DEFAULT 0,
                    available_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    locked_at TIMESTAMPTZ,
                    locked_by VARCHAR(128) DEFAULT '',
                    delivered_at TIMESTAMPTZ,
                    last_error TEXT DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    FOREIGN KEY (event_id) REFERENCES agent_events(id) ON DELETE CASCADE,
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_pending
                    ON agent_event_outbox(status, available_at, id);
                CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_run_seq
                    ON agent_event_outbox(run_id, event_seq);
                CREATE INDEX IF NOT EXISTS idx_agent_event_outbox_user_status
                    ON agent_event_outbox(user_id, status, created_at);
            `);
        }
    },
    {
        id: '202608220004_agent_run_resources',
        description: 'Track PostgreSQL Agent child budget reservations, concurrency limits, and fork history policy.',
        async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_run_resources (
                    run_id VARCHAR(128) PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    parent_run_id VARCHAR(128),
                    token_budget BIGINT NOT NULL DEFAULT 0,
                    tokens_reserved BIGINT NOT NULL DEFAULT 0,
                    tokens_consumed BIGINT NOT NULL DEFAULT 0,
                    max_children INTEGER NOT NULL DEFAULT 4,
                    active_children INTEGER NOT NULL DEFAULT 0,
                    fork_history_mode VARCHAR(16) NOT NULL DEFAULT 'none',
                    fork_history_turns INTEGER NOT NULL DEFAULT 0,
                    reservation_released BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (parent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_agent_run_resources_parent
                    ON agent_run_resources(parent_run_id, reservation_released);
                CREATE INDEX IF NOT EXISTS idx_agent_run_resources_user
                    ON agent_run_resources(user_id, created_at DESC);
            `);
        }
    },
    {
        id: '202608220005_chat_context_windows',
        description: 'Persist PostgreSQL Chat context windows and compact world-state snapshots for cross-entry replay.',
        async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS chat_context_windows (
                    window_id VARCHAR(128) PRIMARY KEY,
                    session_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    window_version INTEGER NOT NULL,
                    parent_window_id VARCHAR(128),
                    status VARCHAR(24) NOT NULL DEFAULT 'active',
                    opened_reason VARCHAR(64) NOT NULL DEFAULT 'initial',
                    initial_state_hash VARCHAR(64) NOT NULL DEFAULT '',
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    closed_at TIMESTAMPTZ,
                    UNIQUE(session_id, user_id, window_version),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS chat_context_snapshots (
                    snapshot_id VARCHAR(128) PRIMARY KEY,
                    session_id VARCHAR(128) NOT NULL,
                    user_id BIGINT NOT NULL,
                    window_id VARCHAR(128) NOT NULL,
                    snapshot_version INTEGER NOT NULL,
                    turn_id VARCHAR(160) NOT NULL DEFAULT '',
                    context_hash VARCHAR(64) NOT NULL DEFAULT '',
                    state_hash VARCHAR(64) NOT NULL,
                    base_state_hash VARCHAR(64) NOT NULL DEFAULT '',
                    injection_mode VARCHAR(16) NOT NULL DEFAULT 'full',
                    full_refresh_reason VARCHAR(64) NOT NULL DEFAULT '',
                    state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    patch JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    UNIQUE(session_id, user_id, snapshot_version),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (window_id) REFERENCES chat_context_windows(window_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_chat_context_windows_session
                    ON chat_context_windows(session_id, user_id, window_version DESC);
                CREATE INDEX IF NOT EXISTS idx_chat_context_snapshots_session
                    ON chat_context_snapshots(session_id, user_id, snapshot_version DESC);
                CREATE INDEX IF NOT EXISTS idx_chat_context_snapshots_hash
                    ON chat_context_snapshots(context_hash);
            `);
        }
    },
    {
        id: '202608220006_agent_residency',
        description: 'Persist PostgreSQL resident Agent state with leases, expiry and per-user LRU eviction.',
        async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS agent_residencies (
                    resident_id VARCHAR(128) PRIMARY KEY,
                    user_id BIGINT NOT NULL,
                    resident_key VARCHAR(255) NOT NULL,
                    run_id VARCHAR(128),
                    status VARCHAR(24) NOT NULL DEFAULT 'idle',
                    state JSONB NOT NULL DEFAULT '{}'::jsonb,
                    context_hash VARCHAR(64) NOT NULL DEFAULT '',
                    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    expires_at TIMESTAMPTZ,
                    lease_owner VARCHAR(128) NOT NULL DEFAULT '',
                    lease_expires_at TIMESTAMPTZ,
                    hit_count BIGINT NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    UNIQUE(user_id, resident_key),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
                );
                CREATE INDEX IF NOT EXISTS idx_agent_residencies_user_access
                    ON agent_residencies(user_id, status, last_accessed_at ASC);
                CREATE INDEX IF NOT EXISTS idx_agent_residencies_expiry
                    ON agent_residencies(status, expires_at, lease_expires_at);
                CREATE INDEX IF NOT EXISTS idx_agent_residencies_run
                    ON agent_residencies(run_id, updated_at DESC);
            `);
        }
    },
    {
        id: '202608220007_provider_usage_calibration',
        description: 'Persist real Provider usage samples and aggregate estimate error metrics per model and protocol.',
        async upPg(client) {
            await client.query(`
                CREATE TABLE IF NOT EXISTS model_usage_calibrations (
                    model_id BIGINT NOT NULL,
                    protocol VARCHAR(32) NOT NULL DEFAULT 'unknown',
                    sample_count BIGINT NOT NULL DEFAULT 0,
                    input_sample_count BIGINT NOT NULL DEFAULT 0,
                    output_sample_count BIGINT NOT NULL DEFAULT 0,
                    estimated_input_tokens BIGINT NOT NULL DEFAULT 0,
                    actual_input_tokens BIGINT NOT NULL DEFAULT 0,
                    input_abs_error_tokens BIGINT NOT NULL DEFAULT 0,
                    input_signed_error_tokens BIGINT NOT NULL DEFAULT 0,
                    max_input_abs_error_tokens BIGINT NOT NULL DEFAULT 0,
                    estimated_output_tokens BIGINT NOT NULL DEFAULT 0,
                    actual_output_tokens BIGINT NOT NULL DEFAULT 0,
                    output_abs_error_tokens BIGINT NOT NULL DEFAULT 0,
                    output_signed_error_tokens BIGINT NOT NULL DEFAULT 0,
                    max_output_abs_error_tokens BIGINT NOT NULL DEFAULT 0,
                    last_actual_total_tokens BIGINT NOT NULL DEFAULT 0,
                    last_source VARCHAR(80) NOT NULL DEFAULT '',
                    last_sample_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                    PRIMARY KEY (model_id, protocol)
                );
                CREATE INDEX IF NOT EXISTS idx_model_usage_calibrations_updated
                    ON model_usage_calibrations(updated_at DESC);
            `);
        }
    },
    {
        id: '202608220008_workflow_credential_user_visibility',
        description: 'Persist individual user targets for shared workflow credentials.',
        up(db) {
            const columns = db.pragma('table_info(workflow_credentials)');
            if (!columns.length) return;
            if (!columns.some(column => column.name === 'allowed_user_ids')) {
                db.exec("ALTER TABLE workflow_credentials ADD COLUMN allowed_user_ids TEXT DEFAULT ''");
            }
            db.exec("UPDATE workflow_credentials SET allowed_user_ids = '' WHERE allowed_user_ids IS NULL");
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE workflow_credentials
                ADD COLUMN IF NOT EXISTS allowed_user_ids TEXT DEFAULT '';
                UPDATE workflow_credentials
                SET allowed_user_ids = ''
                WHERE allowed_user_ids IS NULL;
            `);
        }
    },
    {
        id: '202608220009_chat_agent_run_message_link',
        description: 'Link assistant chat messages created by persistent Agent runs for idempotent recovery.',
        up(db) {
            const columns = db.pragma('table_info(messages)');
            if (columns.length && !columns.some(column => column.name === 'agent_run_id')) {
                db.exec('ALTER TABLE messages ADD COLUMN agent_run_id TEXT');
            }
            if (columns.length) {
                db.exec('CREATE INDEX IF NOT EXISTS idx_messages_agent_run ON messages(agent_run_id)');
                db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_agent_run_unique ON messages(agent_run_id) WHERE agent_run_id IS NOT NULL');
            }
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_run_id VARCHAR(128);
                CREATE INDEX IF NOT EXISTS idx_messages_agent_run ON messages(agent_run_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_agent_run_unique ON messages(agent_run_id) WHERE agent_run_id IS NOT NULL;
            `);
        }
    },
    ...personalAgentMigrations,
    ...personalAgentControlPlaneMigrations,
    ...agentProductionControlPlaneMigrations,
    ...agentSkillGovernanceMigrations,
    ...agentArtifactDeliveryMigrations,
    ...agentStandaloneArtifactMigrations,
    ...agentArtifactCasRefcountMigrations,
    ...agentLocalConnectorMigrations,
    ...regulationsMigrations
];

module.exports = migrations;
