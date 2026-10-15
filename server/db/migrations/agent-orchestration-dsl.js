/**
 * 编排语言数据库迁移
 */

const migrationId = '202610140008_agent_orchestration_dsl';

async function upPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始创建编排语言表...`);

  // 编排模板表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_orchestration_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      dsl_code TEXT NOT NULL,
      tags JSONB DEFAULT '[]',
      metadata JSONB DEFAULT '{}',
      is_public BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orchestration_templates_user
    ON agent_orchestration_templates(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orchestration_templates_public
    ON agent_orchestration_templates(is_public)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orchestration_templates_created
    ON agent_orchestration_templates(created_at DESC)
  `);

  // 编排执行记录表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_orchestration_executions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      orchestration_name VARCHAR(255) NOT NULL,
      dsl_code TEXT NOT NULL,
      context JSONB DEFAULT '{}',
      result JSONB,
      error TEXT,
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orchestration_executions_user
    ON agent_orchestration_executions(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orchestration_executions_status
    ON agent_orchestration_executions(status)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_orchestration_executions_created
    ON agent_orchestration_executions(created_at DESC)
  `);

  logger.info(`[${migrationId}] 编排语言表创建完成`);
}

async function downPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始回滚编排语言表...`);

  await client.query('DROP TABLE IF EXISTS agent_orchestration_executions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_orchestration_templates CASCADE');

  logger.info(`[${migrationId}] 编排语言表回滚完成`);
}

module.exports = {
  id: migrationId,
  description: '多智能体编排语言',
  upPg,
  downPg
};
