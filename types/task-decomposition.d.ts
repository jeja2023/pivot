/**
 * 动态任务分解与自主规划增强类型定义
 */

declare namespace TaskDecomposition {
  /**
   * 任务状态
   */
  type TaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

  /**
   * 任务优先级
   */
  type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

  /**
   * 动态任务分解器选项
   */
  interface DecompositionOptions {
    /** 最大分解递归深度 (默认 3) */
    max_depth?: number;
    /** 最大生成的子任务数量上限 (默认 20) */
    max_tasks?: number;
    /** 是否保留人工审批确认点 */
    require_human_approval?: boolean;
    /** 预算上限 (Token 或货币额度) */
    budget_limit?: number;
    /** 允许调用的工具白名单 */
    allowed_tools?: string[];
  }

  /**
   * 可执行子任务节点
   */
  interface SubTask {
    /** 任务节点唯一 ID (如 "task_1", "task_1_2") */
    id: string;
    /** 任务标题 */
    title: string;
    /** 详细执行目标或提示词 */
    description: string;
    /** 所在分解层级深度 (0 为根任务) */
    depth: number;
    /** 父任务 ID */
    parent_id?: string | null;
    /** 前置依赖的任务 ID 列表 */
    dependencies: string[];
    /** 任务优先级 */
    priority: TaskPriority;
    /** 预估耗时 (ms) */
    estimated_time_ms?: number;
    /** 推荐或指定的工具名称 */
    suggested_tools?: string[];
    /** 当前执行状态 */
    status: TaskStatus;
    /** 实际执行产出 */
    result?: any;
    /** 失败异常信息 */
    error?: string;
  }

  /**
   * 子任务依赖有向无环图 (DAG)
   */
  interface TaskDAG {
    /** 任务节点映射表 */
    tasks: Record<string, SubTask>;
    /** 拓扑排序后的执行批次序列 (同一批次内任务可并行执行) */
    parallel_batches: string[][];
    /** 关键路径 (CPM) 任务序列 */
    critical_path: string[];
    /** 是否检测到环路 */
    has_cycle: boolean;
  }

  /**
   * 自适应执行计划
   */
  interface ExecutionPlan {
    /** 计划唯一 UUID */
    id: string;
    /** 初始高层目标 */
    goal: string;
    /** 规划时的上下文元数据 */
    context?: Record<string, any>;
    /** 子任务有向图 */
    dag: TaskDAG;
    /** 分解层数与统计 */
    stats: {
      total_tasks: number;
      completed_tasks: number;
      failed_tasks: number;
      total_estimated_time_ms: number;
    };
    /** 计划整体状态 */
    status: 'draft' | 'executing' | 'completed' | 'adjusted' | 'failed';
    /** 创建时间 */
    created_at: string;
    /** 上次调整时间 */
    updated_at: string;
  }

  /**
   * 拓扑动态调整记录
   */
  interface PlanAdjustment {
    id: string;
    plan_id: string;
    /** 触发调整的原因 (如节点失败、输出分支条件不满足、人工变更) */
    reason: string;
    /** 增补的新任务 */
    added_tasks?: SubTask[];
    /** 移除或废弃的任务 ID */
    removed_task_ids?: string[];
    /** 修改依赖关系的任务 */
    modified_tasks?: SubTask[];
    /** 调整发生时间 */
    adjusted_at: string;
  }
}

export = TaskDecomposition;
