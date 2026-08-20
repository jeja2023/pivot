# Pivot Optimization And Extension Roadmap

This document records optimization work that is intentionally staged instead of forced into one risky rewrite.

## 2026-08-09 Architecture Baseline

- Rich-text review nodes now use the same selectable-model policy as ordinary LLM and delegate nodes: current-user visibility is enforced, embedding models are excluded, duplicate caches are merged, and empty or stale selections remain explicit in the wizard.
- `agent.content_review` input editing preserves upstream template references and parses structured records safely; its field metadata, numeric bounds, runtime model aliases and detailed output contract are aligned across the client wizard, built-in tool definition and run persistence.
- Full report titles now flow consistently through the summary, Markdown artifact and output metadata. Regression evidence covers model selection, structured input, bounds, aliases and report delivery in `tests/agent-content-review-node.test.js` and `tests/security-agent.test.js`.

## 2026-08-08 Architecture Baseline

- Shared workflow, tool-library and knowledge-library permission dialogs now use the same unit-to-user target-tree interaction; unit selection propagates to its users and full-select controls remain horizontal and non-wrapping.
- `client/chat/share-target-tree.js` is the shared client helper for target rendering, safe escaping, unit/user propagation and bulk selection; workflow-specific ownership and recipient boundaries remain enforced by the existing workflow module.
- Workflow metadata updates use a dedicated owner-only endpoint and do not create a new DAG version. Run-mode step limits are explicit: standard 30, deep 60 and audit 50, with client and server validation using the same limits.
- Regression evidence includes `tests/agent-workflow-metadata.test.js`, security-agent CSS/share-tree assertions and the full `npm test` suite.

## 2026-08-07 Architecture Baseline

- Root-level `README.md`, `CHANGELOG.md`, `使用帮助.md`, and `开发规范.md` remain stable project entry points.
- Design documents, reports, packaging notes, and Windows wrappers are organized under `docs/design/`, `docs/reports/`, `docs/standards/`, and `scripts/bat/`.
- Legacy desktop installers are kept outside `client/`; source-tree files over 50 MiB are blocked by `npm run check:large-files`.
- Express assembly, process/background bootstrap, and HTTP lifecycle now live in `server/app.js`, `server/bootstrap.js`, and `server/server.js`; `server/index.js` remains a thin startup entry.
- Knowledge-tag persistence is the first incremental Repository migration. Existing SQLite transaction and parameter-binding behavior is retained.
- `npm run check:architecture` protects the new directory and server lifecycle boundaries.
- Vite, CSS purging, chat virtualization, and database-driver package splitting remain measurement-gated. Current frontend assets are small enough that preserving direct deployment and incremental `Pivot.modules` migration has higher value than a forced bundler rewrite.

## Release Snapshot

> 维护约定：本文件与 CHANGELOG、版本号同级维护。发布时若本轮涉及"有意分阶段推进/暂缓"的决策，必须在此登记，否则决策会随版本推进丢失。

