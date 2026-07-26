# Pivot Optimization And Extension Roadmap

This document records optimization work that is intentionally staged instead of forced into one risky rewrite.

## Release Snapshot

> 维护约定：本文件与 CHANGELOG、版本号同级维护。发布时若本轮涉及"有意分阶段推进/暂缓"的决策，必须在此登记，否则决策会随版本推进丢失。

- 待发布（当前工作区）依赖安全与流水线收口：生产依赖高危项清零（`axios` 1.16.1→1.18.1、`js-yaml` 4.2.0→4.3.0、`sharp` 0.34.5→0.35.3、`body-parser` 补丁），`engines.node` 收紧为 `>=20.9.0` 以匹配 sharp 要求；审计门禁改为"豁免必须带理由与复查日期、到期自动失效"，并补 7 项门禁回归；CI 由只跑单一套件改为 `npm run check` + `lint` + `npm run test:all` 全量 673 项；修复内置工具箱读取不带 BOM 的 UTF-8 CSV 时中文乱码。
- v0.0.191–v0.0.228 (2026-07-05 ~ 2026-07-25) 按主题归并（逐版本明细见 CHANGELOG）：
  - **公文写作与文档处理**：公文写作分步化与审校体验重构；文档处理底座落地，文字识别/PDF 工具接入应用中心；OCR 彻底外置为独立服务并固化 HTTP 对接协议。
  - **工具箱数据接入**：数据接入边界清晰化、SQLite 数据集导入、数据来源工作台、数据管理入口统一与卡片可读性修复。
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
- Chat generation is split into preflight, context assembly, model stream, and persistence services while emitting observability traces for slow or failed requests.
- RAG debug query responses expose chunk ids, dense/fused/FTS/MMR score components, selected chunks, hybrid weights, applied scope, and index queue state; debug queries are now stored in `rag_debug_queries` and surfaced in the debug modal history.
- 智能体“能力与结果”弹窗内容已使用受限面板，长工具列表和结果沉淀列表会在弹窗内滚动，不再向外撑开视口。
- Frontend code can migrate from loose `window.*` globals into `Pivot.registerModule()` / `Pivot.getModule()` incrementally; `chat.ui` and `chat.attachments` now publish module APIs with legacy global aliases during migration.
- Chat frontend rendering routes raw HTML updates through `PivotSafeHtml.setHtml()`, `npm run check:safe-html` blocks raw `innerHTML`, and `npm run check:window-globals` blocks new legacy `window.*` exposure.
- Permission capability payloads now expose policy object types, data classification levels, and organization/team placeholders.
- Deployment profile payloads describe SQLite WAL single-node defaults, provider contract status, and the Postgres/object-storage/distributed-queue/distributed-lock prerequisites for multi-node mode.
- CI 使用 `npm run audit:policy` 拦截新增 high/critical 依赖告警；豁免必须登记理由与复查日期，到期自动失效，上游已有修复版本时一律不接受豁免（`tests/audit-policy.test.js` 覆盖该机制）。生产依赖当前无豁免项。
- CI 与本地 `npm test` 口径一致：`npm run check`（文本完整性、开发规范、语法、聊天资源、安全 HTML、window 全局、E2E 脚手架）+ `npm run lint` + `npm run test:all`（顺序运行全部测试套件）。
- E2E smoke coverage has a runnable Playwright path through `npm run test:e2e`; `npm run check:e2e-smoke` keeps the E2E config, spec, dependency, and runner script present in lightweight checks.
- 内置工具箱（Built-in MCP）的分发层、格式转换、数据处理与报表目录授权边界已有回归覆盖（`tests/security-builtin-mcp.test.js`），含路径穿越、非白名单扩展名与 CSV 编码断言。

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
   - ⬜ 为模型、知识库集合、工具箱服务与智能体工作流增加组织/团队归属表。
   - ⬜ 为模型使用、工具审批、数据分级、留存与审计导出实现策略对象。
   - ⬜ 超级管理员的破窗访问保持可审计，且对租户自有密钥默认关闭。

5. Frontend hardening — 🔄 进行中（存量未下降）
   - ⚠️ `window.*` 迁移自 v0.0.188 起长期停在 315/320：门禁只冻结了增量，存量未减少。建议改为「每个版本迁 1 个工作区」的配额制，否则不会自然开始。
   - ⬜ 按工作区逐个迁入 `Pivot.registerModule()`，调用方改用 `Pivot.modules.*` 后再移除旧别名。
   - ⬜ Playwright 覆盖仍只有 smoke 路径（2 个用例），需扩展到登录、聊天流式、上传、设置、知识库索引与核心工作台。
   - 说明：前端无构建链、4.3MB 静态资源 27 个 `<script>` 顺序加载，在内网部署且启用 compression 的前提下优先级低，不建议为此引入打包工具而牺牲「改完即生效」的运维简单性。

6. Desktop distribution — 🔄 进行中
   - ✅ Electron 沙箱默认开启。
   - ✅ 生产更新源要求 HTTPS；离线局域网 HTTP 需显式开关加来源白名单（v0.0.203/204）。
   - ⏸ **Electron 主版本升级仍未评估**：v0.0.191 因「避免未经桌面启动、打包和原生模块验证的破坏性升级混入生产依赖修复」而暂缓，当时约定「后续按桌面运行时升级单独评估」，至今未执行。当前 electron 38 已落后 5 个大版本（最新 43），属于桌面端最大的一笔技术债，需要单独排期并完整验证启动、打包、原生模块（better-sqlite3 / sharp / duckdb）与自动更新。
   - ⬜ 为受信任的文档/更新域配置 `allowedExternalOrigins`。

## 已知技术债与判断

- **大文件治理**：`apps-workbench-editor.js` 1418 行、`rag-documents.js` 1251 行、`admin-settings.js` 1131 行超出《开发规范》3.1 的可维护边界。建议在下次改到这些文件时顺手按功能边界拆分，不做专项重构。
- **依赖跨主版本落后**：除 Electron 外，`express` 4→5、`better-sqlite3` 11→13、`mongodb` 6→7、`uuid` 11→14、`bcryptjs` 2→3 均为跨主版本升级，需按「一次一个、带回归」的节奏推进，不做批量升级。
- **同步文件 IO**：`server/routes` 与 `server/services` 中约 19 处 `readFileSync` / `writeFileSync`，需逐个确认是否落在请求热路径上；启动期与低频管理操作可保留。
- **内置工具箱覆盖**：`builtin-mcp-visualization`、`builtin-mcp-documents`、`builtin-mcp-im` 的执行分支尚未覆盖，其中 IM 涉及内网出站通知，建议下一轮优先补齐。
