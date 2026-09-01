/**
 * server/db/migrations/agent-skill-governance.js
 * 技能治理控制面增量迁移（PostgreSQL-only）
 *
 * 落地方案 v1.2 §6.2、§4.2（部署矩阵决策 A）：
 * 控制面表只存在于 PostgreSQL 部署，因此本文件只提供 upPg / downPg；
 * SQLite 侧不创建控制面，由 agent-control-plane-state.js 给出确定性降级。
 *
 * 迁移在既有 agent_skill_* 表上做增量演进，不新建平行表族：
 * 1. 补齐签名信封、内容摘要、规范化 manifest、租户、团队、灰度密钥版本与熔断阈值列；
 * 2. 按 §6.1 第 4 条回填 tenant_id 并收敛历史 owner_key，无法回溯的行按 cancelled 处理；
 * 3. 用触发器保证已验证版本的制品字段不可变。
 */

const defaultTenantMigration = {
    id: '202608310001_agent_skill_default_tenant',
    description: 'Create the single-tenant default organization used when enterprise access is disabled.',
    async upPg(client) {
        await client.query(`
            INSERT INTO organizations (id, name, slug, status)
            OVERRIDING SYSTEM VALUE
            SELECT 1, '默认组织', 'default', 'active'
            WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE id = 1);
        `);
        // 显式插入 id 后必须推进标识列序列，否则后续自增插入会与 id=1 冲突。
        await client.query(`
            SELECT setval(
                pg_get_serial_sequence('organizations', 'id'),
                GREATEST((SELECT COALESCE(MAX(id), 1) FROM organizations), 1)
            )
            WHERE pg_get_serial_sequence('organizations', 'id') IS NOT NULL;
        `);
    },
    async downPg(client) {
        // 默认组织可能已被真实数据引用，回滚只在完全未被引用时删除。
        await client.query(`
            DELETE FROM organizations o
            WHERE o.id = 1
              AND o.slug = 'default'
              AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.organization_id = o.id)
              AND NOT EXISTS (SELECT 1 FROM agent_skill_releases r WHERE r.tenant_id = o.id);
        `);
    }
};

