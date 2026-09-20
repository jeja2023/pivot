/**
 * 独立文档 Artifact 迁移。
 *
 * 公文工作台并不总由 Agent run 产生，但其 DOCX/PDF 仍必须进入同一份
 * Artifact → Rendition → Delivery 审计链。因此允许 agent_artifacts.run_id 为空；
 * 有 run 的既有产物不受影响，独立产物只通过 user_id 归属控制访问。
 */

const standaloneArtifactsMigration = {
    id: '202609010001_agent_standalone_artifacts',
    description: 'Allow user-owned standalone artifacts that are not attached to an Agent run.',
    async upPg(client) {
        await client.query('ALTER TABLE agent_artifacts ALTER COLUMN run_id DROP NOT NULL;');
    },
    async downPg(client) {
        const nullable = await client.query('SELECT 1 FROM agent_artifacts WHERE run_id IS NULL LIMIT 1');
        if (nullable.rows.length) {
            throw new Error('存在独立 Artifact，不能将 agent_artifacts.run_id 回退为 NOT NULL。');
        }
        await client.query('ALTER TABLE agent_artifacts ALTER COLUMN run_id SET NOT NULL;');
    }
};

module.exports = [standaloneArtifactsMigration];
