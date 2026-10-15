/**
 * 智能体质量监控与指标体系类型定义
 */

declare namespace QualityMetrics {
  /**
   * 质量监控时间粒度指标
   */
  interface MetricRecord {
    /** 记录自增 ID */
    id: number;
    /** 关联的工作流 ID */
    workflow_id: number;
    /** 指标归属日期 (YYYY-MM-DD) */
    metric_date: string;
    /** 指标归属小时 (0 - 23，可选) */
    metric_hour?: number | null;

    /** 总执行次数 */
    total_runs: number;
    /** 成功次数 */
    success_runs: number;
    /** 失败次数 */
    failed_runs: number;
    /** 超时次数 */
    timeout_runs: number;

    /** 平均耗时 (ms) */
    avg_latency_ms?: number | null;
    /** P50 延迟分位数 (ms) */
    p50_latency_ms?: number | null;
    /** P95 延迟分位数 (ms) */
    p95_latency_ms?: number | null;
    /** P99 延迟分位数 (ms) */
    p99_latency_ms?: number | null;

    /** 累计消耗 Token 数 */
    total_tokens?: number;
    /** 单次平均消耗 Token 数 */
    avg_tokens?: number | null;
    /** 累计预估成本 (元/美元) */
    total_cost?: number | null;

    /** 记录创建时间 */
    created_at: string;
  }

  /**
   * 趋势图表时间序列点
   */
  interface TrendPoint {
    timestamp: string;
    success_rate: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    total_runs: number;
    total_cost: number;
  }

  /**
   * 质量指标趋势查询结果
   */
  interface MetricTrendResponse {
    workflow_id?: number;
    time_window: '24h' | '7d' | '30d';
    trends: TrendPoint[];
    summary: {
      overall_success_rate: number;
      total_runs: number;
      avg_latency_ms: number;
      total_tokens: number;
      estimated_cost: number;
    };
  }

  /**
   * 质量告警规则定义
   */
  interface AlertRule {
    id: string;
    name: string;
    workflow_id?: number | null;
    /** 触发条件表达式，例如 'success_rate < 0.85' 或 'avg_latency > 3000' */
    condition: string;
    /** 监控时间滑动窗口，例如 '1h', '24h', '7d' */
    window: string;
    /** 通知渠道列表，例如 ['email', 'webhook', 'sms'] */
    notification: string[];
    /** 是否激活 */
    is_active: boolean;
    created_at?: string;
  }
}

export = QualityMetrics;
