'use strict';
module.exports = [{
        id: '202611100001_agent_projects',
        description: '建立个人项目、规则、资料范围及里程碑，复用既有任务和交付物。',
        async upPg(client) {
            await client.query(`CREATE TABLE IF NOT EXISTS agent_projects (
            id VARCHAR(80) PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title VARCHAR(160) NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
            collection_ids JSONB NOT NULL DEFAULT '[]', artifact_ids JSONB NOT NULL DEFAULT '[]', milestones JSONB NOT NULL DEFAULT '[]',
            status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
            CREATE INDEX IF NOT EXISTS idx_agent_projects_owner_updated ON agent_projects(user_id,status,updated_at DESC,id);
            CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(user_id, (pivot_json_extract(context_config::text,'{projectId}')), created_at DESC)
                WHERE deleted_at IS NULL;`);
        }
    }];
