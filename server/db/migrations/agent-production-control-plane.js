/** PostgreSQL-only production control-plane contracts for governed capabilities. */
const baseMigration = {
    id: '202608250001_agent_production_control_plane',
    description: 'Add versioned Skill/workflow releases, channel delivery outbox, inbox events and tenant-scoped reliability.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS field_versions JSONB NOT NULL DEFAULT '{}'::jsonb;
            ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            ALTER TABLE agent_feedback ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            ALTER TABLE agent_evolution_proposals ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS tool_version VARCHAR(64) NOT NULL DEFAULT '';
            ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS task_type VARCHAR(160) NOT NULL DEFAULT '';
            ALTER TABLE agent_tool_reliability ADD COLUMN IF NOT EXISTS task_type VARCHAR(160) NOT NULL DEFAULT '';
            ALTER TABLE agent_tool_reliability ADD COLUMN IF NOT EXISTS tool_version VARCHAR(64) NOT NULL DEFAULT '';

            CREATE TABLE IF NOT EXISTS agent_skill_versions (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                skill_id VARCHAR(64) NOT NULL,
                owner_key VARCHAR(255) NOT NULL,
                name VARCHAR(128) NOT NULL,
                version VARCHAR(32) NOT NULL,
                digest VARCHAR(128) NOT NULL,
                manifest_yaml TEXT NOT NULL,
                instructions_md TEXT NOT NULL DEFAULT '',
                package_path TEXT NOT NULL DEFAULT '',
                source_run_id VARCHAR(128),
                status VARCHAR(32) NOT NULL DEFAULT 'draft',
                created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(owner_key, name, version),
                UNIQUE(owner_key, name, digest)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_skill_versions_lookup
                ON agent_skill_versions(owner_key, name, status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS agent_skill_validations (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                skill_version_id BIGINT NOT NULL REFERENCES agent_skill_versions(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                status VARCHAR(32) NOT NULL DEFAULT 'running',
                manifest_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                signature_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                dependency_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                supply_chain_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                sandbox_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                evaluation_result JSONB NOT NULL DEFAULT '{}'::jsonb,
                risk_level VARCHAR(16) NOT NULL DEFAULT 'medium',
                error_code VARCHAR(64) NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                completed_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_agent_skill_validations_version
                ON agent_skill_validations(skill_version_id, version DESC, created_at DESC);

            CREATE TABLE IF NOT EXISTS agent_skill_releases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                skill_version_id BIGINT NOT NULL REFERENCES agent_skill_versions(id) ON DELETE CASCADE,
                owner_key VARCHAR(255) NOT NULL,
                name VARCHAR(128) NOT NULL,
                rollout_scope VARCHAR(32) NOT NULL DEFAULT 'personal',
                rollout_percent INTEGER NOT NULL DEFAULT 100,
                target_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                target_units JSONB NOT NULL DEFAULT '[]'::jsonb,
                status VARCHAR(24) NOT NULL DEFAULT 'published',
                previous_release_id BIGINT REFERENCES agent_skill_releases(id) ON DELETE SET NULL,
                published_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                published_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                rolled_back_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_agent_skill_releases_runtime
                ON agent_skill_releases(owner_key, name, status, published_at DESC);

            CREATE TABLE IF NOT EXISTS agent_workflow_releases (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                workflow_id BIGINT NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
                workflow_version_id BIGINT NOT NULL REFERENCES agent_workflow_versions(id) ON DELETE CASCADE,
                rollout_scope VARCHAR(32) NOT NULL DEFAULT 'personal',
                rollout_percent INTEGER NOT NULL DEFAULT 100,
                target_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                target_units JSONB NOT NULL DEFAULT '[]'::jsonb,
                status VARCHAR(24) NOT NULL DEFAULT 'published',
                previous_release_id BIGINT REFERENCES agent_workflow_releases(id) ON DELETE SET NULL,
                published_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
                published_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                rolled_back_at TIMESTAMPTZ,
                UNIQUE(workflow_id, workflow_version_id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_workflow_releases_runtime
                ON agent_workflow_releases(workflow_id, status, published_at DESC);

            CREATE TABLE IF NOT EXISTS agent_channel_deliveries (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                binding_id VARCHAR(128) NOT NULL REFERENCES agent_channel_bindings(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                idempotency_key VARCHAR(255) NOT NULL,
                event_type VARCHAR(80) NOT NULL,
                subject VARCHAR(255) NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
                interaction JSONB NOT NULL DEFAULT '{}'::jsonb,
                status VARCHAR(24) NOT NULL DEFAULT 'queued',
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                last_error TEXT NOT NULL DEFAULT '',
                delivered_at TIMESTAMPTZ,
                dead_lettered_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(binding_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_channel_deliveries_due
                ON agent_channel_deliveries(status, next_attempt_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_agent_channel_deliveries_user
                ON agent_channel_deliveries(user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS agent_inbox_events (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                tenant_id BIGINT,
                event_key VARCHAR(255) NOT NULL,
                event_type VARCHAR(80) NOT NULL,
                source_run_id VARCHAR(128),
                source_id VARCHAR(128),
                risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
                title VARCHAR(255) NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                expires_at TIMESTAMPTZ,
                status VARCHAR(24) NOT NULL DEFAULT 'unread',
                snoozed_until TIMESTAMPTZ,
                muted_until TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(user_id, event_key)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_inbox_events_user
                ON agent_inbox_events(user_id, status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_inbox_events_tenant
                ON agent_inbox_events(tenant_id, event_type, created_at DESC);

            ALTER TABLE agent_skill_versions ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            ALTER TABLE agent_skill_releases ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            ALTER TABLE agent_workflow_releases ADD COLUMN IF NOT EXISTS tenant_id BIGINT;

            INSERT INTO agent_skill_versions (skill_id, owner_key, name, version, digest, manifest_yaml, instructions_md, package_path, status, created_by, created_at, updated_at)
            SELECT s.id, s.owner_key, s.name, s.version, s.digest, s.manifest_yaml, s.instructions_md, '', CASE WHEN s.status = 'enabled' THEN 'published' ELSE 'draft' END, NULLIF(s.user_id::text, '')::bigint, s.created_at, s.updated_at
            FROM agent_skills s
            ON CONFLICT(owner_key, name, version) DO NOTHING;
            INSERT INTO agent_skill_releases (skill_version_id, owner_key, name, tenant_id, rollout_scope, rollout_percent, target_user_ids, target_units, status, published_by, published_at)
            SELECT v.id, v.owner_key, v.name, NULL, CASE WHEN v.owner_key LIKE 'scope:%' THEN 'organization' ELSE 'personal' END, 100, '[]'::jsonb, '[]'::jsonb, 'published', v.created_by, v.created_at
            FROM agent_skill_versions v
            WHERE v.status = 'published'
              AND NOT EXISTS (SELECT 1 FROM agent_skill_releases r WHERE r.skill_version_id = v.id);
            INSERT INTO agent_workflow_releases (workflow_id, workflow_version_id, tenant_id, rollout_scope, rollout_percent, target_user_ids, target_units, status, published_by, published_at)
            SELECT w.id, w.published_version_id, NULL, CASE WHEN w.scope = 'shared' THEN 'team' ELSE 'personal' END, 100, '[]'::jsonb, '[]'::jsonb, 'published', w.user_id, w.published_at
            FROM agent_workflows w
            WHERE w.published_version_id IS NOT NULL
              AND w.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM agent_workflow_releases r WHERE r.workflow_id = w.id AND r.workflow_version_id = w.published_version_id);
            UPDATE agent_skill_versions v SET tenant_id = t.organization_id
            FROM team_members tm JOIN teams t ON t.id = tm.team_id
            WHERE v.created_by = tm.user_id AND v.tenant_id IS NULL;
            UPDATE agent_skill_releases r SET tenant_id = v.tenant_id
            FROM agent_skill_versions v WHERE r.skill_version_id = v.id AND r.tenant_id IS NULL;
            UPDATE agent_workflow_releases r SET tenant_id = t.organization_id
            FROM agent_workflows w JOIN team_members tm ON tm.user_id = w.user_id JOIN teams t ON t.id = tm.team_id
            WHERE r.workflow_id = w.id AND r.tenant_id IS NULL;
        `);
    }
};

const tenantMigration = {
    id: '202608250002_agent_release_tenant_columns',
    description: 'Add tenant ownership to published capability releases for runtime isolation.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_skill_versions ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            ALTER TABLE agent_skill_releases ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            ALTER TABLE agent_workflow_releases ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
            UPDATE agent_skill_versions v SET tenant_id = t.organization_id
            FROM team_members tm JOIN teams t ON t.id = tm.team_id
            WHERE v.created_by = tm.user_id AND v.tenant_id IS NULL;
            UPDATE agent_skill_releases r SET tenant_id = v.tenant_id
            FROM agent_skill_versions v WHERE r.skill_version_id = v.id AND r.tenant_id IS NULL;
            UPDATE agent_workflow_releases r SET tenant_id = t.organization_id
            FROM agent_workflows w JOIN team_members tm ON tm.user_id = w.user_id JOIN teams t ON t.id = tm.team_id
            WHERE r.workflow_id = w.id AND r.tenant_id IS NULL;
        `);
    }
};

const digestMigration = {
    id: '202608250003_agent_skill_digest_width',
    description: 'Allow prefixed SHA-256 Skill package digests in the PostgreSQL registry.',
    async upPg(client) {
        await client.query('ALTER TABLE agent_skills ALTER COLUMN digest TYPE VARCHAR(128)');
    }
};

const releaseGateMigration = {
    id: '202608250004_retroactive_release_gates',
    description: 'Demote legacy capabilities without validation evidence so runtime cannot bypass release gates.',
    async upPg(client) {
        await client.query(`
            UPDATE agent_skill_releases r
            SET status = 'cancelled', rolled_back_at = COALESCE(rolled_back_at, NOW() AT TIME ZONE 'Asia/Shanghai')
            WHERE r.status = 'published'
              AND NOT EXISTS (SELECT 1 FROM agent_skill_validations v WHERE v.skill_version_id = r.skill_version_id AND v.status = 'passed');
            UPDATE agent_skill_versions v
            SET status = 'draft', updated_at = NOW() AT TIME ZONE 'Asia/Shanghai'
            WHERE v.status = 'published'
              AND NOT EXISTS (SELECT 1 FROM agent_skill_validations x WHERE x.skill_version_id = v.id AND x.status = 'passed');
            UPDATE agent_skills s
            SET status = 'disabled', updated_at = NOW() AT TIME ZONE 'Asia/Shanghai'
            WHERE s.status = 'enabled'
              AND NOT EXISTS (SELECT 1 FROM agent_skill_releases r WHERE r.name = s.name AND r.owner_key = s.owner_key AND r.status = 'published');
            UPDATE agent_workflow_releases r
            SET status = 'cancelled', rolled_back_at = COALESCE(rolled_back_at, NOW() AT TIME ZONE 'Asia/Shanghai')
            WHERE r.status = 'published'
              AND NOT EXISTS (
                  SELECT 1 FROM agent_eval_runs er
                  JOIN agent_eval_suites es ON es.id = er.suite_id
                  WHERE es.workflow_id = r.workflow_id
                    AND er.status = 'completed'
                    AND COALESCE((NULLIF(er.summary, '')::jsonb->>'passRate')::numeric, 0) >= 80
              );
            UPDATE agent_workflows w
            SET published_version_id = NULL, published_at = NULL, updated_at = NOW() AT TIME ZONE 'Asia/Shanghai'
            WHERE w.published_version_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM agent_workflow_releases r WHERE r.workflow_id = w.id AND r.status = 'published');
        `);
    }
};

const legacySkillVisibilityMigration = {
    id: '202608250005_disable_unvalidated_legacy_skills',
    description: 'Hide legacy Skill registry entries that have no published validated release.',
    async upPg(client) {
        await client.query(`UPDATE agent_skills s SET status = 'disabled', updated_at = NOW() AT TIME ZONE 'Asia/Shanghai' WHERE s.status = 'enabled' AND NOT EXISTS (SELECT 1 FROM agent_skill_releases r WHERE r.name = s.name AND r.owner_key = s.owner_key AND r.status = 'published')`);
    }
};

module.exports = [baseMigration, tenantMigration, digestMigration, releaseGateMigration, legacySkillVisibilityMigration];
