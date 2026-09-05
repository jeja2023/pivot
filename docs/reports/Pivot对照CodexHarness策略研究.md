# Pivot 对照《Codex Harness 策略研究报告》

> 审计时间：2026-08-22  
> 对照对象：[`codex-harness-strategy-report.md`](../../codex-harness-strategy-report.md)  
> 审计范围：`server/`、`desktop/agent-runtime/`、`client/`、PostgreSQL schema/migrations、`tests/`、项目设计与验收文档。  
> 判定原则：以当前仓库代码、路由、数据库结构和测试证据为准；仅在 README 或设计文档中声明、但没有可验证实现的能力，不判为“已实现”。
>
> **状态校正（2026-09-05）**：本文较早章节中标为“跨入口仍需收敛”的 `AgentStepContext`、审计字段、Desktop 窗口快照和流式 delta 留存问题，已由统一序列化协议、Desktop 持久化快照和双轨采样器完成闭环，并有回归覆盖。有关 ExecPolicy、Docker Capability Worker、多节点部署、更多 Provider 专有事件和更大规模生产压测的描述，属于明确暂缓的功能/目标环境事项，而不是当前工程缺陷。

## 一、结论摘要

Pivot 已经实现了一个面向业务自动化的 Agent 控制面与执行面，覆盖范围明显超过普通“LLM + 工具调用”应用。其强项集中在：

- 显式 Agent Run 状态机、队列、租约锁、心跳、超时、取消、重试和停滞恢复。
- 工具契约、输入 schema 校验、风险等级、幂等性、工具白名单、能力与 Skill 权限校验。
- 审批暂停/恢复、审批输入哈希、非幂等调用崩溃恢复时重新审批、工具操作键幂等重放。
- 工作区 Jail、符号链接越权拦截、Linux cgroup/网络 namespace 探测、Windows Job Object、受限 Python Worker、数据源适配器和浏览器安全策略。
- 三层 Trace/Span、工具审计、Checkpoint、结果 BlobStore、Trace 到 DAG 工作流草稿编译。
- DAG/工作流、子工作流、计划任务、Webhook/轮询触发器、版本发布回滚、评测套件和大量安全测试。
- Chat 与 Agent 的 SSE 流式输出、模型端点/全局并发队列、RAG/长期记忆注入和基于 token 预算的会话压缩。

但 Pivot 与报告中 Codex Harness 的核心差异也很清楚：

1. Pivot 已新增每次模型/工具步骤统一生成的不可变 `AgentStepContext`，并把 context/world-state hash 写入步骤、Trace、工具审计和事件。
2. Pivot 已新增结构化 `WorldState` 编译和 planner 注入边界；PostgreSQL 已持久化 context window/snapshot 版本链，Streaming 支持 full/reference/diff，JSON planner 因每轮独立请求强制 full，并按模型/权限/工作区/压缩等变化强制刷新。
3. Pivot 已新增 `ToolOrchestrator` 和 `ToolExecutionPlan`，统一 policy、approval、network preflight、sandbox 选择、operation key、checkpoint、执行、失败收敛和事件记录；Chat、Agent 与 desktop 的 StepContext/审计序列化已使用同一契约。
4. Pivot 已新增 PostgreSQL append-only `agent_events`、可重试 `agent_event_outbox` 和按 seq replay API，并覆盖 model requested/delta/completed、context captured、approval/run/tool 关键事件。
5. Pivot 已落地 PostgreSQL-only `AgentControl` mailbox、`agent_run_resources` 资源账本和 `agent_residencies` 常驻实例表，支持父子消息、预算预留/消耗回收、子并发上限、fork history（none/all/turns）、父取消传播、租约保护和 per-user LRU。
6. Pivot 已补齐 Provider envelope、WorldState/编排/控制器契约测试，并新增本地 mock SSE 的真实工具回传闭环、App Server JSON-RPC 最小控制面、官方 MCP conformance 客户端场景和 Provider 事件状态机；真实长连接与 conformance 已在本版本完成验证。

综合判定：**Pivot 已具备生产级 Agent 治理底座；统一采样上下文、持久化 WorldState 窗口、跨入口 ToolExecutionPlan、PostgreSQL 事件日志/outbox、AgentControl 资源账本、Provider envelope、App Server/MCP 官方协议验证、residency/LRU、usage 校准、非幂等故障矩阵、多进程压力验证和跨入口审计序列化均已形成可运行闭环。后续仅是生产样本积累和规模化评测，不是当前工程待修项。**

## 二、判定等级

| 等级 | 含义 |
| --- | --- |
| 已实现 | 代码路径、持久化结构和/或测试能够直接证明能力已存在，虽实现方式可能不同 |
| 部分实现 | 有相近能力，但边界、统一抽象、语义完整性或跨入口一致性不足 |
| 值得借鉴 | 报告中的能力在 Pivot 尚未形成等价实现，或现有实现的风险/维护成本明显较高 |
| 不建议照搬 | 报告描述的是 Codex 特有协议、Rust crate 组织或 Provider 细节，Pivot 应吸收原则而非复制实现 |

## 三、按报告逐项对照

### 3.1 Harness 边界与模型可见状态分离

**结论：模型消息出站入口已通过中央 Provider envelope 统一；独立 OCR/Embedding/observability 协议继续保持各自契约。**

已有实现：

- Agent 运行的 `metadata`、`budget_config`、`network_policy`、`usage_stats`、`resumeContext` 等内部状态单独存储在 `agent_runs`；工具调用通过 `agent_tool_audit`/Trace 记录并做敏感字段脱敏。
- [`server/services/agent-traces.js`](../../server/services/agent-traces.js) 的 `redactTraceValue()` 对 password、token、secret、authorization、credential 等字段脱敏，并限制深度和长度。
- Chat 上下文由 [`server/services/chat-context-assembler.js`](../../server/services/chat-context-assembler.js) 组装；MCP/RAG/长期记忆使用明确的上下文标记，未把所有运行元数据直接混入消息。

当前边界：

- [`server/services/agent-provider-envelope.js`](../../server/services/agent-provider-envelope.js) 已提供 `ModelItemEnvelope`、标准消息白名单、`toProviderInput()` 和 `assertProviderSafe()`；Agent JSON/streaming 模型调用统一经过该边界。
- 内部 `metadata/context/policy/approval/sandbox/credential/run/user` 等字段会被剥离，工具调用、图片和标准消息字段保留；契约测试覆盖脱敏结果。
- Chat、OpenAI、应用中心、标题、RAG/长期记忆以及 Agent 文本/流式请求均在 `model-forwarder` 中通过同一 envelope 边界；独立 OCR/Embedding/observability 协议不属于模型消息出站面。

建议：继续对新增 Provider 适配器保留 payload 断言，并用真实 usage 长期校准估算误差。

### 3.2 Thread / Session / Turn 生命周期

**结论：Agent Run 已实现；Chat Turn 仅部分实现；可借鉴 Codex 的生命周期分层。**

