/**
 * 流式交互API路由
 */

const express = require('express');
const router = express.Router();
const streamingService = require('../../services/agent-runtime/streaming-service');
const db = require('../../db/connection');
const { requireAuth } = require('../../middleware/auth');

/**
 * GET /api/agent/runs/:runId/stream
 * 建立SSE连接，接收实时流式事件
 */
router.get('/runs/:runId/stream', requireAuth, async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user.id;

    // 验证run权限
    const run = await db('agent_runs')
      .where({ id: runId, user_id: userId })
      .first();

    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    // 建立SSE连接
    const sessionId = await streamingService.connectSSE(req, res, runId, userId);
    console.log(`SSE连接建立: sessionId=${sessionId}, runId=${runId}, userId=${userId}`);

    // 如果run已有历史事件，推送历史
    const historicalEvents = await db('agent_streaming_events')
      .where({ run_id: runId })
      .orderBy('sequence', 'asc')
      .limit(100);

    if (historicalEvents.length > 0) {
      for (const event of historicalEvents) {
        await streamingService.sendEvent(
          sessionId,
          'historical_' + event.event_type,
          JSON.parse(event.data),
          event.content
        );
      }
    }

  } catch (error) {
    console.error('建立SSE连接失败:', error);
    res.status(500).json({ error: 'Failed to establish SSE connection', message: error.message });
  }
});

/**
 * GET /api/agent/runs/:runId/events
 * 获取历史流式事件
 */
router.get('/runs/:runId/events', requireAuth, async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user.id;
    const { limit = 100, offset = 0, eventType } = req.query;

    // 验证权限
    const run = await db('agent_runs')
      .where({ id: runId, user_id: userId })
      .first();

    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    // 查询事件
    let query = db('agent_streaming_events')
      .where({ run_id: runId });

    if (eventType) {
      query = query.where({ event_type: eventType });
    }

    const events = await query
      .orderBy('sequence', 'asc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    // 统计
    const [{ count }] = await db('agent_streaming_events')
      .where({ run_id: runId })
      .count('* as count');

    res.json({
      events: events.map(e => ({
        id: e.id,
        type: e.event_type,
        sequence: e.sequence,
        data: JSON.parse(e.data),
        content: e.content,
        latency: e.latency_ms,
        tokenCount: e.token_count,
        createdAt: e.created_at
      })),
      total: parseInt(count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (error) {
    console.error('获取流式事件失败:', error);
    res.status(500).json({ error: 'Failed to get streaming events', message: error.message });
  }
});

/**
 * GET /api/agent/runs/:runId/thinking-chain
 * 获取思考链记录
 */
router.get('/runs/:runId/thinking-chain', requireAuth, async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user.id;

    // 验证权限
    const run = await db('agent_runs')
      .where({ id: runId, user_id: userId })
      .first();

    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    // 查询思考链
    const thinkingChain = await db('agent_thinking_chains')
      .where({ run_id: runId })
      .orderBy('step_number', 'asc');

    res.json({
      runId,
      steps: thinkingChain.map(step => ({
        stepNumber: step.step_number,
        stepName: step.step_name,
        reasoning: step.reasoning,
        observation: step.observation,
        intermediateResults: step.intermediate_results,
        duration: step.duration_ms,
        tokenCount: step.token_count,
        startedAt: step.started_at,
        completedAt: step.completed_at
      })),
      totalSteps: thinkingChain.length
    });

  } catch (error) {
    console.error('获取思考链失败:', error);
    res.status(500).json({ error: 'Failed to get thinking chain', message: error.message });
  }
});

/**
 * GET /api/agent/streaming/sessions/:sessionId
 * 获取会话信息
 */
router.get('/streaming/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const session = await db('agent_streaming_sessions')
      .where({ session_id: sessionId, user_id: userId })
      .first();

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // 获取事件统计
    const [{ count: eventCount }] = await db('agent_streaming_events')
      .where({ run_id: session.run_id })
      .count('* as count');

    res.json({
      sessionId: session.session_id,
      runId: session.run_id,
      status: session.status,
      firstByteLatency: session.first_byte_latency_ms,
      avgChunkLatency: session.avg_chunk_latency_ms,
      totalChunks: session.total_chunks,
      totalTokens: session.total_tokens,
      eventCount: parseInt(eventCount),
      startedAt: session.started_at,
      completedAt: session.completed_at,
      duration: session.completed_at ?
        new Date(session.completed_at) - new Date(session.started_at) :
        Date.now() - new Date(session.started_at)
    });

  } catch (error) {
    console.error('获取会话信息失败:', error);
    res.status(500).json({ error: 'Failed to get session info', message: error.message });
  }
});

