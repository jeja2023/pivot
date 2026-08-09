# Pivot 设计规范

## Source of truth

- Status: Active
- Last refreshed: 2026-08-09
- Release baseline: v0.0.259
- Primary product surfaces: 会话、应用、任务、自动化、知识库、工具库、设置、桌面客户端
- Evidence reviewed:
  - `README.md`：项目定位、功能边界和历史演进。
  - `client/chat/partials/workspaces/agent-dag.html`、`client/chat/agent-workflow-library.js`：工作流共享入口、范围配置和只读接收体验。
  - `client/chat/share-target-tree.js`、`client/chat/rag-documents.js`、`client/chat/mcp-workbench-main.js`：工作流、知识库和工具库共享目标树、单位/个人联动与批量选择。
  - `client/chat/dag-core.js`、`client/chat/dag-wizard-fields.js`、`client/chat/dag-wizard-input.js`、`server/services/agent-content-review.js`：富文本校对节点的模型选择、结构化记录输入、运行时别名和报告交付契约。
  - `server/services/unit-visibility.js`、`server/services/share-targets.js`、`server/services/agent-workflow-dependencies.js`：单位/个人共享判定、候选目标和接收者依赖绑定规则。
  - `tests/agent-content-review-node.test.js`、`tests/security-agent.test.js`、`tests/recipient-permissions-http.test.js`、`tests/e2e/workflow-version.spec.js`：富文本节点、接收者 HTTP 权限和发布版本失效回归证据。
  - `使用帮助.md`：普通用户在会话、应用、任务、自动化、知识库、工具库和个人设置中的实际使用路径。
  - `开发规范.md`：工程落地规则、UI 复用硬约束、测试和门禁。
  - `docs/公文写作设计方案.md`：公文写作模块设计。
  - `docs/design/工具库数据接入与本机能力设计方案.md`：工具库数据源、本机能力和执行位置设计。
  - `docs/design/文档处理底座与OCR_PDF工具应用分阶段开发方案.md`：文档处理、OCR 和 PDF 能力建设方案。

`DESIGN.md` 是项目级产品与体验设计源头，回答“为什么这样组织、用户如何理解、界面应呈现什么心智模型”。`开发规范.md` 是工程执行源头，回答“代码如何写、样式如何复用、接口如何校验、交付如何验收”。两者不互相复制；涉及 UI 实现时，先按本文件确定体验方向，再按根目录的 `开发规范.md` 落地。

## Shared resource boundaries

- Knowledge collections, database MCP connections and published agent workflows may be shared with an explicit unit or individual-user allowlist; all other assets remain personal by default.
- Recipients have read-only access to shared knowledge, governed database read tools and published workflow definitions. Ownership, mutation, refresh, diagnosis, version management and secret management stay with the owner or administrator.
- Shared workflow execution resolves models, tools and credentials against the recipient account. Bindings are pinned to a published version, become stale after republishing, and must be reconfirmed before execution; credential secrets never enter the recipient payload.
- Every shared workflow response must redact direct HTTP credentials, and publishing or sharing a workflow containing sensitive HTTP literals is rejected.
- Every list, detail, retrieval, graph and cached result path must apply the same visibility predicate before returning data.

## Brand

- Personality: 稳定、可信、清爽、内网办公友好，强调可控、可审计和高效率。
- Trust signals: 来源可见、权限清楚、操作可撤销或可追踪、重要结论有依据、失败原因可理解。
- Avoid: 营销页式大英雄区、过度装饰、炫技动画、隐式上下文、模糊权限边界、让底层实现名主导用户表达。

## Product goals（产品定位）

- Goals:
  - 为私有化、离线化和企业内网场景提供统一 AI 工作入口。
  - 让普通用户能围绕资料、数据、工具和应用完成具体工作，而不是学习底层技术。
  - 让管理员能治理模型、知识、工具、数据源、审计和系统状态。
  - 让统一任务中心承接执行过程，让自动化中心承接工作流与计划资产。
- Non-goals:
  - 不做开放互联网营销站。
  - 不把普通用户暴露在 MCP、RAG、向量库、服务端路径等底层概念里。
  - 不让单个业务应用自成一套导航、样式或权限模型。
  - 不牺牲安全审计来换取短期便利。
- Success signals:
  - 用户能清楚判断本轮回答是否使用了知识库或工具库。
  - 用户能理解数据来源在哪里、由哪台机器执行、是否可用于自动化。
  - 管理员能快速定位模型、知识库、工具库和任务运行问题。
  - 新增业务应用能复用全局工作区、弹窗、表格、分页、上传和状态反馈。

## Personas and jobs