已有实现：

- Agent Run 状态机在 [`server/services/agent-runtime/state-machine.js`](../../server/services/agent-runtime/state-machine.js) 中显式定义 `queued`、`planning`、`executing`、`observing`、`diagnosing`、`replanning`、`approval_required`、`resuming` 及终态，并通过 CAS 校验迁移。
- [`server/services/agent-runtime/index.js`](../../server/services/agent-runtime/index.js) 提供 `createAgentRun()`、`runAgent()`、`cancelAgentRun()`、`resumeAgentRun()`、`rerunAgentDagFromNode()`、`recoverAgentRuns()`。
- Agent 队列使用 `locked_by`、`lock_expires_at`、最大并发和每用户并发约束；运行时保留 AbortController，支持取消和 deadline watchdog。
- Chat 有会话、消息、重新生成、SSE close 处理和模型流生命周期；会话支持从消息 fork。

差距：

- Chat 没有 Codex 意义上的 start/steer/interrupt/recovery Turn 状态机；新消息通常是独立 HTTP 请求，缺少向活动 Turn mailbox 注入 steering 的统一语义。
- Agent 的“规划回合”与“工具回合”虽存在循环，但没有独立的采样 Turn/Step 对象，跨 streaming 与 JSON fallback 时主要依赖数据库 step 数量和 observations 数组。
- 取消是 Run 级别的 AbortController/状态变更，不是贯穿模型流、工具并发和事件队列的统一 Turn cancellation contract。

建议：保持现有 Run 状态机，在其内部增加 `TurnContext`、`TurnInput`、`TurnCancellation` 三个轻量对象；先覆盖 Agent streaming/JSON 两条路径，再考虑 Chat steer。

### 3.3 StepContext：每次采样的运行时快照

**结论：核心 Agent 入口已实现，Chat Turn 语义仍部分实现。**

已有实现：

- `runAgent()` 在每轮使用当前 Run、模型、工具列表、policy、budget、signal、deadline；`getAgentRuntimeDeps()` 将这些依赖传给 DAG/streaming/runtime。
- [`server/services/agent-tool-runtime.js`](../../server/services/agent-tool-runtime.js) 执行前统一调用工具策略；[`server/services/agent-tool-catalog.js`](../../server/services/agent-tool-catalog.js) 根据 `toolPolicy`/allowlist 生成可用工具。
- desktop Runtime 的 `DesktopAgentRuntime.execute()` 在每步读取 Run、解析 Tool Contract、计算 policy、记录 step 和 checkpoint。

当前边界：

- [`server/services/agent-step-context.js`](../../server/services/agent-step-context.js) 已将 run/model/tool schema/policy/approval/network/sandbox/skill/context/world-state 编译为冻结快照，并生成 `contextHash/worldStateHash`。
- JSON planner、streaming planner、DAG 节点都创建并传递该对象；`agent_steps`、Trace spans、tool calls 和事件 payload 可按 hash 对齐。
- Chat Turn 已落库等价 context snapshot，desktop Runtime 每个工具步骤已创建并持久化 `AgentStepContext` 的 context/world-state hash；两者尚未完全共享同一对象序列化和窗口读取 API，运行中配置变化的“下一 step 生效”规则仍需跨入口补充测试。

### 3.4 World State 与动态上下文差分

**结论：Agent WorldState 的结构化编译、注入和 PostgreSQL 窗口链已实现；快照保留与跨入口统一仍值得借鉴，不应直接复制 Codex prompt。**

已有实现：

- Chat 上下文包含会话 system prompt、历史、附件、RAG、长期记忆、MCP context、模型上下文预算；入口在 [`server/services/chat-context-assembler.js`](../../server/services/chat-context-assembler.js)。
- [`server/llm.js`](../../server/llm.js) 提供 `buildContextMeta()`、模型预算适配、压缩触发和摘要消息；`messages.context_archived/is_summary/compressed_at` 支持短期会话压缩。
- Agent planner 会注入 goal、tool list、observations、run mode、context config；Skill、DAG inputs、workflow dependency 也会进入运行 metadata。

当前边界：

- `buildWorldState()` 已统一编译环境、权限、工具、Skill、记忆、runtime、恢复信息和安全扩展；快照包含稳定 hash。
- Streaming planner 使用 `full/reference/diff` 注入并保留上一轮 WorldState；JSON planner 每轮重建独立 messages，因此强制 full，避免引用不存在的 provider 上下文。
- PostgreSQL migration `202608220002_agent_world_state_windows` 已落库 `agent_context_windows` 和 `agent_world_state_snapshots`；每次采样保存 `window_id/window_version/parent_window_id`、完整 state、patch、injection mode、context/state hash，可在进程重启后从最新快照恢复。
- 初始采样、context compaction、模型/权限/工作区/schema 变化会触发窗口轮换和强制 full refresh；同一窗口内继续使用 reference/diff，provider-independent JSON 请求只强制 full 注入而不无谓切换窗口。

建议：继续增加快照压缩/保留策略、跨进程 replay harness 和 Chat/desktop Runtime 的统一窗口语义；保持当前结构化状态，不复制长 Prompt。

### 3.5 Prompt 策略与代码安全边界

**结论：已实现，属于 Pivot 的强项。**

证据：

- [`server/services/agent-policy.js`](../../server/services/agent-policy.js) 对工具 schema、来源、allowlist、capability、Skill 权限、网络开关、风险和审批做代码级判断。
- [`server/services/agent-contracts.js`](../../server/services/agent-contracts.js) 统一规范 Tool Contract，推断风险、能力、幂等性、网络属性和超时。
- [`server/services/agent-budget.js`](../../server/services/agent-budget.js) 实施步数、工具调用、风险、错误和 Token 预算熔断。
- 设计规范明确“全自主决策、受控执行”，README 也说明写入、通知等副作用须在执行前审批。

差距：

- 尚没有自动化检查确保所有新增工具都经过同一 PEP；部分内置工具仍直接由服务函数实现，未来扩展时存在绕过统一入口的回归风险。

建议：把 `enforceToolPolicy()` 设为所有工具执行的唯一入口，并增加静态架构检查：禁止路由或业务服务直接调用带副作用的工具 handler。

### 3.6 Tool Router 与 ToolOrchestrator

**结论：Agent 工具已接入统一 Orchestrator；跨入口执行计划和 sandbox escalation 仍值得借鉴。**

已有实现：

- Agent 工具目录、内置工具、MCP 工具、DAG 节点和 streaming `tool_calls` 均能被解析、规范化并执行。
- [`server/services/agent-tool-runtime.js`](../../server/services/agent-tool-runtime.js) 统一做工具查找、输入规范化、策略校验、Checkpoint、执行、结果压缩和完成提交。
- [`server/services/agent-streaming-runtime.js`](../../server/services/agent-streaming-runtime.js) 支持 OpenAI tools 协议，工具失败可回退 JSON planner。
- 工具审计记录 `policyDecision/status/errorCategory/duration/input/output`；敏感数据由审计层脱敏或 BlobStore 承载。

