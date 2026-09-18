# Pivot 工作流编排易用性优化与节点扩展方案

> 文档性质：结合当前代码基线的产品与技术改造方案
>
> 审查基线：Pivot `0.1.142`，复核日期：2026-09-18
>
> 约定：文中“现有/已实现”只表示当前代码已经具备；“拟改造/拟新增”表示本方案建议实施，不代表当前版本已经支持。

## 一、结论摘要

Pivot 的工作流编排底座已经具备可投入生产的核心能力：版本化工作流资产、DAG 拓扑校验、节点批量调度、节点级超时与重试、输入/输出契约、节点缓存、审批与延时恢复、预览运行、发布版运行、计划任务、Webhook/文件/数据库触发、共享工作流和工具治理。

当前主要问题不是“没有工作流引擎”，而是以下三类能力没有形成连续的用户体验：

1. 数据依赖存在于三处：画布 `dependsOn`、节点参数中的模板表达式、Inspector 的 `when` 条件。用户需要自己理解三套概念，变量选择器也没有把工作流输入节点和真实输出字段完整呈现出来。
2. 编辑器已有较好的画布操作、静态体检、节点测试和高级配置能力，但参数配置仍以“摘要 + 全屏向导”为主；高频字段不能在节点抽屉中直接修改。
3. 节点库和后端工具目录曾经存在可发现性缺口。当前已补齐 `agent.merge`、文本模板、受控通知预设；IM 通知通过受治理的渠道绑定支持企业微信、飞书和钉钉，不接受工作流节点直接提交裸 Webhook URL。

因此，本方案采用“先统一契约，再降低交互成本，最后扩展业务节点”的顺序：

```text
现有能力盘点
    ↓
变量、输出和错误契约统一
    ↓
Inspector 内联编辑与测试结果预览
    ↓
纯函数模板、聚合和通知预设
    ↓
边级 True/False 路由模型
    ↓
完整验收与灰度发布
```

本方案明确不把尚未实现的能力写成现有能力，也不建议直接通过修改前端显示来绕过后端工具治理、网络白名单、审批和沙箱约束。

## 二、审查范围与代码基线

### 2.1 覆盖范围

本次检查覆盖工作流从创建到运行的完整链路：

| 领域 | 当前实现位置 | 检查内容 |
| :--- | :--- | :--- |
| 工作流资产 | `client/chat/agent-workflow-*`、`server/services/agent-workflows.js` | 新建、保存、更新、删除、版本、发布、回滚、共享和依赖映射 |
| 画布编排 | `client/chat/agents-dag-editor.js`、`dag-core.js`、`dag-interaction.js`、`dag-render.js` | 节点增删、拖拽连线、布局、缩放、选择、复制、撤销重做 |
| 节点库 | `dag-node-presets.js`、`agent-dag-node-library.js`、`dag-toolbar.js` | 预设节点、分类、搜索、高级节点、工具可用性 |
| 节点配置 | `dag-inspector.js`、`dag-wizard*.js`、`dag-variable-picker.js` | Inspector、向导、变量插入、输入/输出契约、节点测试 |
| 静态治理 | `dag-governance.js`、`agent-validators.js`、`agent-dag-contracts.js` | 循环、悬空依赖、孤立节点、模板引用、Schema 和预检 |
| 运行时 | `agent-dag-runtime.js`、`agent-dag-utils.js`、`agent-dag-output.js` | 拓扑调度、模板求值、when、并发、重试、超时、输出持久化 |
| 工具治理 | `agent-tool-catalog.js`、`agent-tool-runtime.js`、`agent-contracts.js`、`agent-tool-capabilities.js` | 工具目录、能力、风险、副作用、审批、网络和沙箱 |
| 运行运营 | `agent-run-detail.js`、`agent-run-visuals.js`、`agent-dag-timeline.js` | 节点状态、运行详情、重跑、瀑布图、错误和产物 |
| 自动化入口 | `agent-schedules.js`、`agent-triggers.js`、`routes/triggers.js` | 计划任务、Webhook、文件、数据库触发、幂等和回调 |
| 测试 | `tests/dag-*`、`tests/agent-*`、`tests/e2e/workflow-version.spec.js` | 编辑器契约、运行契约、安全契约和端到端流程 |

### 2.2 当前事实的边界

以下内容是后续方案必须遵守的事实：

- 工作流的持久化 DAG 是 JSON 资产，运行中的节点状态另外持久化到 `agent_dag_nodes`。
- 当前依赖关系的主数据结构是节点上的 `dependsOn`，当前画布连线只表达“先后依赖”，不表达路由分支。
- 当前 `when` 是节点级条件，结构为 `{ source, operator, value }`，运行时在节点进入 runnable 阶段前求值。
- 当前模板解析支持 `goal`、`inputs.*`、`run.goal`、`run.inputs.*`、`nodes.<id>.output.*`、`nodes.<id>.status`、`nodes.<id>.error` 等路径；未解析路径不会自动变成空值，而可能保留原模板文本。
- 当前单节点测试会调用 `/api/agents/tools/test`，可以注入已有上游运行快照，但测试输出只展示在当前 Inspector，不会自动写入全局 `nodeTestOutputs` 字段树缓存。
- 当前服务端仍拒绝在进程内执行 `agent.code`；`workflow.foreach` 已接入独立受控 Worker，直接进程内调用仍会拒绝。
- 当前 IM 基础能力由 `builtin-mcp-im.js` 提供；三平台通知由 `workflow.notify` 复用受治理的渠道绑定和投递队列完成。

## 三、现有工作流功能清单

### 3.1 工作流资产生命周期

当前工作流不是一张临时画布，而是具有生命周期的资产：

1. 创建工作流，填写名称和简介。
2. 编辑当前版本的 DAG JSON 与布局。
3. 保存当前版本，保留版本历史。
4. 静态体检与运行预检。
5. 使用当前草稿预览运行。
6. 发布当前版本，生成稳定发布版。
7. 运行当前版本或发布版本。
8. 查看版本历史，加载历史版本预览或回滚为新的当前版本。
9. 对工作流设置个人/共享范围，配置允许用户和部门。
10. 共享工作流接收方只能查看并运行已发布版本，不能编辑草稿。
11. 共享工作流可以配置运行依赖，将模型、工具和受控凭据映射到接收方环境。

