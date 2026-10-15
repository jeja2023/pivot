/**
 * 流式交互集成模块
 * 将流式服务集成到现有的 agent 运行时中
 */

const streamingService = require('./streaming-service');

/**
 * 为运行创建流式包装器
 */
function createStreamingWrapper(runId, userId) {
  let sessionId = null;
  let isEnabled = false;

  return {
    /**
     * 启用流式推送
     */
    async enable() {
      try {
        const { sessionId: sid } = await streamingService.createSession(runId, userId);
        sessionId = sid;
        isEnabled = true;
        console.log(`流式包装器已启用: runId=${runId}, sessionId=${sessionId}`);
        return sessionId;
      } catch (error) {
        console.error('启用流式包装器失败:', error);
        isEnabled = false;
        return null;
      }
    },

    /**
     * 发送思考过程
     */
    async sendThinking(step, reasoning, observation = null) {
      if (!isEnabled || !sessionId) return false;
      try {
        return await streamingService.sendThinkingChain(sessionId, step, reasoning, observation);
      } catch (error) {
        console.error('发送思考链失败:', error);
        return false;
      }
    },

    /**
     * 发送工具调用开始
     */
    async sendToolStart(toolName) {
      if (!isEnabled || !sessionId) return false;
      try {
        return await streamingService.sendToolProgress(sessionId, toolName, 'start', 0);
      } catch (error) {
        console.error('发送工具开始失败:', error);
        return false;
      }
    },

    /**
     * 发送工具调用进度
     */
    async sendToolProgress(toolName, progress) {
      if (!isEnabled || !sessionId) return false;
      try {
        return await streamingService.sendToolProgress(sessionId, toolName, 'progress', progress);
      } catch (error) {
        console.error('发送工具进度失败:', error);
        return false;
      }
    },

    /**
     * 发送工具调用结束
     */
    async sendToolEnd(toolName, result = null) {
      if (!isEnabled || !sessionId) return false;
      try {
        return await streamingService.sendToolProgress(sessionId, toolName, 'end', 100, result);
      } catch (error) {
        console.error('发送工具结束失败:', error);
        return false;
      }
    },

    /**
     * 发送输出内容
     */
    async sendOutput(content, isFinal = false) {
      if (!isEnabled || !sessionId) return false;
      try {
        return await streamingService.sendOutputChunk(sessionId, content, isFinal);
      } catch (error) {
        console.error('发送输出内容失败:', error);
        return false;
      }
    },

    /**
     * 发送错误
     */
    async sendError(error) {
      if (!isEnabled || !sessionId) return false;
      try {
        return await streamingService.sendError(sessionId, error);
      } catch (error) {
        console.error('发送错误失败:', error);
        return false;
      }
    },

    /**
     * 发送状态变更
     */
    async sendStatusChange(oldStatus, newStatus, metadata = {}) {
      if (!isEnabled || !sessionId) return false;
      try {
        return await streamingService.sendStatusChange(sessionId, oldStatus, newStatus, metadata);
      } catch (error) {
        console.error('发送状态变更失败:', error);
        return false;
      }
    },

    /**
     * 关闭流式会话
     */
    async close(status = 'completed') {
      if (!isEnabled || !sessionId) return;
      try {
        await streamingService.closeSession(sessionId, status);
        isEnabled = false;
        console.log(`流式会话已关闭: sessionId=${sessionId}, status=${status}`);
      } catch (error) {
        console.error('关闭流式会话失败:', error);
      }
    },

    /**
     * 获取状态
     */
    getStatus() {
      return {
        isEnabled,
        sessionId,
        runId,
        userId
      };
    }
  };
}

/**
 * 包装工具执行函数，添加流式推送
 */
function wrapToolExecutor(originalExecutor, streamingWrapper) {
  return async function wrappedToolExecutor(toolName, input, context) {
    // 发送工具调用开始
    await streamingWrapper.sendToolStart(toolName);

    try {
      // 执行工具
      const result = await originalExecutor(toolName, input, context);

      // 发送工具调用结束
      await streamingWrapper.sendToolEnd(toolName, result);

      return result;
    } catch (error) {
      // 发送错误
      await streamingWrapper.sendError(error);
      throw error;
    }
  };
}

/**
 * 包装规划器，添加思考链推送
 */
function wrapPlanner(originalPlanner, streamingWrapper) {
  return async function wrappedPlanner(context) {
    let stepCounter = 0;

    // 如果原始规划器支持流式输出，直接使用
    if (originalPlanner.supportsStreaming) {
      return await originalPlanner(context, {
        onThinking: async (reasoning, observation) => {
          await streamingWrapper.sendThinking(++stepCounter, reasoning, observation);
        }
      });
    }

    // 否则，在规划前后发送事件
    await streamingWrapper.sendThinking(
      ++stepCounter,
      '正在分析当前任务...',
      null
    );

    const result = await originalPlanner(context);

    await streamingWrapper.sendThinking(
      ++stepCounter,
      '规划完成，准备执行',
      `生成了 ${result.actions ? result.actions.length : 0} 个行动`
    );

    return result;
  };
}

/**
 * 为运行时依赖注入流式支持
 */
function injectStreamingSupport(deps, streamingWrapper) {
  const originalExecuteToolByName = deps.executeToolByName;
  const originalResolveAgentPlanningThinking = deps.resolveAgentPlanningThinking;

  return {
    ...deps,

    // 包装工具执行
    executeToolByName: originalExecuteToolByName
      ? wrapToolExecutor(originalExecuteToolByName, streamingWrapper)
      : originalExecuteToolByName,

    // 包装规划器
    resolveAgentPlanningThinking: originalResolveAgentPlanningThinking
      ? wrapPlanner(originalResolveAgentPlanningThinking, streamingWrapper)
      : originalResolveAgentPlanningThinking,

    // 添加流式包装器引用
    streamingWrapper
  };
}

/**
 * 检查运行是否启用流式
 */
async function isStreamingEnabledForRun(runId, db) {
  // 检查是否有活跃的流式会话
  const sessions = await db('agent_streaming_sessions')
    .where({ run_id: runId, status: 'active' })
    .select('session_id');

  return sessions.length > 0;
}

/**
 * 获取运行的所有流式会话
 */
async function getRunStreamingSessions(runId, db) {
  return await db('agent_streaming_sessions')
    .where({ run_id: runId })
    .orderBy('started_at', 'desc');
}

/**
 * 广播事件到运行的所有活跃会话
 */
async function broadcastToRunSessions(runId, eventType, data, content = null, db) {
  const sessions = await db('agent_streaming_sessions')
    .where({ run_id: runId, status: 'active' })
    .select('session_id');

  const promises = sessions.map(session =>
    streamingService.sendEvent(session.session_id, eventType, data, content)
  );

  await Promise.allSettled(promises);
}

module.exports = {
  createStreamingWrapper,
  wrapToolExecutor,
  wrapPlanner,
  injectStreamingSupport,
  isStreamingEnabledForRun,
  getRunStreamingSessions,
  broadcastToRunSessions
};