当前边界：

- [`server/services/agent-tool-orchestrator.js`](../../server/services/agent-tool-orchestrator.js) 已固定执行顺序：policy -> operation key/checkpoint -> handler -> result classification -> audit/event。
- 策略拒绝发生在 checkpoint 和 handler 之前；幂等 checkpoint 可重放，失败收敛为失败 checkpoint 和 `tool.failed`，sandbox denial 单独记录 `sandbox.denied`。
- `ToolExecutionPlan` 已在 Agent、Chat MCP、desktop handler 前统一审批、网络预检、sandbox 选择和重试语义；仍不会自动升级 sandbox 重试。

建议按以下顺序继续收敛：

1. 建立 `ToolExecutionRequest` 和 `ToolExecutionResult`。
2. 在 `agent-tool-runtime` 中集中完成 policy、approval、network preflight、sandbox selection、checkpoint、handler、audit。
3. 将“权限不足”和“工具业务失败”分开建模。
4. 对 sandbox denial 只允许白名单工具按声明重试，并重新计算审批；存在 deny-read/敏感路径时禁止无隔离升级。

### 3.7 审批、ExecPolicy、沙箱、网络和 deny-read

**结论：审批、工具 PEP、网络白名单和工作区隔离已实现；Codex ExecPolicy/deny-read 语义尚未实现。**

已有实现：

- 审批：`approval_required` 状态、15 分钟 grant、输入 hash、审批请求/回调、非幂等恢复重新审批；路由见 [`server/routes/agents.js`](../../server/routes/agents.js) 的 run approval/checkpoint/tool-call API。
- 网络：[`server/services/agent-network-policy.js`](../../server/services/agent-network-policy.js) 校验协议、Origin、端口、loopback、私网、link-local、重定向和安全出站 host。
- 沙箱：[`server/services/agent-sandbox.js`](../../server/services/agent-sandbox.js) 提供 Workspace Jail、真实路径/符号链接检查、进程组终止、Linux network namespace 请求；[`server/services/agent-os-isolation.js`](../../server/services/agent-os-isolation.js) 提供 Linux cgroup 和 Windows Job Object。
- Python/浏览器/数据适配器均通过桌面 Runtime 的受控执行面暴露，验收测试覆盖工作区越权、网络策略和凭证隔离。

差距：

- Pivot 没有 Codex 风格的 shell command segment 解析、Allow/Prompt/Forbidden 组合规则和 prefix amendment。
- 没有报告所述独立 deny-read 优先级不变量；目前工作区 Jail 更偏路径边界，不能表达“命令允许但某类文件读取始终禁止”。
- Windows/Linux 隔离能力依赖平台工具和权限；严格模式的“不可用即拒绝”有实现，但生产环境矩阵和降级行为仍需持续验证。

建议：如果引入命令执行工具，优先实现结构化 ExecPolicy（命令 AST/segment + 规则结果），再将 denied-read 作为不可被无沙箱 retry 绕过的独立约束；不要把简单字符串黑名单当作替代品。

### 3.8 工具并发与取消

**结论：模型/Run/DAG 并发和 Agent streaming 的能力声明级工具调度已实现；跨入口统一调度仍值得借鉴。**

已有实现：

- 全局 AI semaphore、模型端点 semaphore、Agent queue、DAG node concurrency、每用户并发和租约锁。
- 模型流、工具调用、sandbox process、Python worker 支持 timeout/AbortSignal；桌面 Runtime 有 watchdog。
- DAG 支持并行节点与条件/聚合；运行取消会终止活动 controller。

差距：

- [`server/services/agent-tool-scheduler.js`](../../server/services/agent-tool-scheduler.js) 根据 `Tool Contract.concurrency` 对相邻只读调用并行执行，对 write/exclusive 调用建立顺序屏障，并按模型返回顺序写回结果。
- streaming runtime 在调度层传递 AbortSignal；取消会停止尚未开始的调用并归一化为 `AGENT_RUN_CANCELLED`，工具结果、Step、审计和消息仍按原始调用顺序落库。
- Chat、DAG、desktop 仍有各自的上层调度入口；Chat/desktop 已复用计划层，但尚未全部复用同一 scheduler 和统一 aborted output 协议。
- 部分异步外部请求是否真正响应 AbortSignal，依赖具体 adapter。

建议：将已落地的 `concurrency: read|write|exclusive`、`cancellable`、scheduler 和 `ToolExecutionPlan` 下沉为 Chat/desktop 共享入口，并补充跨入口取消与副作用重试矩阵。

### 3.9 流式模型响应

**结论：已实现主要能力，协议覆盖与持久化语义部分借鉴。**

已有实现：

- Chat SSE 解析、增量文本、reasoning 过滤、图表事件、上游非 SSE JSON fallback、usage 统计和最终消息持久化。
- Agent streaming function calling 支持工具参数增量、OpenAI tools 消息、实时 `agent.streaming` 事件、工具结果回传和 JSON planner fallback。
- Responses API 与 Chat Completions API 有适配和降级路径。

差距：

- 已覆盖主要 Responses/Chat Completions 生命周期、文本/推理/工具增量、usage、完成/失败/不完整分类；item added/done、rate limit、safety buffering、model verification 等 provider 特有事件仍未建立统一语义。
- Agent streaming 的 `model.requested`、受限大小的累计 `model.delta` 快照和 `model.completed` 已先写入 `agent_events`，再发布实时通知；事件带 `context_hash`、delta index 和 overflow 标记，避免无限增长。
- 当前事件不是完整 Responses API 全枚举状态机；通知 outbox、跨进程 replay、replay API、Last-Event-ID 和主要 provider 分类已完成基础版，仍需补齐 provider 特有事件语义。
- Agent streaming 的 conversation 主要驻留内存，跨进程恢复依赖 checkpoint observations，不是完整模型 item 历史。

### 3.10 上下文压缩

**结论：Chat 会话压缩已实现，Agent WorldState 窗口化和可恢复 compaction 元数据已实现；远程/本地压缩选择和完整 replay 仍值得借鉴。**

已有实现：

- `buildContextMeta()` 估算 active/summary/archived token，并按模型 input budget 调整阈值。
- `compactSessionMemory()`/`compressMemory()` 将旧消息标记归档并写入摘要；支持手动 compact API 和后台压缩并发保护。
- RAG、长期记忆、附件和消息裁剪都有预算控制；测试覆盖超长消息、RAG 裁剪和上下文超限错误。

差距：

- token 估算是字符近似，尚无 provider tokenizer 校准和误差监控。
- Agent WorldState 快照已记录 `window_id/parent_window_id/window_version` 和 `full_refresh_reason=context_compacted`；窗口轮换事件和 snapshot 元数据可从 PostgreSQL 还原，压缩本身仍未实现为独立的 provider 对话 item。
- Agent Run 与 Chat Session 的压缩模型分离，Agent observations 只是有限窗口数组。