发布流程还受到评测门禁、工具能力、审批策略和依赖配置约束；系统管理员可以使用带原因记录的紧急跳过门禁发布。方案后续不能把“保存”误写成“发布”，也不能把共享接收方的发布版运行误写成当前草稿运行。

### 3.2 画布与编排操作

当前编辑器支持：

- 从节点库添加预设节点，或添加自定义空白节点。
- 节点按“起始与交付、AI 与智能体、知识与检索、数据与文档、流程与控制、呈现与多媒体”等类别组织。
- 节点库搜索；搜索时会自动包含高级节点。
- 预设节点根据当前工具目录判断是否可用；工具不存在、无权限或缺少 Worker 时会禁用卡片并展示原因。
- 从节点输出端口拖到另一节点输入端口创建依赖；新增依赖前会检查循环。
- 多选、框选、拖拽移动、复制/粘贴、复制节点、删除、撤销/重做、水平/垂直对齐、等间距分布、自动布局。
- 画布平移、滚轮缩放、适配全部节点、重置视图、缩略图导航。
- 节点双击后将标题输入框聚焦；双击空白处可添加节点。
- 当前边可以选中并显示状态、条件标签和运行状态，但边没有独立的分支类型。

### 3.3 当前节点类型与执行约束

当前节点库和工具目录包含以下主要类型：

| 类型 | 当前工具 | 当前行为与约束 |
| :--- | :--- | :--- |
| 输入/输出 | `workflow.input`、`workflow.output` | 输入支持必填、默认值和 text/number/boolean/object/array 类型；输出支持文本、Markdown、JSON、表格和文件产物 |
| 模型 | `agent.llm` | 节点读取模型配置，支持 Markdown/text/json；JSON 输出可按节点 Schema 请求原生结构化输出并进行修复校验 |
| 内容校对 | `agent.content_review` | 按记录、上下文预算和并发执行内容校对，返回结构化报告和产物 |
| 智能体协作 | `agent.delegate`、`agent.handoff` | 委派专家调用模型；交接节点只整理结构化 Handoff，不调用模型 |
| HTTP | `agent.http` | 支持 GET/POST/PUT/DELETE/PATCH、请求头、受控凭据和任务网络策略；网络请求受安全客户端和白名单限制 |
| 浏览器 | `agent.browser` | 独立浏览器 Profile、白名单页面、DOM/视觉定位，默认需要审批 |
| 聚合 | `agent.merge` | 将 `fields` 字典映射为 `{ merged, keys, count }`；目标字段实际位于 `output.merged.<field>` |
| 条件 | `workflow.condition` | 返回 `{ matched, value, compareTo, operator, route, text }`；当前 route 值为 `matched` 或 `unmatched` |
| 循环 | `workflow.foreach` | 通过独立受控 Worker 执行，支持并发、逐项重试、单项超时、输出上限、取消和错误汇总 |
| 通知 | `workflow.notify` | 引用已配置的渠道绑定，支持企业微信/飞书/钉钉文本或 Markdown 通知；发送进入幂等投递队列并受审批/网络策略治理 |
| 审批/延时 | `workflow.approval`、`workflow.delay` | 审批与延时具有可恢复状态，不能按普通单节点测试处理 |
| 子工作流 | `workflow.subworkflow` | 运行时阻止循环调用，最多嵌套 3 层 |
| 呈现/格式 | `workflow.embed_*`、`workflow.link_card`、`report.compose`、`viz.*`、`format.*` | 负责结果呈现、报告组装、图表、表格和格式转换 |
| MCP/数据库/文件 | `mcp.*`、`db.*`、`reports.*`、`data.*` 等 | 由工具目录、MCP 服务配置、数据库连接权限和能力治理决定是否可用 |
| IM | `im.list_allowed_targets`、`im.send_user_message`、`im.send_group_message`、`im.send_markdown` | 属于内置 MCP 服务，目标和 payload 由服务配置约束 |

### 3.4 当前配置入口

当前 Inspector 已经可以就地编辑：

- 节点 ID（只读）、标题、工具、执行条件。
- 节点级 `when` 条件。
- 输出模式和工作流输出呈现方式。
- 失败后策略、重试次数、单步超时。
- 输入/输出 Schema 概要和高级契约编辑。
- 上游依赖勾选。

常用业务参数已完成内联化：输入、模型、HTTP、条件、merge、文本模板和受控通知节点可在 Inspector 直接编辑；复杂对象、完整 Schema 和高级策略仍通过参数向导配置。`renderInputSummary` 保留为摘要和向导入口，不再是常用参数的唯一编辑路径。

### 3.5 当前运行时行为

运行时的主要流程如下：

1. 解析和规范化 DAG。
2. 检查节点数量、重复 ID、工具、依赖、循环和不连通节点组。
3. 检查模型节点是否配置模型，以及无上游模型节点是否引用 `goal`/`inputs`。
4. 按 `dependsOn` 计算 ready 节点。
5. 先判断节点级 `condition`：`success`、`failure`、`always`。
6. 再求值节点级 `when`，不满足则标记 skipped。
7. 对 runnable 节点按批次并行，默认并发 4，运行时设置上限 256。
8. 应用工具输入归一化、输入/输出 Schema 校验、工具审批、网络策略和沙箱策略。
9. 对可缓存工具按工具、入参、上游输出和工作流 ID 计算节点缓存键。
10. 执行节点，应用超时、重试、失败策略和取消信号。
11. 持久化节点状态、输出、契约状态、错误、尝试次数和耗时。
12. 生成运行步骤、追踪 span、节点观察记录和最终交付结果。

当前缓存是进程内内存 LRU，默认 TTL 15 分钟、最多 1000 项；副作用、审批、延时等工具不能简单视为可缓存工具。

## 四、已确认的主要问题

### 4.1 P0：变量和输出契约不一致