/**
 * GET /api/agent/streaming/stats
 * 获取流式统计信息
 */
router.get('/streaming/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate } = req.query;

    let query = db('agent_streaming_stats')
      .where({ user_id: userId });

    if (startDate) {
      query = query.where('stat_date', '>=', startDate);
    }
    if (endDate) {
      query = query.where('stat_date', '<=', endDate);
    }

    const stats = await query.orderBy('stat_date', 'desc').limit(30);

    // 总计
    const totals = stats.reduce((acc, stat) => ({
      totalSessions: acc.totalSessions + stat.total_sessions,
      successfulSessions: acc.successfulSessions + stat.successful_sessions,
      failedSessions: acc.failedSessions + stat.failed_sessions,
      totalTokens: acc.totalTokens + parseInt(stat.total_tokens),
      totalEvents: acc.totalEvents + parseInt(stat.total_events)
    }), {
      totalSessions: 0,
      successfulSessions: 0,
      failedSessions: 0,
      totalTokens: 0,
      totalEvents: 0
    });

    // 计算平均值
    const avgFirstByte = stats.length > 0 ?
      Math.round(stats.reduce((sum, s) => sum + (s.avg_first_byte_ms || 0), 0) / stats.length) :
      0;

    res.json({
      stats: stats.map(s => ({
        date: s.stat_date,
        totalSessions: s.total_sessions,
        successRate: s.total_sessions > 0 ?
          (s.successful_sessions / s.total_sessions * 100).toFixed(2) :
          0,
        avgFirstByte: s.avg_first_byte_ms,
        avgDuration: s.avg_session_duration_ms,
        totalTokens: parseInt(s.total_tokens),
        totalEvents: parseInt(s.total_events)
      })),
      totals,
      avgFirstByte
    });

  } catch (error) {
    console.error('获取流式统计失败:', error);
    res.status(500).json({ error: 'Failed to get streaming stats', message: error.message });
  }
});

/**
 * GET /api/agent/streaming/active-sessions
 * 获取活跃会话（管理端点）
 */
router.get('/streaming/active-sessions', requireAuth, async (req, res) => {
  try {
    const stats = streamingService.getStats();
    res.json(stats);
  } catch (error) {
    console.error('获取活跃会话失败:', error);
    res.status(500).json({ error: 'Failed to get active sessions', message: error.message });
  }
});

/**
 * POST /api/agent/runs/:runId/stream/test
 * 测试流式推送（开发用）
 */
router.post('/runs/:runId/stream/test', requireAuth, async (req, res) => {
  try {
    const { runId } = req.params;
    const userId = req.user.id;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    // 发送测试事件
    await streamingService.sendThinkingChain(
      sessionId,
      1,
      '这是一个测试思考链。我正在分析问题的各个方面，寻找最优解决方案...',
      '观察到：问题具有多个可行路径'
    );

    await streamingService.sendToolProgress(sessionId, 'test_tool', 'start', 0);
    await streamingService.sendToolProgress(sessionId, 'test_tool', 'progress', 50);
    await streamingService.sendToolProgress(sessionId, 'test_tool', 'end', 100, { result: 'success' });

    await streamingService.sendOutputChunk(sessionId, '测试输出内容...');
    await streamingService.sendOutputChunk(sessionId, '完成！', true);

    res.json({ success: true, message: 'Test events sent' });

  } catch (error) {
    console.error('发送测试事件失败:', error);
    res.status(500).json({ error: 'Failed to send test events', message: error.message });
  }
});

module.exports = router;
