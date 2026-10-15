/**
 * Agent 评测框架核心模块
 * 提供全面的质量保障和基准测试能力
 */

const { v4: uuidv4 } = require('uuid');

/**
 * 评测用例定义
 */
class EvaluationCase {
  constructor(config) {
    this.id = config.id || uuidv4();
    this.name = config.name;
    this.description = config.description;
    this.category = config.category; // 'correctness' | 'robustness' | 'performance' | 'safety'
    this.difficulty = config.difficulty || 'medium'; // 'easy' | 'medium' | 'hard' | 'expert'
    this.input = config.input; // 用户输入
    this.context = config.context || {}; // 上下文环境
    this.expectedBehavior = config.expectedBehavior; // 期望行为描述
    this.successCriteria = config.successCriteria; // 成功标准（函数或规则）
    this.timeout = config.timeout || 300000; // 超时时间（毫秒）
    this.tags = config.tags || [];
    this.metadata = config.metadata || {};
  }

  /**
   * 验证输出是否符合预期
   */
  async evaluate(output) {
    if (typeof this.successCriteria === 'function') {
      return await this.successCriteria(output, this.input, this.context);
    }

    // 默认规则评估
    const results = {
      passed: false,
      score: 0,
      details: {},
      errors: []
    };

    try {
      // 基本检查
      if (!output || typeof output !== 'object') {
        results.errors.push('输出格式无效');
        return results;
      }

      // 检查是否成功完成
      if (output.status !== 'completed') {
        results.errors.push(`执行未完成: ${output.status}`);
        return results;
      }

      // 检查是否有错误
      if (output.error) {
        results.errors.push(`执行错误: ${output.error}`);
        return results;
      }

      // 检查结果
      if (output.result) {
        results.details.hasResult = true;
        results.score += 0.5;
      }

      // 检查步骤
      if (output.steps && output.steps.length > 0) {
        results.details.stepsCount = output.steps.length;
        results.score += 0.3;
      }

      // 检查工具调用
      if (output.toolCalls && output.toolCalls.length > 0) {
        results.details.toolCallsCount = output.toolCalls.length;
        results.score += 0.2;
      }

      results.passed = results.score >= 0.7;
    } catch (error) {
      results.errors.push(`评估失败: ${error.message}`);
    }

    return results;
  }
}

/**
 * 评测套件
 */
class EvaluationSuite {
  constructor(config) {
    this.id = config.id || uuidv4();
    this.name = config.name;
    this.description = config.description;
    this.cases = config.cases || [];
    this.metadata = config.metadata || {};
  }

  /**
   * 添加评测用例
   */
  addCase(caseConfig) {
    const evalCase = new EvaluationCase(caseConfig);
    this.cases.push(evalCase);
    return evalCase;
  }

  /**
   * 运行评测套件
   */
  async run(agentRunner, options = {}) {
    const results = {
      suiteId: this.id,
      suiteName: this.name,
      startTime: new Date(),
      endTime: null,
      totalCases: this.cases.length,
      passedCases: 0,
      failedCases: 0,
      skippedCases: 0,
      totalScore: 0,
      averageScore: 0,
      caseResults: [],
      summary: {},
      metadata: {}
    };

    for (const evalCase of this.cases) {
      // 跳过条件检查
      if (options.filter && !options.filter(evalCase)) {
        results.skippedCases++;
        continue;
      }

      const caseResult = await this.runCase(evalCase, agentRunner, options);
      results.caseResults.push(caseResult);

      if (caseResult.passed) {
        results.passedCases++;
      } else {
        results.failedCases++;
      }

      results.totalScore += caseResult.score;
    }

    results.endTime = new Date();
    results.duration = results.endTime - results.startTime;
    results.averageScore = results.totalCases > 0
      ? results.totalScore / results.totalCases
      : 0;

    // 生成摘要
    results.summary = this.generateSummary(results);

    return results;
  }

  /**
   * 运行单个用例
   */
  async runCase(evalCase, agentRunner, options = {}) {
    const result = {
      caseId: evalCase.id,
      caseName: evalCase.name,
      category: evalCase.category,
      difficulty: evalCase.difficulty,
      startTime: new Date(),
      endTime: null,
      duration: 0,
      passed: false,
      score: 0,
      output: null,
      evaluation: null,
      error: null,
      metadata: {}
    };

    try {
      // 运行 agent
      const startTime = Date.now();
      const output = await Promise.race([
        agentRunner(evalCase.input, evalCase.context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), evalCase.timeout)
        )
      ]);
      const duration = Date.now() - startTime;

      result.output = output;
      result.duration = duration;
      result.metadata.executionTime = duration;

      // 评估输出
      const evaluation = await evalCase.evaluate(output);
      result.evaluation = evaluation;
      result.passed = evaluation.passed;
      result.score = evaluation.score;