#### 问题 A：工作流输入节点没有进入变量选择器

`getAvailableVariableOptions` 当前全局组只有 `{{goal}}` 和 `{{inputs}}`，没有根据画布上的 `workflow.input` 节点生成：

```text
{{inputs.orderNumber}}
```

运行输入面板已经可以扫描输入节点并生成运行表单，但编辑时的变量选择器没有复用这份定义，形成“运行时能填，编辑时不会选”的断裂。

#### 问题 B：向导仍展示与节点类型无关的静态候选

`buildWizardReferenceGroups` 在没有输出契约时固定展示“完整结果、结构化结果、结果行、结构化行、状态、错误”。这对数据库节点有帮助，但对输入、条件、HTTP、聚合等节点不够准确。

#### 问题 C：当前工具字段存在误导风险

必须以真实执行器为准：

- `agent.http` 使用 `statusCode`，不是 `status`。
- `agent.merge` 的聚合字段在 `output.merged` 下，不是直接位于 `output` 根部。
- `workflow.input` 的实际输出是 `name`、`label`、`type`、`value`、`supplied`、`text`。
- `workflow.condition` 的分支依据是 `matched`；`route` 只是结果标签，不是当前画布边的独立类型。
- `workflow.foreach` 只有在 Worker 执行平面真正可用时才可运行；当前 Worker 由受控沙箱进程承载，服务端进程内入口仍然关闭。

### 4.2 P0：控制流、数据流和分支语义没有统一

当前有三种不同关系：

```text
dependsOn：节点执行顺序
{{nodes.x.output.y}}：数据引用
when：下游节点是否执行
```

它们之间没有自动同步机制：

- 用户在参数中引用上游输出，但忘记建立 `dependsOn` 时，静态体检只能给警告。
- 用户建立 `dependsOn`，但没有配置任何数据引用时，系统不知道用户只是要等待，还是希望注入数据。
- 条件节点的 True/False 逻辑写在多个下游节点的 `when` 中，画布边无法表达“这条边代表满足条件”。

当前静态体检已经能够定位非法引用、未声明依赖和孤立节点，并且会选中对应节点；但运行时错误定位还没有统一的“节点 + 字段 + 修复动作”协议。

### 4.3 P1：参数配置路径过长

高频修改通常是 Prompt、URL、输入参数名、默认值、条件比较值、聚合字段。当前这些字段仍然主要通过向导修改，造成：

- 画布、抽屉、向导之间反复跳转。
- 修改一个字段需要重新渲染较大的表单。
- 输入字段失焦、历史记录和变量插入的行为不统一。
- 侧栏摘要不能反映字段是否缺失、是否引用了未连线节点、是否通过 Schema 校验。

### 4.4 P1：节点库和工具目录的可发现性不足

`agent.merge` 已经存在，也有前端预设卡片，但被标记为高级节点；默认状态下普通用户看不到。`agent.http`、`agent.code`、`workflow.foreach` 也会受高级标记、网络策略、Worker 和能力治理影响，节点卡片需要把“为什么不能用”解释得更清楚。

### 4.5 P1：缺少确定性的文本模板节点

已有 `format.to_json`、`format.extract_json`、`format.normalize_text`、`format.to_markdown_table`，但没有一个无需模型、无需代码、支持变量混排的通用文本模板节点。

因此，用户为了完成如下任务仍可能调用模型或代码节点：

```text
【日报】{{inputs.department}}
今日完成：{{nodes.query.output.count}} 项
摘要：{{nodes.summary.output.text}}
```

### 4.6 P2：True/False 分支不是单纯的端口渲染问题

当前画布只有一个输出端口，连接动作只会向目标节点的 `dependsOn` 添加源节点 ID。要实现 True/False 双出口，必须同时解决：

- DAG JSON 的边级路由表示。
- 旧版 `dependsOn` 工作流兼容。
- ready 节点的路由判定。
- 多个条件边汇聚时的语义。
- 运行详情和跳过原因展示。
- 导入导出、版本 Diff 和静态体检。

只修改 `dag-render.js` 会产生“界面看起来有两个出口，但运行时仍按普通依赖执行”的错误。

### 4.7 P2：IM 通知需求被原方案描述过度

当前 `builtin-mcp-im.js` 的能力是：

- 列出允许通知目标。
- 给用户或群组发送纯文本。
- 给用户或群组发送 Markdown。
- 使用内置服务配置中的 endpoint、secret、payload 模板和目标白名单。

当前已新增 `workflow.notify` 受控通知工具：它只引用 `agent_channel_bindings` 中的绑定 ID，由渠道投递层完成企业微信、飞书、钉钉 payload 适配、凭据引用、网络检查、幂等、重试和死信处理。工作流节点不直接接收 `webhookUrl`。

## 五、优化目标与非目标

### 5.1 目标

1. 用户可以从输入节点、上游节点 Schema 和测试结果中点选变量，不需要记忆模板路径。
2. 画布依赖、变量引用和条件路由可以被静态检查，并在错误处给出动作建议。
3. 高频参数在 Inspector 中直接编辑；复杂 Schema、数据库查询和运行策略仍保留向导或高级区。
4. 纯函数文本组装、变量聚合和现有 IM 通知能力可以从节点库直接发现。
5. 分支路由具有明确的数据模型，旧工作流不需要迁移即可继续运行。
6. 新节点必须同时进入工具定义、能力注册、策略执行、节点预设、运行展示和自动化测试。

### 5.2 非目标

- 本期不重写现有 DAG 调度器，不替换 `dependsOn` 主拓扑模型。
- 本期不把动态 JavaScript 直接放回服务端执行。
- 本期不把 raw Webhook URL 直接暴露给普通用户作为默认通知方式。
- 三平台通知连接器已在本期完成；后续仅扩展更多平台协议，不改变渠道绑定和投递治理边界。
- 本期不以“调用模型自动猜字段”替代 Schema、静态检查和运行时校验。

## 六、总体设计

### 6.1 统一的变量目录

