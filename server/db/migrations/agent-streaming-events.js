/**
 * 流式事件系统迁移
 * 支持实时流式交互、思考链可视化、工具调用流式通知
 */

const migrationId = '202610140003_agent_streaming_events';

async function upPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始创建流式事件系统表...`);

  // 1. 流式事件表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_streaming_events (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

      event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
        'thinking_start',
        'thinking_chunk',
        'thinking_end',
        'tool_call_start',
        'tool_call_progress',
        'tool_call_end',
        'output_chunk',
        'output_end',
        'error',
        'status_change'
      )),

      data JSONB NOT NULL DEFAULT '{}',
      content TEXT,
      sequence INTEGER NOT NULL,

      metadata JSONB DEFAULT '{}',
      token_count INTEGER DEFAULT 0,
      latency_ms INTEGER,

      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streaming_events_run_sequence
    ON agent_streaming_events(run_id, sequence)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streaming_events_run_type
    ON agent_streaming_events(run_id, event_type)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streaming_events_created_at
    ON agent_streaming_events(created_at)
  `);

  // 2. 流式会话表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_streaming_sessions (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

      session_id VARCHAR(64) NOT NULL UNIQUE,
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'error', 'timeout')),

      first_byte_latency_ms INTEGER,
      avg_chunk_latency_ms INTEGER,
      total_chunks INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,

      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      last_activity_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streaming_sessions_session_id
    ON agent_streaming_sessions(session_id)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streaming_sessions_run_status
    ON agent_streaming_sessions(run_id, status)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streaming_sessions_started_at
    ON agent_streaming_sessions(started_at)
  `);

  // 3. 思考链记录表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_thinking_chains (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      session_id BIGINT NOT NULL REFERENCES agent_streaming_sessions(id) ON DELETE CASCADE,

      step_number INTEGER NOT NULL,
      step_name VARCHAR(200),
      reasoning TEXT,
      observation TEXT,
      intermediate_results JSONB,

      duration_ms INTEGER,
      token_count INTEGER,

      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_thinking_chains_run_step
    ON agent_thinking_chains(run_id, step_number)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_thinking_chains_session
    ON agent_thinking_chains(session_id)
  `);

  // 4. 流式连接统计表
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_streaming_stats (
      id BIGSERIAL PRIMARY KEY,
      stat_date DATE NOT NULL,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,

      total_sessions INTEGER DEFAULT 0,
      successful_sessions INTEGER DEFAULT 0,
      failed_sessions INTEGER DEFAULT 0,
      avg_first_byte_ms INTEGER,
      avg_session_duration_ms INTEGER,
      total_tokens BIGINT DEFAULT 0,
      total_events BIGINT DEFAULT 0,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),

      UNIQUE(stat_date, user_id)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_streaming_stats_date
    ON agent_streaming_stats(stat_date)
  `);

  logger.info(`[${migrationId}] 流式事件系统表创建完成`);
}

async function downPg(client, { logger }) {
  logger.info(`[${migrationId}] 开始回滚流式事件系统表...`);

  await client.query('DROP TABLE IF EXISTS agent_streaming_stats CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_thinking_chains CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_streaming_sessions CASCADE');
  await client.query('DROP TABLE IF EXISTS agent_streaming_events CASCADE');

  logger.info(`[${migrationId}] 流式事件系统表回滚完成`);
}

module.exports = {
  id: migrationId,
  description: '实时流式事件系统',
  upPg,
  downPg
};
