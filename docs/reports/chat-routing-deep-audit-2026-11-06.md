# 大模型对话智能路由深度检查

后续修复已归入 [v0.7.108 发布记录](../releases/v0.7.108-智能路由判断与任务续接可靠性升级.md)。本报告保留检查时的缺陷与历史证据，最终工程结果及模型验收暂停状态见[完成记录](chat-routing-completion-2026-11-06.md)。

检查日期：2026-11-06（Asia/Shanghai）。仓库基线：`4ad4b445`；检查对象为当时工作区中的实际代码。

**结论：需要优化。现有权限隔离、语义判断和安全降级已有较完整的基础，最需要修正的是语义判断前的提前返回、任务续接契约更新，以及评测对整条入口链路的覆盖。继续增加动作关键词或调高置信度阈值，不能解决这些根因。**

本轮检查没有修改生产代码、配置或既有工作区改动。新增材料是本报告，以及 `output/chat-routing-audit-2026-11-06/` 中的合成复现脚本和结果。复现未调用真实模型，未执行业务工具，未修改实际任务。相关既有测试通过隔离 PostgreSQL schema 运行。

## 1. 范围与证据

本次“智能路由”指普通对话下一步的判断：直接回答、仅提供方案、知识检索、单次只读工具、新建持久任务、续接任务和业务澄清。模型选择服务 `model-router.js` 属于另一层，本报告不将其负载或价格排序视为任务意图判断。

检查了前端来源覆盖、聊天接口、自动执行入口、意图提示词与契约、请求范围约束、语义检索与工具路由、上下文组装、任务交接与续接，以及评测脚本。对照标准来自 OpenAI 和 Anthropic 的公开文档；这些公开机制可以作为工程参照，不能用来断言竞品私有路由器的实现或准确率。

| 证据 | 结果 | 能说明什么 |
| --- | --- | --- |
| 原有 8 个相关测试文件 | 87 项通过，0 失败 | 既有回归行为正常 |
| 新增定向合成检查 | 14 个输入／探针复现 10 类问题 | 指定边界存在可重复的缺陷或覆盖缺口 |
| 当前固定意图评测集 | v6，44 例，其中 38 例标为关键 | 已有一定覆盖，但未充分检查入口前置分支 |
| 历史真实模型评测 | 全量 v5 为 35/44；v6 定向为 8/9；另有歧义单例 1/1 | 是历史证据，不能证明当前实现的效果 |
| 本轮真实模型准确率／生产错误率 | 未测量 | 不据定向样本推算线上比例 |

14 个定向输入是有目的地构造的反例，不能把“14 个均复现”表达为真实对话的失败率。

复现命令：

```powershell
node output/chat-routing-audit-2026-11-06/reproduce.cjs
```

机器可读结果：`output/chat-routing-audit-2026-11-06/results.json`。其中 `issueObserved=true` 表示观察到了对应问题。

现有回归运行命令：

```powershell
node scripts/run_node_tests.js tests/chat-intent-understanding.test.js tests/chat-intent-fallback.test.js tests/chat-intent-evaluation.test.js tests/chat-adaptive-routing.test.js tests/chat-route-correction.test.js tests/chat-auto-execution.test.js
node scripts/run_node_tests.js tests/chat-source-scope.test.js tests/chat-capability-decision.test.js
```

两批分别为 69/69、18/18。第二批日志保存在 `output/chat-routing-audit-regression-additional.log`。本轮未运行全仓 `npm test`：没有生产实现变更，验证集中于上述判断链路。

## 2. 对照公开的前沿实践

