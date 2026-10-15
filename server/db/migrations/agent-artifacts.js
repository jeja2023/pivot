/**
 * Artifacts 交互空间数据库迁移
 */

const migrationId = '202610140007_agent_artifacts';

async function upPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始创建 Artifacts 交互空间表...`);

  // 清理旧的表结构（如果存在）
  await client.query('DROP TABLE IF EXISTS agent_artifact_comments CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifact_interactions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifact_shares CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifact_versions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifacts CASCADE');

  // Artifacts 主表
  await client.query(`
    CREATE TABLE agent_artifacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id VARCHAR(64) NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      type VARCHAR(50) NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      run_id VARCHAR(100),
      parent_id UUID REFERENCES agent_artifacts(id) ON DELETE SET NULL,
      version INTEGER DEFAULT 1,
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifacts_user
    ON agent_artifacts(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifacts_type
    ON agent_artifacts(type)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifacts_status
    ON agent_artifacts(status)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifacts_run
    ON agent_artifacts(run_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifacts_updated
    ON agent_artifacts(updated_at DESC)
  `);

  // Artifact 版本历史表
  await client.query(`
    CREATE TABLE agent_artifact_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_id UUID REFERENCES agent_artifacts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(artifact_id, version)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact
    ON agent_artifact_versions(artifact_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_created
    ON agent_artifact_versions(created_at DESC)
  `);

  // Artifact 分享表
  await client.query(`
    CREATE TABLE agent_artifact_shares (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_id UUID REFERENCES agent_artifacts(id) ON DELETE CASCADE,
      visibility VARCHAR(50) DEFAULT 'public',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_shares_artifact
    ON agent_artifact_shares(artifact_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_shares_created
    ON agent_artifact_shares(created_at DESC)
  `);

  // Artifact 交互记录表
  await client.query(`
    CREATE TABLE agent_artifact_interactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_id UUID REFERENCES agent_artifacts(id) ON DELETE CASCADE,
      user_id VARCHAR(64),
      interaction_type VARCHAR(100) NOT NULL,
      interaction_data JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_interactions_artifact
    ON agent_artifact_interactions(artifact_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_interactions_user
    ON agent_artifact_interactions(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_interactions_type
    ON agent_artifact_interactions(interaction_type)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_interactions_created
    ON agent_artifact_interactions(created_at DESC)
  `);

  // Artifact 评论表
  await client.query(`
    CREATE TABLE agent_artifact_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_id UUID REFERENCES agent_artifacts(id) ON DELETE CASCADE,
      user_id VARCHAR(64) NOT NULL,
      parent_id UUID REFERENCES agent_artifact_comments(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_comments_artifact
    ON agent_artifact_comments(artifact_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_comments_user
    ON agent_artifact_comments(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_comments_parent
    ON agent_artifact_comments(parent_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_comments_created
    ON agent_artifact_comments(created_at DESC)
  `);

  logger.info(`[${migrationId}] Artifacts 交互空间表创建完成`);
}

async function downPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始回滚 Artifacts 交互空间表...`);

  await client.query('DROP TABLE IF EXISTS agent_artifact_comments CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifact_interactions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifact_shares CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifact_versions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifacts CASCADE');

  logger.info(`[${migrationId}] Artifacts 交互空间表回滚完成`);
}

module.exports = {
  id: migrationId,
  description: 'Artifacts 可视化交互空间',
  upPg,
  downPg
};
