'use strict';

module.exports = [{
    id: '202610180009_agent_prompt_section_active_tenant_guard',
    description: 'Scope stable Prompt Section activation to one approved version per tenant and section.',
    async upPg(client) {
        // 旧实现运行时只会挑选最新版本；若历史数据因手工写入存在多个 active，
        // 保留原有解析顺序中的最新项，退役其余项后再加唯一约束，避免迁移失败或
        // 向任意租户悄然暴露另一租户的策略版本。
        await client.query(`
            WITH ranked AS (
                SELECT id,
                    ROW_NUMBER() OVER (
                        PARTITION BY tenant_id, section_key
                        ORDER BY approved_at DESC NULLS LAST, updated_at DESC, created_at DESC, id DESC
                    ) AS position
                FROM agent_prompt_section_versions
                WHERE stability = 'stable' AND status = 'active' AND approval_status = 'approved'
            )
            UPDATE agent_prompt_section_versions AS version
            SET status = 'retired', updated_at = NOW() AT TIME ZONE 'Asia/Shanghai'
            FROM ranked
            WHERE version.id = ranked.id AND ranked.position > 1;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_prompt_sections_one_active_tenant_section
                ON agent_prompt_section_versions(tenant_id, section_key)
                WHERE stability = 'stable' AND status = 'active' AND approval_status = 'approved';
        `);
    }
}];
