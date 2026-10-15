/**
 * 评测系统数据库迁移
 * 创建评测结果存储表
 */

const migrationId = '202610140004_agent_evaluation';

async function upPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始创建评测系统表...`);

  // 1. 评测套件表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_evaluation_suites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(50),
      version VARCHAR(50),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(name, version)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_eval_suites_category
    ON agent_evaluation_suites(category)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_eval_suites_created
    ON agent_evaluation_suites(created_at DESC)
  `);

  // 2. 评测用例表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_evaluation_cases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      suite_id UUID REFERENCES agent_evaluation_suites(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(50),
      difficulty VARCHAR(20),
      input TEXT NOT NULL,
      context JSONB DEFAULT '{}',
      expected_behavior TEXT,
      success_criteria JSONB,
      timeout_ms INTEGER DEFAULT 300000,
      tags TEXT[],
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(suite_id, name)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_eval_cases_suite
    ON agent_evaluation_cases(suite_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_eval_cases_category
    ON agent_evaluation_cases(category)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_eval_cases_difficulty
    ON agent_evaluation_cases(difficulty)
  `);

  // 3. 基准测试结果表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_benchmark_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      suite_id UUID REFERENCES agent_evaluation_suites(id) ON DELETE CASCADE,
      suite_name VARCHAR(255) NOT NULL,
      run_id UUID,
      user_id UUID,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      duration_ms INTEGER,
      total_cases INTEGER NOT NULL,
      passed_cases INTEGER NOT NULL,
      failed_cases INTEGER NOT NULL,
      skipped_cases INTEGER DEFAULT 0,
      average_score DECIMAL(5,2),
      summary JSONB DEFAULT '{}',
      case_results JSONB DEFAULT '[]',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_benchmark_results_suite
    ON agent_benchmark_results(suite_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_benchmark_results_created
    ON agent_benchmark_results(created_at DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_benchmark_results_score
    ON agent_benchmark_results(average_score DESC)
  `);

  // 4. 用例执行历史表（详细记录）
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_case_executions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      benchmark_result_id UUID REFERENCES agent_benchmark_results(id) ON DELETE CASCADE,
      case_id UUID REFERENCES agent_evaluation_cases(id) ON DELETE CASCADE,
      case_name VARCHAR(255) NOT NULL,
      category VARCHAR(50),
      difficulty VARCHAR(20),
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      duration_ms INTEGER,
      passed BOOLEAN NOT NULL,
      score DECIMAL(5,2),
      output JSONB,
      evaluation JSONB,
      error TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_case_executions_benchmark
    ON agent_case_executions(benchmark_result_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_case_executions_case
    ON agent_case_executions(case_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_case_executions_passed
    ON agent_case_executions(passed)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_case_executions_score
    ON agent_case_executions(score DESC)
  `);

  // 5. 性能指标表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_performance_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      benchmark_result_id UUID REFERENCES agent_benchmark_results(id) ON DELETE CASCADE,
      metric_name VARCHAR(100) NOT NULL,
      metric_value DECIMAL(10,2),
      unit VARCHAR(50),
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_perf_metrics_benchmark
    ON agent_performance_metrics(benchmark_result_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_perf_metrics_name
    ON agent_performance_metrics(metric_name)
  `);

  // 6. 回归检测表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_regression_checks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      current_result_id UUID REFERENCES agent_benchmark_results(id) ON DELETE CASCADE,
      baseline_result_id UUID REFERENCES agent_benchmark_results(id) ON DELETE CASCADE,
      regression_detected BOOLEAN NOT NULL,
      score_change DECIMAL(5,2),
      pass_rate_change DECIMAL(5,2),
      affected_cases TEXT[],
      analysis JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_regression_checks_current
    ON agent_regression_checks(current_result_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_regression_checks_detected
    ON agent_regression_checks(regression_detected)
  `);

  logger.info(`[${migrationId}] 评测系统表创建完成`);
}

async function downPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始回滚评测系统表...`);

  await client.query('DROP TABLE IF EXISTS agent_regression_checks CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_performance_metrics CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_case_executions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_benchmark_results CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_evaluation_cases CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_evaluation_suites CASCADE');

  logger.info(`[${migrationId}] 评测系统表回滚完成`);
}

module.exports = {
  id: migrationId,
  description: 'Agent 评测系统基础设施',
  upPg,
  downPg
};
