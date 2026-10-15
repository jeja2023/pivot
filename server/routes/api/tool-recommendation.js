/**
 * 工具推荐 API 路由
 */

const express = require('express');
const router = express.Router();
const { ToolRecommendationEngine } = require('../../services/agent-runtime/tool-recommendation');
const { authMiddleware: requireAuth } = require('../../auth');

let recommendationEngine = null;

/**
 * 获取推荐引擎实例
 */
function getRecommendationEngine(db) {
  if (!recommendationEngine) {
    recommendationEngine = new ToolRecommendationEngine(db);
  }
  return recommendationEngine;
}

/**
 * 获取工具推荐
 * POST /api/tools/recommend
 */
router.post('/recommend', requireAuth, async (req, res) => {
  try {
    const { task, intent, entities, limit = 5 } = req.body;

    if (!task) {
      return res.status(400).json({
        success: false,
        error: '任务描述不能为空'
      });
    }

    const engine = getRecommendationEngine(req.db);
    const recommendations = await engine.recommend(
      { task, intent, entities },
      limit
    );

    // 记录推荐日志
    await req.db('tool_recommendation_logs').insert({
      user_id: req.user.id,
      task_description: task,
      intent: intent || null,
      entities: JSON.stringify(entities || []),
      recommended_tools: JSON.stringify(recommendations.map(r => ({
        id: r.tool.id,
        name: r.tool.name,
        score: r.score,
        confidence: r.confidence
      }))),
      created_at: new Date()
    });

    res.json({
      success: true,
      data: recommendations
    });
  } catch (error) {
    console.error('获取工具推荐失败:', error);
    res.status(500).json({
      success: false,
      error: '获取工具推荐失败',
      message: error.message
    });
  }
});

/**
 * 记录工具使用反馈
 * POST /api/tools/feedback
 */
router.post('/feedback', requireAuth, async (req, res) => {
  try {
    const { logId, selectedToolId, feedback } = req.body;

    if (!logId) {
      return res.status(400).json({
        success: false,
        error: '日志ID不能为空'
      });
    }

    // 更新推荐日志
    await req.db('tool_recommendation_logs')
      .where({ id: logId, user_id: req.user.id })
      .update({
        selected_tool_id: selectedToolId,
        feedback: feedback || 'used'
      });

    // 记录工具使用统计
    if (selectedToolId) {
      const engine = getRecommendationEngine(req.db);
      await engine.recordUsage(selectedToolId, feedback !== 'failed');
    }

    res.json({
      success: true,
      message: '反馈已记录'
    });
  } catch (error) {
    console.error('记录工具使用反馈失败:', error);
    res.status(500).json({
      success: false,
      error: '记录工具使用反馈失败',
      message: error.message
    });
  }
});

/**
 * 获取工具使用统计
 * GET /api/tools/stats
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { toolId, days = 30 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    let query = req.db('tool_usage_stats')
      .where('created_at', '>=', startDate)
      .select('*');

    if (toolId) {
      query = query.where({ tool_id: toolId });
    }

    const stats = await query.orderBy('usage_count', 'desc');

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('获取工具使用统计失败:', error);
    res.status(500).json({
      success: false,
      error: '获取工具使用统计失败',
      message: error.message
    });
  }
});

/**
 * 获取热门工具排行
 * GET /api/tools/trending
 */
router.get('/trending', requireAuth, async (req, res) => {
  try {
    const { limit = 10, days = 7 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const trending = await req.db('tool_usage_stats')
      .where('created_at', '>=', startDate)
      .select('tool_id', 'usage_count', 'success_count', 'failure_count')
      .orderBy('usage_count', 'desc')
      .limit(parseInt(limit));

    // 计算成功率
    const trendingWithRate = trending.map(tool => ({
      ...tool,
      success_rate: tool.usage_count > 0
        ? (tool.success_count / tool.usage_count).toFixed(2)
        : '0.00'
    }));

    res.json({
      success: true,
      data: trendingWithRate
    });
  } catch (error) {
    console.error('获取热门工具排行失败:', error);
    res.status(500).json({
      success: false,
      error: '获取热门工具排行失败',
      message: error.message
    });
  }
});

/**
 * 获取工具推荐效果分析
 * GET /api/tools/recommendation-effectiveness
 */
router.get('/recommendation-effectiveness', requireAuth, async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // 获取推荐日志
    const logs = await req.db('tool_recommendation_logs')
      .where('created_at', '>=', startDate)
      .select('*');

    // 计算统计指标
    const totalRecommendations = logs.length;
    const selectedTools = logs.filter(log => log.selected_tool_id).length;
    const positiveFeedback = logs.filter(log => log.feedback === 'helpful').length;
    const negativeFeedback = logs.filter(log => log.feedback === 'not_helpful').length;

    // 分析推荐准确率
    let topOneAccuracy = 0;
    let topThreeAccuracy = 0;

    for (const log of logs) {
      if (!log.selected_tool_id || !log.recommended_tools) continue;

      const recommended = JSON.parse(log.recommended_tools);
      if (recommended.length > 0 && recommended[0].id === log.selected_tool_id) {
        topOneAccuracy++;
      }
      if (recommended.slice(0, 3).some(r => r.id === log.selected_tool_id)) {
        topThreeAccuracy++;
      }
    }

    const effectiveness = {
      period: `${days} 天`,
      totalRecommendations,
      adoptionRate: (selectedTools / totalRecommendations * 100).toFixed(2) + '%',
      topOneAccuracy: selectedTools > 0 ? (topOneAccuracy / selectedTools * 100).toFixed(2) + '%' : '0%',
      topThreeAccuracy: selectedTools > 0 ? (topThreeAccuracy / selectedTools * 100).toFixed(2) + '%' : '0%',
      positiveFeedbackRate: selectedTools > 0 ? (positiveFeedback / selectedTools * 100).toFixed(2) + '%' : '0%',
      negativeFeedbackRate: selectedTools > 0 ? (negativeFeedback / selectedTools * 100).toFixed(2) + '%' : '0%'
    };

    res.json({
      success: true,
      data: effectiveness
    });
  } catch (error) {
    console.error('获取推荐效果分析失败:', error);
    res.status(500).json({
      success: false,
      error: '获取推荐效果分析失败',
      message: error.message
    });
  }
});

/**
 * 重新初始化推荐引擎
 * POST /api/tools/reinitialize
 */
router.post('/reinitialize', requireAuth, async (req, res) => {
  try {
    // 检查是否为管理员
    if (!req.user.is_admin) {
      return res.status(403).json({
        success: false,
        error: '只有管理员可以重新初始化推荐引擎'
      });
    }

    const engine = getRecommendationEngine(req.db);
    engine.initialized = false;
    await engine.initialize();

    res.json({
      success: true,
      message: '推荐引擎已重新初始化'
    });
  } catch (error) {
    console.error('重新初始化推荐引擎失败:', error);
    res.status(500).json({
      success: false,
      error: '重新初始化推荐引擎失败',
      message: error.message
    });
  }
});

module.exports = router;