- Primary personas:
  - 普通业务用户：提问、上传资料、查询知识、导入数据、生成报告。
  - 业务管理员：维护知识库、法规资料、工具连接、规范库和部门工作流。
  - 系统管理员：配置模型、全局参数、API Key、工具策略、审计和系统状态。
  - 技术实施人员：接入外部工具服务、数据库、部署环境和本地助手。
- User jobs:
  - 从内部资料中获得可靠回答。
  - 把表格、数据库、报表和文档转为分析结论。
  - 起草、审校和导出正式办公材料。
  - 将临时任务沉淀为可复用工作流。
  - 在出错时知道下一步该检查什么。
- Key contexts of use:
  - 内网、私有化和弱网环境。
  - 多角色权限共存。
  - 中文办公材料、制度、法规、表格和报告为主。
  - Web 与桌面客户端并存，桌面端可承担本机能力。

## Information architecture（信息架构）

- Primary navigation（左侧仅使用一级菜单，不设置二级菜单）:
  - 搜索：打开全局搜索弹窗，默认搜索会话，可切换任务和工作流。
  - 应用：打开应用中心，承载公文写作、数据分析、法规查询、OCR/PDF 等业务应用。
  - 任务：打开统一任务中心，汇总自主任务、工作流任务和计划运行记录；新建任务按需展开。
  - 自动化：打开工作流和计划资产中心；默认展示资产列表，编辑时进入工作流画布。
  - 知识库：打开知识库管理工作台，承载资料上传、专题库/标签、召回测试、质量报告和知识图谱。
  - 工具库：打开数据源、工具和连接管理，承载系统工具、个人连接、外部服务和治理诊断。
  - 最近会话：直接打开对应会话，承担高频上下文切换。
  - 设置：管理员进入系统设置，普通用户进入个人设置。
- Core routes/screens:
  - 聊天主界面：会话、输入、附件、知识库/工具库状态、回答来源提示。
  - 主工作区：知识库、工具库、应用中心和设置等都在统一工作区中打开。
  - 应用工作台：面向具体业务流程，强调列表、详情、任务、结果和导出。
  - 弹窗/抽屉：承载配置、上传、确认、审校、资源选择和详情查看。
- Content hierarchy:
  - 先展示当前任务和可操作状态。
  - 再展示来源、范围、配置和治理信息。
  - 复杂说明放入帮助、详情或模块设计文档，不占据高频工作区首屏。

## Design principles（交互原则）

- 渐进展开：首屏只放高频任务和必要状态；配置、治理和高级能力按需进入弹窗或详情。
- 依据可见：知识库引用、文件来源、数据源、工具调用和报告依据必须可见。
- 执行位置清楚：涉及文件、数据库和本机能力时，必须说明由服务器、我的电脑还是外部服务执行。
- 状态就近：加载、失败、诊断、审批、任务进度应出现在对应操作区域，不漂移到底层工具条。
- 入口去重：同一能力只保留一个主入口；不同入口必须对应不同用户心智或执行位置。
- 管理与使用分离：普通用户看到任务入口；管理员看到治理入口；系统管理员看到全局策略。
- Tradeoffs:
  - 低门槛优先于一次性暴露全部能力。
  - 可审计和安全边界优先于“看起来更方便”的隐式调用。
  - 复用全局组件优先于局部页面视觉创新。

## Visual language（视觉与组件）

- Color: 使用项目全局主题变量。主色表达可执行操作，危险色只用于破坏性操作，状态色表达成功、警告、错误和禁用。
- Typography: 中文办公阅读优先，字号层级克制；工具、卡片、表格内不使用英雄级标题。
- Spacing/layout rhythm: 工具型界面保持紧凑但留足扫描间距；列表、表格、筛选、分页节奏与现有工作区一致。
- Shape/radius/elevation: 卡片和弹窗半径控制在 8px 内；阴影只用于弹窗、浮层和必要层级，不制造装饰性漂浮感。
- Motion: 仅用于加载、展开、切换和反馈；尊重减少动态效果设置，不做持续吸引注意力的动画。
- Imagery/iconography: 工具入口优先使用清晰图标和短标签；业务应用可使用轻量图标，但不使用纯装饰图。

## Components

- Existing components to reuse:
  - 全局按钮、输入框、表格、分页、弹窗、上传控件、状态徽标和确认框。
  - 主工作区布局、应用中心工作台布局、设置页表格与筛选布局。
  - 知识库、法规查询、数据分析中已经沉淀的列表、详情、上传和诊断模式。
  - 应用中心任务型工作台必须复用法规查询沉淀的数据表格、分页、弹窗和操作列模式；OCR/PDF 等处理型应用主页面只承载上传、筛选和任务列表，识别/处理结果、预览和输出明细进入查看弹窗、详情页或独立结果页。