新增一个前端共享的变量目录构建器，由 Inspector、向导和变量气泡共同调用，避免 `dag-core.js`、`dag-wizard-input.js` 和 `dag-inspector.js` 各自维护候选逻辑。

变量目录分为四层：

1. **运行上下文**：`{{goal}}`、`{{inputs}}`。
2. **声明输入**：从 `workflow.input` 扫描 `input.name`、`input.label`、`input.type`、`required`、`description`，生成 `{{inputs.<name>}}`。
3. **契约字段**：优先读取上游节点 `outputSchema`，递归展示对象字段和受控的数组项路径。
4. **测试样本**：当前节点或上游节点最近一次单节点测试结果的真实 JSON 字段，仅作为采样提示，不能覆盖正式 Schema。

每个候选至少包含：

```json
{
  "expression": "{{nodes.http_1.output.data.orderId}}",
  "label": "订单接口 · data.orderId",
  "type": "string",
  "source": "schema",
  "nodeId": "http_1",
  "description": "接口返回数据中的订单号"
}
```

建议增加 `source`：`context`、`workflow_input`、`schema`、`sample`、`status`，用于在 UI 中区分“稳定契约”与“运行采样”。

### 6.2 输出字段目录和真实工具契约

后端工具定义是权威来源，前端预设的 `outputSchema` 只是编辑期提示，必须在构建目录时统一字段命名。第一批固定映射如下：

| 工具 | 推荐字段 | 说明 |
| :--- | :--- | :--- |
| `workflow.input` | `value`、`text`、`name`、`type`、`supplied` | 原始类型使用 `value`，文本场景使用 `text` |
| `workflow.condition` | `matched`、`route`、`value` | True/False 路由改造前仍通过 `matched` 和 `when` 实现 |
| `agent.http` | `statusCode`、`ok`、`headers`、`data`、`text` | 不再展示错误的 `status` 字段 |
| `agent.merge` | `merged`、`keys`、`count` | 自定义字段路径为 `output.merged.<field>` |
| `workflow.output` | `value`、`text`、`table.rows`、`file` | 表格和文件字段必须按呈现模式显示 |
| `workflow.foreach` | `items`、`count`、`inputCount`、`errors`、`stoppedOnError`、`audit`、`worker` | Worker 返回有界结果，并记录完成数、失败数、重试数、并发、超时和输出字节；没有 Worker 时显示不可运行 |
| `workflow.notify` | `queued`、`deliveryId`、`bindingId`、`status`、`platform`、`idempotencyKey` | 通知只入队并由渠道投递层发送 |
| `agent.llm` | `content`、`text`、`responseFormat` | JSON 输出仍应通过节点 Schema 展开字段 |

无 Schema 时可以提供工具专用推荐字段，但不能再给所有节点统一塞入 `rows`、`structuredContent.rows` 等无关字段。

### 6.3 依赖智能提示

当用户在字段中插入 `{{nodes.x.output.y}}` 时：

- 如果 `x` 不是当前节点的传递上游，显示“添加依赖”提示，并允许一键加入 `dependsOn`。
- 如果已经有 `dependsOn` 但字段没有引用上游数据，显示“仅等待依赖”的说明，不强行修改 Prompt。
- 如果用户从 A 的输出端连接到 B，且 B 是 `agent.llm`、`workflow.template`、`report.compose` 等可注入节点，提示“是否插入 A 的推荐字段”，默认不自动改写用户内容。
- 如果字段引用了不存在的节点或不存在的 Schema 字段，静态体检分别标记为错误或警告。

### 6.4 Inspector 渐进式配置

Inspector 改造为三层：

**第一层：节点核心设置**

- 所有可引用运行时结果的节点参数统一呈现“手动填写 / 引用运行时值”控件；文本、数值和普通字段可从任务目标、运行输入及上游输出中可视选择，模型、布尔开关、枚举、数据库连接、绑定 ID、输出名称等已有专用或静态含义的参数仍使用其专用控件。
- 结构化参数优先呈现为“选择上游结构化结果”的控件；例如分组汇总的“数据行”、循环的“items”、内容校对的“records/rows/data”、字段映射、筛选、章节等可直接选择上游节点的 `rows`、`data`、`items` 或完整结果。
- `data.group_summary` 的“分组字段”使用可添加、删除的多字段标签控件；运行时将字段值组合为稳定分组键，输出保留各分组字段、`group` 对象和 `groupByFields`，并兼容旧版单字段字符串。
- 字段映射、筛选、HTTP 请求头/正文和循环变量等键值对象使用“键 + 值”表单，数据字段和表格列可从上游 Schema 或最近测试输出中选择；不再要求用户先构造 JSON 对象。
- 审批对象和多级串签使用标签/逐级表单，浏览器节点以 CSS 选择器、角色/名称或可见文字三种方式描述目标；两者都可按需改用上游结构化结果或高级变量表达式。
- 报表读取节点先列出当前授权范围内的文件，文档渲染节点先列出当前用户可访问的产物；选择器不暴露目录绝对路径、其他用户产物或凭据。
- MCP 工具名先归一化后再匹配专用表单，避免 `mcp.<编号>.data.group_summary` 退化为普通文本输入；运行时变量只出现在可引用字段的取值选择器与统一变量面板，不在每个参数下重复显示任务目标/运行输入按钮。
- 专用控件识别同时以节点持久化工具名、MCP 完整/短名称、工具标题与 Schema 描述为依据，避免工具目录缓存或名称别名导致多字段分组编辑器回退为单文本字段。
- 多字段分组为空时不显示原始数组文本；以“尚未添加分组字段”空状态及横向标签编辑器引导操作。桌面端的分组字段与指标字段采用并排布局，减少表单纵向占用。
- `workflow.input` 定位为高级的“参数声明”而非起点节点：普通工作流直接使用 `{{inputs.<name>}}` 即可生成运行输入；仅在需要类型转换、默认值、必填校验或更友好的字段标签时，才显式添加参数声明。该节点保持独立，不自动作为业务节点的前序依赖。
- `workflow.input` 的默认值会随 text / number / boolean / object / array 类型切换对应控件；对象和数组只接受合法 JSON，避免将类型化默认值误存为普通文本。
- 自定义变量路径、JSON 常量等低频场景收纳到“高级：自定义变量或 JSON”，不再默认以深色代码编辑器占据主要配置区域。
- 报表查询在选定授权文件后可读取工作表与字段候选；工作表、返回字段和筛选字段复用同一批候选，CSV 默认工作表可留空。HTTP 节点优先选择当前用户可用的受控凭据引用，密钥正文不显示也不写入工作流。
- 条件节点将判断方式显示为中文；仅当选择等于、包含或大小比较时展示“比较值”。工作流输出把“默认结果 / 表格 / 文件产物”作为主配置，按交付方式显示对应字段，避免展示无关参数。
- 智能体交接的发现、证据、风险和待确认项使用逐条标签编辑器，减少手写数组；复杂动态数组仍保留高级变量入口。
- 编辑期可运行性检查覆盖工具必填项、默认值、枚举、数值/数组边界以及常见业务组合规则（多字段分组、条件比较、浏览器点击、子工作流 ID、运行参数/交付名称冲突）。问题同时显示在生命周期、画布节点红色标记和 Inspector 修复区；预览、当前版和发布版运行会在发起前拦截。

