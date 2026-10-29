/**
 * Agent 评测系统 API 路由
 */

const express = require('express');
const router = express.Router();
const { BenchmarkManager } = require('../../services/agent-evaluation/evaluation-framework');
const { getAllTestSuites } = require('../../services/agent-evaluation/test-suites');
const { authMiddleware } = require('../../auth');
const { isAdmin } = require('../../permissions');

// 简单的认证中间件包装
const requireAuth = authMiddleware;
const requireAdmin = (req, res, next) => {
    if (!isAdmin(req.user)) {
        return res.status(403).json({ error: '需要管理员权限' });
    }
    next();
};

/**
 * 获取所有评测套件
 * GET /api/evaluation/suites
 */
router.get('/suites', requireAuth, async (req, res) => {
  try {
    const suites = await req.db('agent_evaluation_suites')
      .select('*')
      .orderBy('created_at', 'desc');

    res.json({
      success: true,
      data: suites,
      count: suites.length
    });
  } catch (error) {
    console.error('获取评测套件失败:', error);
    res.status(500).json({
      success: false,
      error: '获取评测套件失败',
      message: error.message
    });
  }
});

/**
 * 获取单个评测套件详情
 * GET /api/evaluation/suites/:id
 */
router.get('/suites/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const suite = await req.db('agent_evaluation_suites')
      .where({ id })
      .first();

    if (!suite) {
      return res.status(404).json({
        success: false,
        error: '评测套件不存在'
      });
    }

    // 获取该套件的所有用例
    const cases = await req.db('agent_evaluation_cases')
      .where({ suite_id: id })
      .orderBy('created_at', 'asc');

    res.json({
      success: true,
      data: {
        ...suite,
        cases
      }
    });
  } catch (error) {
    console.error('获取评测套件详情失败:', error);
    res.status(500).json({
      success: false,
      error: '获取评测套件详情失败',
      message: error.message
    });
  }
});

/**
 * 创建评测套件
 * POST /api/evaluation/suites
 */
router.post('/suites', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, description, category, version, metadata, cases } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: '套件名称不能为空'
      });
    }

    // 检查重复
    const existing = await req.db('agent_evaluation_suites')
      .where({ name, version: version || '1.0.0' })
      .first();

    if (existing) {
      return res.status(409).json({
        success: false,
        error: '该版本的评测套件已存在'
      });
    }

    // 创建套件
    const [suite] = await req.db('agent_evaluation_suites')
      .insert({
        name,
        description,
        category,
        version: version || '1.0.0',
        metadata: JSON.stringify(metadata || {})
      })
      .returning('*');

    // 创建用例
    if (cases && Array.isArray(cases) && cases.length > 0) {
      const caseRecords = cases.map(c => ({
        suite_id: suite.id,
        name: c.name,
        description: c.description,
        category: c.category,
        difficulty: c.difficulty || 'medium',
        input: c.input,
        context: JSON.stringify(c.context || {}),
        expected_behavior: c.expectedBehavior,
        success_criteria: JSON.stringify(c.successCriteria || {}),
        timeout_ms: c.timeout || 300000,
        tags: c.tags || [],
        metadata: JSON.stringify(c.metadata || {})
      }));

      await req.db('agent_evaluation_cases').insert(caseRecords);
    }

    res.status(201).json({
      success: true,
      data: suite
    });
  } catch (error) {
    console.error('创建评测套件失败:', error);
    res.status(500).json({
      success: false,
      error: '创建评测套件失败',
      message: error.message
    });
  }
});

/**
 * 运行基准测试
 * POST /api/evaluation/run
 */
router.post('/run', requireAuth, async (req, res) => {
  try {
    const { suiteId, options } = req.body;
    const _userId = req.user.id;

    if (!suiteId) {
      return res.status(400).json({
        success: false,
        error: '评测套件ID不能为空'
      });
    }

    // 检查套件是否存在
    const suite = await req.db('agent_evaluation_suites')
      .where({ id: suiteId })
      .first();

    if (!suite) {
      return res.status(404).json({
        success: false,
        error: '评测套件不存在'
      });
    }

    // 创建基准测试管理器
    const benchmarkManager = new BenchmarkManager(req.db);

    // 加载预定义套件（这里需要根据实际情况调整）
    const testSuites = getAllTestSuites();
    const targetSuite = testSuites.find(s => s.name === suite.name);

    if (!targetSuite) {
      return res.status(404).json({
        success: false,
        error: '找不到对应的评测套件实现'
      });
    }

    benchmarkManager.registerSuite(targetSuite);

    // 模拟 Agent 运行器（实际应该使用真实的运行器）
    const mockAgentRunner = async (input, _context) => {
      // 这里应该调用真实的 Agent 运行时
      // 暂时返回模拟结果
      return {
        status: 'completed',
        result: `处理完成: ${input}`,
        steps: [
          { step: 1, action: '分析任务', result: '任务理解完成' },
          { step: 2, action: '执行操作', result: '操作完成' }
        ],
        toolCalls: [],
        metadata: {
          duration: Math.random() * 10000
        }
      };
    };

    // 运行基准测试
    const results = await benchmarkManager.runBenchmark(
      targetSuite.id,
      mockAgentRunner,
      {
        ...options,
        saveResults: true
      }
    );

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error('运行基准测试失败:', error);
    res.status(500).json({
      success: false,
      error: '运行基准测试失败',
      message: error.message
    });
  }
});