| 参照 | 可验证的工程原则 | 对本项目的意义 |
| --- | --- | --- |
| [OpenAI：Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | 支持时用结构化输出约束 Schema，并处理拒绝、截断等异常 | 路由协议应由机器约束和校验，而不只依赖提示词里的“必填” |
| [OpenAI：Prompting Realtime models](https://developers.openai.com/api/docs/guides/voice-prompting) | 只读查询在意图和参数明确时执行；澄清聚焦缺失、歧义或冲突的必要事实 | 可以迁移其澄清原则，但该资料是语音代理指南，不是所有产品的统一行为规范 |
| [Anthropic：Introducing advanced tool use](https://www.anthropic.com/research/advanced-tool-use) | 按需发现和加载相关工具，在上下文成本、额外发现延迟与准确率之间取舍 | 保留现有能力过滤和渐进发现，修正裁剪元数据，不需要把全部工具塞入提示 |
| [Anthropic：Writing effective tools](https://www.anthropic.com/research/writing-tools-for-agents) | 明确工具边界、输入输出与描述，并以评测检验效果 | 业务来源与能力边界应在契约和执行层保持一致 |
| [Anthropic：Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) | 同时评估交互过程、工具行为与结果，覆盖多轮状态变化 | 需要在直接调用 resolver 的评测之外加入入口、多轮续接和执行状态检查 |

现有设计中值得保留的部分：

- 动作、业务目标、能力和检索问题已经结构化，明确区分“内部制度问答”与“相同主题的模板创作”。
- 工具先经过账号权限、白名单、能力和审批规则，路由器只能在可见范围内选择。
- 语义服务超时、契约失败和服务不可用有独立故障标记，降级为受限文本回复；失败兜底不计为正确判断。
- 已有会话任务所有权校验、只读工具复核、文件实际生成核验，以及用户撤销授权优先于历史偏好的机制。
- 学习策略被限制在语义允许的动作集合内，不能因历史偏好直接扩大执行范围。

## 3. 已复现的问题

优先级定义：P1 是应优先修复的任务误分流、状态更新或验收缺口；P2 是协议、规模和上下文处理需要加强的地方。本次未发现可直接认定为 P0 的越权执行证据。

### F1 · P1：局部来源限制被当成整轮纠正，吞掉新委托

位置：`server/services/chat-auto-execution-handler.js:29`、`server/services/chat-route-correction.js:10`。

复现输入：

> 不要联网，帮我修复本地项目并运行测试。

实际结果：`action=direct_answer`、`reasonCode=natural_route_correction`、语义入口调用次数为 0，能力为空。同类输入“不检索知识库，核对数据库订单并导出报告”也被提前返回。

原因：纠正检测只要识别到来源排除就可能返回一个纠正对象；处理入口随即完成纠正分支并返回。当前对“仍需分析附件”的情况有专门放行，但文件、代码和数据委托没有统一处理。

影响：用户限定处理方式的同时明确委托工作，系统却进入普通回答路径。工具规划可能保留部分后续行为，但持久任务、验收和文件交付入口已经丢失。

建议：将“即时收紧范围”与“本轮主任务判断”分开。限制应先应用；当同一请求还包含实质工作时，携带限制继续语义判断。只有纯纠正才直接结束。不要继续按附件、代码、订单逐项增加特殊放行。

对应证据：`mixed-restriction-task`，2 例。

### F2 · P1：记忆规则抢占业务请求和词语讨论

位置：`server/services/chat-auto-execution.js:42`、`server/services/chat-intent-resolver.js:52`。

复现输入与实际结果：

| 输入 | 实际结果 |
| --- | --- |
| 记住我喜欢简洁；请制作一份可下载的PPT。 | `memory`，未调用意图模型 |
| 记住这个词用英语怎么说？ | `memory`，未调用意图模型 |

原因：`MEMORY` 主要根据句首判断；排除混合任务的 `containsCurrentTask` 又依赖少量词语，没有覆盖 PPT、图像及多种自然表达。resolver 对 memory 直接返回，所以语义模型无法纠正误判。

建议：零模型记忆路径仅接受能确定整轮含义的纯记忆指令。混合请求与讨论应进入语义消歧；确需同时处理偏好与工作时，将偏好作为附属意图，保留主任务。停止任务这种明确控制权继续即时生效。

这里确认的是“错误进入记忆路径”；没有执行真实记忆写入，不能据此宣称已发生了错误持久化。

对应证据：`memory-preemption`，2 例。

### F3 · P1：短附件直答捷径漏掉文件交付

位置：`server/services/chat-request-scope.js:36`、`server/services/chat-intent-resolver.js:45`。

复现：给请求附加一份短的合成简报。

| 输入 | 实际结果 |
| --- | --- |
| 请分析附件并做成PPT。 | `direct_answer`，`modelCalls=0`，无文件验收要求 |
| Analyze the attached document and export a PDF. | 同上 |

原因：附件直答根据“分析词 + 未命中动作排除正则”判断。排除正则主要是中文动作，没有覆盖“做成PPT”和英文 export。它位于语义裁决之前。

建议：短附件快速路径必须同时确认“只需要文本”和“没有文件、格式或副作用要求”。复用已有 `task-display-title.js` 中的演示文稿格式识别，统一文件交付意图处理；无法高精度确认时交给语义判断。PPT 格式判断不能只在任务已经创建后的 handoff 中补救。

对应证据：`attachment-delivery-fast-path`，2 例。

### F4 · P1：英文否定匹配跨越分句，误伤明确请求的来源

位置：`server/services/chat-request-scope.js:20`、`server/services/chat-request-scope.js:23`。

| 输入 | 实际范围 |
| --- | --- |
| Do not modify files; browse the web to verify the facts. | `excludeWeb=true` |
| Do not change data; use the knowledge base to check the policy. | `excludeKnowledge=true` |

原因：英文否定表达使用 `do not ... {0,24/32} ... 来源词`，中间的通配允许跨过分号。禁止修改被错误解释为禁止后面的查询来源；这些范围随后作为硬约束，模型也无法重新开启。

建议：按分句限定否定作用对象，先处理明确的“动作—对象”关系；对转折和后续肯定请求保留独立判断。加入中英文、标点变化及“不要修改，但需要查询”的对照回归。

对应证据：`negative-clause-overreach`，2 例。

### F5 · P1：任务续接的约束与能力更新语义不完整

位置：`server/services/chat-intent-contract.js:38`、`server/services/chat-intent-contract.js:62`；实际能力更新见 `server/services/chat-task-continuation.js`。

复现原任务：仅统计本周订单、不得修改原始订单，能力为 `data.sql.query`。本轮目标：继续核对，改为本月并生成报告；候选结果补充 `artifact.deliver`。

实际结果：

- 约束同时保留“仅统计本周订单”和“统计本月订单”。时间口径相互冲突。
- 因新能力数组非空，原任务的 `data.sql.query` 不再继承；结果只剩基础能力和交付能力。

前一个问题来自约束数组的无差别并集，当前协议无法表达业务字段替换。后一个问题说明模型必须每次完整重述所有仍需能力，遗漏无法由规范化层修复；任务续接随后会用该数组更新能力限制。

建议：任务契约使用明确的更新语义。时间、地区、格式等业务维度可被本轮指定值替换；禁止写入、来源边界等限制继续受保护。能力根据剩余工作和现有授权重新求最小集合。不能简单改成全量合并，否则又可能恢复已经被撤销的能力。

对应证据：`continuation-contract-update`，1 例。这是候选输出的健壮性检查，未测量真实模型遗漏能力的频率。

### F6 · P2：提示词的必填协议与机器校验不一致

位置：`server/services/chat-intent-prompt.js:22`、`server/services/chat-intent-contract.js:19`、`server/services/chat-intent-resolver.js:60`。

提示词要求 `action`、`objective`、`routing.knowledge`、`routing.tools` 必填，但 `{action:"direct_answer", objective:"查询昨天订单"}` 会被接受为成功语义判断，默认 `knowledge=auto`、`tools=none`。调用中没有传递现有 `callModelJson` 已支持的 `responseFormat`。

这会把“模型没有给出完整依据／工具决策”混入正常判断，使后续规则又承担一部分隐含裁决。兼容默认值本身可以保留，但应明确区分兼容结果与完整语义结果。

建议：统一版本化 Schema、提示词和校验器；支持的提供器使用结构化输出；不支持的提供器仍严格验证必要业务字段，并记录兼容或修复状态。跨字段检查应覆盖 action、tools、capabilities、continuation 和 acceptance 的一致性。

对应证据：`incomplete-contract-accepted`，1 例。

### F7 · P2：工具目录裁剪后仍标为完整可用

位置：`server/services/chat-capability-scope.js`、`server/services/chat-intent-prompt.js:54`。

复现：availability 含 30 个工具且状态为 `available`。提示构建后模型实际只能看到 24 个，状态仍为 `available`，`totalTools=30`。上游在显式选择较多工具时允许返回超过 24 个，提示构建又施加了另一层固定上限。

建议：根据实际传给模型的集合计算 `partial`；标记被省略的来源数量、保留显式选择，并提供现有渐进发现路径。目录不完整应影响发现策略，不能被等同于业务事实不清楚而反复询问用户。

对应证据：`catalog-truncated-with-complete-status`，1 例。

### F8 · P2：长请求按头尾裁剪会丢失中段业务限制

位置：`server/services/chat-intent-prompt.js:29`、`server/services/chat-intent-prompt.js:46`。

复现：在 20,018 字符的合成请求中段放入“仅限华东分公司已付款订单”。送入决策模型的 12,000 字符内容不包含该条件。头尾保留策略改善了尾部否定丢失，但不能保障中段关键范围。

影响限于已经验证的路由输入：第一次来源、查询和能力判断缺少这个条件。执行阶段可能重新读取完整原文，本轮没有证明最终执行必然违反范围。

建议：分离用户任务与长背景；为约束、来源、指代和交付物保留结构化摘要及原文引用。超出预算时明确标记缺失上下文，通过受控读取补齐影响路由的片段。不要仅通过继续扩大字符上限解决。

对应证据：`middle-constraint-omitted`，1 例。

### F9 · P1：超时和取消未覆盖上下文准备阶段

位置：`server/services/chat-auto-execution-handler.js:82`、`server/services/chat-auto-execution-handler.js:88`；模型调用截止位于 `server/services/chat-intent-resolver.js:18`。

当前顺序为：读取消息 → 并行读取任务、记忆和工具目录 → 启动带截止时间的意图模型调用。前三类依赖没有在入口统一受本次请求截止和取消保护。

合成探针将任务读取保持为未完成，注入的意图预算设为 1,000ms。超过预算仍未返回；随后取消请求，40ms 后仍未结束。释放该依赖后请求才结束。生产环境配置下的具体卡顿时长未测量，但该等待路径的边界缺口已确认。

建议：为整个判断入口传递统一截止时间和 AbortSignal；各阶段使用剩余预算。记忆和可选目录超时可标记 unavailable 后继续，任务状态等必要上下文不足时走已有安全降级。分别记录上下文准备、排队、模型推理和总耗时，避免只观察 model call duration。

对应证据：`context-wait-ignores-abort`，1 例。

### F10 · P1：评测入口与评分标准不足以拦住上述退化

位置：`scripts/evaluate_chat_intents.js:27`、`scripts/evaluate_chat_intents.js:33`、`scripts/lib/chat_intent_evaluation.js:6`。

有三个具体缺口：

1. 真实模型评测直接调用 `resolveChatIntent`，没有经过 `decideAutomaticChatExecution` 的纠正分支，因此即使扩充模型用例，也不一定发现 F1 这种入口提前返回。
2. 能力与约束主要做正向包含检查。没有表达 `forbiddenCapabilities`、`forbiddenToolNames`、额外能力上限和禁止续接对象的通用断言。合成的直答结果即使携带额外写入能力和陌生工具名，只要正向条件满足，独立评分函数仍会返回通过。这证明评分器有盲区，不代表运行时接受或执行了该陌生工具。
3. `implementationDigest` 只包含 5 个文件，遗漏影响实际判断的 handler、request-scope、baseline 分类器等文件。完整链路改变后，报告摘要未必改变。

建议：保留 resolver 级评测，再增加入口级与多轮任务级评测；同时断言应该执行和不得执行的行为。实现摘要覆盖完整判断依赖与配置。新增反例先作为修复集，另设独立冻结集，避免提示词只记住已知句式。

对应证据：`evaluation-negative-capability-gap`，1 个评分探针；入口与摘要缺口另由代码检查确认。

## 4. 历史模型证据与性能判断

仓库历史文件中：

| 报告 | 日期 | 结果 | 延迟 |
| --- | --- | --- | --- |
| `output/chat-intent-model-evaluation-v5.json` | 2026-10-20 | 35/44；关键失败 7；不可用 8 | P50 9,183ms；P95 30,008ms |
| `output/chat-intent-model-evaluation-v6-focused.json` | 2026-10-20 | 8/9；关键失败 1；不可用 1 | P50 11,339ms；P95 30,012ms |
| `output/chat-intent-source-ambiguous-reproduction.json` | 2026-10-20 | 定向歧义用例 1/1 | 5,043ms |

本轮沿用现有脚本的五文件摘要算法，当前摘要为 `79e442fa21f37004fa183dd27bcce3879903b03fc8b2430a478a18aefbf6fceb`。后两个历史报告的摘要均与当前不同；v5 文件没有相同字段。历史单例复验通过也不等于当前全量 44 例通过。

这些数据足以说明应把路由前置延迟作为单独指标重新测量，但不能直接宣称今天仍有相同超时率。应在目标模型和并发环境中重新运行全量、独立冻结集及入口评测，再比较错误率、过度澄清、漏执行、错续接和 P50/P95。

“根据模型自报 confidence 设置统一阈值”不宜直接作为修复。现有代码已明确能力不等于授权；低置信度处理应结合场景评测校准、字段冲突、上下文完整度和操作风险，区分业务歧义与系统故障。性能优化可比较轻量裁决器与困难样本升级，但要先以当前调用作为质量基线，避免新增模型调用增加串行延迟。

## 5. 建议的实施顺序与验收

| 顺序 | 工作 | 验收重点 |
| --- | --- | --- |
| 第一批 | 修正 F1–F4 的前置分支；补入口级反例 | 来源限制和偏好不能吞掉主任务；短附件文件交付进入任务；否定只作用于正确对象；纯停止与撤销仍立即有效 |
| 第二批 | 为 F5 建立任务契约更新语义 | 时间／地区／格式替换正确；不得恢复已撤销授权或扩大权限；仍需能力不丢失；多任务目标与已完成任务重放分别验证 |
| 第三批 | 处理 F6–F9 的 Schema、上下文和预算 | 必填及跨字段一致；目录完整度真实；关键限制可追溯；任一上下文依赖卡住时可取消并在总预算内降级 |
| 贯穿三批 | 加固 F10 评测与证据链 | 原有 87 项继续通过；14 个探针对应预期行为修复；独立冻结集、入口、多轮和禁止行为断言全部有结果 |

验收应把“原有单元回归通过”“模拟候选输出正常化”“真实模型理解正确”“端到端任务交付成功”分开记录。每项问题的修复用例应补标点、同义表达、中英文和历史上下文变化，不能只修复报告里的原句。

当前最有价值的下一步是先处理前置分支和续接契约，再更新评测。现有受控执行体系可以继续复用，本轮证据没有要求重建一套路由系统。