- v0.1.5 (2026-08-20) 规划启动用量设计一体化看板融合架构、完成 CI 自动化 PostgreSQL 容器测试与测试运行器时区与并发竞态加固：规划将分散的「用量统计」、「用量明细」与「审计报表」三合一融合为统一的「用量中心 / 用量设计」看板，打通从宏观用量监控、微观明细穿透下钻到审计报表与一键 CSV 结构化导出的全流程闭环；GitHub Actions CI 配置 PostgreSQL 16 自动化服务容器与健康检查，测试运行器支持 CI 数据库连接自动回退；全局注入 `TZ=Asia/Shanghai` 与 `PG_TIMEZONE=Asia/Shanghai` 时区隔离并消除 8 小时断言偏差；修复 `getAgentQueue()` 单例覆盖导致的并发测试抢占竞态；测试运行器启用 `--test-reporter=spec` 错误详情汇总。全量 Node 测试 476/476、`npm run check` 与 ESLint 100% 通过。
- v0.1.4 (2026-08-19) 完成认证退出与空会话体验优化、可观测性与监控单行布局增强、全链路审计中文化、审计报表导出与 PostgreSQL 自动备份加固：CSRF 豁免 `/auth/logout` 且前端异步等待实现单次退出；空会话恢复静默重置避免错误 Toast；监控面板列宽自适应彻底消除 PostgreSQL 标签截断；慢查询与告警条目增加时间戳并重构为单行流式布局，排除大模型正常推理耗时；全模块（知识库/知识图谱等）补齐审计日志并完成操作与详情全量中文化；新增审计报表 CSV 导出功能（涵盖每日 Token 趋势、用户消耗排行与部门消耗对比）；`pg_dump` 备份实现 Windows 常见路径自动查找与应用 Schema 范围保护。全量 457 个 JS 检查与 ESLint 0 错误 0 警告通过。
- v0.1.3 (2026-08-19) 完成 PostgreSQL 运维备份、E2E 环境隔离、异步生命周期等待、GPU 容错与跨平台启动优化：接入原生 `pg_dump` 自定义格式热备份引擎，支持超时、环境变量凭据隔离与按天数/版本轮转清理；PostgreSQL 参数占位符引入词法状态机；E2E 测试实现独立 Schema、随机端口与服务隔离；修复 Webhook 异步分发等待与 Electron 本地服务 `initPromise` 初始化等待；GPU 显存水位增加递增校验与安全回退；移除 Windows 专有 `chcp` 前缀支持跨平台/Docker 启动。新增 18 项专项回归，全量 Node 测试 476/476、`npm run check` 与 ESLint 100% 通过。
- v0.1.2 (2026-08-19) 完成 PostgreSQL DDL 幂等与普通用户权限（42501）容错、请求日志真实用户身份提取、全栈中英文错误断言对齐与死代码精简。全量 Node 测试 472/472 100% 通过。
- v0.1.1 (2026-08-19) 完成全系统工程全量中文化重构、控制台日志汉化美化、Cookie 与 401 轮询优化及代码质量闭环。453 个 JS 文件检查与 ESLint 0 错误 0 警告。
- v0.1.0 (2026-08-18) 完成核心数据库纯 PostgreSQL 架构全面升级与全链路异步化、79 张表原生中文注释字典与生产级核验保障。
- v0.0.269 (2026-08-18) 完成生产环境 PostgreSQL 双模式迁移全栈就绪、全链路数据访问层异步化改造与元数据字典注释系统。
- v0.0.268 (2026-08-17) 完成聊天输入区能力聚合、文件夹上传与工具白名单精细化过滤：输入区操作栏统一收口至「+」悬浮菜单与二级抽屉式面板；附件支持整文件夹层级上传及输入框拖拽/剪贴板原生粘贴；知识库面板内置健康度检查与范围筛选；工具库支持模型自动选择与手动白名单勾选，前后端打通精确工具授权。Node 回归 467/467、ESLint 与 E2E 冒烟测试通过。
- v0.0.259 (2026-08-09) 完善富文本校对节点的模型选择和输入输出契约：向导统一展示当前账号可用模型，明确处理无模型和失效模型状态；`records` 支持上游结构化结果、JSON 和模板变量，字段说明与数值边界完整；运行时兼容 `model`/`modelId`/`model_id`，报告标题贯通摘要与产物，输出 Schema 覆盖统计、逐条问题、产物和警告。全量 Node 452/452、`npm run check` 与 `npm run lint` 通过。
- v0.0.258 (2026-08-08) 完成自动化工作流编辑、执行轮次和共享权限界面收口：资产中心可独立编辑工作流名称与简介，标准/深度/审查模式自动轮次统一为 30/60/50 并由前后端共同限制；工作流、工具库和知识库分享统一使用单位展开个人的目标树，单位联动个人、全选/全不选横向排列且保存时去除重复个人授权。新增共享目标树公共脚本、元数据测试和 CSS 优先级回归断言；全量 Node 447/447、安全智能体 52/52、Chat asset check 与 ESLint 通过。
- v0.0.257 (2026-08-07) 完成共享资源的个人授权和工作流接收者依赖闭环：工作流、知识库专题库与数据库 MCP 连接支持单位/个人白名单，统一列表、详情、检索、缓存和工具目录的可见性过滤；接收者可为共享工作流选择本账号可用的模型、工具和受控凭据，绑定固定到发布版本，重新发布后自动标记 stale 并阻断运行。直接 HTTP 敏感值在共享响应中脱敏，且禁止共享/发布；知识库写操作、MCP 服务器编辑和非只读工具调用在路由层拒绝。新增迁移、依赖配置面板、分享个人选择与隔离 HTTP/Playwright 回归；Node 446/446、HTTP 2/2、E2E 3/3 通过。
- v0.0.256 (2026-08-07) 完成自主任务执行治理和工作流编辑体验升级：保留最大执行轮次作为高级安全边界，但取消固定 10 轮默认值，改为标准模式自动 20 轮、深度/审查模式自动 50 轮，模板与计划任务用 `0` 持久化“自动”语义；流式工具调用与 JSON 回退共享总轮次，达到上限后保留已有结果、生成总结并明确标记可能不完整。修复快捷目标和保存模板无响应，补齐工作流直接重命名及节点名称失焦问题；Token 上限与上下文来源完成响应式并排布局。全量 Node 回归 438/438、项目检查、ESLint 和 E2E 2/2 通过。
- v0.0.255 (2026-08-06) 完成计划任务、工作流配置和新闻内容校对闭环：计划只能运行已发布工作流，按间隔调度支持 5 至 1440 分钟；节点应用操作提供即时反馈，保存后重新打开仍恢复手动配置；自由任务转工作流会生成数据库查询、富文本逐条校对和输出节点，清理 HTML 后按记录/分块校对并保留原文证据；结构化结果保留行边界，查询截断、分块失败和未处理记录会显式标记，完整报告沉淀为可下载产物。全量 Node 回归 437/437，项目检查和相关 ESLint 检查通过。
- v0.0.249 (2026-08-06) 完成知识库与工具库的单位共享权限升级：知识库专题库支持共享范围和单位白名单，文档列表、标签、摘要、详情、FTS/LIKE、检索缓存与 Graph-RAG 查询统一做可见性隔离；工具库数据库 MCP 连接支持单位共享，接收者仅可使用治理后的只读数据库工具，刷新、诊断和写管理操作均被阻断；前端补齐分享弹窗、只读状态、写操作过滤与可写专题库选择；新增旧库迁移字段和索引，MCP 33/33、RAG 75/75、Agent 48/48 专项回归通过。
- v0.0.248 (2026-08-06) 完成工作流共享权限前后端闭环：资产中心提供所有者共享弹窗和范围标识，管理员可选择全部有效单位、普通用户受限于自身单位；新增共享选项与共享设置更新 API，服务端保留所有者写权限并记录审计；共享工作流发布前不对接收者展示，接收者只读取发布版 DAG 并以只读画布运行，不能编辑、发布、回滚、删除、管理版本或创建计划。补充共享发布边界、只读交互和安全静态断言回归。
- v0.0.247 (2026-08-05) 完成阶段一至五的自动化闭环与数据访问底座：工作流单位可见性、发布版本降级、Webhook/文件/数据库触发器、Cron 解析、加密凭据、审批/延迟节点、IM 一次性签名回调和 `awaiting_approval` 队列挂起机制全部落地；新增 SQL 语句缓存、数据库方言辅助、raw SQL 基线以及 runs/workflows/sessions/knowledge 领域仓储。阶段五明确保持 SQLite 事务边界，不做 ORM 引入或一次性全量 SQL 迁移；全量 Node 回归 419/419，项目检查、ESLint、数据库启动迁移和 raw SQL 门禁通过。
- v0.0.246 (2026-08-04) 完成工作流输出模式与结构化交付体验升级：节点统一提供格式化文本、纯文本和结构化数据；JSON 输出绑定 JSON Schema，优先调用原生 Structured Outputs，失败自动降级并修复一次；新增可视化 Schema 编辑器、输出预览、示例校验和基于 Schema 的下游字段选择器；工作流输出增加表格与文件产物展示，底层继续使用 JSON 数据和文件引用；暂不引入 YAML/XML。全量 Node 回归 393/393、语法、ESLint、文本完整性、安全 HTML、window 全局和开发规范检查通过。
- v0.0.245 (2026-08-04) 完成自动化运行结果产品化与全界面中文化：自由任务和工作流运行详情改为结果优先，执行轨迹与技术字段按需折叠；工具输出支持多层 JSON、MCP `content` 包装和截断行数据的可读提取，数据库结果优先显示中文表格；自动化任务、工作流、计划任务、节点参数、质量评估和运行元数据统一中文化，桌面与移动端布局同步收口。内部协议保持兼容，智能体专项测试 47/47、JavaScript 语法检查 400/400、文本与安全 HTML 检查、改动文件 ESLint 和 E2E 2/2 通过。
- v0.0.244 (2026-08-04) 完成只读查询筛选与日期时间条件增强：筛选条件支持整组 AND/OR 关系并保存配置；读取字段后按 `date`、`datetime`、`timestamp`、`time` 类型切换专用输入控件，范围和日期列表条件分别提供起止选择器与逗号分隔输入；生成 SQL 时统一日期时间格式且不自动转换时区。新增查询构建器回归测试，项目检查、ESLint、Node 全量回归 386/386 和 E2E 2/2 通过。
- v0.0.243 (2026-08-04) 完成工作流数据库读取与桌面客户端布局收口：只读查询节点的表/字段按钮使用独立点击绑定并按所选数据库连接解析 MCP 工具，按钮附近持续展示触发、读取、成功和分类失败状态，明确服务端发起请求及 `localhost` 语义；预设节点列表增加受限高度和内部滚动；桌面端任务模板与“能力与结果”弹窗避让 30px 原生标题栏，内容高度按剩余视口计算，分割线移到内容区顶部且菜单文字层级调整。项目检查、E2E 冒烟和 1320×860 布局断言通过。
- v0.0.240 (2026-08-03) 完成聊天附件预览与自动化通知体验优化：图片附件改为稳定的缩略图卡片，明确展示读取中、待上传和预览不可用状态，避免浏览器破损图标及文件名误导；对象 URL 在 DOM 插入后再绑定，预览失败时仍保留附件并提示发送时上传；任务模板通知中心将工作流运行、智能体运行和审批相关历史英文状态统一转换为中文。新增专项回归测试，聊天渲染、智能体通知、资源检查和 ESLint 验证通过。
- v0.0.239 (2026-08-03) 完成会话输入区精简：移除清空输入框按钮，将模型选择器移动到输入框右侧、发送箭头左侧并收口为纯模型名称显示，保留列表中的能力说明和键盘操作；重构《使用帮助》为不含版本记录、管理员配置和实现细节的普通用户操作手册，版本同步脚本不再改写帮助文档，并新增文档职责门禁。桌面与 `390×844` 移动端实际页面验证、`npm run check`、`npm run lint` 和 `git diff --check` 通过。
- v0.0.238 (2026-08-01) 完成产品信息架构升级：左侧导航收口为单层搜索、应用、任务、自动化、知识库、工具库、最近会话和设置；全局搜索打通会话/任务/工作流，统一任务中心汇总三类运行记录，自动化首页改为工作流与计划资产中心，用户侧统一“工具库”和“自主任务”命名并移除“工具箱”输入兼容；完成移动端侧栏、任务筛选和搜索弹窗适配，`npm run check`、`npm run lint`、Node 回归 376/376、智能体安全回归 40/40 及桌面/移动端视觉检查通过。
- v0.0.237 (2026-07-31) 完成隔离局域网纯 HTTP 部署加固：统一 IPv4-mapped IPv6 出站判定、Electron 同源导航和 IPC 来源校验、refresh token 摘要与一次性轮换、健康/指标接口分层、主动内容治理、临时目录测试隔离及 Windows 打包瘦身；Electron 升级到 39.8.10，生产依赖审计 0 项，Node 回归 376/376、E2E 2/2 与 unpacked 打包通过。
- v0.0.236 (2026-07-31) 完成智能体工作台和工作流编排收口：去除重复入口、统一顶部命令区和已保存工作流选择器，移除用户侧提示词库，明确 `agent.delegate` / `agent.handoff` 语义，质量评测弹窗统一全局表单布局，新增只读 SQL 可视化查询构建器并保留高级 SQL；查询继续复用后端只读治理，SQL Server `TOP` 限流兼容问题已修复。
- v0.0.233 (2026-07-30) 正式汇总发布智能体产品化升级：结构化可读结果、稳定 DAG 布局、显式主大模型节点、Agent Trace、节点数据契约、发布治理、持久化检查点、质量评测中心、确定性回归基线、`agent.delegate`、结构化 `agent.handoff` 和 Supervisor 模板完整贯通；完成 1440px/390px 视觉验收与全仓 691 项回归。模型裁判、自动 CI 发布门禁、原生工具调用能力探测和角色级独立预算仍作为二期治理项。
- v0.0.232 (2026-07-30) 完成智能体质量评测与多智能体协作第一阶段：评测集、真实任务批量回归、确定性规则评分、历史基线对比、任务追踪回链、`agent.delegate`、结构化 `agent.handoff` 和 Supervisor 工作流模板落地；模型裁判、自动发布门禁与原生工具调用能力探测继续作为后续治理项。
- v0.0.231 (2026-07-30) 完成智能体可追踪、节点契约和检查点恢复：Agent Trace/Span 独立存储、敏感字段脱敏、运行详情时间瀑布、DAG 输入输出契约、运行时严格校验、预检覆盖率、发布门禁及持久化恢复状态落地；评测中心和多智能体交接仍按后续里程碑推进。
- v0.0.230 (2026-07-30) 完成工作流 DAG 布局持久化、主大模型节点显式化，以及自由任务/工作流结果的结构化可读展示。
- v0.0.229 (2026-07-26) 完成生产依赖高危清零、审计门禁、CI 全量校验与内置报表 CSV 中文乱码修复。
- v0.0.191–v0.0.228 (2026-07-05 ~ 2026-07-25) 按主题归并（逐版本明细见 CHANGELOG）：
  - **公文写作与文档处理**：公文写作分步化与审校体验重构；文档处理底座落地，文字识别/PDF 工具接入应用中心；OCR 彻底外置为独立服务并固化 HTTP 对接协议。
  - **工具库数据接入**：数据接入边界清晰化、SQLite 数据集导入、数据来源工作台、数据管理入口统一与卡片可读性修复。
  - **本机资源反向执行**：remote 模式下桌面端本机 SQLite/报表目录反向执行通道，授权中心、执行器诊断与打包态路径修复（v0.0.207–v0.0.216 连续收口）。
  - **桌面客户端**：自动更新接入 downloads 发布目录、离线局域网 HTTP 更新放行、顶部菜单与关于窗口重组、登录态过期自动回到登录页。
  - **API 兼容层**：推理模型代码补全修复，`/v1/completions` 参数、批量 prompt、多 choice、流式错误与诊断完整收口；Qwen3 增加 llama.cpp thinking 硬开关。
  - **工程规范**：开发规范门禁、中文提示/日志规范、设计规范重构（DESIGN.md 与专项方案拆分）。