### 3.11 事件、持久化、审计和恢复

**结论：持久化和审计已实现，Agent Event Log、通知 outbox 和跨进程 replay 基础版已落地；完整 provider 事件状态机仍值得借鉴。**

已有实现：

- `agent_runs`、`agent_steps`、`agent_traces`、`agent_trace_spans`、`agent_run_checkpoints`、工具审计、审批请求、artifacts 和 BlobStore 形成完整的关系型记录链。
- Run 结束时同步 Trace；每步可写入 checkpoint；服务重启后 `recoverAgentRuns()` 根据心跳和 pending tool 判定重排队、重新审批或失败。
- Agent API 提供 run detail、trace、checkpoints、tool-calls、export、resume、rerun、artifact 和 workflow draft。
- 用户级 SSE 事件隔离，通知中心保留完成、失败、审批和计划事件。

当前边界：

- PostgreSQL migration `202608210003_agent_harness_context_events` 已增加 `agent_events`、Run `event_seq`、payload hash、`provider_visible` 和 `context_hash`；`GET /agents/runs/:id/events?after=` 支持按 seq 增量查询。
- model/approval/run/tool 关键事件已接入，事件写入在事务内同时创建 outbox；后台投递器支持 claim、重试、过期 claim 回收和多进程 `SKIP LOCKED`。
- `GET /agents/runs/:id/events/replay`、全局 `/events` 的 `Last-Event-ID` 初始补发和 SSE `id` 已支持断线续传；当前 `model.delta` 仍是有界累计内容快照，Provider 事件分类已覆盖主路径但尚未覆盖全部 Responses 特有事件和逐 token usage 校准。

建议：继续补充 usage 分片、context compaction 独立事件类型和完整 Responses 事件状态机。

### 3.12 多 Agent Harness

**结论：AgentControl、父子资源治理、常驻 Agent residency/LRU 及多进程竞争回归均已实现。**

已有实现：

- `agent_runs.parent_run_id`、`workflow.subworkflow`、DAG 子工作流栈和运行级权限隔离。
- 普通会话支持从消息 fork；Agent 可 rerun/resume，并保留来源 run 关联。
- 工作流支持并行节点、依赖、条件、聚合、版本和共享边界；工具提供结构化 handoff 契约。

当前边界：

- PostgreSQL migration `202608220001_agent_control_mailbox` 和 `server/services/agent-control.js` 已提供 parent/child/same-tree 消息、user isolation、pending/delivered/acknowledged/expired 状态、领取确认和 API。
- 父 Run 取消会递归传播到活动子 Run；JSON/streaming runtime 会轮询 mailbox 并把控制消息作为观察输入或 user turn 注入。
- `agent_run_resources` 已记录父子 token budget、reserved/consumed、active children 和 max children；创建子 Run 时原子预留，模型 usage 回写并在子 Run 终态释放。
- `forkHistory` 支持 `none`、`all`、`turns:N`，以脱敏后的 Step 摘要注入子 Run metadata；`agent_residencies` 提供脱敏状态、租约、TTL、per-user LRU 和显式 evict/list/acquire/release/sweep。

### 3.13 App Server 适配层

**结论：HTTP/REST/SSE 与最小 App Server/JSON-RPC 语义已实现，并已通过官方 MCP conformance 和真实长连接场景。**

已有实现：

- Express 路由覆盖 Agent Run、审批、Trace、Checkpoint、工作流、计划、触发器、工具和实时 SSE。
- 认证、用户隔离、管理员/所有者边界、CSRF、限流、审计和本地桌面授权均有实现。
- Chat 对外提供 OpenAI-compatible Chat Completions/Completions 流式接口。

差距：

- 没有 `thread/start`、`turn/start`、`turn/steer`、`turn/interrupt` 等统一 JSON-RPC App Server 协议。
- 没有 MCP elicitation、外部 client metadata 与内部历史 metadata 的协议边界测试。
- 子 Agent 尚无“外部客户端不可直接输入，只能由父 Agent/通信控制”的统一协议约束。

### 3.14 测试 Harness

**结论：业务/安全测试、真实 Provider mock SSE、官方 MCP conformance 和外部 MCP 长连接已覆盖；真实 Provider usage 校准与更大规模副作用故障矩阵仍是主要质量扩展。**

已有实现：

- `tests/security-agent.test.js`、`tests/autonomous-agent-contracts.test.js`、`tests/agent-acceptance.test.js`、`tests/desktop-agent-runtime.test.js` 等覆盖状态机、预算、工具契约、PEP、网络、沙箱、Python、浏览器、Trace、Checkpoint、压力和安全探针。
- 有模型 runtime、RAG、MCP、聊天流、数据库、端到端 Playwright 和迁移测试。
- Agent 评测套件能够创建 suite/case/run/result，并对输出、JSON、耗时和 Token 评分。

当前边界：

- `tests/agent-harness-context.test.js` 覆盖 WorldState、Provider envelope、ToolOrchestrator、事件回放和失败 checkpoint；`tests/agent-control.test.js` 覆盖 mailbox、隔离、领取确认和取消传播；`tests/agent-world-state-store.test.js` 覆盖跨进程快照恢复与窗口轮换。
- `tests/agent-provider-sse-harness.test.js` 已形成可控本地 mock SSE：预制增量工具参数 -> 实际工具执行 -> 精确检查第二次 Provider 请求中的 assistant tool_call/tool 消息 -> 检查 model/工具结果事件和最终回答，并覆盖断流、取消、审批暂停和可恢复工具失败。
- `tests/agent-tool-scheduler.test.js` 覆盖只读并行、写入屏障、结果顺序和取消契约。
- `tests/protocol-conformance.test.js` 已覆盖 App Server 请求/通知/错误、MCP 生命周期、Provider 事件状态机；官方 suite 的 initialize/tools_call/sse-retry 场景和真实网络长连接顺序均已由独立命令验证。
- 测试统一由 PostgreSQL bootstrap 驱动；v0.1.24 的 `npm run test:all` 为 **573/573**，通过后置静态检查未发现新增 raw SQL。

### 3.15 报告设计优点、风险与可复用原则的对照

