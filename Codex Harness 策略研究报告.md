# Codex Harness 策略研究报告

## 1. 审计范围与版本

本文基于 OpenAI Codex 仓库 `main` 分支的提交：

- Commit: `7f9832d0d08c0e2fd56a02421477756474fec95d`
- 审计时间: 2026-08-21
- 仓库: [openai/codex](https://github.com/openai/codex/tree/7f9832d0d08c0e2fd56a02421477756474fec95d)

Codex 仓库中不存在一个单独名为 `harness strategy` 的文档。本文将分散在 Core、History、Sandboxing、App Server、Agent、Protocol 和测试目录中的实现，归纳为一套完整的 Harness 运行时策略。

本文所说的 Harness，主要指运行时 Agent Harness；同时也单独说明仓库中的测试 Harness 和 MCP 协议一致性 Harness，避免将运行时控制平面与测试设施混为一谈。

## 2. 核心结论

Codex 的 Harness 不是一个包裹在模型外面的简单 Prompt，而是一个完整的运行时控制平面：

```
CLI / App Server / SDK
        |
        v
ThreadManager / CodexThread
        |
        v
Session + Turn 状态机
        |
        v
StepContext + WorldState + ContextManager
        |
        v
Responses API 模型采样
        |
        v
ToolRouter + ToolCallRuntime
        |
        v
Approval + ExecPolicy + Sandbox + Network
        |
        v
工具结果 / 事件 / 持久化历史
        |
        +---- 下一次模型采样
        +---- 客户端事件流
        +---- 子 Agent 通信
```

核心职责可以概括为：

1. 管理对话、线程和 Turn 生命周期。
2. 将模型、环境、权限、工具、插件和 `AGENTS.md` 编译为当前上下文。
3. 解析模型流式输出并驱动工具调用。
4. 在每个副作用前执行审批、执行策略和沙箱检查。
5. 持久化消息、上下文、事件、压缩窗口和 Agent 图。
6. 管理 steering、取消、重试、压缩和恢复。
7. 管理多 Agent 的创建、继承、通信、并发和驻留。
8. 对 CLI、App Server、SDK 和 MCP 提供统一 Core 行为。

最重要的架构原则是：

> 模型只负责提出消息和工具调用；Harness 负责决定模型看到什么、能够调用什么、调用是否允许、如何执行以及状态如何恢复。

## 3. Harness 的边界设计

Codex 将模型可见数据和 Harness 私有数据分离。

| 信息类型 | 主要用途 | 是否发送给模型 |
| --- | --- | --- |
| `ResponseItem` | 对话、工具调用、工具结果 | 是 |
| `CodexHarnessMetadata` | 客户端注入标记、内部历史属性 | 否 |
| `RolloutItem` | 历史、事件、上下文、压缩和 Agent 通信持久化 | 视类型而定 |

`ResponseItemEnvelope` 将模型内容和 Harness 元数据分开保存：

- [history/src/lib.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/history/src/lib.rs#L34-L50)

```
pub struct ResponseItemEnvelope {
    pub item: ResponseItem,
    pub metadata: Option<CodexHarnessMetadata>,
}
```

模型请求构造时，`ContextManager::for_prompt()` 保留 `ResponseItem`，但移除 envelope 元数据：

- [context_manager/history.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/context_manager/history.rs#L197-L214)

由此形成明确边界：

```
持久化历史 = 模型内容 + Harness 元数据
模型请求   = 仅模型内容
```

App Server 测试专门验证 `metadata` 和 `client_authored` 不得进入 Provider 请求：

- [thread_inject_items.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/app-server/tests/suite/v2/thread_inject_items.rs#L230-L267)

## 4. 线程、会话和 Turn 生命周期

### 4.1 外部请求进入

App Server 的 `turn/start` 会：

- 加载或恢复 thread。
- 校验输入大小和图片 URL。
- 检查当前 Agent 是否允许直接输入。
- 解析 cwd、workspace roots 和环境选择。
- 构造审批策略、沙箱策略、模型、推理强度等设置。
- 将 App Server 输入映射为 Core 输入。
- 调用 `start_or_steer_turn()`。

参考：

- [turn_processor.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/app-server/src/request_processors/turn_processor.rs#L478-L613)

### 4.2 Start、Steer、Interrupt 和 Recovery 分离

Codex 不把用户输入简单地追加到一个全局消息列表，而是区分：

- 启动新 Turn。
- 向当前 Turn 注入 steering。
- 仅在空闲时启动后台工作。
- 中断当前 Turn。
- 恢复历史 Turn。
- 向子 Agent 发送 inter-agent communication。

`start_or_steer()` 的行为：

1. 当前存在可 steer 的普通 Turn 时，将输入加入 mailbox。
2. 没有活动 Turn 时，创建新的 `TurnContext` 并启动任务。
3. Plan、Compact、Review 等不可 steer 的 Turn 返回明确错误。
4. 设置只有在输入被接受后才应用，避免无效请求污染会话状态。

参考：

- [turn_input.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/turn_input.rs#L167-L248)

这说明 Harness 本身拥有显式生命周期状态机，而不是依赖模型自行判断“现在是否可以继续”。

### 4.3 一次 Turn 内的循环

`run_turn()` 的基本流程：

1. 处理上一 Turn 的异步 Hook 结果。
2. 创建或复用 `ModelClientSession`。
3. 在采样前检查上下文压缩。
4. 根据用户输入确定需要的 MCP Server 和插件。
5. 捕获当前 `StepContext`。
6. 生成或更新 World State。
7. 注入 skills、plugins、hooks 和用户输入。
8. 构造模型请求。
9. 处理模型流式事件。
10. 执行工具调用。
11. 将工具结果写回历史。
12. 如果模型需要继续、存在 pending input 或发生上下文变化，则再次采样。

参考：

- [turn.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/turn.rs#L140-L159)

模型只返回 assistant message 时，Turn 可以结束；模型返回工具调用时，工具结果会作为下一次采样输入发送回模型。

## 5. StepContext：每次采样的运行时快照

每次采样都会生成一个 `StepContext`，保存本次模型请求所需的完整运行时视图：

- 当前模型和模型能力。
- 推理强度和摘要策略。
- 审批策略。
- 当前环境和工作目录。
- 文件系统权限。
- MCP binding。
- 已加载的 `AGENTS.md`。
- 可用工具路由器。
- 插件和能力根目录。
- Executor 能力发现结果。
- telemetry 状态。

`capture_step_context_with_required_mcp_servers()` 会处理：

- 环境 readiness 刷新。
- `AGENTS.md` 加载。
- 能力根目录解析。
- Executor 能力发现。
- MCP Runtime 准备。
- 工具推荐计算。
- Tool Router 构建。

参考：

- [session/mod.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/mod.rs#L3153-L3279)

关键设计是：

> 工具列表、环境状态、权限策略和模型输入必须来自同一个 StepContext 快照。

这避免了“模型看到旧工具列表，但工具执行使用新权限”的状态不一致。

## 6. World State：动态上下文编译器

Codex 没有把所有上下文永久硬编码到 system prompt 中，而是依据运行时状态生成 World State。

World State 包含：

- 模型专属指令。
- Personality。
- Token budget 和上下文窗口提示。
- Realtime 状态。
- `AGENTS.md` 内容。
- 当前权限和审批策略。
- ExecPolicy。
- Collaboration Mode。
- 当前工作目录、环境和日期。
- 子 Agent 信息。
- Apps 和 Plugins 使用说明。
- 延迟加载工具 namespace。
- Extension 提供的上下文。
- Multi-Agent 模式和 usage hint。
- Managed developer instructions。

参考：

- [world_state.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/world_state.rs#L32-L297)

### 6.1 全量注入和差分注入

第一次 Turn：

```
完整初始上下文 + 完整 World State + 用户输入
```

后续 Turn：

```
仅上下文差分 + 环境变化 + 用户输入
```

`ContextManager` 保存：

- `reference_context_item`
- `world_state_baseline`
- `history_version`
- token usage 信息

参考：

- [history.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/context_manager/history.rs#L43-L65)

`record_context_updates_and_set_reference_context_item()` 会判断：

- 是否首次注入上下文。
- 当前模型是否发生变化。
- 当前环境是否发生变化。
- 是否只需要发送 World State patch。
- 是否需要重新发送完整上下文。

参考：

- [session/mod.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/mod.rs#L3854-L3941)

这种设计降低 token 消耗，也使上下文变化可以持久化和恢复。

## 7. Prompt 策略：行为引导与安全执行分离

Codex 的基础 prompt 明确告诉模型：

- 它接收 Harness 提供的用户输入和工作区上下文。
- 它可以输出终端命令和 patch 工具调用。
- 工具调用可能需要用户审批。
- `AGENTS.md` 具有作用域和继承规则。
- 可以创建和更新计划。
- 需要持续完成任务。

参考：

- [gpt_5_2_prompt.md](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/gpt_5_2_prompt.md#L1-L32)

但这些 prompt 指令不是最终安全边界。真正的权限判断仍由以下代码完成：

- `ExecPolicy`
- `AskForApproval`
- `PermissionProfile`
- `SandboxManager`
- `ToolOrchestrator`

可以概括为：

```
Prompt：告诉模型应该如何行为
Harness：强制模型实际上能做什么
```

## 8. 工具执行策略

### 8.1 Tool Router

模型可能返回：

- `FunctionCall`
- `CustomToolCall`
- `ToolSearchCall`
- 本地 shell call
- MCP 工具调用

Tool Router 将这些响应映射为实际的 `ToolInvocation` 和 `ToolRuntime`。

工具运行时不会直接执行命令，而是进入统一的 `ToolOrchestrator`。

### 8.2 ToolOrchestrator 的固定流程

源码在模块顶部直接说明了设计：

```
approval -> select sandbox -> attempt -> retry with escalated sandbox
```

参考：

- [orchestrator.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/tools/orchestrator.rs#L1-L7)

具体流程：

1. 根据工具和当前权限策略计算审批需求。
2. 判断是否禁止执行。
3. 选择首次沙箱。
4. 启动网络审批或网络代理。
5. 执行工具。
6. 如果沙箱拒绝，判断工具是否允许升级。
7. 必要时再次请求审批。
8. 以更高权限或无沙箱方式重试。
9. 记录 telemetry 和 sandbox outcome。
10. 将工具结果转为模型可理解的 `ResponseInputItem`。

### 8.3 审批策略

| 策略 | 行为 |
| --- | --- |
| `Never` | 不请求用户审批 |
| `OnRequest` | 受限文件系统下请求审批 |
| `Granular` | 按粒度决定，必要时禁止自动通过 |
| `UnlessTrusted` | 默认请求审批 |

参考：

- [sandboxing.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/tools/sandboxing.rs#L150-L230)

审批结果可以缓存到 `ApprovalStore`，支持在一个会话内对相同权限请求减少重复询问。

### 8.4 ExecPolicy

ExecPolicy 不是简单的命令字符串黑名单，而是：

- 将 shell 命令拆分为多个 command segment。
- 对每个 segment 分别计算 Allow、Prompt、Forbidden。
- 允许规则产生 prefix amendment。
- 对不同配置层进行继承判断。
- 在运行时更新允许前缀和网络规则。

参考：

- [exec_policy.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/exec_policy.rs)

### 8.5 沙箱策略

Codex 支持平台相关的沙箱：

- macOS Seatbelt。
- Linux Bubblewrap、Seccomp、Landlock。
- Windows Restricted Token。
- 无沙箱模式。

权限 profile 与沙箱不是同一个概念：

```
danger-full-access
    = 文件系统沙箱禁用
    != 自动跳过所有审批
```

`danger-full-access` 映射为无文件系统限制，但审批策略仍由 `AskForApproval` 决定。

### 8.6 Deny-read 优先级

即使 ExecPolicy 已允许命令，如果当前权限 profile 包含 denied-read 规则，Codex 也不会无沙箱运行，因为无沙箱会绕过 denied-read 限制。

安全不变量是：

> 允许执行命令，不等于允许绕过文件读取隔离。

## 9. 工具并发和取消策略

`ToolCallRuntime` 为每个工具调用保留产生该工具列表的 `StepContext`，避免工具执行期间上下文漂移。

参考：

- [parallel.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/tools/parallel.rs#L40-L205)

并发控制使用读写锁：

```
支持并行的工具：获取 read lock，可并行执行
不支持并行的工具：获取 write lock，串行执行
```

工具任务进入 `FuturesOrdered`：

- 模型可以一次返回多个工具调用。
- 工具执行可以并行。
- 工具结果按队列顺序写回历史。
- 用户取消时，未完成任务会被 abort。
- 被取消的工具会生成标准化的 aborted output。

这样既支持高吞吐，也能避免多个写操作相互破坏。

## 10. 流式模型响应策略

Codex 处理的主要 Responses API 事件包括：

- `OutputItemAdded`
- `OutputItemDone`
- 文本 delta
- reasoning delta
- tool argument delta
- `Completed`
- token usage
- rate limit
- safety buffering
- model verification

参考：

- [turn.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/turn.rs#L2179-L2245)

当工具调用完成时，Codex 将工具 future 放入 in-flight 队列；模型响应结束后统一 drain：

- [turn.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/turn.rs#L2129-L2153)

如果发生以下任一情况，本轮不会直接结束：

- `end_turn = false`
- 工具结果要求继续
- 用户在模型运行中提交了新输入
- 上下文需要压缩

Harness 会继续下一次采样。

## 11. 上下文压缩策略

Codex 支持三种压缩方式：

1. Token-budget 压缩。
2. Provider 远程压缩。
3. 本地压缩。

选择顺序由模型能力和 feature 决定：

- [turn.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/turn.rs#L1178-L1257)

压缩通常采用：

```
保留关键用户消息
+ 生成摘要
+ 重新注入当前上下文
+ 创建新的 context window
```

压缩过程包括：

- 保留近期消息和 cache-friendly 内容。
- 摘要作为新的历史边界。
- 重新注入当前模型、权限、环境和 Agent 角色。
- 保存 `window_id`、`previous_window_id`、`window_number`。
- 将压缩结果写入 rollout。
- 恢复时重新构造上下文。

压缩不是简单删除旧消息，而是一个可持久化的历史重写过程。

需要注意的是，历史 token 使用量通过近似字节算法估算，而不是完整 tokenizer：

- [history.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/context_manager/history.rs#L245-L270)

这是实现效率与估算精度之间的折中。

## 12. 事件和持久化策略

Codex 使用 rollout 作为长期状态记录。

`RolloutItem` 可以保存：

- Session metadata。
- Response item。
- Compaction。
- Turn context。
- World state。
- Inter-agent communication。
- Security risk score。
- Event message。

参考：

- [history/src/lib.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/history/src/lib.rs#L93-L105)

事件发送采用：

```
先持久化
再写入 trace
最后发送给客户端
```

参考：

- [session/mod.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/mod.rs#L2148-L2187)

客户端断线后，仍可以通过 rollout 恢复：

- 历史内容。
- Agent 状态。
- 工具结果。
- 压缩窗口。
- 上下文基线。
- 已发生的事件。

## 13. 多 Agent Harness

### 13.1 AgentControl

所有 root Agent 和子 Agent 共享 `AgentControl`，用于：

- 创建子 Agent。
- 发送输入。
- 发送 inter-agent communication。
- 查询状态。
- 中断 Agent。
- 管理父子关系。
- 管理 rollout budget。
- 管理 Agent path 和 nickname。

### 13.2 子 Agent 继承策略

子 Agent 可以继承：

- 父 Agent 的环境选择。
- 父 Agent 的工作区。
- 父 Agent 的 ExecPolicy，但需要配置兼容。
- 部分或全部对话历史。
- 父 Agent 的 trace 上下文。

但 fork 时会过滤：

- 活跃工具调用。
- 未配对的工具状态。
- 不适合子 Agent 的本地 shell 内容。
- 父 Agent 专属 multi-agent usage hint。
- 父 Agent 的角色和模式信息。

子 Agent 会重新注入：

- developer instructions。
- Agent role。
- usage hint。
- 当前环境状态。

### 13.3 Fork 模式

V2 支持：

- `none`：不带历史。
- `all`：完整历史 fork。
- 正整数：只保留最近 N 个 turn。

### 13.4 并发限制和 LRU 驻留

V2 子 Agent 有两类限制：

- 同时执行的 Agent 数量限制。
- 内存中驻留的 Agent 数量限制。

`AgentExecutionLimiter` 使用原子计数控制活跃子 Agent：

- [execution.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/agent/control/execution.rs#L13-L97)

`V2Residency` 使用 LRU 队列：

- 新 Agent 需要 slot 时先尝试预留。
- 没有 slot 时查找最久未使用的 Agent。
- 只有已完成、无 active turn、无 mailbox 的 Agent 才可卸载。
- 卸载前确保 rollout 已物化。
- 下次访问时从 rollout 恢复。

参考：

- [residency.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/agent/control/residency.rs#L48-L157)

这使多 Agent 系统具备类似进程调度器的内存管理能力。

## 14. App Server 适配层

App Server 不是另一个独立 Agent，而是 Core 的协议适配层：

```
JSON-RPC / WebSocket / stdio
          |
          v
Request Processor
          |
          v
ThreadManager / CodexThread
          |
          v
Core Session
```

App Server 负责：

- 请求参数校验。
- thread/turn ID 管理。
- Client metadata。
- 事件订阅。
- 审批响应。
- MCP elicitation。
- realtime 会话。
- 子 Agent 访问限制。
- App Server 通知转换。

例如，V2 子 Agent 不允许外部 App Server 直接输入，只能通过父 Agent 或 inter-agent communication 交互，避免外部客户端绕过 Agent 层级直接修改子 Agent 状态。

## 15. 测试 Harness 策略

Codex 的测试 Harness 也采用分层设计。

### 15.1 Core 工具集成测试

`tool_harness.rs` 使用本地 mock Responses API：

- 返回预制 SSE。
- 模型先发工具调用。
- Codex 执行工具。
- 验证第二次模型请求中的工具结果。
- 检查事件、计划、patch、错误和输出。

参考：

- [tool_harness.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/tests/suite/tool_harness.rs#L64-L135)

### 15.2 App Server 集成测试

App Server 测试验证：

- JSON-RPC 请求是否转换正确。
- 事件顺序是否正确。
- metadata 是否不会进入 Provider。
- 注入上下文是否位于环境上下文之后、用户输入之前。
- turn start、steer、interrupt 是否遵守状态约束。

### 15.3 Python SDK Harness

Python 测试提供本地 `MockResponsesServer`：

- 捕获 `/v1/responses`。
- 返回可控 SSE。
- 隔离 `CODEX_HOME`。
- 使用临时 workspace。
- 强制 `approval_policy=never`。
- 强制 `sandbox_mode=read-only`。
- 精确检查模型请求 JSON。

参考：

- [sdk/python/tests/app_server_harness.py](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/sdk/python/tests/app_server_harness.py)

### 15.4 MCP 协议一致性测试

仓库包含 MCP conformance harness：

- 使用固定版本的官方 MCP conformance suite。
- 覆盖 legacy、intermediate、modern 协议。
- 覆盖 HTTP、stdio 和 OAuth。
- 对历史通过项建立 baseline。
- 只允许新增修复，不允许新增回归。
- 独立测试 production reviewer 和 catalog boundary。

参考：

- [scripts/mcp_conformance/README.md](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/scripts/mcp_conformance/README.md)

## 16. 设计优点

### 16.1 强控制平面

模型无法直接访问文件系统、网络或进程，所有副作用都经过工具、审批和沙箱。

### 16.2 上下文一致性

每次采样使用同一个 StepContext，工具列表、权限、环境和模型输入保持一致。

### 16.3 持久化优先

事件和工具结果先写入 rollout，再通知客户端，天然支持恢复和审计。

### 16.4 模型可见状态与内部状态分离

Harness 私有 metadata 可以持久化，但不会泄漏到 Provider。

### 16.5 动态上下文差分

World State 采用全量初始化、差分更新，兼顾准确性和 token 成本。

### 16.6 安全策略组合化

审批、ExecPolicy、文件系统沙箱、网络代理和 Guardian review 可以独立组合。

### 16.7 多 Agent 可控

子 Agent 有父子关系、继承边界、并发限制、LRU 驻留和持久化恢复。

## 17. 主要复杂性和风险

### 17.1 Harness 不是单一模块

策略分散在 `core`、`history`、`sandboxing`、`app-server`、`agent`、`config` 和 `protocol` 多个 crate 中，理解和维护成本较高。

### 17.2 Prompt 和代码策略并存

模型 prompt 负责行为引导，但真正的安全控制在代码中。维护时不能把 prompt 当作权限边界。

### 17.3 动态上下文可能膨胀

World State、skills、plugins、MCP、extensions 和 Agent hints 会共同增加上下文复杂度。

### 17.4 压缩策略存在近似误差

token 使用是近似估计；远程压缩、本地压缩和 token-budget 压缩之间也存在行为差异。

### 17.5 多 Agent 状态机复杂

fork、resume、evict、restore、completion watcher、父子通信和 mailbox 共同增加并发场景。

### 17.6 权限升级需要严格测试

沙箱拒绝后的 retry 逻辑必须同时考虑：

- 是否允许无沙箱。
- 是否存在 denied-read。
- 是否需要再次审批。
- 是否存在网络审批。
- Guardian 是否需要重新审核。

## 18. 可复用的 Harness 设计原则

如果实现自己的 Coding Agent，可以借鉴 Codex 的以下结构：

1. 建立显式的 `Thread / Session / Turn / Step` 层次。
2. 为每次模型采样创建不可变运行时快照。
3. 将上下文编译为 World State，并支持 full injection 和 diff injection。
4. 使用 `ResponseItemEnvelope` 保存模型内容和内部 metadata。
5. 模型请求前剥离所有 Harness 私有字段。
6. 所有工具调用统一进入 Tool Router。
7. 工具执行统一经过 approval -> sandbox -> retry。
8. 将审批策略和沙箱策略分离。
9. 使用事件日志持久化状态，再向客户端发送通知。
10. 对工具并发使用能力声明，而不是全局盲目并行。
11. 为上下文压缩建立独立的窗口和恢复模型。
12. 多 Agent 使用父子图、资源限额和明确的 fork 策略。
13. 使用本地 mock SSE 验证“模型响应 -> 工具执行 -> 下一次模型请求”。
14. 使用协议 conformance harness 验证 App Server 和 MCP 兼容性。
15. 把安全约束放在运行时代码中，而不是只放在 system prompt 中。

## 19. 总结

Codex 的 Harness 本质上是一个：

```
模型驱动
+ 代码约束
+ 事件持久化
+ 安全隔离
+ 多 Agent 调度
+ 可恢复运行时
```

它最值得借鉴的不是某一段 Prompt，而是以下五个核心抽象的组合关系：

1. `StepContext`：一次采样的稳定运行时快照。
2. `WorldState`：动态环境和策略的上下文编译器。
3. `ToolOrchestrator`：审批、沙箱、网络和重试的统一入口。
4. `Rollout`：历史、事件、上下文和恢复的持久化日志。
5. `AgentControl`：多 Agent 创建、通信、资源限制和恢复控制器。

最终可以将 Codex Harness 概括为：

> 一个模型提出行动、代码决定边界、事件记录事实、状态支持恢复、多个 Agent 受控协作的 Agent 操作系统。

## 20. 关键源码索引

| 主题 | 关键文件 |
| --- | --- |
| Turn 状态机和采样循环 | [codex-rs/core/src/session/turn.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/turn.rs) |
| Turn 输入、steer 和生命周期 | [codex-rs/core/src/session/turn_input.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/turn_input.rs) |
| StepContext 捕获 | [codex-rs/core/src/session/mod.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/mod.rs) |
| World State | [codex-rs/core/src/session/world_state.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/session/world_state.rs) |
| 历史和 token 管理 | [codex-rs/core/src/context_manager/history.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/context_manager/history.rs) |
| Rollout 数据结构 | [codex-rs/history/src/lib.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/history/src/lib.rs) |
| 工具审批和沙箱 | [codex-rs/core/src/tools/orchestrator.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/tools/orchestrator.rs) |
| 工具并发和取消 | [codex-rs/core/src/tools/parallel.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/tools/parallel.rs) |
| ExecPolicy | [codex-rs/core/src/exec_policy.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/exec_policy.rs) |
| 多 Agent 控制 | [codex-rs/core/src/agent/control](https://github.com/openai/codex/tree/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/src/agent/control) |
| App Server turn 入口 | [codex-rs/app-server/src/request_processors/turn_processor.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/app-server/src/request_processors/turn_processor.rs) |
| Core 工具测试 Harness | [codex-rs/core/tests/suite/tool_harness.rs](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/codex-rs/core/tests/suite/tool_harness.rs) |
| Python SDK 测试 Harness | [sdk/python/tests/app_server_harness.py](https://github.com/openai/codex/blob/7f9832d0d08c0e2fd56a02421477756474fec95d/sdk/python/tests/app_server_harness.py) |
| MCP 一致性 Harness | [scripts/mcp_conformance](https://github.com/openai/codex/tree/7f9832d0d08c0e2fd56a02421477756474fec95d/scripts/mcp_conformance) |

## 21. v0.1.23 闭环更新（2026-08-22）

本项目已继续完成本报告原先列为“值得继续借鉴”的三项工程：

- Provider envelope 已在 `server/services/model-forwarder.js` 的中央出站边界收敛。Chat、OpenAI 兼容、应用中心、标题、RAG/长期记忆和 Agent 文本/流式请求共用消息、Responses input、tool/function 和工具调用字段清洗；内部治理字段不再从消息对象透传到 Provider。
- MCP 外部客户端已支持分片 SSE、通知、标准 HTTP session、协议版本、GET SSE 重连、`retry` 延迟、`Last-Event-ID` 恢复以及目标响应后的流关闭。固定依赖 `@modelcontextprotocol/conformance@0.2.0-alpha.11`，官方 `initialize` 1/1、`tools_call` 2/2、`sse-retry` 3/3 均通过。
- Agent residency/LRU 已从评估项变为 PostgreSQL 持久化能力：迁移 `202608220006_agent_residency`、WorldState 脱敏快照与 hash、租约/TTL、按用户 LRU、evict/list/acquire/release/sweep 和后台清理均已实现。App Server 以显式 `residentKey` 绑定常驻实例，避免普通一次性 Run 形成无界驻留。

当时仍保留的两类后续质量工作已在 v0.1.24 完成，详见下一节。

## 22. v0.1.24 质量扩展闭环（2026-08-22）

- Provider usage 校准已落地：`model_usage_calibrations` 按模型/协议聚合真实 input/output/total usage 与字符估算的 signed error、absolute error、bias ratio 和 max error；普通 JSON、Agent planner、工作流节点、委派、内容校对和流式调用均接入记录层。
- 非幂等故障矩阵已扩展：超时、Worker 错误、上游不可用、重复投递和外部提交状态未知均有恢复契约；完成 operation key 只读重放，pending 非幂等调用必须重新审批。
- Residency 多进程压力已验证：8 个独立进程争抢同一 PostgreSQL lease 只有一个获胜，12 路并发 touch 收敛到 per-user LRU 上限。
- v0.1.24 质量扩展命令 `npm run test:agent:quality` 为 `6/6`；全量 PostgreSQL 回归为 `573/573`，`npm run check` 和 `npm run lint` 均通过。
