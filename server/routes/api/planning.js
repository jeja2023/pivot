/**
 * 自主规划 API 路由
 */

const express = require('express');
const router = express.Router();
const { EnhancedPlanningEngine } = require('../../services/agent-runtime/enhanced-planning');
const { authMiddleware: requireAuth } = require('../../auth');

// 模拟 LLM 服务（实际应该注入真实服务）
const mockLLMService = {
  async complete(options) {
    // 这里应该调用真实的 LLM API
    // 暂时返回模拟数据
    console.log('LLM 请求:', options.prompt.substring(0, 100) + '...');

    if (options.prompt.includes('分解为子任务')) {
      return {
        subtasks: [
          {
            id: 'task-1',
            description: '分析需求',
            dependencies: [],
            estimatedComplexity: 'low',
            requiredTools: ['read_file'],
            acceptanceCriteria: '需求文档已读取并理解'
          },
          {
            id: 'task-2',
            description: '设计方案',
            dependencies: ['task-1'],
            estimatedComplexity: 'medium',
            requiredTools: ['search_files'],
            acceptanceCriteria: '技术方案已确定'
          },
          {
            id: 'task-3',
            description: '实现功能',
            dependencies: ['task-2'],
            estimatedComplexity: 'high',
            requiredTools: ['write_file', 'execute_command'],
            acceptanceCriteria: '代码已编写并通过测试'
          }
        ],
        reasoning: '将复杂任务分解为需求分析、方案设计、功能实现三个阶段'
      };
    }

    if (options.prompt.includes('调整计划')) {
      return {
        adjustedSubtasks: [
          {
            id: 'task-1',
            description: '分析需求（已完成）',
            dependencies: [],
            estimatedComplexity: 'low'
          },
          {
            id: 'task-2-revised',
            description: '重新设计方案',
            dependencies: ['task-1'],
            estimatedComplexity: 'medium'
          },
          {
            id: 'task-3',
            description: '实现功能',
            dependencies: ['task-2-revised'],
            estimatedComplexity: 'high'
          }
        ],
        reasoning: '由于设计阶段遇到问题，需要重新设计方案',
        changes: [
          { type: 'modified', description: '将 task-2 修改为 task-2-revised' }
        ]
      };
    }

    return { subtasks: [], reasoning: '无法处理该请求' };
  }
};

let planningEngine = null;

/**
 * 获取规划引擎实例
 */
function getPlanningEngine(db) {
  if (!planningEngine) {
    planningEngine = new EnhancedPlanningEngine(mockLLMService, db);
  }
  return planningEngine;
}

/**
 * 创建执行计划
 * POST /api/planning/create
 */
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { task, context = {} } = req.body;

    if (!task) {
      return res.status(400).json({
        success: false,
        error: '任务描述不能为空'
      });
    }

    const engine = getPlanningEngine(req.db);
    const plan = await engine.createPlan(task, {
      ...context,
      userId: req.user.id
    });

    res.json({
      success: true,
      data: plan
    });
  } catch (error) {
    console.error('创建执行计划失败:', error);
    res.status(500).json({
      success: false,
      error: '创建执行计划失败',
      message: error.message
    });
  }
});

/**
 * 获取执行计划详情
 * GET /api/planning/:planId
 */
router.get('/:planId', requireAuth, async (req, res) => {
  try {
    const { planId } = req.params;

    const plan = await req.db('agent_execution_plans')
      .where({ id: planId })
      .first();

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: '计划不存在'
      });
    }

    // 解析 JSON 数据
    plan.plan_data = JSON.parse(plan.plan_data);

    res.json({
      success: true,
      data: plan
    });
  } catch (error) {
    console.error('获取执行计划失败:', error);
    res.status(500).json({
      success: false,
      error: '获取执行计划失败',
      message: error.message
    });
  }
});

/**
 * 获取计划执行进度
 * GET /api/planning/:planId/progress
 */
router.get('/:planId/progress', requireAuth, async (req, res) => {
  try {
    const { planId } = req.params;

    const engine = getPlanningEngine(req.db);
    const progress = await engine.getPlanProgress(planId);

    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('获取计划进度失败:', error);
    res.status(500).json({
      success: false,
      error: '获取计划进度失败',
      message: error.message
    });
  }
});

/**
 * 调整执行计划
 * POST /api/planning/:planId/adjust
 */
router.post('/:planId/adjust', requireAuth, async (req, res) => {
  try {
    const { planId } = req.params;
    const { executionResults, context = {} } = req.body;

    if (!executionResults) {
      return res.status(400).json({
        success: false,
        error: '执行结果不能为空'
      });
    }

    const engine = getPlanningEngine(req.db);
    const adjustment = await engine.adjustPlan(planId, executionResults, context);

    // 如果有调整，保存调整历史
    if (adjustment.adjusted) {
      await req.db('agent_plan_adjustments').insert({
        plan_id: planId,
        original_plan: JSON.stringify(adjustment.plan),
        adjusted_plan: JSON.stringify(adjustment.plan),
        reason: adjustment.reason,
        changes: JSON.stringify(adjustment.changes || []),
        created_at: new Date()
      });
    }

    res.json({
      success: true,
      data: adjustment
    });
  } catch (error) {
    console.error('调整执行计划失败:', error);
    res.status(500).json({
      success: false,
      error: '调整执行计划失败',
      message: error.message
    });
  }
});

