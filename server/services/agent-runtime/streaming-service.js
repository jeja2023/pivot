/**
 * 流式交互服务
 * 提供实时流式推送、思考链可视化、性能优化
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const db = require('../../db/connection');
const { logger } = require('../../logger');

class StreamingService extends EventEmitter {
  constructor() {
    super();
    this.activeSessions = new Map(); // sessionId -> { res, runId, userId, startTime }
    this.sessionBuffers = new Map(); // sessionId -> event buffer
    this.heartbeatInterval = 30000; // 30秒心跳

    // 启动心跳检查
    this.startHeartbeat();
  }

  /**
   * 创建流式会话
   */
  async createSession(runId, userId) {
    const sessionId = uuidv4();

    // 插入会话记录
    const [session] = await db('agent_streaming_sessions')
      .insert({
        run_id: runId,
        user_id: userId,
        session_id: sessionId,
        status: 'active',
        started_at: new Date()
      })
      .returning('*');

    // 初始化缓冲区
    this.sessionBuffers.set(sessionId, []);

    return {
      sessionId,
      session
    };
  }

  /**
   * 连接SSE流
   */
  async connectSSE(req, res, runId, userId) {
    const { sessionId } = await this.createSession(runId, userId);

    // 设置SSE头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用nginx缓冲
      'Access-Control-Allow-Origin': '*'
    });

    // 记录连接
    this.activeSessions.set(sessionId, {
      res,
      runId,
      userId,
      startTime: Date.now(),
      lastActivity: Date.now(),
      eventCount: 0
    });

    // 发送连接确认
    this.sendEvent(sessionId, 'connected', {
      sessionId,
      runId,
      timestamp: new Date().toISOString()
    });

    // 处理客户端断开
    req.on('close', () => {
      this.closeSession(sessionId);
    });

    return sessionId;
  }

  /**
   * 发送流式事件
   */
  async sendEvent(sessionId, eventType, data, content = null) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.warn(`Session ${sessionId} not found or already closed`);
      return false;
    }

    const { res, runId, userId } = session;
    const sequence = session.eventCount++;
    const timestamp = Date.now();

    // 计算首字延迟
    let firstByteLatency = null;
    if (sequence === 0) {
      firstByteLatency = timestamp - session.startTime;
      await this.updateSessionMetrics(sessionId, { first_byte_latency_ms: firstByteLatency });
    }

    // 构建事件数据
    const eventData = {
      type: eventType,
      sequence,
      data,
      content,
      timestamp: new Date(timestamp).toISOString(),
      latency: timestamp - session.lastActivity
    };

    // 记录到数据库（异步，不阻塞）
    this.recordEvent(runId, userId, eventType, data, content, sequence, eventData.latency)
      .catch(err => console.error('记录流式事件失败:', err));

    // 发送SSE
    try {
      res.write(`id: ${sequence}\n`);
      res.write(`event: ${eventType}\n`);
      res.write(`data: ${JSON.stringify(eventData)}\n\n`);

      session.lastActivity = timestamp;
      return true;
    } catch (err) {
      console.error(`发送事件失败 [${sessionId}]:`, err);
      this.closeSession(sessionId);
      return false;
    }
  }

  /**
   * 发送思考链事件
   */
  async sendThinkingChain(sessionId, step, reasoning, observation = null) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;

    // 记录思考链
    const thinkingRecord = await db('agent_thinking_chains')
      .insert({
        run_id: session.runId,
        session_id: await this.getSessionDbId(sessionId),
        step_number: step,
        reasoning,
        observation,
        started_at: new Date()
      })
      .returning('*');

    // 分块发送思考内容
    const chunks = this.chunkText(reasoning, 100); // 每100字符一块

    // 发送开始事件
    await this.sendEvent(sessionId, 'thinking_start', {
      step,
      totalChunks: chunks.length
    });

    // 发送思考内容块
    for (let i = 0; i < chunks.length; i++) {
      await this.sendEvent(sessionId, 'thinking_chunk', {
        step,
        chunk: i,
        totalChunks: chunks.length,
        progress: ((i + 1) / chunks.length * 100).toFixed(1)
      }, chunks[i]);

      // 模拟逐字输出效果（可选）
      await this.sleep(50);
    }

    // 发送结束事件
    await this.sendEvent(sessionId, 'thinking_end', {
      step,
      observation: observation || null,
      thinkingId: thinkingRecord[0].id
    });

    return true;
  }

  /**
   * 发送工具调用进度
   */
  async sendToolProgress(sessionId, toolName, status, progress, result = null) {
    const eventType = status === 'start' ? 'tool_call_start' :
                     status === 'progress' ? 'tool_call_progress' :
                     'tool_call_end';

    return await this.sendEvent(sessionId, eventType, {
      tool: toolName,
      status,
      progress,
      result: result ? this.sanitizeResult(result) : null
    });
  }

  /**
   * 发送输出内容（流式）
   */
  async sendOutputChunk(sessionId, content, isFinal = false) {
    const eventType = isFinal ? 'output_end' : 'output_chunk';

    return await this.sendEvent(sessionId, eventType, {
      isFinal,
      length: content ? content.length : 0
    }, content);
  }

  /**
   * 发送错误事件
   */
  async sendError(sessionId, error) {
    return await this.sendEvent(sessionId, 'error', {
      message: error.message,
      code: error.code || 'UNKNOWN_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }

  /**
   * 发送状态变更
   */
  async sendStatusChange(sessionId, oldStatus, newStatus, metadata = {}) {
    return await this.sendEvent(sessionId, 'status_change', {
      oldStatus,
      newStatus,
      ...metadata
    });
  }

  /**
   * 关闭会话
   */
  async closeSession(sessionId, status = 'completed') {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const { res, startTime, eventCount } = session;
    const duration = Date.now() - startTime;

    // 更新会话状态
    await db('agent_streaming_sessions')
      .where({ session_id: sessionId })
      .update({
        status,
        completed_at: new Date(),
        total_chunks: eventCount,
        avg_chunk_latency_ms: eventCount > 0 ? Math.round(duration / eventCount) : 0
      });

    // 发送关闭事件
    try {
      res.write(`event: close\n`);
      res.write(`data: ${JSON.stringify({ status, duration, eventCount })}\n\n`);
      res.end();
    } catch (err) {
      // 连接可能已关闭
    }

    // 清理
    this.activeSessions.delete(sessionId);
    this.sessionBuffers.delete(sessionId);

    console.log(`Session ${sessionId} closed: ${status}, duration: ${duration}ms, events: ${eventCount}`);
  }

  /**
   * 记录事件到数据库
   */
  async recordEvent(runId, userId, eventType, data, content, sequence, latency) {
    try {
      await db('agent_streaming_events').insert({
        run_id: runId,
        user_id: userId,
        event_type: eventType,
        data: JSON.stringify(data),
        content,
        sequence,
        latency_ms: latency,
        token_count: content ? this.estimateTokens(content) : 0,
        created_at: new Date()
      });
    } catch (err) {
      console.error('记录流式事件失败:', err);
      // 不抛出异常，避免影响流式推送
    }
  }

  /**
   * 更新会话指标
   */
  async updateSessionMetrics(sessionId, metrics) {
    try {
      await db('agent_streaming_sessions')
        .where({ session_id: sessionId })
        .update({
          ...metrics,
          last_activity_at: new Date()
        });
    } catch (err) {
      console.error('更新会话指标失败:', err);
    }
  }

  /**
   * 获取会话数据库ID
   */
  async getSessionDbId(sessionId) {
    const [session] = await db('agent_streaming_sessions')
      .where({ session_id: sessionId })
      .select('id');
    return session ? session.id : null;
  }

  /**
   * 心跳检查
   */
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeout = 5 * 60 * 1000; // 5分钟超时

      for (const [sessionId, session] of this.activeSessions.entries()) {
        // 发送心跳
        try {
          session.res.write(`:heartbeat ${now}\n\n`);
        } catch (err) {
          console.warn(`心跳发送失败，关闭会话 ${sessionId}`);
          this.closeSession(sessionId, 'error');
          continue;
        }

        // 检查超时
        if (now - session.lastActivity > timeout) {
          console.warn(`会话超时，关闭 ${sessionId}`);
          this.closeSession(sessionId, 'timeout');
        }
      }
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref?.();
  }

  /**
   * 工具函数：分块文本
   */
  chunkText(text, chunkSize = 100) {
    if (!text) return [];
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * 工具函数：估算token数
   */
  estimateTokens(text) {
    if (!text) return 0;
    // 简单估算：中文1字=1token，英文1词=1token
    const chineseChars = (text.match(/[一-龥]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    return chineseChars + englishWords;
  }

  /**
   * 工具函数：清理结果（移除敏感信息）
   */
  sanitizeResult(result) {
    if (typeof result === 'string' && result.length > 1000) {
      return result.slice(0, 1000) + '... (truncated)';
    }
    return result;
  }

  /**
   * 工具函数：延迟
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取活跃会话统计
   */
  getStats() {
    return {
      activeSessions: this.activeSessions.size,
      sessions: Array.from(this.activeSessions.entries()).map(([id, session]) => ({
        sessionId: id,
        runId: session.runId,
        userId: session.userId,
        duration: Date.now() - session.startTime,
        eventCount: session.eventCount
      }))
    };
  }

  /**
   * 清理所有会话（用于服务关闭）
   */
  async cleanup() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const sessions = [...this.activeSessions.entries()];
    const results = await Promise.allSettled(sessions.map(async ([sessionId, session]) => {
      try { await this.closeSession(sessionId, 'shutdown'); }
      finally {
        try { session.res.end(); } catch (_) {}
        this.activeSessions.delete(sessionId);
        this.sessionBuffers.delete(sessionId);
      }
    }));
    const failures = results.filter(result => result.status === 'rejected').length;
    if (failures) logger.warn({ failures }, '旧流式会话状态清理失败，连接已释放');
  }
}

// 单例模式
const streamingService = new StreamingService();

module.exports = streamingService;