      // 性能评分
      if (duration < 5000) {
        result.metadata.performanceScore = 1.0;
      } else if (duration < 15000) {
        result.metadata.performanceScore = 0.8;
      } else if (duration < 30000) {
        result.metadata.performanceScore = 0.6;
      } else {
        result.metadata.performanceScore = 0.4;
      }

    } catch (error) {
      result.error = error.message;
      result.passed = false;
      result.score = 0;
    }

    result.endTime = new Date();
    return result;
  }

  /**
   * 生成摘要报告
   */
  generateSummary(results) {
    const summary = {
      passRate: results.totalCases > 0
        ? (results.passedCases / results.totalCases * 100).toFixed(2) + '%'
        : '0%',
      averageScore: results.averageScore.toFixed(2),
      totalDuration: results.duration,
      averageDuration: results.totalCases > 0
        ? Math.round(results.duration / results.totalCases)
        : 0,
      byCategory: {},
      byDifficulty: {},
      topFailures: []
    };

    // 按类别统计
    const categoryStats = {};
    const difficultyStats = {};

    for (const caseResult of results.caseResults) {
      // 类别统计
      if (!categoryStats[caseResult.category]) {
        categoryStats[caseResult.category] = {
          total: 0,
          passed: 0,
          totalScore: 0
        };
      }
      categoryStats[caseResult.category].total++;
      if (caseResult.passed) {
        categoryStats[caseResult.category].passed++;
      }
      categoryStats[caseResult.category].totalScore += caseResult.score;

      // 难度统计
      if (!difficultyStats[caseResult.difficulty]) {
        difficultyStats[caseResult.difficulty] = {
          total: 0,
          passed: 0,
          totalScore: 0
        };
      }
      difficultyStats[caseResult.difficulty].total++;
      if (caseResult.passed) {
        difficultyStats[caseResult.difficulty].passed++;
      }
      difficultyStats[caseResult.difficulty].totalScore += caseResult.score;
    }

    // 计算类别通过率
    for (const [category, stats] of Object.entries(categoryStats)) {
      summary.byCategory[category] = {
        passRate: (stats.passed / stats.total * 100).toFixed(2) + '%',
        averageScore: (stats.totalScore / stats.total).toFixed(2),
        total: stats.total,
        passed: stats.passed
      };
    }

    // 计算难度通过率
    for (const [difficulty, stats] of Object.entries(difficultyStats)) {
      summary.byDifficulty[difficulty] = {
        passRate: (stats.passed / stats.total * 100).toFixed(2) + '%',
        averageScore: (stats.totalScore / stats.total).toFixed(2),
        total: stats.total,
        passed: stats.passed
      };
    }

    // 找出失败率最高的用例
    summary.topFailures = results.caseResults
      .filter(r => !r.passed)
      .sort((a, b) => a.score - b.score)
      .slice(0, 5)
      .map(r => ({
        caseName: r.caseName,
        category: r.category,
        difficulty: r.difficulty,
        score: r.score,
        error: r.error
      }));

    return summary;
  }
}

/**
 * 基准测试管理器
 */
class BenchmarkManager {
  constructor(db) {
    this.db = db;
    this.suites = new Map();
  }

  /**
   * 注册评测套件
   */
  registerSuite(suite) {
    if (!(suite instanceof EvaluationSuite)) {
      throw new Error('必须是 EvaluationSuite 实例');
    }
    this.suites.set(suite.id, suite);
    return suite;
  }

  /**
   * 运行基准测试
   */
  async runBenchmark(suiteId, agentRunner, options = {}) {
    const suite = this.suites.get(suiteId);
    if (!suite) {
      throw new Error(`评测套件不存在: ${suiteId}`);
    }

    const results = await suite.run(agentRunner, options);

    // 保存结果到数据库
    if (this.db && options.saveResults !== false) {
      await this.saveBenchmarkResults(results);
    }

    return results;
  }

  /**
   * 保存基准测试结果
   */
  async saveBenchmarkResults(results) {
    const record = {
      id: uuidv4(),
      suite_id: results.suiteId,
      suite_name: results.suiteName,
      started_at: results.startTime,
      ended_at: results.endTime,
      duration_ms: results.duration,
      total_cases: results.totalCases,
      passed_cases: results.passedCases,
      failed_cases: results.failedCases,
      skipped_cases: results.skippedCases,
      average_score: results.averageScore,
      summary: JSON.stringify(results.summary),
      case_results: JSON.stringify(results.caseResults),
      metadata: JSON.stringify(results.metadata),
      created_at: new Date()
    };

    await this.db('agent_benchmark_results').insert(record);
    return record.id;
  }

  /**
   * 获取历史基准测试结果
   */
  async getHistoricalResults(suiteId, limit = 10) {
    return await this.db('agent_benchmark_results')
      .where({ suite_id: suiteId })
      .orderBy('created_at', 'desc')
      .limit(limit);
  }

  /**
   * 比较两次基准测试结果
   */
  async compareResults(resultId1, resultId2) {
    const [result1, result2] = await Promise.all([
      this.db('agent_benchmark_results').where({ id: resultId1 }).first(),
      this.db('agent_benchmark_results').where({ id: resultId2 }).first()
    ]);

    if (!result1 || !result2) {
      throw new Error('基准测试结果不存在');
    }

    return {
      scoreChange: result2.average_score - result1.average_score,
      passRateChange: (result2.passed_cases / result2.total_cases) -
                     (result1.passed_cases / result1.total_cases),
      durationChange: result2.duration_ms - result1.duration_ms,
      improved: result2.average_score > result1.average_score,
      summary: {
        result1: JSON.parse(result1.summary),
        result2: JSON.parse(result2.summary)
      }
    };
  }
}

module.exports = {
  EvaluationCase,
  EvaluationSuite,
  BenchmarkManager
};