/**
 * 记录任务执行结果
 * POST /api/planning/:planId/results
 */
router.post('/:planId/results', requireAuth, async (req, res) => {
  try {
    const { planId } = req.params;
    const { taskId, taskDescription, status, result, error, duration } = req.body;

    if (!taskId || !status) {
      return res.status(400).json({
        success: false,
        error: '任务ID和状态不能为空'
      });
    }

    const now = new Date();
    const [executionResult] = await req.db('agent_execution_results')
      .insert({
        plan_id: planId,
        task_id: taskId,
        task_description: taskDescription,
        status,
        result: JSON.stringify(result || {}),
        error,
        started_at: new Date(now.getTime() - (duration || 0)),
        completed_at: now,
        duration_ms: duration,
        created_at: now
      })
      .returning('*');

    // 更新计划状态
    const allResults = await req.db('agent_execution_results')
      .where({ plan_id: planId })
      .select('status');

    const plan = await req.db('agent_execution_plans')
      .where({ id: planId })
      .first();

    if (plan) {
      const planData = JSON.parse(plan.plan_data);
      const totalTasks = planData.subtasks.length;
      const completedTasks = allResults.filter(r => r.status === 'completed').length;

      let planStatus = 'running';
      if (completedTasks === totalTasks) {
        planStatus = 'completed';
      } else if (allResults.some(r => r.status === 'failed')) {
        planStatus = 'failed';
      }

      await req.db('agent_execution_plans')
        .where({ id: planId })
        .update({
          status: planStatus,
          updated_at: now,
          completed_at: planStatus === 'completed' ? now : null
        });
    }

    res.json({
      success: true,
      data: executionResult
    });
  } catch (error) {
    console.error('记录任务执行结果失败:', error);
    res.status(500).json({
      success: false,
      error: '记录任务执行结果失败',
      message: error.message
    });
  }
});

/**
 * 获取计划调整历史
 * GET /api/planning/:planId/adjustments
 */
router.get('/:planId/adjustments', requireAuth, async (req, res) => {
  try {
    const { planId } = req.params;

    const adjustments = await req.db('agent_plan_adjustments')
      .where({ plan_id: planId })
      .orderBy('created_at', 'desc');

    // 解析 JSON 数据
    const parsedAdjustments = adjustments.map(adj => ({
      ...adj,
      original_plan: JSON.parse(adj.original_plan),
      adjusted_plan: JSON.parse(adj.adjusted_plan),
      changes: JSON.parse(adj.changes)
    }));

    res.json({
      success: true,
      data: parsedAdjustments
    });
  } catch (error) {
    console.error('获取计划调整历史失败:', error);
    res.status(500).json({
      success: false,
      error: '获取计划调整历史失败',
      message: error.message
    });
  }
});

/**
 * 获取用户的所有计划
 * GET /api/planning/list
 */
router.get('/list', requireAuth, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    const userId = req.user.id;

    let query = req.db('agent_execution_plans')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    if (status) {
      query = query.where({ status });
    }

    const plans = await query;

    // 解析 plan_data
    const parsedPlans = plans.map(plan => ({
      ...plan,
      plan_data: JSON.parse(plan.plan_data)
    }));

    const totalQuery = req.db('agent_execution_plans')
      .where({ user_id: userId })
      .count('* as count');

    if (status) {
      totalQuery.where({ status });
    }

    const [{ count }] = await totalQuery;

    res.json({
      success: true,
      data: parsedPlans,
      pagination: {
        total: parseInt(count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('获取计划列表失败:', error);
    res.status(500).json({
      success: false,
      error: '获取计划列表失败',
      message: error.message
    });
  }
});

/**
 * 删除计划
 * DELETE /api/planning/:planId
 */
router.delete('/:planId', requireAuth, async (req, res) => {
  try {
    const { planId } = req.params;
    const userId = req.user.id;

    const plan = await req.db('agent_execution_plans')
      .where({ id: planId, user_id: userId })
      .first();

    if (!plan) {
      return res.status(404).json({
        success: false,
        error: '计划不存在或无权删除'
      });
    }

    await req.db('agent_execution_plans')
      .where({ id: planId })
      .delete();

    res.json({
      success: true,
      message: '计划已删除'
    });
  } catch (error) {
    console.error('删除计划失败:', error);
    res.status(500).json({
      success: false,
      error: '删除计划失败',
      message: error.message
    });
  }
});

module.exports = router;
