# Pivot Optimization And Extension Roadmap

This document records optimization work that is intentionally staged instead of forced into one risky rewrite.

## Release Snapshot

> 维护约定：本文件与 CHANGELOG、版本号同级维护。发布时若本轮涉及"有意分阶段推进/暂缓"的决策，必须在此登记，否则决策会随版本推进丢失。

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
- CI 与本地 `npm test` 口径一致：`npm run check`（文本完整性、开发规范、语法、聊天资源、安全 HTML、window 全局、E2E 脚手架）+ `npm run lint` + `npm run test:all`（顺序运行全部测试套件）。
- E2E smoke coverage has a runnable Playwright path through `npm run test:e2e`; `npm run check:e2e-smoke` keeps the E2E config, spec, dependency, and runner script present in lightweight checks.
- 内置工具库（Built-in MCP）的分发层、格式转换、数据处理与报表目录授权边界已有回归覆盖（`tests/security-builtin-mcp.test.js`），含路径穿越、非白名单扩展名与 CSV 编码断言。

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

3. Enterprise persistence path — ⏸ 有意暂缓
   - 判断依据：当前定位为私有化内网单机部署，SQLite WAL 足够支撑；在真正需要多节点前提前投入不划算。
   - ⬜ 先实现持久化适配器，再引入 PostgreSQL 承载会话、审计日志、智能体运行与可观测事件。
   - ⬜ 多节点部署前把上传与生成产物迁到对象存储适配器后面。
   - ⬜ 启用多实例时，用分布式提供者替换进程内锁与队列。

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
