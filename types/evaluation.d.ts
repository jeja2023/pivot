/**
 * 智能体评测与质量保障体系类型定义
 */

declare namespace Evaluation {
  /**
   * 评测用例输入输出及评分项
   */
  interface TestCase {
    /** 用例唯一序号或标识 */
    id?: string | number;
    /** 用例名称 */
    name: string;
    /** 输入参数或 Prompt */
    input: Record<string, any> | string;
    /** 期望输出或标准答案 */
    expected_output?: Record<string, any> | string;
    /** 判定准则或断言表达式 */
    criteria?: string[];
    /** 用例权重 (默认 1.0) */
    weight?: number;
    /** 分类标签 */
    tags?: string[];
  }

  /**
   * 评分权重配置
   */
  interface ScoringConfig {
    /** 准确性评分权重 (0 - 1.0) */
    accuracy_weight?: number;
    /** 成本评分权重 (0 - 1.0) */
    cost_weight?: number;
    /** 延迟评分权重 (0 - 1.0) */
    latency_weight?: number;
    /** 可靠性评分权重 (0 - 1.0) */
    reliability_weight?: number;
    /** 模糊匹配或语义相似度阈值 (0 - 1.0) */
    similarity_threshold?: number;
    /** 最大允许延迟超时时间 (ms) */
    timeout_ms?: number;
  }

  /**
   * 评测套件
   */
  interface EvaluationSuite {
    /** 套件 ID */
    id: number;
    /** 套件名称 */
    name: string;
    /** 详细描述 */
    description?: string;
    /** 绑定的工作流 ID */
    workflow_id?: number | null;
    /** 测试用例列表 */
    test_cases: TestCase[];
    /** 评分规则配置 */
    scoring_config: ScoringConfig;
    /** 创建人 ID */
    created_by?: number | null;
    /** 创建时间 */
    created_at: string;
    /** 更新时间 */
    updated_at: string;
  }

  /**
   * 评测运行记录
   */
  interface EvaluationRun {
    /** 运行记录 ID */
    id: number;
    /** 关联的套件 ID */
    suite_id: number;
    /** 关联的工作流版本 ID */
    workflow_version_id?: number | null;
    /** 总测试用例数 */
    total_cases: number;
    /** 通过用例数 */
    passed_cases: number;
    /** 失败用例数 */
    failed_cases: number;
    /** 跳过用例数 */
    skipped_cases: number;
    /** 平均延迟 (ms) */
    avg_latency_ms?: number | null;
    /** 总 Token 消耗 */
    total_tokens?: number | null;
    /** 平均预估成本 */
    avg_cost?: number | null;
    /** 准确性评分 (0 - 100) */
    accuracy_score?: number | null;
    /** 成本评分 (0 - 100) */
    cost_score?: number | null;
    /** 延迟评分 (0 - 100) */
    latency_score?: number | null;
    /** 可靠性评分 (0 - 100) */
    reliability_score?: number | null;
    /** 综合加权评分 (0 - 100) */
    overall_score?: number | null;
    /** 触发来源 ('manual' | 'scheduled' | 'ci_cd') */
    triggered_by: string;
    /** 运行状态 ('running' | 'completed' | 'failed' | 'aborted') */
    status: 'running' | 'completed' | 'failed' | 'aborted';
    /** 失败异常信息 */
    error_message?: string | null;
    /** 开始时间 */
    started_at: string;
    /** 完成时间 */
    completed_at?: string | null;
    /** 详细结果快照 */
    detailed_results?: CaseResult[];
  }

  /**
   * 单用例执行详情
   */
  interface CaseResult {
    /** 用例结果 ID */
    id?: number;
    /** 关联运行 ID */
    run_id?: number;
    /** 用例序号 (从 0 开始) */
    case_index: number;
    /** 用例名称 */
    case_name?: string;
    /** 实际输入 */
    input: any;
    /** 期望输出 */
    expected_output?: any;
    /** 智能体实际输出 */
    actual_output?: any;
    /** 结果状态 ('passed' | 'failed' | 'skipped' | 'timeout') */
    status: 'passed' | 'failed' | 'skipped' | 'timeout';
    /** 执行耗时 (ms) */
    execution_time_ms?: number;
    /** Token 消耗 */
    token_usage?: number;
    /** 错误堆栈 */
    error_message?: string;
    /** 单项匹配评分 (0 - 100) */
    match_score?: number;
    /** 产生时间 */
    created_at?: string;
  }

  /**
   * 双版本对比结果
   */
  interface EvaluationComparison {
    baseline_run_id: number;
    target_run_id: number;
    score_diff: {
      overall: number;
      accuracy: number;
      latency: number;
      cost: number;
      reliability: number;
    };
    improved_cases: number[];
    regressed_cases: number[];
  }
}

export = Evaluation;