- v0.0.190 (2026-07-04) 收口系统监控 AI 并发口径：区分全局保存配置上限与 GPU 临时保护下的当前有效上限，保存全局参数后清理监控摘要缓存，并补充并发/GPU/运行时设置回归测试。
- v0.0.189 (2026-07-04) 收口智能体“能力与结果”弹窗滚动问题：可用工具与结果沉淀改为独立受限面板，旧的 `overflow: visible` 兼容规则不再作用于弹窗，并通过 Playwright 布局指标与 `npm run check` 验证。
- v0.0.188 (2026-07-03) completes the actionable follow-up pass: `chat.ui` / `chat.attachments` module migration, stored RAG debug history and observability warnings, runnable Playwright E2E smoke tests, desktop update feed policy validation, and enterprise/multi-node schema plus provider placeholders.
- v0.0.187 (2026-07-03) completes the second-stage architecture pass: chat orchestration services, agent run state machine, RAG retrieval score and queue diagnostics, frozen `window.*` baseline guard, permission capability matrix, and deployment profile contract.
- v0.0.186 (2026-07-03) shipped the completed guardrails from the full-project optimization pass: guarded uploads, safe outbound HTTP, runtime settings cache invalidation, agent lock renewal, chat observability, Electron origin hardening, `Pivot.modules` migration helpers, safe HTML rendering, and CI checks for raw `innerHTML` usage.
- Remaining frontend state work should continue feature by feature: expose new APIs through `Pivot.exposeModule()`, move callers to `Pivot.modules.*`, then remove legacy `window.*` aliases once references are gone.