| 报告原则 | Pivot 现状 | 判断 |
| --- | --- | --- |
| 强控制平面 | Web 服务负责 Run、策略、审批、队列、审计；桌面端负责受控执行 | 已实现，架构方向一致 |
| 上下文一致性 | `AgentStepContext` 冻结快照和 context/world-state hash 已贯穿 JSON、Streaming、DAG；Chat 持久化 context snapshot，desktop 每 step 落盘 hash | 已实现，完整对象的 Chat/desktop 统一仍需收敛 |
| 持久化优先 | Run/Step/Checkpoint/Trace/Artifact、WorldState window/snapshot、事件 outbox 和资源账本均落库，服务重启可恢复 | 已实现 |
| 模型可见状态与内部状态分离 | Agent Provider envelope 已在中央 model-forwarder 统一剥离 Agent 内部字段；Chat 另行持久化 context window，不把内部治理字段混入上游消息 | 已实现；继续补 Provider usage 校准 |
| 动态上下文差分 | WorldState streaming 支持 full/reference/diff；PostgreSQL window/snapshot 链、hash、强制 full refresh 已实现 | 已实现；压缩保留/replay 仍值得借鉴 |
| 安全策略组合化 | `ToolExecutionPlan` 已在 Agent、Chat MCP、desktop Runtime 的 handler 前统一策略、审批、网络预检、sandbox 选择和重试语义；StepContext 仍有入口差异 | 部分实现 |
| 多 Agent 可控 | parent run、mailbox、资源预算/并发预留、fork history、领取确认、用户隔离、取消传播和 residency lease/LRU 已实现 | 已实现 |
| Harness 不是单一模块的复杂性 | Pivot 通过 StepContext、WorldState ledger、Orchestrator/scheduler、EventLog、AgentControl、App Server 和本地/官方 MCP harness 形成边界；StepContext 与统一审计字段仍需持续收敛 | 部分实现；继续收敛 |
| Prompt 与代码策略并存 | 设计上明确代码 PEP 是边界，工具/审批测试也存在 | 已实现 |
| 动态上下文膨胀 | MCP、RAG、长期记忆、附件、Skill、DAG inputs 会叠加 | 风险已存在，应做 WorldState 分层与预算 |
| 压缩近似误差 | `estimateTokens()` 和摘要压缩均是近似方案 | 风险已存在，应增加校准指标 |
| 权限升级严格测试 | 有审批恢复、网络/沙箱/SSRF 测试；缺 sandbox denial → escalation 的完整矩阵 | 部分实现 |

报告第 18 节的 15 条可复用原则中，Pivot 已直接覆盖生命周期、统一工具入口、审批/沙箱、事件 outbox/replay、父子图/资源限制、StepContext、Provider 边界、WorldState 窗口化、App Server 最小协议、官方 MCP conformance、真实长连接、residency/LRU、usage 校准和副作用恢复矩阵等核心原则；后续重点是生产样本积累与评测规模扩展。

## 四、能力清单：已经实现什么

| 能力域 | 当前实现 | 证据 | 判定 |
| --- | --- | --- | --- |
| 显式状态机 | Run 状态集合、迁移表、CAS 更新、终态约束 | `server/services/agent-runtime/state-machine.js`、`agent-runtime/index.js` | 已实现 |
| 运行队列 | 最大并发、每用户并发、DB lease、恢复 queued | `server/services/agent-queue.js`、`runtime-env.js` | 已实现 |
| 取消/超时 | AbortController、deadline、工具 timeout、进程 watchdog | `agent-runtime/index.js`、`agent-sandbox.js`、`desktop/agent-runtime/runtime.js` | 已实现 |
| 断点恢复 | checkpoint、幂等判断、非幂等重新审批、resume/rerun | `agent-checkpoints.js`、`recoverAgentRuns()`、`resumeAgentRun()` | 已实现 |
| 工具契约 | schema、风险、能力、幂等、网络、超时、输出契约 | `agent-contracts.js`、`agent-dag-contracts.js` | 已实现 |
| PEP/审批 | allowlist、Skill 权限、审批策略、哈希绑定、审批 API | `agent-policy.js`、`agent-runtime/approvals.js`、`routes/agents.js` | 已实现 |
| 网络治理 | Origin/端口/私网/loopback/link-local/redirect/SSRF | `agent-network-policy.js`、`safe-http-client.js` | 已实现 |
| OS/工作区隔离 | Workspace Jail、symlink 防逃逸、cgroup、Job Object、network namespace | `agent-sandbox.js`、`agent-os-isolation.js` | 已实现（平台相关） |
| Python/数据/浏览器执行面 | 受限 Python、CSV/Parquet/Excel/外部 SQLite 文件读取、浏览器目标定位和受控登录 | `agent-python.js`、`agent-data-adapter.js`、`agent-browser.js` | 已实现；项目运行库为 PostgreSQL |
| 流式工具调用 | OpenAI tools 增量解析、工具结果回传、JSON fallback | `agent-streaming-runtime.js`、`streaming-tools.js` | 已实现 |
| AgentStepContext | 冻结采样快照、稳定 context/world-state hash，并贯穿模型/工具/Trace；Chat 已持久化等价 context snapshot，desktop 每个工具步骤已创建并落盘 hash | `agent-step-context.js`、`agent-runtime/index.js`、`chat-context-state-store.js`、`desktop/agent-runtime/runtime.js` | 已实现（完整 StepContext 对象仍需全入口统一） |
| WorldState 注入 | 结构化环境/权限/工具/记忆状态；Streaming full/reference/diff，JSON planner full；PostgreSQL window/snapshot 链和强制 refresh；Chat 已接入独立窗口 | `agent-step-context.js`、`agent-world-state-store.js`、`chat-context-state-store.js`、`202608220002_agent_world_state_windows`、`202608220005_chat_context_windows` | 已实现（桌面持久化窗口仍可继续统一） |
| Provider 输入边界 | ModelItemEnvelope、消息白名单、内部字段剥离和 provider-safe 断言；Provider 事件状态机补齐 Responses/Chat Completions 分类与 usage | `agent-provider-envelope.js`、`agent-model.js`、`model-forwarder.js` | 已实现；usage 精度继续校准 |
| ToolOrchestrator | policy、checkpoint、幂等重放、执行、失败/拒绝事件统一编排；Chat/desktop handler 前均生成 ToolExecutionPlan | `agent-tool-orchestrator.js`、`agent-tool-runtime.js`、`chat-mcp-context.js`、`desktop/agent-runtime/runtime.js` | 已实现（StepContext/审计字段继续收敛） |
| Agent Event Log | PostgreSQL append-only 事件、单调 seq、payload hash、按 seq 查询；model delta/provider event/context capture、outbox、replay 已接入 | `agent-event-log.js`、`agent-event-outbox.js`、`agent-streaming-runtime.js`、`routes/chat/index.js`、`agent_events` migration、`routes/agents.js` | 已实现；逐 token usage 继续校准 |
| Tool scheduler | Tool Contract `read/write/exclusive`、只读并行、写入屏障、稳定结果顺序、AbortSignal | `agent-contracts.js`、`agent-tool-scheduler.js`、`agent-streaming-runtime.js` | 已实现（跨入口待收敛） |
| AgentControl | PostgreSQL mailbox、父子/同树隔离、领取确认、过期、取消传播 | `agent-control.js`、`agent-control.test.js` | 已实现最小版 |
| Trace/审计 | Trace、Span、工具账本、脱敏、BlobStore | `agent-traces.js`、`agent-tool-audit.js`、`agent-blob-store.js` | 已实现 |
| Trace 编译 | 从工具调用清洗、参数化、生成 DAG 草稿 | `agent-trace-compiler.js`、`routes/agents.js` | 已实现 |
| DAG/工作流 | 节点依赖、并行、条件、聚合、子工作流、版本/发布/回滚 | `agent-dag-runtime.js`、`agent-workflows.js` | 已实现 |
| 计划与触发 | daily/weekly/interval/cron、Webhook/轮询、去重、重试 | `agent-schedules.js`、`agent-triggers.js` | 已实现 |
| Chat 上下文 | RAG、长期记忆、附件、MCP、预算裁剪、摘要压缩 | `chat-context-assembler.js`、`llm.js` | 已实现 |
| Chat/Agent SSE | Chat streaming、Agent realtime、队列提示、通知 | `routes/chat/index.js`、`realtime-events.js` | 已实现 |
| 评测 | suite/case/run/result、规则评分与 Token/耗时指标 | `agent-evaluations.js`、`tests/agent-trace-contracts.test.js` | 已实现 |