- 标题。
- 工具。
- 业务主字段 1～3 个。
- 上游依赖。
- 测试节点。

**第二层：运行逻辑**

- 执行条件。
- `when` 条件。
- 失败策略。
- 重试次数。
- 节点超时。

**第三层：高级契约与原始配置**

- 输入/输出 JSON Schema。
- 数据库查询构造器和高级 SQL。
- 复杂数组/对象配置。
- 原始 JSON。

内联编辑要求：

- 输入事件只更新内存草稿，失焦或明确提交后记录一次历史。
- Schema 类型、必填项和工具允许值即时校验。
- 重新渲染后保持焦点和光标位置。
- 只读共享工作流仍然禁用所有编辑控件。
- `Ctrl+Enter` 仅用于多行字段提交，不能误触发工作流运行。

### 6.5 单节点测试和采样字段树

保留现有 `/agents/tools/test`，增加前端会话级测试快照：

```text
nodeTestOutputs: Map<nodeId, {
  output,
  resolvedInput,
  createdAt,
  expiresAt,
  source: 'test'
}>
```

约束：

- 快照只存在当前编辑会话，默认 15 分钟过期；不写入工作流资产和数据库。
- 最大节点数、最大 JSON 字节数和最大递归深度必须受限。
- 字段树只展示脱敏采样值；`token`、`secret`、`password`、`authorization` 等字段只显示字段名。
- 副作用工具默认禁止单节点测试，或提供明确的“测试会真实产生副作用”确认和审批。
- `workflow.approval`、`workflow.delay`、`workflow.subworkflow` 继续要求完整工作流测试。
- 测试快照只能补充候选，正式运行仍以真实模板求值和 Schema 为准。

### 6.6 条件路由的兼容演进

#### 第一阶段：增强现有节点级 `when`

保持旧结构不变，增加：

- 条件节点专用推荐变量 `nodes.<id>.output.matched`。
- 下游 `when` 面板的 True/False 快捷按钮。
- 由连接动作自动生成 `when`，用户仍可在 Inspector 中调整。
- 画布边显示“满足条件/不满足条件”标签。
- 运行详情展示 `actual`、`expected`、`operator` 和跳过原因。

#### 第二阶段：新增边级路由结构

如果产品确实需要真正的双出口，采用向后兼容的 `edges` 扩展：

```json
{
  "schemaVersion": "pivot.dag.v2",
  "nodes": [
    { "id": "check", "tool": "workflow.condition", "dependsOn": [] },
    { "id": "yes", "tool": "agent.llm", "dependsOn": ["check"] },
    { "id": "no", "tool": "agent.llm", "dependsOn": ["check"] }
  ],
  "edges": [
    { "from": "check", "to": "yes", "route": "true" },
    { "from": "check", "to": "no", "route": "false" }
  ]
}
```

兼容规则：

- 没有 `edges` 的旧工作流继续只按 `dependsOn` 和 `when` 运行。
- `edges` 的 `from/to` 必须对应已有节点；`route` 目前只允许 `default`、`true`、`false`。
- `workflow.condition` 才能产生 `true/false` 路由；其他节点只能使用 `default`。
- 规范化阶段从 `edges` 推导 `dependsOn`，但不能反向凭空推导 True/False。
- 同一目标节点来自同一条件节点的 True 和 False 边同时存在时，必须静态报错，避免双重执行语义不明确。
- 运行时先等待所有依赖完成，再根据源条件节点的 `matched` 决定该边是否激活；未激活边的节点只有在所有依赖关系均确定后才能标记 skipped。
- 运行详情在节点跳过信息中记录 `routeSource`、`route` 和 `matched`，不新增敏感数据。

边级路由必须同步更新前端规范化、导入导出、Diff、静态体检、运行时、节点运行图和测试；不能只修改端口渲染。

## 七、节点扩展方案

### 7.1 `workflow.template`：确定性文本模板节点

新增一个无模型、无网络、无副作用的内置工具，建议契约为：

```json
{
  "name": "workflow.template",
  "title": "文本模板",
  "input_schema": {
    "type": "object",
    "required": ["template"],
    "properties": {
      "template": { "type": "string", "maxLength": 50000 },
      "trim": { "type": "boolean", "default": true },
      "missingVariable": { "type": "string", "enum": ["keep", "empty", "error"], "default": "keep" }
    }
  }
}
```

输出建议为：

```json
{
  "text": "渲染后的文本",
  "charCount": 12,
  "missingVariables": []
}
```

实现约束：

- 复用现有 DAG 模板求值规则，不另造一套变量语法。
- 精确匹配单个变量时保留原始类型只适用于对象/数组字段输入；模板最终输出仍为字符串。
- 变量混排时对对象和数组使用受控 JSON 序列化。
- `missingVariable=keep` 保留原表达式并输出警告，`empty` 替换为空字符串，`error` 直接失败。
- 禁止模板执行 JavaScript、函数调用、路径穿越或网络请求。
- 节点默认出现在“流程与控制”或“格式转换”分组，不标记为高级节点。