const governanceColumnsMigration = {
    id: '202608310002_agent_skill_governance_columns',
    description: 'Add signing envelopes, content digests, tenant/team scoping, rollout secret versions and breaker thresholds.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_skill_signing_envelopes (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                content_digest VARCHAR(128) NOT NULL,
                key_id VARCHAR(128) NOT NULL,
                algorithm VARCHAR(64) NOT NULL DEFAULT 'RSA-SHA256',
                signature TEXT NOT NULL,
                signature_form VARCHAR(16) NOT NULL,
                issued_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                revoked_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                UNIQUE(content_digest, key_id, signature_form)
            );
            COMMENT ON TABLE agent_skill_signing_envelopes IS '技能签名信封：导入期与验证期共用的唯一签名记录';

            ALTER TABLE agent_skill_versions ADD COLUMN IF NOT EXISTS content_digest VARCHAR(64);
            ALTER TABLE agent_skill_versions ADD COLUMN IF NOT EXISTS manifest_json JSONB;
            ALTER TABLE agent_skill_versions ADD COLUMN IF NOT EXISTS signing_envelope_id BIGINT REFERENCES agent_skill_signing_envelopes(id) ON DELETE SET NULL;
            ALTER TABLE agent_skill_versions ADD COLUMN IF NOT EXISTS legacy_unrestricted BOOLEAN NOT NULL DEFAULT FALSE;
            ALTER TABLE agent_skill_versions ADD COLUMN IF NOT EXISTS legacy_unrestricted_until TIMESTAMPTZ;

            ALTER TABLE agent_skill_releases ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES teams(id) ON DELETE RESTRICT;
            ALTER TABLE agent_skill_releases ADD COLUMN IF NOT EXISTS rollout_secret_version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE agent_skill_releases ADD COLUMN IF NOT EXISTS breaker_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb;

            ALTER TABLE agent_skill_validations ADD COLUMN IF NOT EXISTS evidence_ref JSONB NOT NULL DEFAULT '{}'::jsonb;

            ALTER TABLE agent_skills ADD COLUMN IF NOT EXISTS tenant_id BIGINT;

            UPDATE agent_skill_versions
            SET content_digest = LOWER(REPLACE(digest, 'sha256:', ''))
            WHERE content_digest IS NULL
              AND digest IS NOT NULL
              AND LOWER(REPLACE(digest, 'sha256:', '')) ~ '^[0-9a-f]{64}$';

            CREATE INDEX IF NOT EXISTS idx_agent_skill_releases_team
                ON agent_skill_releases(tenant_id, team_id, status, published_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_skills_tenant_scope
                ON agent_skills(tenant_id, scope, status, updated_at DESC);
        `);
        // manifest_json 单行回填：整表 CAST 会因个别历史脏数据导致整个迁移回滚。
        const rows = await client.query(`
            SELECT id, manifest_yaml
            FROM agent_skill_versions
            WHERE manifest_json IS NULL AND manifest_yaml IS NOT NULL
            LIMIT 5000
        `);
        for (const row of rows.rows || []) {
            let parsed;
            try { parsed = JSON.parse(row.manifest_yaml); } catch (_) { parsed = null; }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            await client.query('UPDATE agent_skill_versions SET manifest_json = $1::jsonb WHERE id = $2', [JSON.stringify(parsed), row.id]);
        }
    },
    async downPg(client) {
        await client.query(`
            DROP INDEX IF EXISTS idx_agent_skills_tenant_scope;
            DROP INDEX IF EXISTS idx_agent_skill_releases_team;
            ALTER TABLE agent_skills DROP COLUMN IF EXISTS tenant_id;
            ALTER TABLE agent_skill_validations DROP COLUMN IF EXISTS evidence_ref;
            ALTER TABLE agent_skill_releases DROP COLUMN IF EXISTS breaker_thresholds;
            ALTER TABLE agent_skill_releases DROP COLUMN IF EXISTS rollout_secret_version;
            ALTER TABLE agent_skill_releases DROP COLUMN IF EXISTS team_id;
            ALTER TABLE agent_skill_versions DROP COLUMN IF EXISTS legacy_unrestricted_until;
            ALTER TABLE agent_skill_versions DROP COLUMN IF EXISTS legacy_unrestricted;
            ALTER TABLE agent_skill_versions DROP COLUMN IF EXISTS signing_envelope_id;
            ALTER TABLE agent_skill_versions DROP COLUMN IF EXISTS manifest_json;
            ALTER TABLE agent_skill_versions DROP COLUMN IF EXISTS content_digest;
            DROP TABLE IF EXISTS agent_skill_signing_envelopes;
        `);
    }
};

const tenantBackfillMigration = {
    id: '202608310003_agent_skill_tenant_backfill',
    description: 'Backfill skill tenant ownership, converge legacy scope owner keys and cancel unresolvable shared releases.',
    async upPg(client, options = {}) {
        const enterpriseAccess = String((options.env || process.env).PIVOT_ENTERPRISE_ACCESS || '').trim().toLowerCase() === 'true';
        // 第一步：能经 created_by / published_by 唯一回溯到组织的行优先按真实组织回填。
        await client.query(`
            UPDATE agent_skill_versions v
            SET tenant_id = resolved.organization_id
            FROM (
                SELECT tm.user_id, MIN(t.organization_id) AS organization_id
                FROM team_members tm
                JOIN teams t ON t.id = tm.team_id AND t.status = 'active'
                WHERE tm.status = 'active'
                GROUP BY tm.user_id
                HAVING COUNT(DISTINCT t.organization_id) = 1
            ) resolved
            WHERE v.tenant_id IS NULL AND v.created_by = resolved.user_id;

            UPDATE agent_skill_releases r
            SET tenant_id = v.tenant_id
            FROM agent_skill_versions v
            WHERE r.skill_version_id = v.id AND r.tenant_id IS NULL AND v.tenant_id IS NOT NULL;

            UPDATE agent_skills s
            SET tenant_id = v.tenant_id
            FROM agent_skill_versions v
            WHERE s.owner_key = v.owner_key AND s.name = v.name AND s.tenant_id IS NULL AND v.tenant_id IS NOT NULL;
        `);
        if (!enterpriseAccess) {
            // 企业访问关闭：单租户部署统一回填默认租户。
            await client.query(`
                UPDATE agent_skill_versions SET tenant_id = 1 WHERE tenant_id IS NULL;
                UPDATE agent_skill_releases SET tenant_id = 1 WHERE tenant_id IS NULL;
                UPDATE agent_skills SET tenant_id = 1 WHERE tenant_id IS NULL;
            `);
        } else {
            // 企业访问开启：无法回溯租户的共享发布必须作废，不得静默保留为全平台可见。
            await client.query(`
                UPDATE agent_skill_releases
                SET status = 'cancelled', rolled_back_at = COALESCE(rolled_back_at, NOW() AT TIME ZONE 'Asia/Shanghai')
                WHERE tenant_id IS NULL AND status = 'published';

                UPDATE agent_skills s
                SET status = 'disabled', updated_at = NOW() AT TIME ZONE 'Asia/Shanghai'
                WHERE s.tenant_id IS NULL AND s.scope IN ('shared', 'global') AND s.status = 'enabled';
            `);
        }
        // 第二步：收敛历史 owner_key。scope:shared / scope:global 不带租户，是 A2 越权链的载体。
        // 只有在改写不会与既有唯一键冲突时才改写；冲突行保留原值并在第三步作废。
        await client.query(`
            UPDATE agent_skill_versions v
            SET owner_key = 'org:' || v.tenant_id
            WHERE v.owner_key LIKE 'scope:%'
              AND v.tenant_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM agent_skill_versions x
                  WHERE x.owner_key = 'org:' || v.tenant_id AND x.name = v.name AND x.version = v.version AND x.id <> v.id
              );

            UPDATE agent_skill_releases r
            SET owner_key = 'org:' || r.tenant_id
            WHERE r.owner_key LIKE 'scope:%' AND r.tenant_id IS NOT NULL;

            UPDATE agent_skills s
            SET owner_key = 'org:' || s.tenant_id
            WHERE s.owner_key LIKE 'scope:%'
              AND s.tenant_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM agent_skills x
                  WHERE x.owner_key = 'org:' || s.tenant_id AND x.name = s.name AND x.id <> s.id
              );

            UPDATE agent_skill_releases
            SET status = 'cancelled', rolled_back_at = COALESCE(rolled_back_at, NOW() AT TIME ZONE 'Asia/Shanghai')
            WHERE owner_key LIKE 'scope:%' AND status = 'published';
        `);
        // 第三步：team 范围必须有 team_id，历史行无法补齐时作废而不是留空静默不可见。
        await client.query(`
            UPDATE agent_skill_releases
            SET status = 'cancelled', rolled_back_at = COALESCE(rolled_back_at, NOW() AT TIME ZONE 'Asia/Shanghai')
            WHERE rollout_scope = 'team' AND team_id IS NULL AND status = 'published';
        `);
        // 第四步：确认无空租户后才置 NOT NULL，避免升级中断。
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM agent_skill_versions WHERE tenant_id IS NULL) THEN
                    ALTER TABLE agent_skill_versions ALTER COLUMN tenant_id SET NOT NULL;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM agent_skill_releases WHERE tenant_id IS NULL) THEN
                    ALTER TABLE agent_skill_releases ALTER COLUMN tenant_id SET NOT NULL;
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'agent_skill_releases_team_scope_check'
                ) THEN
                    ALTER TABLE agent_skill_releases
                        ADD CONSTRAINT agent_skill_releases_team_scope_check
                        CHECK (rollout_scope <> 'team' OR team_id IS NOT NULL);
                END IF;
            END $$;
        `);
    },
    async downPg(client) {
        await client.query(`
            ALTER TABLE agent_skill_releases DROP CONSTRAINT IF EXISTS agent_skill_releases_team_scope_check;
            ALTER TABLE agent_skill_releases ALTER COLUMN tenant_id DROP NOT NULL;
            ALTER TABLE agent_skill_versions ALTER COLUMN tenant_id DROP NOT NULL;
        `);
    }
};