## Completed Guardrails

- Uploads use a shared guarded Multer wrapper with multipart limits, file-count limits, aborted-request cleanup, and magic-byte validation for both chat attachments and RAG documents.
- Server-side JSON HTTP calls are routed through `safe-http-client` or `model-forwarder`, which enforce SSRF checks, restricted agents, timeouts, `proxy: false`, and JSON-only payloads.
- Runtime settings use a short-lived in-memory snapshot and invalidate after admin saves.
- Agent queue workers renew running locks, validate run status transitions, record retry reasons, and expose active-run and oldest-queue-age metrics.
- Agent Trace stores user-scoped run spans for routing, model, tool, DAG and control operations; sensitive keys are redacted before persistence and run details render a responsive waterfall view.
- DAG nodes support persisted input/output contracts, runtime value validation, contract status in node history, preflight coverage metrics and publish-time blocking for invalid contracts or inaccessible tools.
- Agent runs persist bounded checkpoints after planning, tool, DAG and control steps; free-task resume restores successful observations and recent failures, while DAG resume reuses completed nodes.
- Agent evaluation suites execute real user-scoped runs, grade deterministic content/structure/performance rules, preserve historical cases, compare completed batches and link every result back to its trace.
- Multi-agent workflows can delegate isolated role-specific sub-tasks and emit structured Handoff payloads; the built-in Supervisor template creates parallel research/review branches with an explicit primary adjudication model.
- Chat generation is split into preflight, context assembly, model stream, and persistence services while emitting observability traces for slow or failed requests.
- RAG debug query responses expose chunk ids, dense/fused/FTS/MMR score components, selected chunks, hybrid weights, applied scope, and index queue state; debug queries are now stored in `rag_debug_queries` and surfaced in the debug modal history.
- 智能体“能力与结果”弹窗内容已使用受限面板，长工具列表和结果沉淀列表会在弹窗内滚动，不再向外撑开视口。
- Frontend code can migrate from loose `window.*` globals into `Pivot.registerModule()` / `Pivot.getModule()` incrementally; `chat.ui` and `chat.attachments` now publish module APIs with legacy global aliases during migration.
- Chat frontend rendering routes raw HTML updates through `PivotSafeHtml.setHtml()`, `npm run check:safe-html` blocks raw `innerHTML`, and `npm run check:window-globals` blocks new legacy `window.*` exposure.
- Active-content controls force HTML attachments to download with `nosniff`, route dynamic insertion through `PivotSafeHtml`, remove the print path's `document.write`, and scan `innerHTML`, `insertAdjacentHTML`, `createContextualFragment`, `document.write`, and `srcdoc` in CI.
- Refresh tokens are stored as SHA-256 digests and rotated transactionally; legacy plaintext rows migrate in place without invalidating active sessions, while registration has an independent per-IP rate limit.
- Public health checks expose no filesystem paths, detailed diagnostics require authentication and use a short cache, and Prometheus metrics are closed unless a bearer token or explicit isolated-LAN override is configured.
- Permission capability payloads now expose policy object types, data classification levels, and organization/team placeholders.
- Deployment profile payloads describe SQLite WAL single-node defaults, provider contract status, and the Postgres/object-storage/distributed-queue/distributed-lock prerequisites for multi-node mode.
- CI 使用 `npm run audit:policy` 拦截新增 high/critical 依赖告警；豁免必须登记理由与复查日期，到期自动失效，上游已有修复版本时一律不接受豁免（`tests/audit-policy.test.js` 覆盖该机制）。生产依赖当前无豁免项。
- CI 与本地 `npm test` 口径一致：`npm run check`（文本完整性、开发规范、语法、聊天资源、安全 HTML、window 全局、E2E 脚手架）+ `npm run lint` + `npm run test:all`（顺序运行全部测试套件，476 项测试 100% 全部通过）。
- E2E smoke coverage has a runnable Playwright path through `npm run test:e2e`；`npm run check:e2e-smoke` 保持脚手架检查。支持 `PIVOT_E2E_ISOLATED=true` 启用独立 PostgreSQL Schema、临时目录与随机端口隔离运行。
- 内置工具库（Built-in MCP）的分发层、格式转换、数据处理与报表目录授权边界已有回归覆盖（`tests/security-builtin-mcp.test.js`），含路径穿越、非白名单扩展名与 CSV 编码断言。
- 数据库持久化全面支持 PostgreSQL 生产级连接池、79 表元数据字典、参数占位符安全词法转换与原生 `pg_dump`（自定义格式、超时控制、环境变量凭据脱敏、版本/保留天数轮转）热备份体系。
- 系统 GPU 显存监控具备严格的水位递增校验与安全默认值回退（`normalizeGpuThresholds`），确保动态 AI 并发削峰填谷稳定运行。

