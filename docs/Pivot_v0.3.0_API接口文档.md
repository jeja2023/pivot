# Pivot v0.3.0 RESTful API 接口规范

> **认证方式**：Cookie 会话 / JWT Bearer Token / Stealth Access Token  
> **数据格式**：`application/json`

---

## 1. 核心端点概览

### 1.1 工作流模板 (`/api/agent/workflow-templates`)
- `GET /api/agent/workflow-templates` - 查询模板列表（支持 category, difficulty, search, page, limit）
- `GET /api/agent/workflow-templates/:id` - 获取模板详情
- `POST /api/agent/workflow-templates` - 创建新模板
- `PUT /api/agent/workflow-templates/:id` - 更新模板定义
- `DELETE /api/agent/workflow-templates/:id` - 删除模板
- `POST /api/agent/workflow-templates/:id/apply` - 传入变量并一键实例化工作流
- `POST /api/agent/workflow-templates/:id/rate` - 模板评分

### 1.2 实时流式通信 (`/api/streaming`)
- `POST /api/streaming/sessions` - 创建流式任务会话
- `GET /api/streaming/sessions/:sessionId/stream` - 建立 SSE 长连接流
- `GET /api/streaming/sessions/:sessionId/events` - 拉取历史流式事件序列
- `POST /api/streaming/sessions/:sessionId/close` - 正常关闭会话

### 1.3 评测与质量保障 (`/api/evaluation`)
- `GET /api/evaluation/suites` - 评测套件列表
- `POST /api/evaluation/suites` - 创建评测套件与用例
- `POST /api/evaluation/run` - 执行评测流水线
- `GET /api/evaluation/results/:id` - 评测详情与指标明细
- `GET /api/evaluation/compare/:id1/:id2` - 双版本评测基准对比
- `GET /api/evaluation/metrics/trend` - 质量指标时序趋势

### 1.4 工具推荐 (`/api/tools`)
- `POST /api/tools/recommend` - 基于上下文推荐 Top-N 工具
- `POST /api/tools/feedback` - 上报工具调用效果与反馈
- `GET /api/tools/stats` - 工具调用统计明细
- `GET /api/tools/trending` - 热门工具热度榜单

### 1.5 自适应任务规划 (`/api/planning`)
- `POST /api/planning/create` - 创建高层目标分解规划
- `GET /api/planning/:planId` - 查询计划 DAG 详情
- `POST /api/planning/:planId/adjust` - 动态调整子任务拓扑结构
- `POST /api/planning/:planId/results` - 提交子任务执行产物

### 1.6 多模态产物交互空间 (`/api/artifacts`)
- `POST /api/artifacts` - 创建新产物
- `GET /api/artifacts` - 获取用户产物列表
- `GET /api/artifacts/:id` - 获取产物详情（自动记录交互）
- `PUT /api/artifacts/:id` - 保存修改并自增版本号
- `DELETE /api/artifacts/:id` - 软删除产物
- `GET /api/artifacts/:id/versions` - 查询历史版本列表
- `POST /api/artifacts/:id/restore` - 一键回滚到指定历史版本
- `POST /api/artifacts/:id/share` - 创建具有有效期控制的分享链接
- `GET /api/artifacts/shared/:shareId` - 公开免密访问分享产物
- `POST /api/artifacts/:id/comments` - 发表评论讨论
- `GET /api/artifacts/:id/comments` - 查询讨论留言列表
- `DELETE /api/artifacts/:id/comments/:commentId` - 删除评论

### 1.7 编排 DSL 声明式语言 (`/api/orchestration`)
- `POST /api/orchestration/parse` - 解析 YAML/JSON 为执行 AST
- `POST /api/orchestration/validate` - 拓扑循环检测与模式验证
- `POST /api/orchestration/execute` - 调度多智能体协作执行