### 7.2 `agent.merge`：从高级节点变为可发现节点

不新增后端工具，先完成现有能力的可发现性改造：

- 从高级节点中移到“流程与控制”常规节点，或在节点库提供“常用聚合”入口。
- Inspector 提供可视化键值对编辑器：目标字段名、变量表达式、删除和新增。
- 明确输出预览为 `merged` 对象，变量选择器展示 `output.merged.<field>`。
- 多个上游节点的输出仍需通过依赖勾选或连接建立拓扑；键值对只负责数据映射，不隐式改变拓扑。
- 对空字段名、重复字段名和未声明上游引用提供即时提示。

### 7.3 受控通知：渠道绑定与三平台适配

`workflow.notify` 的节点只声明渠道绑定与消息内容；平台由绑定自动确定并由服务端复核，避免用户选择绑定后又填写不匹配的平台。

新增 `workflow.notify` 工具，并保留现有 `im.*` 工具作为底层能力预设：

- “发送用户消息” → `im.send_user_message`。
- “发送群组消息” → `im.send_group_message`。
- “发送 Markdown 通知” → `im.send_markdown`。
- “受控通知” → `workflow.notify`，节点从当前用户的活跃企业微信、飞书或钉钉渠道绑定中选择；填写正文、格式和幂等键，平台由绑定带出。
- 目标通过 `im.list_allowed_targets` 加载，不能让节点绕过白名单。
- 消息内容支持模板变量插入。
- 节点卡片展示“需要已配置 IM 服务/允许目标/可能需要审批”。
- 预览运行禁止实际发送副作用消息；完整运行沿用工具审批和通知审计。
- 渠道投递使用现有 `agent_channel_deliveries`，具备认领租约、幂等键、指数退避、最多 6 次尝试和死信状态。

连接器实现约束：

- 企业微信使用 `text/markdown` payload，飞书使用 `text/post` payload，钉钉使用 `text/markdown` payload；统一由安全 HTTP 客户端发送。
- Webhook 凭据存储与轮换通过 `credential_ref` 和工作流凭据控制面完成；钉钉签名凭据只在服务端投递时解析。
- 任务级网络白名单和 SSRF 防护。
- 钉钉请求使用时间戳和 HMAC 签名；所有平台投递均使用服务端生成的幂等键，避免重放重复入队。
- 失败重试、幂等键和已有渠道队列的退避/死信策略；平台限流参数由 Endpoint/网关策略控制。
- 发送前审批和预览模式拦截。
- 成功/失败响应的统一输出 Schema。

工作流节点不接受裸 `webhookUrl`；管理员在渠道设置中维护 Endpoint 和受控凭据引用。

`workflow.foreach` 的受控 Worker 限制为最多 1000 项、32KB 代码、256KB 变量、单项 200KB 输出和累计 1MB 输出；并发上限 20、逐项超时 50～5000ms、逐项重试最多 3 次、控制面进程最多运行 10 分钟。每次执行返回完成/失败/重试/并发/超时/输出字节审计汇总；取消通过运行 `AbortSignal` 终止整个 Worker 进程。

### 7.4 仍不新增的节点

- `workflow.foreach` 已完成受控 Worker 接入；节点仍保持高级标记，并要求运行环境提供受控 Worker。
- 新的代码节点：已有 `agent.code`，但必须在独立 Worker；不能用新别名绕开现有沙箱。
- 通用“万能 HTTP Webhook 节点”：已有 `agent.http`，继续沿用凭据和网络策略治理。

## 八、工具治理和安全要求

任何新增内置节点都必须同时完成：

1. `server/services/agent-tools.js`：工具名称、标题、输入 Schema、风险和副作用属性。
2. `server/services/agent-tools-workflow-nodes.js` 或对应领域执行器：实现和输出契约。
3. `server/services/agent-tool-capabilities.js`：显式能力登记。
4. `server/services/agent-contracts.js`：输出契约、幂等性、并发模式、网络和审批属性。
5. `server/services/agent-tool-catalog.js`：目录投影和用户可见能力。
6. `server/services/agent-tool-runtime.js`：统一执行入口，不得直接绕过工具编排器。
7. `client/chat/dag-node-presets.js`：预设、默认输入和输出 Schema。
8. `client/chat/dag-toolbar-fields.js`：主字段、隐藏字段和高级字段。
9. `client/chat/agent-run-tool-labels.js`、`tool-policy.js`：运行记录和策略界面中文说明。
10. 单元测试、安全测试、工具目录测试、节点编辑器契约测试和端到端测试。

安全底线：

- `agent.http` 和通知连接器必须经过网络策略；不能只在前端校验 URL。
- 共享工作流必须继续脱敏凭据、请求头和敏感 URL 参数。
- 有副作用的节点不能被缓存、预览执行或自动重试，除非有明确的幂等契约。
- `workflow.approval`、IM 审批回调和渠道交互必须保留令牌、签名、幂等和审计逻辑。
- `agent.code`、`workflow.foreach` 不能在服务端进程内动态执行。
- 工具能力必须通过能力登记和工具策略判断，不能以工具名称或前端显示状态代替授权。

## 九、分期实施路线

### 阶段 0：契约和基线修正（P0）

目标：先消除方案和代码之间的事实偏差，建立统一数据来源。

任务：

- 建立共享变量目录构建器。
- 扫描 `workflow.input`，生成 `{{inputs.<name>}}`。
- 修正 `agent.http.statusCode`、`agent.merge.output.merged` 等字段提示。
- 为 `workflow.input`、`workflow.condition`、`agent.http`、`agent.merge`、`workflow.output` 建立工具专用输出建议。
- 将 `dag-core.js`、`dag-wizard-input.js`、变量选择气泡改为复用同一目录。
- 静态体检覆盖 `when.source` 和所有节点输入字段。
- 为未解析变量、未声明依赖、缺少必填输入提供统一错误代码和节点定位信息。