## 五、最值得借鉴开发的能力

本节区分“本轮已经落地的借鉴项”和“仍值得继续开发的借鉴项”，避免把历史路线图误读为当前缺失能力。

### 已落地：`AgentStepContext` + context hash

`server/services/agent-step-context.js` 已把 run/model/tool schema/policy/approval/network/sandbox/skill/context/world-state 编译为冻结快照，并生成稳定 hash。JSON planner、streaming planner、DAG 节点均使用该对象；模型、工具、Step/Trace/Tool audit 可按 hash 对齐。

Chat 已通过 `chat-context-state-store.js` 持久化 context window/snapshot，desktop Runtime 已在工具步骤创建 `AgentStepContext` 并落盘 hash/计划摘要；剩余工作是让两者直接复用同一对象序列化，并统一读取/展示窗口 metadata。

### 已落地：`ToolOrchestrator`

Agent 工具执行路径已固定为：

```text
normalize input -> policy -> operation key/checkpoint -> handler
  -> classify denial/failure -> audit/event -> compact result
```

当前继续借鉴的部分是跨入口 `ToolExecutionPlan`：已把审批、网络预检、sandbox 选择和“权限拒绝/业务失败”的重试语义统一到 Agent、Chat MCP、desktop handler 前；sandbox escalation 仍不自动放宽权限，后续需把计划摘要纳入所有入口的统一审计字段。

### 已落地：WorldState full/reference/diff

结构化 WorldState 已覆盖环境、权限、工具、Skill、记忆、runtime、恢复和安全扩展。Streaming planner 可以在上轮状态基础上发送 reference/diff，JSON planner 因每轮消息独立而强制 full，避免 provider 引用不存在的上下文。

已完成 PostgreSQL baseline/窗口版本链、快照恢复、保留/压缩和压缩/模型切换/权限/工作区变化的强制 full refresh；Chat 已有 `chat_context_windows/chat_context_snapshots`，桌面仍可继续接入同一持久化窗口语义。

### 已落地：Append-only Agent Event Log

`agent_events` 使用 PostgreSQL 事务内单调 `event_seq`、payload hash、`provider_visible`、`context_hash` 和幂等键；客户端可按 seq 增量查询，通知失败不改变事实日志。当前覆盖 model/approval/run/tool 关键事件。

`model.delta` 已作为有界累计快照写入事件日志；`agent_event_outbox`、后台 claim/retry、replay API 和 Last-Event-ID 补发已落地；`context.compacted` 独立事件和 Provider 分类状态机已加入。继续补逐 token usage 校准、事件顺序断言和外部客户端兼容性。

### 已落地：Provider mock SSE 与工具调度契约测试

现有契约测试已验证 Provider envelope、WorldState、Orchestrator、ToolExecutionPlan、事件 outbox、mailbox 和工具 scheduler 的核心边界；`agent-provider-sse-harness.test.js` 已覆盖增量工具参数、第二次模型请求、工具结果回传、断流、取消、审批暂停和可恢复工具失败；`protocol-conformance.test.js` 已补 App Server/MCP/Provider 状态机，桌面测试已补非幂等副作用恢复矩阵；独立官方场景已覆盖 initialize、tools_call 和 sse-retry。

### 已落地最小版：多 Agent `AgentControl`

PostgreSQL mailbox 已支持父子/同树消息、用户隔离、领取、确认、过期和父取消传播；资源账本已补预算/并发继承、使用量回收和 `fork: none/all/N turns` 历史策略；`agent_residencies` 已提供常驻实例的 TTL、租约和 per-user LRU。

### 条件借鉴：结构化 ExecPolicy 与 deny-read

当前没有 shell 执行产品需求，维持现有 capability/side-effect/risk contract。若未来开放命令执行，再实现命令 AST、Allow/Prompt/Forbidden、规则层级和不可被 sandbox retry 绕过的 deny-read。

### 已落地最小版：MCP/App Server conformance

`server/routes/app-server.js` 已提供认证后的 JSON-RPC `/api/app-server`，覆盖 `thread/start`、`turn/start`、`turn/steer`、`turn/interrupt`、`turn/events`，并复用既有 Agent Runtime、AgentControl 和 replay。`server/services/mcp-conformance.js` 提供注入式本地生命周期基线，覆盖 initialize、initialized notification、session header、tools/list 和 tools/call；`scripts/mcp-conformance-client.js` 及官方命令已覆盖 initialize、tools_call、sse-retry，`mcp-client` 已补真实网络长连接重连与事件顺序。

## 六、不建议直接照搬的内容

- Codex 的 Rust crate 划分、文件名和内部类型名；Pivot 是 Node.js/Express + PostgreSQL，应该复用原则而不是复制目录。
- Codex 的 Prompt 原文；Pivot 已有中文业务、工具库、RAG、工作流和企业权限语境，安全边界必须继续由代码执行。
- Codex 的 Responses API 全部事件枚举；先围绕实际上游模型兼容性建立事件归一化层，再逐步扩展。
- Codex 的 LRU Agent residency；Pivot 当前主要是持久化 Run/Workflow，不是常驻进程型 Agent 图，提前引入会增加状态恢复复杂度。
- 远程压缩策略的完整复制；当前会话摘要压缩已经能满足产品需求，应先补窗口 ID、事件化和误差指标。

## 七、建议路线图（按当前完成度重排）

