# Pivot v0.3.0 数据库 Schema 说明文档

> **支持引擎**：PostgreSQL 14+  
> **迁移策略**：启动时自动事务迁移（`server/db/migrate.js`）

---

## 1. 迁移汇总表

| 迁移文件 | 版本化 ID | 模块名称 | 包含数据表 |
| :--- | :--- | :--- | :--- |
| `agent-workflow-templates.js` | `202610140002_agent_workflow_templates` | 工作流模板库 | `agent_workflow_templates`, `agent_workflow_template_categories`, `agent_workflow_template_versions`, `agent_workflow_template_usage`, `agent_workflow_template_ratings` |
| `agent-streaming-events.js` | `202610140003_agent_streaming_events` | 流式事件推送 | `agent_streaming_events`, `agent_streaming_subscriptions` |
| `agent-evaluation.js` | `202610140004_agent_evaluation` | 智能体评测体系 | `agent_evaluation_suites`, `agent_evaluation_cases`, `agent_evaluation_runs`, `agent_evaluation_results` |
| `agent-tool-usage-stats.js` | `202610140005_agent_tool_usage_stats` | 工具推荐模型 | `agent_tool_usage_stats`, `agent_tool_transitions` |
| `agent-enhanced-planning.js` | `202610140006_agent_enhanced_planning` | 增强规划与分解 | `agent_execution_plans`, `agent_plan_tasks`, `agent_plan_adjustments` |
| `agent-artifacts.js` | `202610140007_agent_artifacts` | 多模态产物交互空间 | `agent_artifacts`, `agent_artifact_versions`, `agent_artifact_shares`, `agent_artifact_interactions`, `agent_artifact_comments` |
| `agent-orchestration-dsl.js` | `202610140008_agent_orchestration_dsl` | 多智能体编排 DSL | `agent_orchestration_templates`, `agent_orchestration_executions` |

---

## 2. 关键表结构定义

### 2.1 agent_artifacts (产物主表)
- `id` (UUID, 主键): 产物唯一标识符
- `user_id` (VARCHAR(64), 非空): 所属用户 ID
- `title` (VARCHAR(500), 非空): 产物标题
- `description` (TEXT): 详细说明
- `type` (VARCHAR(50), 非空): 产物模态类型 (html, react, vue, markdown, code, chart, diagram)
- `content` (TEXT, 非空): 产物正文代码
- `metadata` (JSONB): 扩展配置与元信息
- `version` (INTEGER, 默认 1): 当前最新版本号
- `status` (VARCHAR(50), 默认 'active'): 生命周期状态 (active, archived, deleted)
- `created_at` / `updated_at` (TIMESTAMPTZ)

### 2.2 agent_workflow_templates (模板表)
- `id` (SERIAL, 主键): 模板 ID
- `name` (VARCHAR(200), 非空): 模板显示名称
- `slug` (VARCHAR(100), 唯一): 唯一标识键
- `category_id` (INTEGER, 外键): 所属分类
- `dag_spec_template` (JSONB, 非空): 工作流结构模板 (包含 `{{var.name}}`)
- `variables` (JSONB, 默认 '[]'): 动态变量规范数组
- `usage_count` (INTEGER): 使用次数统计
- `rating_avg` (DECIMAL(3,2)): 加权平均分

### 2.3 agent_evaluation_runs (评测运行表)
- `id` (SERIAL, 主键): 评测批次 ID
- `suite_id` (INTEGER, 外键): 评测套件
- `accuracy_score` / `latency_score` / `cost_score` / `reliability_score` / `overall_score` (DECIMAL(5,2)): 五维量化指标
- `status` (VARCHAR(20)): 状态 (running, completed, failed)
- `started_at` / `completed_at` (TIMESTAMPTZ)
