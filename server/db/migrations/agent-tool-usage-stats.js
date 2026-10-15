/**
 * 工具使用统计表迁移
 */

const migrationId = '202610140005_agent_tool_usage_stats';

async function upPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始创建工具使用统计表...`);

  // 工具使用统计表
  await client.query(`
    CREATE TABLE IF NOT EXISTS tool_usage_stats (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tool_id VARCHAR(255) NOT NULL,
      usage_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      avg_duration_ms INTEGER,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_usage_stats_tool_id
    ON tool_usage_stats(tool_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_usage_stats_created
    ON tool_usage_stats(created_at DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_usage_stats_usage_count
    ON tool_usage_stats(usage_count DESC)
  `);

  // 工具推荐日志表
  await client.query(`
    CREATE TABLE IF NOT EXISTS tool_recommendation_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      task_description TEXT NOT NULL,
      intent VARCHAR(100),
      entities JSONB DEFAULT '[]',
      recommended_tools JSONB NOT NULL,
      selected_tool_id VARCHAR(255),
      feedback VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_recommendation_logs_user
    ON tool_recommendation_logs(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_recommendation_logs_created
    ON tool_recommendation_logs(created_at DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_tool_recommendation_logs_selected
    ON tool_recommendation_logs(selected_tool_id)
  `);

  logger.info(`[${migrationId}] 工具使用统计表创建完成`);
}

async function downPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始回滚工具使用统计表...`);

  await client.query('DROP TABLE IF EXISTS tool_recommendation_logs CASCADE');
  await client.query('DROP TABLE IF EXISTS tool_usage_stats CASCADE');

  logger.info(`[${migrationId}] 工具使用统计表回滚完成`);
}

module.exports = {
  id: migrationId,
  description: '工具使用统计和推荐日志',
  upPg,
  downPg
};