## Next Architecture Milestones

> 状态标注：✅ 已完成 / 🔄 进行中 / ⏸ 有意暂缓 / ⬜ 未开始

1. Chat orchestration tests — ✅ 已完成
   - ✅ 路由级测试已覆盖额度拒绝、会话越权、模型缺失、RAG 命中与未命中、长期记忆命中、上下文自动裁剪、当前输入超限预检与流式中断持久化（`tests/security-chat/route-orchestration.js`，配套装置 `chat-route-harness.js`）。
   - ✅ 路由保持为薄 SSE 传输层，业务留在 `chat-preflight` / `chat-context-assembler` / `chat-persistence` 等服务中。

2. RAG quality and operations — 🔄 进行中
   - ✅ 存储化 debug 历史已落地（`rag_debug_queries` 与调试弹窗历史）。
   - ⬜ embedding 延迟趋势图未开始。
   - ⬜ 按集合的检索预设（法律、法规、公文、数据分析）未开始。
   - ⬜ 检索诊断尚未进入管理员可观测视图，目前仅在调试弹窗内可见。

3. Enterprise persistence path — ✅ 已完成
   - ✅ 生产环境全面升级至纯 PostgreSQL（PostgreSQL 14+/16+/17+），全链路 Repository 异步 Promise API 改造完成。
   - ✅ 79 张核心业务表原生中文元数据注释字典（`server/db/schema/comments.js`）及 `pgvector` / `pg_trgm` 扩展安装支持。
   - ✅ 原生 `pg_dump` 自定义格式热备份、超时控制、进程环境变量脱敏注入及按保留期与版本轮转清理完成。
   - ⬜ 跨多节点集群部署时，引入对象存储适配器与分布式任务队列/锁提供者。