- New/changed components:
  - 聊天输入操作区：附件、知识库、工具库、上下文、模型名称和发送动作按使用顺序排列；不提供重复的清空按钮。
  - 模型选择触发器：位于输入框右侧、发送按钮左侧，仅显示当前模型名称；能力标识与说明放在展开列表中，长名称省略且不挤压发送按钮。
  - 数据源卡片：显示执行位置、归属范围、风险等级、工作流可用性。
  - 配置向导：数据库、报表目录、本机能力和外部服务分类型配置。
  - 来源提示条：展示回答、报告或图表来自哪些知识、文件、数据源和工具。
  - 本机助手状态：展示设备、在线状态、授权范围和不可用原因。
- Variants and states:
  - 加载、空、失败、禁用、无权限、待审批、已脱敏、离线、部分成功。
  - 个人、全局、服务器执行、我的电脑执行、外部服务执行。
- Token/component ownership:
  - 组件和样式实现规则归 `开发规范.md`。
  - 本文件只定义产品语义、信息层级和交互意图。

## Accessibility

- Target standard: 以键盘可达、焦点清晰、语义明确、文字可读为最低要求。
- Keyboard/focus behavior:
  - 弹窗、确认框、上传区、表格操作和工具卡片必须可键盘操作。
  - 关闭、取消、提交、危险确认要有稳定焦点顺序。
- Contrast/readability:
  - 状态徽标、辅助说明、错误文本必须满足可读对比度。
  - 禁止仅靠颜色表达风险或状态。
- Screen-reader semantics:
  - 上传、进度、错误、审批和工具调用状态应有可读文本。
  - 图标按钮必须有可理解的 `aria-label` 或同等文本。
- Reduced motion and sensory considerations:
  - 长回答回放、进度动画和图表动画应支持降低动态效果。

## Responsive behavior

- Supported breakpoints/devices:
  - 桌面浏览器和桌面客户端为主要生产力场景。
  - 移动端支持查看、轻量提问、审批和简单管理，不追求复杂工作流编辑。
- Layout adaptations:
  - 桌面端优先左右或上下分区，保证列表与详情可并行扫描。
  - 窄屏下将侧栏、筛选、详情和操作区堆叠，核心动作靠近内容。
  - 表格在窄屏应优先保留关键列，复杂字段进入详情。
- Touch/hover differences:
  - 不依赖 hover 才能发现关键操作。
  - 悬浮信息必须有点击或详情替代入口。

## Interaction states

- Loading: 显示正在处理的对象、阶段和可预期结果；长任务进入任务状态而不是无限等待。
- Empty: 给出下一步主动作，例如上传资料、导入数据、连接数据源、创建工作流。
- Error: 说明发生在哪个执行位置、用户能做什么、是否需要管理员处理。
- Success: 提供后续动作，例如查看结果、生成图表、加入报告、发送通知、保存为工作流。
- Disabled: 说明禁用原因，例如无权限、工具停用、设备离线、配置不完整。
- Offline/slow network:
  - 服务器能力失败时提示网络、权限和服务状态。
  - 本机能力失败时提示桌面客户端或本地助手状态。

## Content voice

- Tone: 简洁、明确、稳重，不把技术细节推给普通用户。
- Terminology:
  - 用户侧统一称“工具库”，不以 MCP 作为主名称。
  - 数据库入口使用“服务器可访问数据库”。
  - 报表目录入口使用“服务器可访问报表目录”。
  - 本机能力使用“连接本机数据库”“授权本机报表目录”。
  - 知识库强调“资料”“来源”“命中”“依据”。
- Microcopy rules:
  - 先说结果，再说原因，再说下一步。
  - 涉及 `localhost`、路径、数据库、权限时必须说明执行位置。
  - 错误提示避免暴露密钥、完整连接串、敏感路径和内部堆栈。
  - 面向普通用户少用底层实现名；必要技术名词放在中文解释中。

## Implementation constraints

- Framework/styling system:
  - 实现必须遵守 `开发规范.md` 的 UI 复用、样式来源、文件拆分和测试要求。
  - 本文件不重复列出 `.btn-primary`、`.form-input` 等 class 规则；具体实现以 `开发规范.md` 为准。
- Design-token constraints:
  - 不新增局部主题体系。
  - 新语义状态确实需要颜色或尺寸 token 时，先评估是否应进入全局样式。
- Performance constraints:
  - 首屏避免加载低频工作台和大图表库。
  - 大文件、OCR、PDF、数据库查询和智能体运行走任务或分页，不阻塞普通请求。
