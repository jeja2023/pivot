/**
 * 增强的自主规划引擎
 * 支持任务分解、依赖分析、动态调整
 */

/**
 * 任务分解器
 */
class TaskDecomposer {
  constructor(llmService) {
    this.llmService = llmService;
  }

  /**
   * 将复杂任务分解为子任务
   */
  async decompose(task, context = {}) {
    const prompt = this.buildDecomposePrompt(task, context);

    const response = await this.llmService.complete({
      prompt,
      temperature: 0.7,
      maxTokens: 2000,
      schema: {
        type: 'object',
        properties: {
          subtasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                dependencies: { type: 'array', items: { type: 'string' } },
                estimatedComplexity: { type: 'string', enum: ['low', 'medium', 'high'] },
                requiredTools: { type: 'array', items: { type: 'string' } },
                acceptanceCriteria: { type: 'string' }
              },
              required: ['id', 'description', 'dependencies']
            }
          },
          reasoning: { type: 'string' }
        },
        required: ['subtasks', 'reasoning']
      }
    });

    return response;
  }

  buildDecomposePrompt(task, context) {
    return `你是一个任务规划专家。请将以下复杂任务分解为可执行的子任务。

任务描述：
${task}

上下文信息：
${JSON.stringify(context, null, 2)}

要求：
1. 将任务分解为清晰、可执行的子任务
2. 识别子任务之间的依赖关系
3. 评估每个子任务的复杂度（low/medium/high）
4. 为每个子任务指定可能需要的工具
5. 定义每个子任务的完成标准

请以结构化的 JSON 格式返回分解结果。`;
  }
}

/**
 * 依赖分析器
 */
class DependencyAnalyzer {
  /**
   * 构建任务依赖图
   */
  buildDependencyGraph(subtasks) {
    const graph = new Map();
    const inDegree = new Map();

    // 初始化
    for (const task of subtasks) {
      graph.set(task.id, []);
      inDegree.set(task.id, 0);
    }

    // 构建边
    for (const task of subtasks) {
      for (const depId of task.dependencies || []) {
        if (graph.has(depId)) {
          graph.get(depId).push(task.id);
          inDegree.set(task.id, inDegree.get(task.id) + 1);
        }
      }
    }

    return { graph, inDegree };
  }

