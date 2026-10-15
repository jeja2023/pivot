/**
 * 流式交互 API 路由
 */

const express = require('express');
const router = express.Router();
const streamingService = require('../../services/agent-runtime/streaming-service');
const { authMiddleware: requireAuth } = require('../../auth');

/**
 * 创建流式会话
 * POST /api/streaming/sessions
 */
router.post('/sessions', requireAuth, async (req, res) => {
  try {
    const { runId } = req.body;
    const userId = req.user.id;

    if (!runId) {
      return res.status(400).json({
        success: false,
        error: 'runId 不能为空'
      });
    }

    const { sessionId } = await streamingService.createSession(runId, userId);

    res.json({
      success: true,
      data: { sessionId, runId }
    });
  } catch (error) {
    console.error('创建流式会话失败:', error);
    res.status(500).json({
      success: false,
      error: '创建流式会话失败',
      message: error.message
    });
  }
});

/**
 * 获取流式事件
 * GET /api/streaming/sessions/:sessionId/events
 */
router.get('/sessions/:sessionId/events', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { since, limit = 100 } = req.query;

    // 验证会话所有权
    const session = await req.db('agent_streaming_sessions')
      .where({ session_id: sessionId })
      .first();

    if (!session) {
      return res.status(404).json({
        success: false,
        error: '会话不存在'
      });
    }

    if (session.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: '无权访问此会话'
      });
    }

    let query = req.db('agent_streaming_events')
      .where({ session_id: sessionId })
      .orderBy('sequence', 'asc')
      .limit(parseInt(limit));

    if (since) {
      query = query.where('sequence', '>', parseInt(since));
    }

    const events = await query;

    res.json({
      success: true,
      data: events,
      count: events.length
    });
  } catch (error) {
    console.error('获取流式事件失败:', error);
    res.status(500).json({
      success: false,
      error: '获取流式事件失败',
      message: error.message
    });
  }
});

/**
 * SSE 流式推送
 * GET /api/streaming/sessions/:sessionId/stream
 */
router.get('/sessions/:sessionId/stream', requireAuth, async (req, res) => {
  const { sessionId } = req.params;

  try {
    // 验证会话所有权
    const session = await req.db('agent_streaming_sessions')
      .where({ session_id: sessionId })
      .first();

    if (!session) {
      return res.status(404).json({
        success: false,
        error: '会话不存在'
      });
    }

    if (session.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: '无权访问此会话'
      });
    }

    // 设置 SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // 发送初始连接成功事件
    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

    // 获取当前最大序列号
    let lastSequence = 0;
    const lastEvent = await req.db('agent_streaming_events')
      .where({ session_id: sessionId })
      .orderBy('sequence', 'desc')
      .first();

    if (lastEvent) {
      lastSequence = lastEvent.sequence;
    }

    // 轮询新事件
    const pollInterval = setInterval(async () => {
      try {
        const newEvents = await req.db('agent_streaming_events')
          .where({ session_id: sessionId })
          .where('sequence', '>', lastSequence)
          .orderBy('sequence', 'asc')
          .limit(50);

        for (const event of newEvents) {
          const eventData = {
            type: event.event_type,
            sequence: event.sequence,
            data: event.event_data,
            content: event.content,
            timestamp: event.created_at
          };

          res.write(`data: ${JSON.stringify(eventData)}\n\n`);
          lastSequence = event.sequence;
        }

        // 检查会话是否已关闭
        const currentSession = await req.db('agent_streaming_sessions')
          .where({ session_id: sessionId })
          .first();

        if (currentSession && currentSession.status !== 'active') {
          res.write(`data: ${JSON.stringify({ type: 'session_closed', status: currentSession.status })}\n\n`);
          clearInterval(pollInterval);
          res.end();
        }
      } catch (error) {
        console.error('轮询事件失败:', error);
        clearInterval(pollInterval);
        res.end();
      }
    }, 500);

    // 客户端断开连接时清理
    req.on('close', () => {
      clearInterval(pollInterval);
    });

  } catch (error) {
    console.error('SSE 流式推送失败:', error);
    res.status(500).json({
      success: false,
      error: 'SSE 流式推送失败',
      message: error.message
    });
  }
});

/**
 * 关闭流式会话
 * POST /api/streaming/sessions/:sessionId/close
 */
router.post('/sessions/:sessionId/close', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { status = 'completed' } = req.body;

    // 验证会话所有权
    const session = await req.db('agent_streaming_sessions')
      .where({ session_id: sessionId })
      .first();

    if (!session) {
      return res.status(404).json({
        success: false,
        error: '会话不存在'
      });
    }

    if (session.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: '无权操作此会话'
      });
    }

    await streamingService.closeSession(sessionId, status);

    res.json({
      success: true,
      data: { sessionId, status }
    });
  } catch (error) {
    console.error('关闭流式会话失败:', error);
    res.status(500).json({
      success: false,
      error: '关闭流式会话失败',
      message: error.message
    });
  }
});

/**
 * 获取会话状态
 * GET /api/streaming/sessions/:sessionId/status
 */
router.get('/sessions/:sessionId/status', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await req.db('agent_streaming_sessions')
      .where({ session_id: sessionId })
      .first();

    if (!session) {
      return res.status(404).json({
        success: false,
        error: '会话不存在'
      });
    }

    if (session.user_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: '无权访问此会话'
      });
    }

    // 获取事件统计
    const [{ count: eventCount }] = await req.db('agent_streaming_events')
      .where({ session_id: sessionId })
      .count('* as count');

    res.json({
      success: true,
      data: {
        ...session,
        eventCount: parseInt(eventCount)
      }
    });
  } catch (error) {
    console.error('获取会话状态失败:', error);
    res.status(500).json({
      success: false,
      error: '获取会话状态失败',
      message: error.message
    });
  }
});

/**
 * 获取用户的所有流式会话
 * GET /api/streaming/sessions
 */
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, limit = 20, offset = 0 } = req.query;

    let query = req.db('agent_streaming_sessions')
      .where({ user_id: userId })
      .orderBy('started_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    if (status) {
      query = query.where({ status });
    }

    const sessions = await query;

    const totalQuery = req.db('agent_streaming_sessions')
      .where({ user_id: userId })
      .count('* as count');

    if (status) {
      totalQuery.where({ status });
    }

    const [{ count }] = await totalQuery;

    res.json({
      success: true,
      data: sessions,
      pagination: {
        total: parseInt(count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('获取流式会话列表失败:', error);
    res.status(500).json({
      success: false,
      error: '获取流式会话列表失败',
      message: error.message
    });
  }
});

module.exports = router;