const immutableVersionMigration = {
    id: '202608310004_agent_skill_version_immutability',
    description: 'Prevent artifact fields of validated or published Skill versions from being mutated in place.',
    async upPg(client) {
        await client.query(`
            CREATE OR REPLACE FUNCTION agent_skill_version_guard() RETURNS trigger AS $$
            BEGIN
                IF OLD.status IN ('validated', 'published') THEN
                    IF NEW.manifest_yaml IS DISTINCT FROM OLD.manifest_yaml
                        OR NEW.manifest_json IS DISTINCT FROM OLD.manifest_json
                        OR NEW.instructions_md IS DISTINCT FROM OLD.instructions_md
                        OR NEW.package_path IS DISTINCT FROM OLD.package_path
                        OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
                        OR NEW.digest IS DISTINCT FROM OLD.digest THEN
                        RAISE EXCEPTION '已验证的技能版本制品不可修改，请创建新版本。';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trg_agent_skill_version_guard ON agent_skill_versions;
            CREATE TRIGGER trg_agent_skill_version_guard
                BEFORE UPDATE ON agent_skill_versions
                FOR EACH ROW EXECUTE FUNCTION agent_skill_version_guard();
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP TRIGGER IF EXISTS trg_agent_skill_version_guard ON agent_skill_versions;
            DROP FUNCTION IF EXISTS agent_skill_version_guard();
        `);
    }
};

module.exports = [
    defaultTenantMigration,
    governanceColumnsMigration,
    tenantBackfillMigration,
    immutableVersionMigration
];
