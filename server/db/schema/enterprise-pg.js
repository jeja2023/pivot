/**
 * server/db/schema/enterprise-pg.js
 * 企业扩展表的 PostgreSQL DDL（对应 enterprise.js）
 */
const PG_NOW = `(NOW() AT TIME ZONE 'Asia/Shanghai')`;

async function initEnterpriseSchemaStatements(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS rag_debug_queries (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id BIGINT NOT NULL,
            query TEXT NOT NULL,
            scope_json TEXT DEFAULT '{}',
            top_k INTEGER DEFAULT 0,
            candidate_limit INTEGER DEFAULT 0,
            score_threshold REAL DEFAULT 0,
            candidate_count INTEGER DEFAULT 0,
            matched_count INTEGER DEFAULT 0,
            selected_chunk_ids TEXT DEFAULT '[]',
            scores_json TEXT DEFAULT '[]',
            queue_json TEXT DEFAULT '{}',
            elapsed_ms INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS organizations (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            status TEXT DEFAULT 'active',
            metadata_json TEXT DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            updated_at TIMESTAMPTZ DEFAULT ${PG_NOW}
        )
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS teams (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            organization_id BIGINT NOT NULL,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            metadata_json TEXT DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            updated_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            UNIQUE(organization_id, slug),
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
        )
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS team_members (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            team_id BIGINT NOT NULL,
            user_id BIGINT NOT NULL,
            role TEXT DEFAULT 'member',
            status TEXT DEFAULT 'active',
            created_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            updated_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            UNIQUE(team_id, user_id),
            FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS resource_permissions (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            subject_type TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            action TEXT NOT NULL,
            effect TEXT DEFAULT 'allow',
            conditions_json TEXT DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            updated_at TIMESTAMPTZ DEFAULT ${PG_NOW}
        )
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS policy_objects (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            organization_id BIGINT,
            owner_user_id BIGINT,
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            classification TEXT DEFAULT 'internal',
            policy_json TEXT DEFAULT '{}',
            status TEXT DEFAULT 'active',
            created_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            updated_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
            FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS deployment_provider_configs (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            provider_type TEXT NOT NULL,
            provider_key TEXT NOT NULL,
            status TEXT DEFAULT 'planned',
            config_json TEXT DEFAULT '{}',
            health_json TEXT DEFAULT '{}',
            last_checked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            updated_at TIMESTAMPTZ DEFAULT ${PG_NOW},
            UNIQUE(provider_type, provider_key)
        )
    `);

    // 索引
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rag_debug_queries_user_created ON rag_debug_queries(user_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rag_debug_queries_created ON rag_debug_queries(created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_teams_org_status ON teams(organization_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_team_members_user_status ON team_members(user_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_resource_permissions_subject ON resource_permissions(subject_type, subject_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_resource_permissions_resource ON resource_permissions(resource_type, resource_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_policy_objects_lookup ON policy_objects(object_type, object_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_deployment_provider_configs_type ON deployment_provider_configs(provider_type, status)`);
}

function enterpriseSchemaSqlPg() {
    // 保留与 SQLite 版本相同的接口名称，供 pg.js 导入调用
    return null; // pg.js 直接调用 initEnterpriseSchemaStatements
}

module.exports = { initEnterpriseSchemaStatements, enterpriseSchemaSqlPg };