4. Permission expansion — ⬜ 未开始
   - ⬜ 为模型、知识库集合、工具库服务与智能体工作流增加组织/团队归属表。
   - ⬜ 为模型使用、工具审批、数据分级、留存与审计导出实现策略对象。
   - ⬜ 超级管理员的破窗访问保持可审计，且对租户自有密钥默认关闭。

5. Frontend hardening — 🔄 进行中（存量未下降）
   - ⚠️ `window.*` 迁移自 v0.0.188 起长期停在 315/320：门禁只冻结了增量，存量未减少。建议改为「每个版本迁 1 个工作区」的配额制，否则不会自然开始。
   - ⬜ 按工作区逐个迁入 `Pivot.registerModule()`，调用方改用 `Pivot.modules.*` 后再移除旧别名。
   - ⬜ Playwright 覆盖仍只有 smoke 路径（2 个用例），需扩展到登录、聊天流式、上传、设置、知识库索引与核心工作台。
   - 说明：前端无构建链、4.3MB 静态资源 27 个 `<script>` 顺序加载，在内网部署且启用 compression 的前提下优先级低，不建议为此引入打包工具而牺牲「改完即生效」的运维简单性。

6. Desktop distribution — 🔄 进行中
   - ✅ Electron 沙箱默认开启。
   - ✅ Electron 38 → 39 主版本升级已完成，并通过 Windows unpacked 打包、ASAR 内容和原生模块打包链路验证（v0.0.237）。未来主版本仍按一次一版、完整回归的节奏推进。
   - ✅ 导航、重定向和特权 IPC 已绑定配置目标同源，适配私有 IP、IPv6 字面量与局域网主机名，不依赖域名或证书（v0.0.237）。
   - ✅ 无证书环境默认关闭自动更新；若在可信隔离局域网启用 HTTP 更新，需显式开关和精确来源白名单（v0.0.203/204/237）。
   - ✅ 打包排除历史安装器，正式发布生成 SHA-256 清单，支持受控离线分发（v0.0.237）。
   - ⬜ 为受信任的文档/更新域配置 `allowedExternalOrigins`。

