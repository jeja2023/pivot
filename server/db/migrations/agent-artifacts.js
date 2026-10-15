/**
 * Artifacts 交互空间数据库迁移
 */

const migrationId = '202610140007_agent_artifacts';

async function upPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始创建/更新 Artifacts 交互空间表...`);

  // 1. 确保核心 agent_artifacts 表结构完整（保留既有字段、BIGINT 主键与外键约束）
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_artifacts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id TEXT,
      user_id BIGINT NOT NULL,
      type VARCHAR(50) DEFAULT 'summary',
      title VARCHAR(500) NOT NULL,
      content TEXT NOT NULL,
      current_version_id BIGINT,
      note TEXT,
      description TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      parent_id BIGINT REFERENCES agent_artifacts(id) ON DELETE SET NULL,
      version INTEGER DEFAULT 1,
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
      updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
    )
  `);

  // 平滑扩充可能缺失的列（适配历史库与快照基线）
  await client.query(`
    ALTER TABLE agent_artifacts
      ADD COLUMN IF NOT EXISTS note TEXT,
      ADD COLUMN IF NOT EXISTS current_version_id BIGINT,
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES agent_artifacts(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
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

  // 2. 确保 agent_artifact_versions 表结构完整
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_artifact_versions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      artifact_id BIGINT NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
      version BIGINT NOT NULL,
      content TEXT NOT NULL,
      note TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
      UNIQUE(artifact_id, version)
    )
  `);

  await client.query(`
    ALTER TABLE agent_artifact_versions
      ADD COLUMN IF NOT EXISTS note TEXT,
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS created_by BIGINT;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact
    ON agent_artifact_versions(artifact_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_created
    ON agent_artifact_versions(created_at DESC)
  `);

  // 3. Artifact 分享表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_artifact_shares (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      artifact_id BIGINT REFERENCES agent_artifacts(id) ON DELETE CASCADE,
      visibility VARCHAR(50) DEFAULT 'public',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
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

  // 4. Artifact 交互记录表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_artifact_interactions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      artifact_id BIGINT REFERENCES agent_artifacts(id) ON DELETE CASCADE,
      user_id VARCHAR(64),
      interaction_type VARCHAR(100) NOT NULL,
      interaction_data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
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

  // 5. Artifact 评论表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_artifact_comments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      artifact_id BIGINT REFERENCES agent_artifacts(id) ON DELETE CASCADE,
      user_id VARCHAR(64) NOT NULL,
      parent_id BIGINT REFERENCES agent_artifact_comments(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
      updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
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

  logger.info(`[${migrationId}] Artifacts 交互空间表创建/更新完成`);
}

async function downPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始回滚 Artifacts 交互空间表...`);

  await client.query('DROP TABLE IF EXISTS agent_artifact_comments CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifact_interactions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_artifact_shares CASCADE');

  logger.info(`[${migrationId}] Artifacts 交互空间表回滚完成`);
}

module.exports = {
  id: migrationId,
  description: 'Artifacts 可视化交互空间',
  upPg,
  downPg
};
