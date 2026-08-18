function enterpriseTablesSql() {
    return `
        CREATE TABLE IF NOT EXISTS rag_debug_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
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
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS organizations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            status TEXT DEFAULT 'active',
            metadata_json TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            metadata_json TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(organization_id, slug),
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS team_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT DEFAULT 'member',
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(team_id, user_id),
            FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS resource_permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_type TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            action TEXT NOT NULL,
            effect TEXT DEFAULT 'allow',
            conditions_json TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE TABLE IF NOT EXISTS policy_objects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id INTEGER,
            owner_user_id INTEGER,
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            classification TEXT DEFAULT 'internal',
            policy_json TEXT DEFAULT '{}',
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
            FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS deployment_provider_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider_type TEXT NOT NULL,
            provider_key TEXT NOT NULL,
            status TEXT DEFAULT 'planned',
            config_json TEXT DEFAULT '{}',
            health_json TEXT DEFAULT '{}',
            last_checked_at DATETIME,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            UNIQUE(provider_type, provider_key)
        );
    `;
}

function enterpriseIndexesSql() {
    return `
        CREATE INDEX IF NOT EXISTS idx_rag_debug_queries_user_created ON rag_debug_queries(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_rag_debug_queries_created ON rag_debug_queries(created_at);
        CREATE INDEX IF NOT EXISTS idx_teams_org_status ON teams(organization_id, status);
        CREATE INDEX IF NOT EXISTS idx_team_members_user_status ON team_members(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_resource_permissions_subject ON resource_permissions(subject_type, subject_id);
        CREATE INDEX IF NOT EXISTS idx_resource_permissions_resource ON resource_permissions(resource_type, resource_id);
        CREATE INDEX IF NOT EXISTS idx_policy_objects_lookup ON policy_objects(object_type, object_id, status);
        CREATE INDEX IF NOT EXISTS idx_deployment_provider_configs_type ON deployment_provider_configs(provider_type, status);
    `;
}

/**
 * 兼容旧调用点：表 + 索引一次性返回（SQLite 单次 db.exec 场景）
 */
function enterpriseSchemaSql() {
    return `${enterpriseTablesSql()}\n${enterpriseIndexesSql()}`;
}

module.exports = {
    enterpriseTablesSql,
    enterpriseIndexesSql,
    enterpriseSchemaSql
};