  /**
   * 拓扑排序，生成执行顺序
   */
  topologicalSort(subtasks) {
    const { graph, inDegree } = this.buildDependencyGraph(subtasks);
    const queue = [];
    const result = [];

    // 找到所有入度为 0 的节点
    for (const [taskId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(taskId);
      }
    }

    // BFS 遍历
    while (queue.length > 0) {
      const current = queue.shift();
      result.push(current);

      for (const neighbor of graph.get(current)) {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    // 检测循环依赖
    if (result.length !== subtasks.length) {
      throw new Error('检测到循环依赖');
    }

    return result;
  }

  /**
   * 识别可并行执行的任务组
   */
  identifyParallelGroups(subtasks) {
    const { inDegree } = this.buildDependencyGraph(subtasks);
    const groups = [];
    const processed = new Set();
    const taskMap = new Map(subtasks.map(t => [t.id, t]));

    while (processed.size < subtasks.length) {
      const currentGroup = [];

      // 找到所有当前可执行的任务（入度为 0 且未处理）
      for (const [taskId, degree] of inDegree.entries()) {
        if (degree === 0 && !processed.has(taskId)) {
          currentGroup.push(taskMap.get(taskId));
          processed.add(taskId);
        }
      }

      if (currentGroup.length === 0) {
        throw new Error('无法继续执行，可能存在循环依赖');
      }

      groups.push(currentGroup);

      // 更新入度
      for (const task of currentGroup) {
        for (const depTask of subtasks) {
          if (depTask.dependencies && depTask.dependencies.includes(task.id)) {
            inDegree.set(depTask.id, inDegree.get(depTask.id) - 1);
          }
        }
      }
    }

    return groups;
  }
}

/**
 * 执行计划生成器
 */
class ExecutionPlanner {
  constructor(llmService) {
    this.llmService = llmService;
    this.decomposer = new TaskDecomposer(llmService);
    this.dependencyAnalyzer = new DependencyAnalyzer();
  }

  /**
   * 生成完整的执行计划
   */
  async generatePlan(task, context = {}) {
    // 1. 分解任务
    const decomposition = await this.decomposer.decompose(task, context);

    // 2. 分析依赖并生成执行顺序
    const parallelGroups = this.dependencyAnalyzer.identifyParallelGroups(
      decomposition.subtasks
    );

    // 3. 估算资源需求
    const resourceEstimate = this.estimateResources(decomposition.subtasks);

    // 4. 生成执行策略
    const strategy = this.determineStrategy(decomposition.subtasks, context);

    return {
      task,
      subtasks: decomposition.subtasks,
      executionGroups: parallelGroups,
      totalSteps: decomposition.subtasks.length,
      estimatedDuration: resourceEstimate.duration,
      estimatedCost: resourceEstimate.cost,
      strategy,
      reasoning: decomposition.reasoning,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 估算资源需求
   */
  estimateResources(subtasks) {
    const complexityWeights = {
      low: 1,
      medium: 3,
      high: 5
    };

    let totalComplexity = 0;
    for (const task of subtasks) {
      totalComplexity += complexityWeights[task.estimatedComplexity || 'medium'];
    }

    return {
      duration: totalComplexity * 30, // 秒
      cost: totalComplexity * 0.01, // 美元（假设值）
      tokens: totalComplexity * 1000
    };
  }

  /**
   * 确定执行策略
   */
  determineStrategy(subtasks, context) {
    const totalTasks = subtasks.length;
    const highComplexityTasks = subtasks.filter(
      t => t.estimatedComplexity === 'high'
    ).length;

    // 如果有多个高复杂度任务，建议分阶段执行
    if (highComplexityTasks > 2) {
      return {
        mode: 'phased',
        description: '分阶段执行，每阶段完成后确认',
        checkpoints: this.identifyCheckpoints(subtasks)
      };
    }

    // 如果任务数量多但复杂度不高，建议并行执行
    if (totalTasks > 5 && highComplexityTasks === 0) {
      return {
        mode: 'parallel',
        description: '最大化并行执行以提高效率',
        maxParallelism: Math.min(totalTasks, 5)
      };
    }

    // 默认顺序执行
    return {
      mode: 'sequential',
      description: '顺序执行，确保稳定性',
      allowPartialFailure: false
    };
  }

  /**
   * 识别检查点
   */
  identifyCheckpoints(subtasks) {
    const checkpoints = [];
    let currentGroup = [];

    for (let i = 0; i < subtasks.length; i++) {
      currentGroup.push(subtasks[i].id);

      // 高复杂度任务后设置检查点
      if (subtasks[i].estimatedComplexity === 'high') {
        checkpoints.push({
          after: subtasks[i].id,
          tasks: [...currentGroup],
          description: `完成 ${subtasks[i].description} 后确认`
        });
        currentGroup = [];
      }
    }

    // 剩余任务作为最后一个检查点
    if (currentGroup.length > 0) {
      checkpoints.push({
        after: currentGroup[currentGroup.length - 1],
        tasks: currentGroup,
        description: '完成所有剩余任务'
      });
    }

    return checkpoints;
  }
}

/**
 * 动态规划调整器
 */
class PlanAdjuster {
  constructor(llmService) {
    this.llmService = llmService;
  }

  /**
   * 根据执行结果调整计划
   */
  async adjustPlan(originalPlan, executionResults, context = {}) {
    // 分析执行情况
    const analysis = this.analyzeExecution(executionResults);

    // 如果一切正常，返回原计划
    if (analysis.status === 'on_track') {
      return {
        adjusted: false,
        plan: originalPlan,
        reason: '执行顺利，无需调整'
      };
    }

    // 需要调整计划
    const adjustmentPrompt = this.buildAdjustmentPrompt(
      originalPlan,
      executionResults,
      analysis
    );

    const response = await this.llmService.complete({
      prompt: adjustmentPrompt,
      temperature: 0.7,
      maxTokens: 2000,
      schema: {
        type: 'object',
        properties: {
          adjustedSubtasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                dependencies: { type: 'array' },
                estimatedComplexity: { type: 'string' }
              }
            }
          },
          reasoning: { type: 'string' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                description: { type: 'string' }
              }
            }
          }
        },
        required: ['adjustedSubtasks', 'reasoning']
      }
    });