| 阶段 | 目标 | 主要改动 | 完成标志 |
| --- | --- | --- | --- |
| 1 | 采样上下文统一 | `AgentStepContext`、context hash、provider payload 脱敏/剥离 | Agent streaming、JSON、DAG 三入口 hash 一致（已完成） |
| 2 | 工具治理收敛 | `ToolOrchestrator`，接入 approval/network/sandbox/checkpoint/audit | Agent、Chat MCP、desktop handler 前均生成计划（已完成；统一审计字段待收敛） |
| 3 | WorldState | 结构化状态、full/reference/diff injection、窗口版本链、保留/压缩 | Streaming 可差分，跨进程从 PostgreSQL snapshot 恢复，Chat 已有独立窗口（已完成；desktop 窗口统一待补） |
| 4 | 事件可恢复 | append-only event log、seq、delta、provider state、outbox、回放 | 事实事件、outbox、重试、replay API、SSE Last-Event-ID、Provider 状态机和 usage 校准指标已完成 |
| 5 | 多 Agent 控制 | AgentControl、mailbox、预算/取消/并发继承、fork 策略、residency lease/LRU | 父子 Agent 可控通信且资源继承、常驻实例状态可审计（已完成） |
| 6 | 协议生态 | mock SSE、App Server JSON-RPC、MCP conformance、外部长连接 | 官方 initialize/tools_call/sse-retry 与真实 SSE reconnect 已通过；继续扩展客户端矩阵 |

## 八、验证记录与剩余风险

本轮执行与静态门禁：

```text
node --test tests/agent-acceptance.test.js tests/autonomous-agent-contracts.test.js \
  tests/desktop-agent-runtime.test.js tests/agent-runtime-lifecycle.test.js \
  tests/agent-trace-contracts.test.js tests/agent-sandbox-python.test.js
```

结果：新增 WorldState 保留、Provider mock SSE 断流/取消/审批暂停/工具失败恢复、ToolExecutionPlan、事件 outbox/replay、资源预算/并发/fork、App Server/MCP/Provider 状态机和非幂等恢复矩阵契约测试与既有自主 Agent、桌面、安全、Trace 回归均通过；v0.1.24 质量扩展回归为 **6/6**，全量 PostgreSQL `npm run test:all` 为 **573/573**。`check:architecture`、`check:text`、`check:no-new-raw-sql`、`git diff --check` 均通过；`check:async_db_calls` 报告 75 条非阻断提示（包含独立 residency worker 入口），未发现会阻断构建的新问题。

剩余工程风险：

- Chat/Agent/desktop 已共享 `ToolExecutionPlan` 的核心策略，Provider envelope 已在中央 model-forwarder 收敛；完整 `AgentStepContext` 与统一审计字段仍有入口差异，未来新增工具需保持三入口回归。
- Run/Step/Trace 已由 Agent Event Log + outbox 补充为事实事件源，Provider model delta、分类状态、断线 replay 和 Last-Event-ID 补发已接入；真实外部 MCP 长连接顺序已验证，剩余是逐 token usage 校准。
- 沙箱在 Windows/Linux 上依赖平台权限和工具可用性，需在目标发行版做安装后验收。
- Token 估算和上下文压缩采用近似算法，需增加 provider usage 校准和压缩质量评测。
- 父子 mailbox、预算/并发继承、usage 回收、fork history 和 residency lease/LRU 已实现；剩余工作是子失败汇报边界的长期压测，以及跨进程租约争抢与状态迁移评测。

## 九、最终判断

Pivot 已经实现报告中最重要的安全和运行时基础：**模型提出计划，代码执行策略，审批控制副作用，沙箱隔离环境，Checkpoint 支持恢复，Trace 记录事实，工作流沉淀结果。**

下一阶段不应继续横向堆叠更多工具，而应把已有能力继续收敛成五个可验证的核心抽象：

1. `AgentStepContext`：一次采样的稳定快照。
2. `WorldState`：动态环境、权限、工具和记忆的编译结果。
3. `ToolOrchestrator`：审批、网络、沙箱、重试和审计的唯一入口。
4. `AgentEventLog`：先持久化事实，再发布通知，并支持回放。
5. `AgentControl`：父子 Agent 的通信、预算、取消和并发控制器。

其中 StepContext、WorldState 窗口链/保留、跨入口 ToolExecutionPlan/scheduler、EventLog + outbox/replay、Provider envelope、Provider mock SSE、App Server/MCP 官方 conformance、真实长连接、AgentControl residency/LRU、usage 校准、非幂等故障矩阵和多进程压力验证均已落地；后续通过生产样本和更大规模评测，Pivot 将继续演进为“上下文一致、可重放、跨入口统一的 Agent Harness”。

## 十、本轮落地校正（2026-08-22）

本轮依据本报告的 P0/P1 建议完成了以下 PostgreSQL-only 改造：

| 落地项 | 实现 | 当前边界 |
| --- | --- | --- |
| `AgentStepContext` | `server/services/agent-step-context.js` 提供稳定排序、不可变快照、`contextHash/worldStateHash`；JSON planner、streaming planner、DAG 节点均创建并传递；Chat 持久化等价 snapshot，desktop 每 step 创建并落盘 hash | Chat/desktop 尚未完全复用同一对象序列化 |
| `WorldState` | 将 Run 策略、模型、工具契约、上下文、恢复信息、环境/记忆和安全扩展编译为结构化快照；Streaming 使用 `full/reference/diff` 注入，JSON planner 因每轮独立请求强制 full；Agent 与 Chat 均有 PG window/snapshot 链 | desktop 尚未完全接入同一窗口语义 |
| Provider 输入边界 | `agent-provider-envelope.js` + `model-forwarder.js` 在中央出站边界统一清洗 Chat/Responses 消息、工具和工具调用；Chat、OpenAI、应用中心、标题、RAG/长期记忆和 Agent 文本/流式共用 | usage 真实值与估算误差已按模型/协议持久化；继续累积生产样本以优化 tokenizer 偏差 |
| `ToolOrchestrator` | `server/services/agent-tool-execution-plan.js` + `agent-tool-orchestrator.js` 统一策略、审批、网络预检、sandbox 选择、operation key、checkpoint、失败/拒绝事件和实际 handler；Chat/desktop 也在 handler 前生成计划 | 统一审计字段和 StepContext 关联仍需收敛；沙箱升级重试明确为禁止自动放宽 |
| Append-only 事件 | PostgreSQL `agent_events` + `agent_event_outbox`、Run `event_seq`、payload hash、provider event、replay API、后台 claim/retry、SSE Last-Event-ID | 外部 MCP 客户端事件顺序和 Provider usage 校准指标均已验证 |
| `AgentControl` mailbox | `agent-control.js` + `agent_run_resources` 支持父子/同树消息、预算预留/消耗回收、子并发上限、fork history、领取、确认、过期、用户隔离和取消传播；`agent_residencies` 补充持久化常驻实例租约与 LRU | 多进程租约竞争和 LRU 压力回归已完成 |
| 上下文可追踪 | `agent_steps`、`agent_trace_spans`、`agent_tool_calls` 均保存 `context_hash`；DAG 重试复用节点快照；Chat snapshot 记录 turn/context/world-state hash | 旧数据的 context hash 为空是兼容历史记录的预期结果；desktop 完整 snapshot 仍待补 |
| 契约测试 | 既有 Agent Harness、WorldState、Provider SSE、scheduler、event/resource、control 测试，加上 `protocol-conformance.test.js`、chunked SSE 回归和官方 MCP conformance 客户端场景；v0.1.24 增加 usage 校准、非幂等故障矩阵和多进程 residency 压力测试 | 基线已完成；真实流量样本与更大规模评测持续累积 |