7. Agent quality platform — 🔄 进行中
   - ✅ 运行追踪第一阶段已完成：Trace/Span、敏感字段脱敏、标准/流式/DAG 三路径采集和运行详情时间瀑布。
   - ✅ DAG 契约第一阶段已完成：输入/输出契约、运行时校验、预检覆盖率和发布阻断。
   - ✅ 评测中心第一阶段已完成：任务集、期望输出、确定性规则评分、真实任务批量运行、历史基线对比和 Trace 回链。
   - ⬜ 增加模型裁判、人工标注校准和可选的发布/CI 回归门禁，避免仅靠字符串与结构规则判断语义质量。
   - ✅ 持久化检查点第一阶段已完成：规划、工具、DAG 和控制步骤保存有上限的恢复状态，自由任务恢复观察，DAG 复用完成节点并从失败点继续。
   - ⬜ 将支持工具调用的模型默认迁移到原生 `tool_calls`，并记录能力探测与 JSON 规划器回退原因。
   - ✅ 多智能体 Supervisor/Handoff 第一阶段已完成：角色化委派、隔离上下文、结构化交接、并行研究/审阅模板、主裁决节点和 Trace 类型均已落地。
   - ⬜ 为多智能体节点补充独立预算分摊、角色级工具白名单和跨分支冲突检测；当前仍继承工作流总体权限、审批和预算边界。

## 已知技术债与判断

- **桌面构建链审计**：生产依赖与直接 Electron 运行时审计均为 0；完整 `npm audit` 的 16 项 high、0 项 critical 位于 electron-builder 间接构建链。尝试 `npm audit` 建议的降级版本会扩大到 28 项并引入 critical，因此保留 26.15.3 并等待上游修复，不以降级换取表面清零。
- **大文件治理**：`apps-workbench-editor.js` 1418 行、`rag-documents.js` 1251 行、`admin-settings.js` 1131 行超出《开发规范》3.1 的可维护边界。建议在下次改到这些文件时顺手按功能边界拆分，不做专项重构。
- **依赖跨主版本落后**：除 Electron 外，`express` 4→5、`better-sqlite3` 11→13、`mongodb` 6→7、`uuid` 11→14、`bcryptjs` 2→3 均为跨主版本升级，需按「一次一个、带回归」的节奏推进，不做批量升级。
- **同步文件 IO**：`server/routes` 与 `server/services` 中约 19 处 `readFileSync` / `writeFileSync`，需逐个确认是否落在请求热路径上；启动期与低频管理操作可保留。
- **内置工具库覆盖**：`builtin-mcp-visualization`、`builtin-mcp-documents`、`builtin-mcp-im` 的执行分支尚未覆盖，其中 IM 涉及内网出站通知，建议下一轮优先补齐。

## v0.0.241 自动化治理收口（2026-08-03）

本版本完成自动化计划的产品级可靠性收口：账号撤权会暂停计划并取消未完成运行；调度器使用租约与计划时段幂等键，保证崩溃恢复时不丢计划、不重复建任务；计划输入、模板和工作流关联由服务端严格校验；失败采用指数退避并记录错误；计划数量、账号级并发和自动化写操作均有边界；任务中心按计划 ID 查询历史运行。新增回归覆盖周日计算、非法计划输入、手动运行幂等和撤权后的调度隔离。