验收：

- 点选输入节点字段可以插入 `{{inputs.orderNumber}}`。
- HTTP 节点只推荐 `statusCode`，聚合节点只推荐 `output.merged.*`。
- 变量引用节点不存在时静态体检报错；节点存在但未连线时显示修复按钮。
- 旧版工作流 JSON 不发生字段破坏。

### 阶段 1：配置路径和测试体验（P1）

任务：

- Inspector 为输入、模型、HTTP、条件、聚合、模板节点提供核心字段内联编辑。
- 参数校验、历史记录、焦点恢复、只读共享状态全部纳入测试。
- 单节点测试输出进入会话级采样字段树，增加 TTL、大小和脱敏。
- 副作用节点测试、审批节点测试、Worker 节点测试分别展示不同的可操作说明。
- 节点错误展示“定位节点、打开字段、添加依赖、配置凭据、打开依赖映射”等动作。

验收：

- 修改 Prompt、URL、输入名称、条件比较值不需要打开全屏向导。
- 测试输出字段可以插入下游字段，但刷新页面后不会污染工作流资产。
- 测试通知节点不会真实发送消息。
- 节点运行错误可以从运行详情定位到画布节点和配置字段。

### 阶段 2：确定性节点和现有通知能力（P1/P2）

任务：

- 新增 `workflow.template`，完成输入/输出契约、变量缺失策略和安全限制。
- 将 `agent.merge` 变为常用可发现节点。
- 将 `im.*` 现有能力做成通知预设，不新增未经治理的 raw Webhook 字段。
- 为模板、聚合和通知补齐预览、审批、缓存和失败策略说明。

验收：

- 模板节点在无模型、无网络条件下可以稳定运行。
- 同一模板在预览和正式运行中的变量求值结果一致。
- IM 预设只能选择允许目标，预览不会发送，正式运行可审计。

### 阶段 3：边级 True/False 路由（P2）

前置条件：阶段 0 的变量/契约完成，阶段 1 的错误定位完成。

任务：

- 引入 `schemaVersion: pivot.dag.v2` 和可选 `edges`。
- 更新画布端口、连线交互、规范化、导入导出、Diff、静态体检和运行时。
- 保留旧版 `dependsOn + when` 兼容路径。
- 增加条件边、路由跳过、汇聚节点和多分支互斥测试。

验收：

- True/False 两条边只能激活一条。
- 未激活分支被标记为 skipped，并在运行详情说明来源条件和实际值。
- 旧版工作流导入、保存、运行、发布和回滚结果不改变。
- 共享发布版和触发器运行使用同一套路由语义。

### 阶段 4：通知连接器与 Worker 能力（已完成）

本阶段已完成：

- 三平台通知连接器。
- `workflow.foreach` 独立 Worker 执行平面。
- Worker 任务取消、超时、输出大小、并发、重试和审计。

补充实现：

- `workflow.notify` 受治理工具和节点预设。
- `agent_channel_bindings` / `agent_channel_deliveries` 复用现有渠道控制面。
- 企业微信、飞书、钉钉 provider payload 构造与安全 HTTP 发送。
- Worker 使用工作区 Jail、无网络沙箱、控制面批准、输出大小上限和 AbortSignal 取消。

## 十、文件改动清单

### 10.1 阶段 0～1

| 文件 | 改动 |
| :--- | :--- |
| `client/chat/dag-core.js` | 统一变量目录、输入节点扫描、工具输出推荐 |
| `client/chat/dag-wizard-input.js` | 用共享目录生成引用组和字段建议，删除无差别静态 rows 候选 |
| `client/chat/dag-variable-picker.js` | 展示变量来源、类型、采样状态和搜索结果 |
| `client/chat/dag-inspector.js` | 核心字段内联编辑、错误动作、测试快照接入 |
| `client/chat/dag-node-presets.js` | 修正输出 Schema、开放 merge、增加 template 和 IM 预设 |
| `client/chat/dag-toolbar-fields.js` | 新节点主字段和高级字段配置 |
| `client/chat/dag-governance.js` | 检查输入字段、when 引用和依赖修复建议 |
| `client/chat/agent-workflow-editor.js` | 共享运行输入定义和编辑期变量目录 |
| `client/chat/agent-run-detail.js`、`agent-run-dag-focus.js`、`agent-run-visuals.js` | 错误节点动作、字段定位、路由/跳过信息展示 |
| `client/chat/agent-run-tool-labels.js`、`tool-policy.js` | 新工具和新错误的中文说明 |
| `client/chat/styles/workspaces/agent/*` | 内联字段、变量目录、错误动作和采样树样式 |
| `server/services/agent-tools.js` | 注册 `workflow.template`，补充工具 Schema |
| `server/services/agent-tools-workflow-nodes.js` | 实现纯函数模板执行器 |
| `server/services/agent-dag-utils.js` | 统一模板求值、缺失变量和 when 诊断信息 |
| `server/services/agent-dag-runtime.js` | 运行时错误上下文、采样/路由输出和兼容处理 |
| `server/services/agent-tool-capabilities.js` | 登记新增工具能力 |
| `server/services/agent-contracts.js` | 新工具风险、幂等、输出契约和副作用属性 |
| `server/services/agent-tool-catalog.js`、`agent-tool-runtime.js` | 工具目录与统一执行入口 |
| `server/services/builtin-mcp-im.js` | 仅在通知预设需要时补充返回字段或目标元数据 |
| `server/services/agent-channel-adapters.js`、`agent-channels.js` | 受控通知渠道、三平台 payload、投递重试、幂等和死信 |
| `server/services/agent-foreach-worker.js` | 独立循环 Worker，逐项超时、并发、重试、输出限制和错误汇总 |
| `server/services/agent-sandbox.js`、`.env.example` | Worker 的取消信号、进程输出限制和可配置启停开关 |
| `client/chat/agent-harness.js` | 受控 IM 渠道绑定的平台和 Endpoint 配置 |
| `tests/workflow-foreach-worker.test.js` | Worker、取消、重试、通知 payload 和治理测试 |