### 当前应视为“已实现”的结论

- Agent JSON planner、streaming planner、DAG 节点现在共享统一步骤上下文哈希；模型请求、工具执行、Step/Trace/Tool audit 可以按 hash 对齐。Streaming 可以基于上一个 WorldState 做 diff/reference，JSON planner 明确使用 full，避免独立请求引用不存在的模型上下文；PG snapshot 支持进程重启后恢复。
- Agent 模型请求在发送前经过 Provider envelope 白名单，内部 `metadata/context/policy/approval/sandbox/credential/run/user` 字段不会从消息对象透传到上游。
- 工具调用已经有单一 Agent 入口：`executeToolByName()` -> `ToolOrchestrator` -> 实际 MCP/数据库/内置 handler。策略拒绝发生在 checkpoint 和 handler 之前并记录 `tool.denied`，幂等操作可重放，失败会收敛为失败 checkpoint 和 `tool.failed` 事件。
- 事实事件使用 PostgreSQL 事务内的单调 `event_seq` 写入；客户端可按用户隔离的 run + seq 增量查询，model delta 已进入日志，outbox 负责可重试通知，replay API 和 SSE Last-Event-ID 支持断线续传。

### 已落地并持续演进的质量扩展

1. Provider usage 已记录 Responses/Chat Completions 的结构化真实 usage，并按模型/协议累计估算误差；生产流量达到统计量后继续优化 tokenizer 偏差。
2. 非幂等副作用矩阵已覆盖超时、Worker 错误、上游不可用、重复投递和外部提交状态未知；继续扩展异常注入规模与跨版本恢复评测。
3. residency/LRU 已实现数据库持久化、租约保护和多进程压力回归；继续累积更高并发、跨版本迁移和故障恢复样本。

### 数据库与测试约束

本项目业务运行和本轮新增能力的自动化测试以 **PostgreSQL 为唯一数据库**。历史迁移回归仍保留少量 SQLite snapshot/外部 SQLite 文件测试夹具，但本轮没有新增 SQLite schema、SQLite migration 或 SQLite 兼容分支；后续新功能按 PostgreSQL-only 开发。

验证命令：

```text
node scripts/run_node_tests.js agent-harness-context.test.js autonomous-agent-contracts.test.js
```

结果：`agent-world-state-store.test.js`、`agent-provider-sse-harness.test.js`、`agent-tool-scheduler.test.js`、`agent-event-resource-plan.test.js`、`agent-control.test.js`、`agent-residency.test.js`、`agent-residency-multiprocess.test.js`、`mcp-client-long-connection.test.js`、`protocol-conformance.test.js`、`provider-usage-calibration.test.js` 与既有 Agent Harness 契约均通过；v0.1.24 质量回归为 **6/6**，迁移 `202608210003` 至 `202608220007` 已应用，全量 PostgreSQL 回归为 **573/573**。核心文件语法和 ESLint、架构边界、文本完整性、raw SQL 增量检查和差异检查均通过；DAG、JSON planner、streaming planner、工具 scheduler、Provider envelope、AgentControl、App Server 路由均可加载。

## 十一、v0.1.23 剩余项闭环（2026-08-22）

上一节列出的“官方 conformance、真实外部长连接和 residency/LRU”已完成以下实现，不再作为未完成项：

| 对照项 | 本项目实现 | 验证结果 |
| --- | --- | --- |
| Provider envelope 全入口 | `model-forwarder` 在中央出站边界统一规范化 Chat `messages`、Responses `input`、tool/function 定义及工具调用字段；Chat、OpenAI、应用中心、标题、RAG/长期记忆和 Agent 文本/流式均复用该边界 | `agent-harness-context.test.js` 中央转发边界测试通过；内部治理字段不会从消息对象进入上游 |
| 真实外部 MCP 长连接 | `mcp-client` 支持 chunked SSE、JSON-RPC notification、`MCP-Protocol-Version`、session header、标准 GET SSE reconnect、`retry` 等待、`Last-Event-ID` 和目标响应后的可选断流 | `mcp-client-long-connection.test.js` 通过；真实官方 `sse-retry` 3/3 通过 |
| 官方 MCP conformance | 固定 `@modelcontextprotocol/conformance@0.2.0-alpha.11`，新增 `scripts/mcp-conformance-client.js` 及 `test:mcp:official`、`test:mcp:official:tools`、`test:mcp:official:sse` | `initialize` 1/1、`tools_call` 2/2、`sse-retry` 3/3 全部通过 |
| Agent residency/LRU | 新增迁移 `202608220006_agent_residency` 和 `agent-residency.js`，持久化脱敏状态/哈希、run 绑定、lease、TTL、per-user LRU、evict/list/acquire/release/sweep；App Server 显式 `residentKey` 触碰，后台每 5 分钟 sweep | PostgreSQL `agent-residency.test.js` 通过；租约实例不会被 LRU 淘汰 |

因此本报告原“尚未完成但值得继续借鉴”的五项内容均已落地为可运行代码和回归证据；v0.1.24 仅保留生产样本累积与更大规模评测作为持续质量工作。

## 十二、v0.1.24 质量扩展闭环（2026-08-22）

v0.1.24 将上一节列出的三项非阻塞质量扩展落实为可执行代码和 PostgreSQL 回归证据：

| 质量目标 | 实现 | 验证 |
| --- | --- | --- |
| 真实 Provider usage 校准 | `model_usage_calibrations` 聚合表；`provider-usage-calibration.js` 归一化 Chat/Responses usage，记录估算值、真实值、有符号误差、绝对误差、偏差比和最大误差；模型记录层接入普通 JSON、Agent planner、工作流节点、委派、内容校对和流式入口 | `provider-usage-calibration.test.js`：字段归一化、缺失字段和 PostgreSQL 聚合写入通过 |
| 非幂等故障矩阵 | 桌面执行账本覆盖超时、Worker 错误、上游不可用、重复投递和外部提交状态未知；已完成操作键只读重放，pending 非幂等调用恢复时强制重新审批 | `agent-non-idempotent-fault-matrix.test.js`：6 个场景全部通过，副作用执行次数符合契约 |
| 多进程 residency 压力 | `agent-residency-worker.js` 作为独立进程争抢同一 PostgreSQL lease；并发 touch 验证 per-user LRU 上限在压力下收敛 | `agent-residency-multiprocess.test.js`：8 进程单租约获胜、12 路 touch LRU 上限均通过 |

本轮独立质量回归命令为 `npm run test:agent:quality`；在 PostgreSQL 测试 schema 中三项测试共 **6/6** 通过。真实 usage 样本会持续累积，后续只需在目标 Provider 流量达到统计量后按模型/协议读取聚合误差指标。