## v0.0.246 工作流输出模式与结构化交付体验升级（2026-08-04）

本版本将工作流输出从“能返回结果”提升为“可理解、可约束、可组合、可交付”：大模型和工作流输出节点统一展示“格式化文本、纯文本、结构化数据”三种模式；结构化模式可以绑定 JSON Schema，优先使用模型原生 Structured Outputs，端点不支持时降级为普通 JSON 请求，失败结果自动修复一次并返回契约校验原因。节点契约弹窗增加可视化字段编辑、嵌套对象、数组项、必填字段、JSON 高级编辑、输出预览和示例校验。下游输入向导根据 Schema 生成字段建议，并由运行时解析 `{{nodes.extract.output.customer.name}}` 等嵌套路径。工作流输出补充表格与文件产物展示：表格基于 JSON 行列渲染，文件只保存安全文件引用；内部不引入 YAML/XML。全量 Node 回归 `393/393`、语法、ESLint、文本完整性、安全 HTML、window 全局和开发规范检查通过。

## v0.0.245 自动化运行结果产品化与全界面中文化（2026-08-04）

本版本从普通用户理解任务结果的顺序重新设计自动化运行详情：状态、结果、耗时和必要操作成为首要信息，执行节点、治理规则、成本估算、模型参数、节点输入输出和原始载荷退到可展开的技术层。工具结果渲染链路会逐层解析普通对象、数组、多层或双重序列化 JSON、MCP `content` 包装及被截断的行数据，优先生成中文表格、指标和摘要，原始内容仅用于追溯。自动化中心、自由任务、工作流、计划任务、查询向导、质量评估和运行追踪的可见标签、状态、枚举与服务端提示统一中文化；工具和内部协议仍使用原始标识存储，保证历史数据和外部调用兼容。响应式布局补齐窄屏标题分行、稳定表格列宽和长内容换行，并以专项回归、语法、文本、安全 HTML、ESLint 和 Playwright 冒烟测试守住展示边界。

## v0.0.244 只读查询筛选与日期时间条件增强（2026-08-04）

本版本完善数据只读查询节点的条件编辑能力：筛选条件可以在整组 AND 与 OR 之间切换，默认保持原有 AND 行为并兼容历史字段名。读取表字段后，日期、日期时间、时间类型会自动启用对应的原生选择控件，`between` 使用起止值，`IN` 使用逗号分隔列表；日期时间生成 SQL 前统一为标准空格分隔格式，不隐式转换时区。查询构建器回归测试覆盖关系持久化、类型识别、控件值归一化和跨数据库 SQL 结果。

## v0.0.243 工作流数据库读取与客户端布局收口（2026-08-04）

本版本补齐只读数据库查询节点从连接选择到表/字段加载的完整反馈链路：按钮使用独立事件绑定，数据库工具解析为所选连接的完整工具名，请求中不再携带仅供前端选择使用的连接标识；服务端错误码、提示和诊断信息继续传递到节点配置界面，并按安全策略、拒绝连接、超时、认证失败、工具缺失和输入缺失分类显示。查询节点同时说明请求由 Pivot 服务端发起，避免把浏览器电脑的 `localhost` 误认为服务端可访问地址。工作流预设节点列表增加内部垂直滚动，长分类保持在视口内。桌面客户端的模态区域从 30px 原生标题栏下方开始，任务模板和“能力与结果”弹窗按剩余动态视口计算高度；分割线由标题栏底边移到内容区顶部，菜单行高度保持不变，菜单文字与业务标题形成清晰层级。

## v0.0.242 旧库迁移兼容性热修复（2026-08-04）

v0.0.241 的自动化索引曾在基础 schema 阶段创建，而历史数据库要到后续 legacy migration 才具备 `dedupe_key`、`dispatch_retry_at` 和 `claim_expires_at` 字段，导致升级启动在迁移前中断。v0.0.242 将依赖新增列的索引保留在字段补全后的幂等迁移阶段，基础 schema 只负责新表字段定义和不依赖迁移列的通用索引。新增历史自动化表启动快照覆盖该顺序，并用真实数据库完成一致性备份、迁移、二次启动及完整性检查；新建任务弹窗的桌面最大高度同步提升至 860px，减少常见视口中的正文滚动并保留窄屏保护；《使用帮助》移除已下线的“任务运行”章节，并按“搜索、应用、知识库、工具库、自动化”的首页导航顺序重排，同时补充产品定位、核心能力、工作方式选择和当前设置/知识库操作说明。GitHub Actions 基础 action 已切换到 Node.js 24 运行时，依赖审计锁定版本与 Windows 执行路径同步修复，避免新增漏洞或本地假通过绕过门禁。全量发布门禁与 Node 回归 `384/384` 通过。
