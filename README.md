# Pivot (智枢) —— AI 智能中枢管理系统

![版本](https://img.shields.io/badge/%E7%89%88%E6%9C%AC-0.0.50-%2310b981)
![授权](https://img.shields.io/badge/%E6%8E%88%E6%9D%83-%E5%85%A8%E6%A0%88%E7%89%88-blue)

**Pivot (智枢)** 是一款面向私有化、离线化和企业内网场景的全栈 AI 对话与智能体工作平台。系统集成多模型接入、知识库检索、MCP 工具调用、智能体任务、第三方 OpenAI-compatible API、审计日志、系统监控、数据维护和企业级权限治理能力，目标是在可控环境中提供稳定、安全、可审计的 AI 工作入口。

> 普通用户使用说明请阅读 [Pivot 用户使用手册](使用手册.md)。部署后也可在前端左下角点击“手册”，在应用内打开同一份手册内容；直接访问 `/manual` 仍可独立查看。

## 最新版本：0.0.50

### v0.0.50 更新摘要

- **`auto-escalate` 成本升级策略**：路由策略新增第 6 项，先用最便宜模型尝试，合成最终答案后启发式判定置信度（空输出/过短/异常 finishReason/低置信短语），不达标时升级到更强模型重新合成；前端模板下拉同步增加该选项。
- **路由工具增强**：`server/services/model-router.js` 新增 `assessConfidence` 与 `pickEscalationModel` 两个工具函数，支持中英文低置信短语识别。
- **验证**：新增 3 项单测，`npm test` 通过 `99/99`，`npm run check` 全部 103 文件通过。

### v0.0.49 更新摘要

- **agent-runtime 接入流式 function calling**：在 `runAgent` 主循环新增可选的流式 `tool_calls` 协议分支，配合 v0.0.48 的累加器与 `callModelStreamingWithTools` API；每轮规划与工具调用都会写入 `agent_steps`，审计完整保留。
- **环境变量开关**：默认 `AGENT_STREAMING_TOOLS=false`，所有现有任务行为零改动；置为 `true` 才启用流式分支，任何流式失败自动回退到旧回合制 JSON 协议，确保任务能完成。
- **DAG 任务不受影响**：`run_mode = 'dag'` 永远走原有图调度，不会被流式工具替换。
- **验证**：`npm run check` 全部 103 文件通过，`node tests/security.test.js` 维持 `96/96`。

### v0.0.48 更新摘要

- **流式 function calling 基础设施**：新增 `server/services/streaming-tools.js` 纯函数累加器，按 OpenAI streaming tool_calls 协议累加多工具 `arguments` 与 assistant `content`；`finalize()` 返回结构化结果（含解析后的参数与 parseError 降级字段），兼容 legacy `function_call` delta。
- **agent-model 新增 `callModelStreamingWithTools` API**：基于 `axios stream` + `createSseEventParser` 实现流式调用，复用现有全局/端点并发保护与失败统计；当前**不替换** `callModelText`，agent-runtime 主循环维持回合制 JSON，未来可通过环境变量渐进启用。
- **验证**：新增 7 项 streaming-tools 单测，`npm test` 通过 `96/96`，`npm run check` 全部 103 文件通过。

### v0.0.47 更新摘要

- **智能体 DAG 可视化编辑器**：新增 `client/chat/agents-dag-editor.js`（纯原生 SVG + 拖拽，零依赖），节点可拖动、出端口拖到入端口即创建依赖；工具栏提供"添加节点 / 自动布局 / 从 JSON 同步"；选中节点后弹出详情面板编辑标题、工具、条件、输入 JSON 与依赖；与原 `#agent-dag-spec` textarea 双向同步，JSON 视图改为折叠 details，普通用户不再面对原始 JSON。
- **CSS 与集成**：`styles/workspaces/agent.css` 末尾追加约 180 行编辑器样式（网格画布背景、节点/边/端口/选中态、详情面板栅格表单、依赖胶囊），兼容暗色模式；`agents.js` 在 `loadAgentTools()` 后自动挂载编辑器。
- **验证**：`npm run check` 全部 102 文件通过，`node tests/security.test.js` 维持 `89/89`。

### v0.0.46 更新摘要

- **智能体模型路由策略**：新增 `server/services/model-router.js`，提供 5 种策略 —— `fixed`（固定）、`auto-vision`（视觉优先）、`auto-context`（上下文匹配）、`auto-cost`（成本优先）、`auto-load`（负载均衡）；智能体任务启动时按 `model_router` 字段自动选模，命中时写入 `chosen_model_id` 并在步骤记录中标注路由理由，回退安全。
- **DB 扩展与前端入口**：`agent_templates` 与 `agent_runs` 新增 `model_router` 字段（默认 `fixed`，对旧任务零影响）；智能体工作台"MCP 审批"旁新增"模型路由"下拉，模板加载/保存自动透传策略选择。
- **接口**：新增 `/api/agents/model-routers` 公开策略元数据，供前端下拉填充。
- **验证**：新增 5 项单测，`npm test` 通过 `89/89`，`npm run check` 全部 101 文件通过。

### v0.0.45 更新摘要

- **RAG 召回测试可视化**：调试弹窗新增关键词高亮、得分进度条、按文件聚合的"命中 / 峰值 / 均值"汇总条；`/api/rag/debug-query` 接口返回检索耗时。
- **会话 PDF 导出**：新增 `/api/sessions/:id/print` 打印友好视图（带 CSP nonce），用户在浏览器内按 Ctrl/Cmd+P 即可导出 PDF；会话菜单新增"打印 / 导出 PDF"入口，无需引入服务端重型依赖。
- **验证**：`npm run check` 全部 100 文件通过，`node tests/security.test.js` 通过 `84/84`。

### v0.0.44 更新摘要

- **`window.Pivot` 全局工具命名空间**：新增 `client/chat/pivot-core.js`，集中提供节流、防抖、rafThrottle、LruCache、formatBytes / formatNumber、chooseStreamInterval 等小工具，向前兼容现有 `window.*` 全局函数，新代码可统一从 `window.Pivot` 调用。
- **流式 Markdown 自适应节流**：聊天流式渲染按累计内容长度阶梯式调整刷新间隔（80 / 140 / 220 / 320ms），长回答中 `marked.parse` 的重排开销显著下降，无明显视觉延迟。
- **验证**：`npm run check` 全部通过，`node tests/security.test.js` 维持 `84/84`。

### v0.0.43 更新摘要

- **LRU / TtlCache 工具**：新增 `server/cache.js`，提供带容量上限和 TTL 的 LRU 与懒清理 TtlCache；服务端 `dirSizeCache` 改用 LRU，避免内网长期常驻部署的目录尺寸缓存无限增长。
- **MCP 调用日志脱敏**：新增 `redactSecrets` / `maskSecretString`，MCP 调用日志的 input/output 在写入审计表前自动屏蔽 `api_key`、`Bearer`、`sk-*`、JWT 等敏感字段，避免落入合规导出包。
- **后台任务超时与并发治理**：新增 `withTimeout` / `KeyedConcurrencyGuard` / `TimeoutError`；`compressMemory` 接入超时（默认 60s）与会话级去重，全局并发上限可调；GPU 监控、模型端点监控、智能体任务恢复等启动失败改为带日志告警，不再静默吞错。
- **MCP 审批服务端二次校验**：移除 `agent-runtime` 中的 `metadata.approval === 'all_mcp_approved'` 死分支，只承认通过 `approveAgentTool` 写入的工具白名单。
- **智能体运行时拆分**：从 1978 行的 `agent-runtime.js` 拆出 `agent-validators.js`（常量与所有 normalize* 函数），主文件减少约 200 行，对外导出表完全保持。
- **回归测试加固**：新增 9 项基础设施单测，`npm test` 通过 `84/84`。

### v0.0.41 更新摘要

- **普通用户使用手册**：新增独立 [Pivot 用户使用手册](使用手册.md)，按登录、对话、附件、知识库、MCP、智能体、模型配置、API Key、状态排查、常见问题和安全建议组织，聚焦普通用户操作指导。
- **前端手册入口**：左下角用户区新增“手册”入口，在应用内工作区打开同一份手册内容，用户不需要切换到新标签页查找文档。
- **Docker 部署可用性**：服务端新增 `/manual` 与嵌入版 `/manual?embed=1` 渲染页面，直接读取根目录 `使用手册.md`；检查脚本会校验手册文件、前端入口和 `.dockerignore`，避免 Docker 镜像部署后手册缺失。
- **侧栏用户区优化**：左下角用户名称、手册、设置和退出保持紧凑单行布局；系统管理员标识改为小盾牌图标，仅内置 `admin` 账号显示，长名称保留悬浮完整提示。
- **文档与版本同步**：版本升级至 `v0.0.41`，`package.json`、`package-lock.json`、前端版本兜底值、README 与 CHANGELOG 已同步；`npm run check` 已通过。

### v0.0.40 更新摘要

- **监控与模型状态优化**：GPU 与并发保护区的利用率按比例正确显示，模型端点状态只保留当前启用配置，删除和历史残留端点不再占位。
- **MCP 工作台优化**：已缓存工具改为紧凑卡片网格，MCP 调用记录按服务归属展示，类型下拉顺序和空态布局都更顺手。
- **智能体工作台修复**：智能体模型选择与主页面一致，修正模型文案乱码，补齐高风险审批、任务重跑约束、模板/计划删除、DAG 续跑和导出内容。
- **模型弹窗紧凑化**：新增与编辑模型弹窗压缩了标题、说明、输入框、行距和按钮高度，更适合密集配置。
- **知识库与智能体复核**：确认知识库上传、索引、调试检索、质量报告，以及智能体运行、预检、模板、计划、产物、知识库工具调用链路完整可用。
- **文档与版本同步**：版本升级至 `v0.0.40`；`npm run check`、`node tests/security.test.js` 已通过。

### v0.0.39 更新摘要

- **权限与输入工具修复**：完成超级管理员、管理员、普通用户三类权限复核；普通用户和管理员均可在聊天输入框点击启用知识库与 MCP，按钮改为点击变色选中，不再使用复选框视觉。
- **MCP 模块升级**：新增报表与数据文件、可视化图表、报告编排、局域网消息通知四类内置 MCP；数据库 MCP 增强局域网连接诊断，MCP 治理区压缩为紧凑状态条。
- **组合式报告工作流**：支持按“数据库/文件取数 → 图表/表格展示 → 固定格式报告 → 内网消息通知”拆分为独立 MCP server 后自由组合，适合数据表分析和固定报告生成。
- **界面与监控优化**：修复左侧面板宽度随标题字数变化的问题；GPU 区域只展示 Pivot 部署服务器本机 GPU 与并发保护，同服务器模型可通过本机别名识别为本地端点。
- **文档与版本同步**：版本升级至 `v0.0.39`；`npm test` 已通过，安全测试 `73/73`。

### v0.0.37 更新摘要

- **主工作区与监控页优化**：搜索、设置、MCP、知识库和智能体保持右侧主工作区展示；系统监控页改为明确区域布局，慢查询与异常告警完整显示并减少不必要的纵向滚动。
- **权限模型收口**：普通用户和非内置 `admin` 管理员可使用自己的 MCP、知识库、搜索、系统设置和智能体配置；内置用户名 `admin` 保留全局/共享/审计能力。
- **MCP、知识库、智能体治理增强**：新增 MCP 调用日志与治理概览、知识库质量报告、智能体任务预检，并记录智能体触发的 MCP 调用来源。
- **局域网数据库 MCP 适配**：数据库 MCP 默认允许个人连接局域网数据库；如需恢复旧限制，可设置 `MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN=true`。
- **文档与版本同步**：版本升级至 `v0.0.37`；`npm test` 已通过，安全测试 `64/64`。

### v0.0.36 更新摘要

- **智能体模板展示优化**：优化了模板库中时间相关数据的可读性，解决了长日期截断问题。
- **系统设置界面精简**：移除了设置面板冗余的 Logo 和标题，取消了侧边栏分类标签，提升了视觉清爽度。
- **文档与版本同步**：版本升级至 `v0.0.36`；`npm run verify` 已通过。

### v0.0.35 重点能力

- **对话分支 / Fork**：可从任意消息分叉出新会话，复制该消息之前的上下文，适合方案推演、改写和审查分路线探索。
- **智能体结果版本管理**：沉淀结果支持版本、备注、对比和回滚，方便把智能体输出作为可维护的内部资产。
- **慢查询与异常告警**：记录慢 SQL、模型端点慢响应和 RAG 慢检索，系统监控页可配置 webhook 告警。
- **智能体 DAG 编排**：新增 DAG 运行模式，可用 JSON 定义依赖节点、条件跳过和并行工具调用。
- **插件化能力市场**：内置工具、MCP 服务和数据库连接会抽象为可启停能力包，普通对话和智能体会按能力包状态过滤可用工具。

### v0.0.34 重点能力

- **侧栏轻量化**：搜索入口改为与知识库、MCP、智能体一致的侧栏按钮，移除会话列表上方常驻搜索、归档和批量工具条。
- **会话搜索弹窗升级**：搜索弹窗支持标题、消息内容和 `#标签` 检索，当前/归档视图等高，批量标签操作迁移到弹窗内。
- **会话结果交互统一**：搜索结果标签显示在标题前方，标题与消息条数同一行，悬停显示三点菜单并复用主会话操作。
- **侧栏底部与工作区细节**：管理员标识、设置和退出恢复同排布局；知识库、MCP、智能体和系统设置保持主工作区展示与统一关闭按钮样式。

### v0.0.33 重点能力

- **局域网部署优化**：根路径页面复用预加载模板，智能体队列改为数据库锁抢占，支持多实例协同、锁超时恢复和运行状态统计。
- **监控与维护性增强**：修正 Prometheus 直方图累计 bucket 输出，统一 logger 导出，抽出智能体模型调用层和正整数环境变量解析工具，并复用会话消息查询 SQL。
- **实时事件推送**：新增 `/api/events` SSE 通道，智能体任务状态、步骤变化、审批和通知会主动推送；断线或受限内网环境会自动回退轮询。
- **附件在线预览**：聊天消息附件和附件库支持统一预览窗，图片、PDF、文本、Markdown、CSV、JSON 可直接查看。
- **会话标签治理**：支持标签汇总、多标签筛选、标签重命名/删除，以及会话批量加标、移除标签、替换标签；默认会话列表样式保持不变，点击“批量”后才进入选择模式。
- **设置页工作区化**：系统设置改为与知识库、MCP、智能体一致的右侧主区域视图，顶部提供“返回对话”，不再以遮罩弹窗占据页面。
- **合规审计包**：管理员可导出 `pivot_compliance_audit.zip`，集中包含会话清单、审计日志、模型用量明细和模型费用统计，适合局域网离线留存。
- **模型费用统计**：模型配置增加输入/输出百万 Token 单价与币种，用量页和导出报表同步展示估算成本。
- **安全与验证**：新增文本完整性检查并收紧前端 CSP；当前 `npm run verify` 已通过，安全测试通过 `64/64`。

## 审查报告优化补充

- **局域网多实例稳定性**：智能体任务队列改为数据库锁抢占，支持多实例协同、锁超时恢复和运行状态统计，适合内网服务器横向部署或服务重启恢复。
- **服务端性能与监控**：根路径复用预加载 HTML 模板，减少同步磁盘读取；Prometheus 直方图恢复累计 bucket 输出，便于接入内网监控平台。
- **代码维护性**：统一 logger 导出、复用消息查询 SQL、抽出智能体模型调用层，并用 `server/number.js` 收拢环境变量正整数解析逻辑。
- **升级可追踪性**：新增 `schema_migrations` 迁移记录，`migrate.js` 保留历史兼容迁移并标注后续结构升级边界。

## 功能扩展补充

- **智能体实时事件推送**：`/api/events` 提供登录用户级 SSE 实时通道，智能体任务状态、步骤变化和通知会主动推送到前端工作台，减少内网页面长时间轮询。
- **断线兜底**：浏览器不支持 EventSource 或实时连接断开时，前端会自动回到原有轮询刷新，保证旧环境和受限内网代理仍可使用。
- **权限隔离**：实时事件按用户订阅和投递，任务与通知只会发送给所属用户。
- **附件在线预览**：聊天消息中的附件卡片和后台附件库支持统一预览窗，图片、PDF、文本、Markdown、CSV、JSON 可直接查看，其他格式保留新标签打开。
- **会话标签治理**：会话列表支持标签汇总、多标签筛选、标签重命名/删除和批量加标/移除/替换，默认保持原列表样式，进入批量模式后才显示选择控件，便于局域网团队按项目、部门、风险等级或审计事项整理历史会话。
- **合规审计包**：管理员可导出 `pivot_compliance_audit.zip`，集中包含会话清单、审计日志、模型用量明细和模型费用统计，适合内网离线留存、抽查和交付审计。
- **模型费用统计**：模型配置增加输入/输出百万 Token 单价与币种，用量页和导出报表会同步展示估算成本，方便在多模型、多部门场景下核算内网资源开销。

## 近期基础能力

- 内置应用级 SQLite 热备份：维护服务默认每 24 小时调用 `db.backup()` 生成东八区毫秒级时间戳备份到 `data/backups/`，并按保留天数和版本数量滚动清理。
- 后台维护闭环增强：软删除附件、知识库源文件、知识库分块、FTS 索引和历史消息会在保留期后被物理清理，并配套执行 `PRAGMA optimize` 与增量 vacuum。
- 第三方 API 网关补齐向量转发：持有 Pivot API Key 的客户端可通过 OpenAI-compatible `/v1/embeddings` 调用当前用户可用的 RAG 向量模型。
- 知识库中文文件名修复：上传入口统一规范化文件名，保留正常中文并修复 latin1 mojibake，避免知识库列表中文档名称显示乱码。
- 前端 CSP 治理推进：`client/chat` 清除内联事件，模型、提示词、附件、API Key、会话菜单和工作台操作均采用事件委托。
- 会话列表采用游标分页，减少创建、置顶或更新会话时滚动列表出现重复或跳页。
- PWA 更新机制收紧：Service Worker 只缓存稳定 vendor 资源，业务页面、脚本、API 与版本清单交回服务端和浏览器处理。
- 用户删除聊天消息、会话、附件、知识库文档和智能体任务时采用软删除，保留审计日志、用量统计、用量明细和资产元数据。
- 第三方 API Key 调用新增请求与响应留痕，仅内置 `admin` 超级管理员可在 API 接入管理页查看和检索。
- 管理端数据表、Token 单位、模型配置布局、审计报表时间筛选和 API Key 输入/输出 Token 统计持续统一。

## 核心特性

### 1. 对话与多模型

- **多模型接入**：支持 OpenAI-compatible Chat Completions / Responses 风格的上游模型接入，可配置 Base URL、API Key、模型 ID、温度、最大输出 Token、每日额度和端点并发。
- **模型可见性**：支持全局模型、部门可见模型和用户私有模型；用户私有模型只对所有者可见，智能体和计划任务不会越权使用其他用户私有模型。
- **模型能力标识**：模型配置、模型列表、聊天下拉和智能体模型选择器展示文本、视觉、推理等能力图标。
- **模型探测**：支持一键获取上游服务模型列表，减少手工配置成本。
- **模型端点保护**：支持端点并发上限、健康检查 URL、排队与熔断保护；用户排队时会看到前方等待数、当前生成占用数和最长等待时间。
- **Token 统计**：网页聊天、智能体、RAG embedding 和第三方 API 调用统一计入模型每日额度、后台报表和 Prometheus 指标。

### 2. 智能体工作台

- **目标拆解**：智能体可把复杂目标拆解为多步骤任务，按需调用知识库、会话检索、最近会话、模型列表、系统健康和 MCP 工具。
- **运行模式**：支持标准、深度、审查和 DAG 编排模式，规划提示会根据模式调整检索深度、证据约束、风险表达和依赖图执行方式。
- **工具范围控制**：支持仅内置工具、内置 + MCP、工具白名单、能力包启停和管理员工具隔离。
- **MCP 审批**：高风险 MCP 调用可挂起等待用户批准或拒绝，数据库只读 MCP 可按策略安全执行。
- **预算与重试**：支持 Token 预算、失败重试、任务运行超时、单次工具调用超时和运行心跳检测。
- **任务审计**：任务详情保留目标、模型、步骤、工具输入输出、错误信息、Token 用量、耗时和最终结果。
- **DAG 编排**：DAG 模式支持 JSON 定义节点依赖、条件表达式、并行工具调用和聚合节点，从线性步骤扩展到可治理流程。
- **模板库**：可保存常用目标与运行参数，形成个人或共享模板。
- **计划任务**：支持每日、每周和手动计划，服务端定时扫描到期计划并入队执行。
- **通知中心**：任务完成、失败、停止、等待审批、计划入队和结果沉淀均会生成用户级通知。
- **结果沉淀**：任务最终答案或错误摘要可保存为结果资产，并支持版本备注、差异对比和回滚。
- **断点续跑**：失败或中断任务可基于上一轮状态、错误和最近步骤继续执行，避免只能从头重跑。

### 3. MCP 工具接入

- **外部 MCP Server**：支持配置个人或全局 MCP Server，保存服务后可刷新工具缓存，并供普通对话和智能体任务调用。
- **数据库 MCP Server**：内置数据库 MCP 预设，通过可视化表单填写类型、主机、端口、数据库名、用户名、密码、Schema、SSL 和最大返回行数。
- **局域网数据库连接**：默认允许用户连接自己的局域网数据库；如需恢复旧限制，可在服务端环境变量中设置 `MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN=true`。
- **报表与数据文件 MCP**：可配置局域网目录或共享目录，只负责列出、摘要读取、抽样查询和对比 CSV、Excel、JSON、Markdown 等报表/数据文件。
- **可视化图表 MCP**：从上一步返回的数据行生成 `pivot-chart` 或 `pivot-table` 结构化展示块，用于普通对话和报告结果中的图表、表格展示。
- **报告编排 MCP**：接收摘要、指标、表格和图表块，按固定章节模板组装 Markdown 报告，适合数据库表分析、月报、巡检报告等固定格式输出。
- **局域网消息通知 MCP**：对接内网即时聊天工具的 Webhook/API，按白名单用户或群组发送文本/Markdown 通知，不依赖微信、钉钉等外部平台。
- **组合式流程**：数据库、报表文件、可视化、报告编排和消息通知彼此独立，未来可按业务需要自由组合，而不是把完整流程固化在一个 MCP server 中。
- **统一数据库入口**：数据库类型作为连接字段选择，不再按数据库种类拆成多个工具入口。
- **支持数据库类型**：PostgreSQL、MySQL/MariaDB、SQL Server、SQLite 和 MongoDB。
- **只读安全边界**：SQL 数据库提供表列表、结构查看和只读查询；MongoDB 提供集合列表、样本读取和聚合读取。
- **SQL 限制**：只允许单语句读取类 SQL，例如 `SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`，写入、DDL 和管理类关键字会被拦截。
- **SQLite 路径约束**：SQLite 文件路径限制在允许目录内，并以只读方式打开。
- **连接测试**：新增测试连接按钮，保存或编辑前可确认数据库连接是否可用。
- **工具缓存**：刷新服务后展示已缓存可调用工具，工具名称和说明尽量使用中文语义。
- **能力包市场**：内置工具、外部 MCP Server 和数据库 MCP 连接会同步为能力包，可按用户权限启停，并影响普通对话、智能体工具列表和 MCP 工具调用。

## 插件化能力市场使用说明

当前能力市场是内置能力包管理，不是联网下载插件商店。系统会自动把以下能力同步成可管理包：

- 内置智能体工具：知识库检索、会话检索、最近会话、知识库列表、模型列表、系统健康、模型运行态等。
- 已配置并可见的外部 MCP Server。
- 数据库 MCP 连接，例如 PostgreSQL、MySQL/MariaDB、SQL Server、SQLite 和 MongoDB。

使用方式：

1. 进入左侧 **智能体** 工作台。
2. 展开 **能力与结果**。
3. 在 **能力清单** 上方查看能力包，并切换启用或停用。
4. 停用后，该能力会从智能体可用工具、普通对话 MCP 工具候选和 `/api/mcp/tools/call` 调用中被过滤或拒绝。
5. 新增或刷新 MCP Server、数据库连接后，重新打开或刷新智能体工作台即可同步看到对应能力包。

权限规则：

- 全局内置能力包只有内置 `admin` 可以启停。
- 用户自己的 MCP Server 和数据库连接能力包可由拥有者启停。
- 管理员专用内置能力普通用户不可见。

相关接口：

- `GET /api/capabilities/packages`：查看当前用户可见能力包。
- `PUT /api/capabilities/packages/:key`：启用或停用能力包，请求体示例为 `{ "enabled": false }`。

### 4. RAG 知识库与中文检索

- **正式工作台**：知识库作为正式功能接入左侧工具入口，整合文档列表、RAG 配置、召回测试、删除审计、批量重建、批量删除、失败重试和上传文档。
- **普通对话接入**：聊天输入区提供知识库开关，用户可按本轮问题决定是否检索私有文档。
- **智能体接入**：智能体可按目标调用知识库检索、知识库文档列表和相关上下文。
- **索引状态**：文档记录状态、分块数、已索引分块、进度百分比、错误信息和处理时间；服务重启后会恢复处理中任务。
- **召回测试**：可临时调整相似度阈值、Top K 和候选数量，展示命中文档、分块、相似度分数和命中状态；测试期间按钮禁用并显示加载状态。
- **反馈闭环**：召回结果可提交“有用/无用”反馈，便于分析低质量文档和低命中查询。
- **中文 ngram**：索引时生成中文 1-3 gram token，改善 `unicode61` 对中文短词、单字和词组召回不足的问题。
- **候选预过滤**：`knowledge_chunks_fts` 通过触发器同步分片检索内容，减少向量相似度计算候选数量。
- **结果缓存**：RAG 检索结果支持 TTL 缓存，同一用户重复问题可减少 embedding 调用和数据库排序开销。
- **Embedding 配置**：管理员可维护系统默认向量配置，普通用户可维护个人配置；云端、本机和局域网向量服务均通过 HTTP 接入。
- **兼容端点**：支持 OpenAI compatible `/v1/embeddings` 以及 Ollama 常用 `/api/embed`、`/api/embeddings`。

### 5. 效率工具集

- **FTS5 全文搜索系统**：集成 SQLite FTS5 毫秒级检索引擎，支持海量历史消息的关键词搜索，并通过触发器同步索引。
- **指令中心**：内置常用 Prompt 模板，支持 AI 角色和 System Prompt 一键切换。
- **会话管理**：支持多轮会话、置顶、归档、多标签、搜索、导出 Markdown 和软删除审计。
- **重新回答**：支持一键丢弃错误输出，并结合最新上下文重新生成回答。
- **多模态附件**：聊天会话支持上传图片、PDF、Word、Excel、TXT、Markdown、CSV 等文件，并尽量在上传阶段抽取可读文本。
- **PWA 应用**：支持作为独立应用安装到桌面或移动端，稳定 vendor 资源可缓存，业务页面保持及时更新。

### 6. 系统运营监控

- **实时运营面板**：展示系统活跃度、用量趋势、模型调用、Token 消耗和核心资源状态。
- **健康检查**：`/api/health` 返回数据库、数据目录、上传目录、内存和磁盘检查结果。
- **维护状态**：系统监控面板展示最近维护任务成功时间、处理条数和错误信息。
- **RAG 指标**：暴露 RAG 检索次数、缓存命中、候选数量、命中数量、Top Score 和检索/入库耗时。
- **Prometheus 指标**：便于接入企业监控体系。
- **GPU 监控**：支持读取 Pivot 所在服务器的 GPU 使用情况；远端模型 GPU 负载需通过远端健康接口或模型端点监控补充。
- **端点状态**：展示模型端点健康探针、并发、排队、失败次数和熔断状态。

### 7. 安全、存储与审计

- **超级管理员边界**：只有内置用户名 `admin` 是超级管理员；普通管理员不能创建全局模型、全局 Prompt、全局 MCP 服务，也不能管理其他管理员账号。
- **资产确权隔离**：上传文件按用户和会话路径隔离存储，附件访问令牌绑定用户、会话和文件路径，并带过期时间。
- **软删除治理**：聊天、附件、知识库文档和智能体任务均采用软删除策略；内置 `admin` 可查看删除审计入口。
- **全链路审计日志**：记录敏感操作、IP 地址、用户、对象和操作详情，支持筛选与导出。
- **第三方 API 留痕**：API Key 调用记录请求内容、响应内容、输入 Token、输出 Token、状态和模型。
- **CSP 与 XSS 防护**：Helmet 与 CSP 配置深度加固，前端尽量采用事件委托减少内联脚本。
- **SSRF 防护**：出站请求默认拦截本机、内网、云元数据地址和受限主机别名，可通过配置显式允许本地模型主机。
- **文档解析安全上限**：DOCX/XLSX ZIP 解析内置 entry 数量、单文件解压大小和总解压大小限制，降低压缩炸弹风险。
- **日志脱敏**：生产日志自动切换高性能 JSON 模式，并对 API Key、密码等敏感字段脱敏。
- **灾备方案**：内置数据库字段迁移逻辑与定时快照备份脚本。

## 多模态与附件上传

聊天会话支持直接多选上传图片和文档，当前上传队列最多保留 5 个附件。系统会尽量在上传阶段完成文档文本抽取，并把可读内容随用户问题一并发送给模型。

### 支持格式

- 图片：`png`、`jpg`、`jpeg`、`gif`、`webp`、`bmp`
- 文档：`pdf`、`txt`、`md`、`csv`、`doc`、`docx`、`xls`、`xlsx`

### 处理策略

- PDF 优先抽取文本；扫描 PDF 无文本时会尝试渲染页面为图片交给视觉模型。
- Word 和 Excel 通过 `word-extractor` 与 `xlsx` 解析，兼容新旧 Office 格式。
- 加密文件需要提供密码；无法解密时会在上传阶段提示。
- 图片会被限制大小、像素和输出体积，避免超大图造成 OOM 风险。
- 当前多模态模型按“每次最多 1 张图片”发送；多余图片会被跳过并提示。
- 模型配置中可显式开启“视觉输入（图片/扫描件）”。未开启的模型收到图片或扫描件兜底图片时会提前提示该模型不具备视觉能力。

## 远端模型监控与控制

系统监控页中的本机 GPU 指标只代表 Pivot 所在服务器。如果大模型部署在其他服务器，本机 `nvidia-smi` 无法反映远端 GPU 负载。远端模型建议通过模型配置中的以下字段进行保护：

- **端点并发上限**：限制 Pivot 对同一个模型端点同时发起的请求数量。局域网多模态模型如果一次只可靠处理一张图片，建议设置为 `1`。
- **远端健康检查 URL**：填写远端模型服务提供的健康接口，例如 `http://192.168.1.20:8000/health`。

系统会在“系统监控 > 模型端点状态”中展示远端端点的健康探针、并发、排队、失败次数和熔断状态。模型配置中的端点并发填 `0` 时会使用 `MODEL_ENDPOINT_DEFAULT_CONCURRENCY`。连续失败时会短暂熔断，避免持续压垮远端模型服务。

如果大模型服务和 Pivot 部署在同一台服务器，但模型地址使用宿主机内网 IP、反向代理域名或容器访问域名，建议把这些本机别名加入 `PIVOT_LOCAL_MODEL_HOSTS` 或 `PIVOT_ADVERTISE_HOSTS`，例如：

```bash
PIVOT_LOCAL_MODEL_HOSTS=192.168.31.10,pivot.local,host.docker.internal
PIVOT_ADVERTISE_HOSTS=192.168.31.10,pivot.example.com
```

这样系统监控的“模型端点状态”会把这些端点标记为本地；“GPU 与并发保护”区域始终只代表 Pivot 部署服务器的本机 GPU，不展示远端模型列表。

## 部署指南

### 1. 镜像打包

在联网环境中构建镜像并导出：

```bash
docker build -t pivot:latest .
docker save -o pivot.tar pivot:latest
```

### 2. 离线部署

将 `pivot.tar` 和 `docker-compose.yml` 拷贝至目标服务器：

```bash
docker load -i pivot.tar
docker network create ai-bridge
docker compose up -d
```

### 3. 升级已有部署

如果目标服务器已经运行过旧版本，建议显式重建并重启容器，确保运行中的容器使用新镜像：

```bash
docker compose down
docker build -t pivot .
docker compose up -d
```

如果是离线包部署，需先在目标服务器加载新镜像，再重建容器：

```bash
docker load -i pivot.tar
docker compose down
docker compose up -d
```

本项目启动时会自动执行数据库迁移。升级后可用以下命令确认容器内代码和数据库字段是否已更新：

```bash
docker exec pivot node -e "const { db } = require('/app/server/db'); console.log(db.prepare('PRAGMA table_info(models)').all().map(c=>c.name))"
docker logs pivot --tail=200
```

如果字段没有出现，通常说明容器仍在运行旧镜像、没有重建容器，或 `/app/data` 挂载目录权限导致 SQLite 迁移失败。

## 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境

复制模板并按需修改：

```bash
copy .env.example .env
```

Linux / macOS：

```bash
cp .env.example .env
```

`.env.example` 是配置模板，实际服务启动时读取 `.env`。生产部署修改 `.env` 后需要重启服务，新的登录有效期需要重新登录后才会体现在 Cookie 中。
局域网部署时，通常可以保持 `PUBLIC_URL` 为空，`CORS_ORIGIN` 只填写实际会访问本系统的内网地址；如果是纯 HTTP 内网环境，`COOKIE_SECURE` 保持 `false` 即可。若模型服务、MCP 服务或反向代理使用内网主机名，把它们补到 `PIVOT_LOCAL_MODEL_HOSTS` 和 `MODEL_URL_ALLOWLIST` 里，避免被当成外网地址拦截。

### 3. 启动服务

```bash
npm start
```

开发模式：

```bash
npm run dev
```

默认访问：

```text
http://localhost:3000
```

首次初始化会确保内置 `admin` 用户存在。生产环境请务必修改默认密码，并配置强随机 `JWT_SECRET`。

## 关键环境变量

```env
# 基础服务
PORT=3000
DATA_DIR=./data
JWT_SECRET=change-me

# 登录态有效期
ACCESS_TOKEN_EXPIRES_MINUTES=480
REFRESH_TOKEN_EXPIRES_DAYS=30

# 全局 AI 并发与排队
MAX_CONCURRENT_AI_REQUESTS=1
MAX_AI_QUEUE_SIZE=20
AI_QUEUE_TIMEOUT_MS=300000

# 模型端点默认并发上限（模型里填 0 时使用）
MODEL_ENDPOINT_DEFAULT_CONCURRENCY=1
MODEL_ENDPOINT_QUEUE_TIMEOUT_MS=300000

# 本地模型主机白名单
PIVOT_LOCAL_MODEL_HOSTS=localhost,127.0.0.1
PIVOT_TRUST_CONTAINER_LOCAL_HOSTS=false

# 智能体运行治理
AGENT_MAX_CONCURRENT_RUNS=2
AGENT_RUN_TIMEOUT_MS=900000
AGENT_TOOL_TIMEOUT_MS=120000
AGENT_STALE_RUNNING_MINUTES=30

# 数据库 MCP
MCP_SQLITE_ROOTS=
MCP_RESTRICT_PRIVATE_DATABASE_HOSTS_TO_ADMIN=false
MCP_DATABASE_CONNECT_TIMEOUT_MS=10000
MCP_DATABASE_TEST_TIMEOUT_MS=10000

# RAG 检索与缓存
EMBEDDING_MODE=http
EMBEDDING_API_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=text-embedding-3-small
RAG_CANDIDATE_LIMIT=300
RAG_CACHE_TTL_MS=300000
RAG_CACHE_MAX_ITEMS=500
RAG_SCORE_THRESHOLD=0.4

# 慢查询与异常告警
PIVOT_SLOW_SQL_MS=500
PIVOT_SLOW_MODEL_MS=30000
PIVOT_SLOW_RAG_MS=3000
PIVOT_ALERT_WEBHOOK_URL=
PIVOT_ALERT_WEBHOOK_TIMEOUT_MS=5000

# 后台维护
AUDIT_LOG_RETENTION_DAYS=180
API_CALL_LOG_RETENTION_DAYS=30
STORAGE_GC_RETENTION_DAYS=30
STORAGE_GC_BATCH_SIZE=100
SQLITE_INCREMENTAL_VACUUM_PAGES=200
DB_BACKUP_DIR=
DB_BACKUP_RETENTION_DAYS=7
DB_BACKUP_MAX_VERSIONS=7

# 本机 GPU 动态保护，仅代表 Pivot 所在服务器
GPU_MONITOR_INTERVAL_MS=15000
GPU_CONCURRENT_MIN=1
GPU_CONCURRENT_MAX=4
GPU_VRAM_REJECT_THRESHOLD=0.97
```

## 验证命令

```bash
npm run check
npm run lint
node tests/security.test.js
```

完整验证：

```bash
npm run verify
```

数据库初始化 smoke test：

```bash
node -e "require('./server/db'); console.log('db init ok')"
```

## 数据库与迁移

项目启动时会自动执行 SQLite schema 初始化和迁移。历史数据库会自动补齐新增字段与索引，包括：

- 用户、消息、附件和会话的软删除与审计字段。
- 模型能力、端点并发、每日额度、输入 Token 上限和私有模型字段。
- 模型输入/输出百万 Token 单价和费用币种字段。
- 知识库文档状态、分块、FTS 索引、反馈和 RAG 配置字段。
- MCP 服务、数据库 MCP 连接、工具缓存、刷新状态和能力包字段。
- 智能体任务治理字段、DAG 节点、模板、计划、通知、结果沉淀和结果版本表。
- 慢查询、慢模型响应、慢 RAG 检索和异常告警事件表。

迁移逻辑遵循幂等设计，重复启动不会重复创建字段。若旧数据库启动失败，优先检查日志中的缺失字段、迁移顺序和数据目录权限。

## 目录结构

- `server/`：后端核心程序，包含 Express 路由、SQLite schema、服务层、模型适配、RAG、MCP、智能体运行时和安全中间件。
- `client/`：前端静态资源，包含聊天页、管理端、工作台、PWA 和本地渲染资源。
- `data/`：SQLite 数据库及默认备份目录。
- `uploads/`：用户附件隔离存储目录。
- `scripts/`：语法检查、数据库备份、模型下载等辅助脚本。
- `tests/`：安全、迁移、RAG、MCP、智能体和系统边界测试。

## 版本记录

详细变更请查看 [CHANGELOG.md](CHANGELOG.md)。

**当前版本**：v0.0.41（普通用户使用手册、前端手册入口、Docker 手册可访问性、侧栏用户区紧凑优化）