    return {
      adjusted: true,
      plan: {
        ...originalPlan,
        subtasks: response.adjustedSubtasks
      },
      reason: response.reasoning,
      changes: response.changes || []
    };
  }

  analyzeExecution(executionResults) {
    let completedTasks = 0;
    let failedTasks = 0;
    let totalTasks = executionResults.length;

    for (const result of executionResults) {
      if (result.status === 'completed') {
        completedTasks++;
      } else if (result.status === 'failed') {
        failedTasks++;
      }
    }

    if (failedTasks === 0) {
      return { status: 'on_track' };
    }

    if (failedTasks > totalTasks * 0.3) {
      return { status: 'major_issues', failedTasks, completedTasks };
    }

    return { status: 'minor_issues', failedTasks, completedTasks };
  }

  buildAdjustmentPrompt(originalPlan, executionResults, analysis) {
    return `你是一个任务规划专家。原计划执行遇到问题，需要调整计划。

原始任务：${originalPlan.task}

原计划子任务：
${JSON.stringify(originalPlan.subtasks, null, 2)}

执行结果：
${JSON.stringify(executionResults, null, 2)}

分析结果：
${JSON.stringify(analysis, null, 2)}

请根据执行情况调整计划：
1. 分析失败原因
2. 调整受影响的子任务
3. 添加必要的新任务或移除不必要的任务
4. 更新依赖关系
5. 说明调整理由

请以结构化的 JSON 格式返回调整后的计划。`;
  }
}

/**
 * 增强的自主规划引擎
 */
class EnhancedPlanningEngine {
  constructor(llmService, db) {
    this.llmService = llmService;
    this.db = db;
    this.planner = new ExecutionPlanner(llmService);
    this.adjuster = new PlanAdjuster(llmService);
  }

  /**
   * 生成执行计划
   */
  async createPlan(task, context = {}) {
    const plan = await this.planner.generatePlan(task, context);

    // 保存计划到数据库
    if (this.db) {
      const [savedPlan] = await this.db('agent_execution_plans')
        .insert({
          task_description: task,
          plan_data: JSON.stringify(plan),
          status: 'pending',
          created_at: new Date()
        })
        .returning('*');

      plan.id = savedPlan.id;
    }

    return plan;
  }

  /**
   * 动态调整计划
   */
  async adjustPlan(planId, executionResults, context = {}) {
    // 获取原计划
    const savedPlan = await this.db('agent_execution_plans')
      .where({ id: planId })
      .first();

    if (!savedPlan) {
      throw new Error('计划不存在');
    }

    const originalPlan = JSON.parse(savedPlan.plan_data);

    // 调整计划
    const adjustment = await this.adjuster.adjustPlan(
      originalPlan,
      executionResults,
      context
    );

    if (adjustment.adjusted) {
      // 更新数据库
      await this.db('agent_execution_plans')
        .where({ id: planId })
        .update({
          plan_data: JSON.stringify(adjustment.plan),
          updated_at: new Date()
        });
    }

    return adjustment;
  }

  /**
   * 获取计划执行进度
   */
  async getPlanProgress(planId) {
    const plan = await this.db('agent_execution_plans')
      .where({ id: planId })
      .first();

    if (!plan) {
      throw new Error('计划不存在');
    }

    const planData = JSON.parse(plan.plan_data);
    const executionResults = await this.db('agent_execution_results')
      .where({ plan_id: planId })
      .select('*');

    const totalTasks = planData.subtasks.length;
    const completedTasks = executionResults.filter(
      r => r.status === 'completed'
    ).length;

    return {
      planId,
      totalTasks,
      completedTasks,
      progress: totalTasks > 0 ? (completedTasks / totalTasks * 100).toFixed(2) : 0,
      status: plan.status,
      executionResults
    };
  }
}

module.exports = {
  EnhancedPlanningEngine,
  TaskDecomposer,
  DependencyAnalyzer,
  ExecutionPlanner,
  PlanAdjuster
};