- Compatibility constraints:
  - 私有化、内网、Docker、桌面客户端和弱网场景都要保留清晰失败路径。
  - 已废弃的用户侧名称不保留输入识别兼容；底层协议与历史数据只在确有迁移需要时兼容。
- Test/screenshot expectations:
  - UI 改动需要覆盖桌面和窄屏布局、空状态、错误状态和长文本。
  - 涉及工具库、本机能力、上传和数据源时，必须验证权限与执行位置提示。

## Module Design Index

- 公文写作：`docs/公文写作设计方案.md`
  - 首页列表化，单篇编辑聚焦正文，辅助能力通过弹窗进入。
  - 本篇材料和知识库引用必须可见，并作为 AI 起草、审校和改写依据。
- 工具库数据接入：`docs/design/工具库数据接入与本机能力设计方案.md`
  - 工具库采用“数据来源 + 处理工具 + 输出动作”心智模型。
  - 明确服务器可访问数据库、服务器可访问报表目录、导入数据文件和本机能力的执行位置。
- 文档处理、OCR 与 PDF：`docs/design/文档处理底座与OCR_PDF工具应用分阶段开发方案.md`
  - 先建设共享文档处理底座，再复用到 OCR、PDF、知识库、法规查询和聊天附件。
  - OCR 与 PDF 能力应区分文本抽取、版面预览、识别结果和导出结果。
  - OCR/PDF 任务列表必须沿用法规查询的数据表格布局，表头、完整边框、行高、状态徽标、操作列和分页保持全局一致。
  - OCR 识别结果、PDF 处理结果和输出文件清单不得直接铺在主页面；通过查看入口进入弹窗/详情页，下载入口统一放在操作列或结果弹窗中。
- 知识库：
  - 以专题库、标签、召回测试、质量报告和来源可见为核心。
  - 普通聊天按需启用知识库，不默认把整库注入上下文。
- 数据分析：
  - 以导入数据集、字段画像、查询、透视、图表、对比和导出为核心。
  - AI 结论必须保留数据集和查询来源，正式汇报前提示人工复核。
- 法规查询：
  - 以法规文档、版本、条文级检索、来源下载、归档治理和基于条文的 AI 问答为核心。
  - 法规结论必须能回到条文和源文件。
- 任务与自动化：
  - 自主任务用于探索和试跑，工作流用于稳定、可审计、可复用流程，计划任务用于周期执行。
  - 任务中心管理运行，自动化中心管理工作流和计划资产，两者不再作为同一“智能体”菜单的二级入口。
  - 新建自主任务的快捷目标属于配置预设，只填入目标和推荐策略，不应绕过用户确认直接启动；当前配置可以保存为模板复用。
  - 最大执行轮次属于高级安全边界，默认按运行模式自动选择而不是使用偏小的固定值；标准模式 30 轮，深度模式 60 轮，审查模式 50 轮，人工配置受对应模式上限约束。单次任务 Token 上限独立控制累计输入和输出，留空或 `0` 表示不限。
  - 达到执行轮次或 Token 上限时必须保留已有结果并明确提示可能不完整；运行详情应区分模型“执行轮次”和持久化“执行记录”，工作流 DAG 继续以节点记录为主。
  - 工作流名称和简介在资产列表中独立编辑，详情页专注节点编排；节点名称允许就地编辑，但提交边界必须清晰，不能因逐字保存导致焦点丢失。
  - 节点输出统一提供格式化文本、纯文本和结构化数据三种用户模式；结构化数据绑定 JSON Schema，并以可视化编辑、预览、校验和字段选择降低使用门槛。
  - 下游引用应根据上游 Schema 提供字段选择器；表格和文件产物属于 JSON 数据与文件引用的展示层，不引入 YAML/XML 作为内部承载格式。
  - 工具范围、审批、失败重试和结果产物必须可见。
- 系统设置与治理：
  - 面向管理员，使用高密度但清晰的表格、筛选、详情和诊断布局。
  - 全局策略与个人资源管理边界必须清晰。

## Open questions

- [ ] 是否需要为知识库、数据分析、法规查询分别补独立模块设计方案？影响：能减少大型模块继续依赖 README 历史记录作为设计依据。
- [ ] 本地助手是否作为桌面客户端的一部分发布，还是提供轻量独立安装包？影响：工具库本机能力的信息架构和安装引导。
- [ ] 全局共享资源是否需要部门级可见范围，而不只是个人/全局？影响：模型、知识库、数据源、工具服务和工作流权限设计。
- [ ] 是否需要统一“来源提示条”组件供聊天、报告、数据分析和公文写作复用？影响：依据可见的一致性。
