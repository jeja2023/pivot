/**
 * 自主规划系统数据库迁移
 */

const migrationId = '202610140006_agent_enhanced_planning';

async function upPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始创建自主规划系统表...`);

  // 执行计划表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_execution_plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      task_description TEXT NOT NULL,
      plan_data JSONB NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      estimated_duration INTEGER,
      estimated_cost DECIMAL(10,4),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_execution_plans_user
    ON agent_execution_plans(user_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_execution_plans_status
    ON agent_execution_plans(status)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_execution_plans_created
    ON agent_execution_plans(created_at DESC)
  `);

  // 任务执行结果表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_execution_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id UUID REFERENCES agent_execution_plans(id) ON DELETE CASCADE,
      task_id VARCHAR(255) NOT NULL,
      task_description TEXT NOT NULL,
      status VARCHAR(50) NOT NULL,
      result JSONB,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_execution_results_plan
    ON agent_execution_results(plan_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_execution_results_status
    ON agent_execution_results(status)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_execution_results_created
    ON agent_execution_results(created_at DESC)
  `);

  // 计划调整历史表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_plan_adjustments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id UUID REFERENCES agent_execution_plans(id) ON DELETE CASCADE,
      original_plan JSONB NOT NULL,
      adjusted_plan JSONB NOT NULL,
      reason TEXT NOT NULL,
      changes JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_plan_adjustments_plan
    ON agent_plan_adjustments(plan_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_plan_adjustments_created
    ON agent_plan_adjustments(created_at DESC)
  `);

  // 依赖关系表（用于快速查询）
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_task_dependencies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id UUID REFERENCES agent_execution_plans(id) ON DELETE CASCADE,
      task_id VARCHAR(255) NOT NULL,
      depends_on VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(plan_id, task_id, depends_on)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_plan
    ON agent_task_dependencies(plan_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_task_dependencies_task
    ON agent_task_dependencies(task_id)
  `);

  logger.info(`[${migrationId}] 自主规划系统表创建完成`);
}

async function downPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始回滚自主规划系统表...`);

  await client.query('DROP TABLE IF EXISTS agent_task_dependencies CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_plan_adjustments CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_execution_results CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_execution_plans CASCADE');

  logger.info(`[${migrationId}] 自主规划系统表回滚完成`);
}

module.exports = {
  id: migrationId,
  description: '增强的自主规划系统',
  upPg,
  downPg
};