/**
 * 获取基准测试结果列表
 * GET /api/evaluation/results
 */
router.get('/results', requireAuth, async (req, res) => {
  try {
    const { suiteId, limit = 20, offset = 0 } = req.query;

    let query = req.db('agent_benchmark_results')
      .select('*')
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    if (suiteId) {
      query = query.where({ suite_id: suiteId });
    }

    const results = await query;

    const totalQuery = req.db('agent_benchmark_results').count('* as count');
    if (suiteId) {
      totalQuery.where({ suite_id: suiteId });
    }
    const [{ count }] = await totalQuery;

    res.json({
      success: true,
      data: results,
      pagination: {
        total: parseInt(count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    console.error('获取基准测试结果失败:', error);
    res.status(500).json({
      success: false,
      error: '获取基准测试结果失败',
      message: error.message
    });
  }
});

/**
 * 获取单个基准测试结果详情
 * GET /api/evaluation/results/:id
 */
router.get('/results/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await req.db('agent_benchmark_results')
      .where({ id })
      .first();

    if (!result) {
      return res.status(404).json({
        success: false,
        error: '基准测试结果不存在'
      });
    }

    // 获取用例执行详情
    const caseExecutions = await req.db('agent_case_executions')
      .where({ benchmark_result_id: id })
      .orderBy('created_at', 'asc');

    res.json({
      success: true,
      data: {
        ...result,
        caseExecutions
      }
    });
  } catch (error) {
    console.error('获取基准测试结果详情失败:', error);
    res.status(500).json({
      success: false,
      error: '获取基准测试结果详情失败',
      message: error.message
    });
  }
});

/**
 * 比较两次基准测试结果
 * GET /api/evaluation/compare/:id1/:id2
 */
router.get('/compare/:id1/:id2', requireAuth, async (req, res) => {
  try {
    const { id1, id2 } = req.params;

    const benchmarkManager = new BenchmarkManager(req.db);
    const comparison = await benchmarkManager.compareResults(id1, id2);

    res.json({
      success: true,
      data: comparison
    });
  } catch (error) {
    console.error('比较基准测试结果失败:', error);
    res.status(500).json({
      success: false,
      error: '比较基准测试结果失败',
      message: error.message
    });
  }
});

/**
 * 获取性能指标趋势
 * GET /api/evaluation/metrics/trend
 */
router.get('/metrics/trend', requireAuth, async (req, res) => {
  try {
    const { suiteId, metricName, days = 30 } = req.query;

    if (!suiteId) {
      return res.status(400).json({
        success: false,
        error: '评测套件ID不能为空'
      });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    let query = req.db('agent_performance_metrics as pm')
      .join('agent_benchmark_results as br', 'pm.benchmark_result_id', 'br.id')
      .where('br.suite_id', suiteId)
      .where('pm.timestamp', '>=', startDate)
      .select(
        'pm.metric_name',
        'pm.metric_value',
        'pm.unit',
        'pm.timestamp',
        'br.average_score'
      )
      .orderBy('pm.timestamp', 'asc');

    if (metricName) {
      query = query.where('pm.metric_name', metricName);
    }

    const metrics = await query;

    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    console.error('获取性能指标趋势失败:', error);
    res.status(500).json({
      success: false,
      error: '获取性能指标趋势失败',
      message: error.message
    });
  }
});

/**
 * 检测回归
 * POST /api/evaluation/regression-check
 */
router.post('/regression-check', requireAuth, async (req, res) => {
  try {
    const { currentResultId, baselineResultId } = req.body;

    if (!currentResultId || !baselineResultId) {
      return res.status(400).json({
        success: false,
        error: '当前结果ID和基线结果ID不能为空'
      });
    }

    const benchmarkManager = new BenchmarkManager(req.db);
    const comparison = await benchmarkManager.compareResults(
      baselineResultId,
      currentResultId
    );

    // 判断是否回归（性能下降超过5%）
    const regressionDetected = comparison.scoreChange < -0.05 ||
                               comparison.passRateChange < -0.05;

    // 找出受影响的用例
    const affectedCases = [];
    if (regressionDetected) {
      const currentCases = await req.db('agent_case_executions')
        .where({ benchmark_result_id: currentResultId })
        .select('*');

      const baselineCases = await req.db('agent_case_executions')
        .where({ benchmark_result_id: baselineResultId })
        .select('*');

      const baselineMap = new Map(baselineCases.map(c => [c.case_name, c]));

      for (const current of currentCases) {
        const baseline = baselineMap.get(current.case_name);
        if (baseline && (current.score < baseline.score - 0.1 ||
                        (!current.passed && baseline.passed))) {
          affectedCases.push(current.case_name);
        }
      }
    }

    // 保存回归检测结果
    const [regressionCheck] = await req.db('agent_regression_checks')
      .insert({
        current_result_id: currentResultId,
        baseline_result_id: baselineResultId,
        regression_detected: regressionDetected,
        score_change: comparison.scoreChange,
        pass_rate_change: comparison.passRateChange,
        affected_cases: affectedCases,
        analysis: JSON.stringify(comparison)
      })
      .returning('*');

    res.json({
      success: true,
      data: {
        regressionDetected,
        comparison,
        affectedCases,
        regressionCheck
      }
    });
  } catch (error) {
    console.error('回归检测失败:', error);
    res.status(500).json({
      success: false,
      error: '回归检测失败',
      message: error.message
    });
  }
});

module.exports = router;
