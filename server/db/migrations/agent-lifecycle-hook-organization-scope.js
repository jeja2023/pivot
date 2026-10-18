'use strict';

module.exports = [{
    id: '202610180017_agent_lifecycle_hook_organization_scope',
    description: 'Make signed managed lifecycle Hook packages organization-scoped and enforce one organization Hook registration per package member.',
    async upPg(client) {
        await client.query(`
            WITH ranked_managed_hooks AS (
                SELECT h.id,
                       ROW_NUMBER() OVER (
                           PARTITION BY h.tenant_id, h.package_id, h.package_version, h.hook_name
                           ORDER BY h.updated_at DESC, h.id DESC
                       ) AS position
                FROM agent_lifecycle_hooks h
                JOIN agent_lifecycle_hook_packages p
                  ON p.tenant_id = h.tenant_id
                 AND p.package_id = h.package_id
                 AND p.package_version = h.package_version
                 AND p.manifest_digest = h.package_manifest_digest
                 AND p.signing_envelope_id = h.signing_envelope_id
            ), promoted AS (
                UPDATE agent_lifecycle_hooks h
                   SET user_id = NULL,
                       updated_at = NOW()
                  FROM ranked_managed_hooks ranked
                 WHERE h.id = ranked.id
                   AND ranked.position = 1
                 RETURNING h.id
            )
            UPDATE agent_lifecycle_hooks h
               SET status = 'disabled',
                   updated_at = NOW()
              FROM ranked_managed_hooks ranked
             WHERE h.id = ranked.id
               AND ranked.position > 1
               AND h.status = 'enabled';

            CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_lifecycle_hooks_organization_member
                ON agent_lifecycle_hooks(tenant_id, package_id, package_version, hook_name)
                WHERE user_id IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_lifecycle_hooks_personal_member
                ON agent_lifecycle_hooks(tenant_id, user_id, package_id, package_version, hook_name)
                WHERE user_id IS NOT NULL;
        `);
    }
}];
