# Pivot v0.3.0 技术架构设计文档

> **发布版本**：v0.3.0  
> **设计范围**：智能体系统 7 大核心能力架构拓扑与交互模型

---

## 1. 系统分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    用户交互与工作区层                        │
│   工作流画布 │ 模板商城 │ 流式面板 │ Artifacts抽屉 │ 评测工作台 │
└─────────────────────────────────────────────────────────────┘
                               ↓ (REST / SSE)
┌─────────────────────────────────────────────────────────────┐
│                    API 路由与安全网关                        │
│   /api/agent/workflow-templates  │  /api/streaming          │
│   /api/evaluation                │  /api/tools              │
│   /api/planning                  │  /api/artifacts          │
│   /api/orchestration                                        │
└─────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────┐
│                    核心服务与调度引擎                        │
│   WorkflowTemplateService │ StreamingService │ Evaluator    │
│   ToolRecommendationEngine│ EnhancedPlanner  │ DSLParser    │
│   ArtifactManager         │ OrchestrationExecutor           │
└─────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────┐
│                    持久化与基础设施层                        │
│   PostgreSQL 14+ 连接池 (server/db/client.js 原生驱动)       │
│   版本化自动迁移 (027-033) │ CAS 大对象存储 │ 运行时审计    │
└─────────────────────────────────────────────────────────────┘
```

## 2. 核心技术设计

### 2.1 原生数据库交互标准
系统全面废弃 Knex 查询构造器依赖，统一收口至 `server/db/client.js`，采用基于连接池的原生参数化 SQL 交互，内置占位符解析（`?` 自动映射为 `$1, $2, ...`），保证高并发吞吐与事务一致性。

### 2.2 流式通信架构 (SSE)
基于 HTTP/1.1 与 HTTP/2 Server-Sent Events 实现长连接单向事件下发。由 `StreamingService` 维护客户端订阅列表，配合事件序列编号，支持客户端优雅重连与事件补发。

### 2.3 多模态产物沙箱隔离 (Artifacts)
通过动态构建带有严格策略属性的 `iframe` 沙箱（`sandbox="allow-scripts allow-modals allow-forms"`），将用户生成的外部 HTML、SVG 或代码隔离在独立上下文，彻底杜绝 Cookie 盗用与宿主 DOM 越权篡改。

### 2.4 声明式 DSL 执行流水线
1. **Lexer / Tokenizer**：词法提取与 YAML/JSON 规范解析；
2. **AST Validator**：模式校验、依赖拓扑循环检测（Tarjan 算法）；
3. **Execution Scheduler**：并行批次分组，按 DAG 阶段实例化调用对应的 Agent 运行时。