### 10.2 阶段 3

| 文件 | 改动 |
| :--- | :--- |
| `client/chat/dag-core.js` | 规范化和序列化 `schemaVersion/edges` |
| `client/chat/dag-interaction.js` | 选择 True/False 端口和创建带 route 的边 |
| `client/chat/dag-render.js` | 条件节点双出口、边标签和路由状态 |
| `client/chat/dag-governance.js` | 边级路由静态检查和旧版兼容 |
| `client/chat/dag-toolbar.js` | 路由体检、导入导出提示 |
| `server/services/agent-validators.js` | 规范化和验证 edges |
| `server/services/agent-dag-runtime.js` | 依赖完成、路由激活和跳过语义 |
| `server/services/agent-dag-utils.js` | 条件边求值和诊断输出 |
| `client/chat/agent-run-visuals.js` | 运行图显示路由边和分支跳过原因 |
| `tests/dag-authoring-contract.test.js` | 编辑器和变量契约 |
| `tests/dag-governance-contract.test.js` | edges、兼容和静态检查 |
| `tests/agent-trace-contracts.test.js` | 输出字段和运行详情契约 |
| 新增 DAG runtime 路由测试 | True、False、汇聚、错误、恢复和触发器场景 |

## 十一、验收测试矩阵

### 11.1 编排和变量

- 创建 `workflow.input(name=orderNumber)`，下游变量选择器出现 `{{inputs.orderNumber}}`。
- 输入节点是 number、boolean、object、array 时，变量目录展示正确类型。
- 输入节点重命名后，表达式、运行输入面板和静态检查保持一致。
- 选择上游 HTTP 字段得到 `statusCode`、`data`、`headers`，不出现 `status`。
- 选择 merge 字段得到 `output.merged.customerName`。
- 未连接但已引用上游字段时，一键添加依赖后运行顺序正确。
- 引用不存在节点时，保存和运行预检均能定位节点与字段。

### 11.2 配置和测试

- 输入、模型、HTTP、条件、merge、template 的核心字段可在 Inspector 内联编辑。
- 编辑过程中撤销/重做只生成合理的历史步，不因每次输入事件产生大量历史记录。
- 变量气泡插入到文本中间时，光标位置和括号处理正确。
- 单节点测试可以带入上游已有状态。
- 测试输出采样树有 TTL、大小限制和敏感字段脱敏。
- 测试 HTTP/IM/浏览器等副作用节点不会在预览模式执行。

### 11.3 运行时和可靠性

- 线性、并行、汇聚和不连通工作流均有明确运行结果。
- `success`、`failure`、`always` 和 `when` 的组合行为与文档一致。
- 节点超时、重试、`onError=continue`、取消和恢复不破坏依赖状态。
- 可缓存节点命中时运行详情显示缓存；副作用节点不会误命中缓存。
- 输入/输出契约失败时，错误包含节点 ID、字段路径和契约问题。
- 审批、延时和子工作流不能通过单节点测试绕过完整运行状态机。

### 11.4 版本、共享和触发

- 草稿预览只运行当前快照，发布版运行只读取发布版本。
- 共享接收方看不到草稿，不能编辑、发布、回滚或删除。
- 共享工作流中的凭据、Authorization、Token 和敏感 URL 参数均被脱敏。
- 共享工作流缺少依赖映射时，预检可以直接打开依赖配置。
- 计划任务、Webhook、文件和数据库触发都使用发布版，并保留来源元数据。
- Webhook payload 有 256 KB 限制、签名/时间戳/幂等策略和统一错误响应。
- 触发重复请求不会因幂等键重复创建运行。

### 11.5 节点扩展

- `workflow.template` 在无模型、无网络时输出稳定一致。
- 模板缺失变量的三种策略行为明确并有测试。
- `agent.merge` 空字段、重复字段、嵌套对象和未声明引用均有测试。
- IM 预设只使用允许目标，预览不发送，正式运行按既有治理策略审批和审计。
- 新工具在能力登记、工具目录、前端预设、运行标签和安全测试中均可发现。

## 十二、指标与发布策略

不再使用“效率提升一倍”“减少 70% 操作”等未经测量的承诺，改为上线前后可比较指标：

- 首次完成“输入 → 上游数据 → 输出”的用户任务成功率。
- 每个工作流平均打开参数向导次数。
- 未解析变量、未声明依赖和运行时空值错误数量。
- 从错误提示定位到节点并完成修复的平均时间。
- 单节点测试后成功插入下游字段的比例。
- 模板节点、merge 节点和 IM 预设的使用率。
- 预览运行与发布版运行的结果一致率。
- 副作用节点被预览或缓存误执行的安全事件数，目标为 0。

发布建议：

1. 先通过静态契约和单元测试。
2. 在测试环境运行完整 DAG、审批、延时、共享和触发器回归。
3. 对 `workflow.template` 和 Inspector 内联编辑做小范围灰度。
4. 观察错误率、变量插入成功率和预览/正式一致率。
5. 最后再启用边级路由实验开关。

## 十三、最终建议

这份方案的正确实施顺序应当是：

```text
修正真实字段与工具契约
    → 统一变量目录
    → 内联编辑和测试采样
    → 增加确定性模板节点
    → 开放 merge 与现有 IM 预设
    → 最后实施边级 True/False 路由
```

其中，变量目录、真实输出字段、Inspector 内联编辑、模板节点、三平台受控通知、Worker 循环执行和 True/False 双出口均已落地。本次产品级复核继续补齐了空画布起步路径、画布/检查器/运行前的同源配置反馈、报表与凭据的受控选择器、条件与交付方式的渐进式表单；后续仅属于运营和演进工作，例如基于生产流量调优平台限流参数，以及适配更多通知平台，不改变本方案已完成的治理边界。

完成上述边界修正后，Pivot 的工作流编排能够在保留现有企业级调度、安全治理和版本发布能力的基础上，降低普通用户的变量、配置和分支理解成本，同时避免把未实现能力、错误字段或未经治理的外部副作用写入产品方案。
