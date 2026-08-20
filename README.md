# Pivot (智枢) —— AI 智能中枢管理系统

![版本](https://img.shields.io/badge/%E7%89%88%E6%9C%AC-0.1.12-%2310b981)
![授权](https://img.shields.io/badge/%E6%8E%88%E6%9D%83-%E5%85%A8%E6%A0%88%E7%89%88-blue)

**Pivot (智枢)** 是面向组织内部的全场景智能协同与业务自动化中枢平台，适用于私有化、离线化和企业内网场景。系统以统一的智能工作入口连接对话、专业应用、知识库、工具库和自动化流程，覆盖从信息理解、内容生产、数据分析到任务执行、流程编排和结果沉淀的完整工作链路，并提供多模型接入、审计日志、系统监控和企业级权限治理能力。

> 普通用户使用说明请阅读 [Pivot 使用帮助](使用帮助.md)。部署后也可在前端左下角点击”帮助”，在应用内打开同一份帮助内容；直接访问 `/manual` 仍可独立查看。

### 当前界面结构

左侧导航保持单层结构：`搜索`打开会话、工作流及相关运行记录的全局搜索，`应用`进入应用中心，`自动化`进入统一工作区，并通过顶部的`工作流`和`计划任务`标签切换对应功能，`知识库`管理资料，`工具库`管理数据源、工具与连接；下方展示最近会话，底部`设置`会按账号权限打开系统设置或个人设置。

## 最新版本：0.1.12

（详细版本变更与历史演进说明请参阅 [CHANGELOG.md](CHANGELOG.md)）

## 核心特性

### 全量长文本语义分析

- 数据分析的“智能分析”页支持创建全量语义分析任务；系统按模型上下文预算自动切分全部记录，包含超长单元格，不做抽样。
- 任务在 PostgreSQL 中持久化，后台 worker 按批次执行并保存结果，支持进度轮询、服务重启恢复、失败重试、取消和最终汇总报告。
- 每批调用均经过统一上下文预算、模型并发和每日 Token 额度治理；批次结果和汇总报告会写入数据分析历史记录。

### 1. 对话与多模型

- **多模型接入**：支持 OpenAI-compatible Chat Completions / Responses 风格的上游模型接入，可配置 Base URL、API Key、模型 ID、温度、最大输出 Token、每日额度和端点并发。
- **第三方 API 流式输出**：对外的 OpenAI-compatible `/v1/chat/completions` 与 `/v1/completions` 支持流式，调用方在请求体携带 `stream: true` 即按 SSE（`text/event-stream`）真流式逐块返回，与标准 OpenAI 客户端/SDK 用法一致；不带或 `stream: false` 时返回一次性 JSON。示例：`curl -N -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" -d '{"model":"<模型ID>","stream":true,"messages":[{"role":"user","content":"你好"}]}' http://<host>/v1/chat/completions`。
- **模型可见性**：支持全局模型、部门可见模型和用户私有模型；用户私有模型只对所有者可见，自主任务、工作流和计划任务不会越权使用其他用户私有模型。
- **模型能力标识**：模型配置、模型列表、聊天下拉和自主任务模型选择器展示文本、视觉、推理等能力图标。
- **模型探测**：支持一键获取上游服务模型列表，减少手工配置成本。
- **模型端点保护**：支持端点并发上限、健康检查 URL、排队与熔断保护；用户排队时会看到前方等待数、当前生成占用数和最长等待时间。
- **Token 统计**：网页聊天、自主任务、工作流、RAG embedding 和第三方 API 调用统一计入模型每日额度、后台报表和 Prometheus 指标。
- **模型路由策略**：自主任务支持 6 种路由策略（`fixed` / `auto-vision` / `auto-context` / `auto-cost` / `auto-load` / `auto-escalate`），可在任务启动或模板中选择；命中替换时会写入 `agent_runs.chosen_model_id` 并在步骤记录中标注路由理由，路由失败安全回退到原模型。

### 2. 自动化流程与计划

- **工作流与计划任务**：从左侧“自动化”进入工作流或计划任务，管理可复用流程、发布版本、运行计划和历史结果。
- **发布与调度边界**：计划任务只允许选择已发布工作流；按间隔计划支持每 5 至 1440 分钟执行一次，适合一天多次处理。
- **流程执行**：已发布工作流按定义的节点顺序执行，按需调用知识库、会话检索、模型列表、系统健康和工具库工具。
- **运行策略**：工作流支持按业务需要配置节点依赖、条件执行、并行处理和结果汇总。
- **工具范围控制**：支持仅内置工具、内置 + 工具库、工具白名单、工具包启停和管理员工具隔离。
- **MCP 审批**：高风险 MCP 调用可挂起等待用户批准或拒绝，数据库只读 MCP 可按策略安全执行；服务端只承认通过 `approveAgentTool` 写入的 `approvedTools` 白名单，杜绝路由层意外绕过审批策略（v0.0.43 收口）。
- **任务快捷目标与模板**：新建一次性任务可使用“风险总结”“待办整理”“资料检查”快速填入目标和推荐模式，也可将当前模型、运行模式、工具策略、上下文和执行限制保存为模板复用。
- **执行轮次与模型用量治理**：最大执行轮次默认采用自动策略，标准模式 30 轮、深度模式 60 轮、审查模式 50 轮；人工配置也受对应模式上限约束，流式工具调用和 JSON 回退共享总轮次。单次任务 Token 上限累计输入与输出，留空或填写 `0` 表示不限。
- **工作流编辑体验**：资产列表支持独立编辑工作流名称和简介，详情页专注节点编排；节点名称在完成输入并按 Enter 或离开输入框后一次保存，避免逐字提交导致焦点丢失。
- **工作流共享权限**：分享弹窗按单位展开个人账号，支持单位/个人精确授权、全选/全不选和单位联动个人；共享接收者仍只能查看和运行已发布版本。
- **预算与重试**：支持失败重试、流程运行超时、单次工具调用超时和运行心跳检测；达到执行轮次或 Token 上限时会保留已有结果并明确提示结果可能不完整。
- **运行审计**：工作流和计划运行详情保留目标、模型、步骤、工具输入输出、错误信息、Token 用量、耗时和最终结果；MCP 调用日志的 input/output 写入审计前自动脱敏。
- **自动化资产中心**：左侧“自动化”通过顶部标签统一承载工作流与计划任务，可搜索、查看状态、运行或进入编辑器；工作流画布只在新建或编辑时打开。
- **工作流编排**：工作流编排支持可视化定义节点依赖、条件执行、并行工具调用和聚合节点；画布支持拖拽节点、端口连线、自动布局、适配画布、滚轮缩放、空白平移、小地图、草稿保存、工作流库、发布、版本对比和历史回滚，JSON 高级视图保留为弹窗入口。
- **节点工具选择**：节点工具选择器按知识与会话、数据库、报表与文件、图表与展示、数据处理、文档处理、格式转换、消息通知、系统诊断和外部能力分组，显示中文名称、用途说明、来源标签、审批提示和内部工具 ID。
- **流式 function calling（可选）**：v0.0.48 / v0.0.49 在 `runAgent` 引入按 OpenAI tools 协议的流式分支，通过环境变量 `AGENT_STREAMING_TOOLS=true` 启用；任何流式失败自动回退到旧回合制 JSON 协议，DAG 任务永远走原图调度。
- **模板库**：工作流模板复用步骤、节点和依赖结构，便于团队统一维护流程。
- **计划任务**：已发布工作流可承接每日、每周和手动计划，支持暂停、恢复和查看历史运行。
- **通知中心**：工作流完成、失败、停止、等待审批、计划入队和结果沉淀均会生成用户级通知。
- **结果沉淀**：流程最终答案或错误摘要可保存为结果资产，并支持版本备注、差异对比和回滚。
- **断点续跑**：失败或中断流程可基于上一轮状态、错误和最近步骤继续执行，避免只能从头重跑。
- **新闻内容校对**：数据库查询结果可接入富文本内容校对节点，向导支持选择当前账号可用模型并引用结构化 `records`；节点自动清理 HTML、逐条检查标题和正文，长内容会分块处理，多条记录会分别返回问题、通过或未完成状态，并可沉淀为 Markdown 报告产物。

### 3. 工具库与 MCP 工具接入

用户侧统一使用“工具库”命名，底层继续兼容 MCP 协议。聊天和工作流是否调用工具库，由对应流程的工具开关或工具范围控制决定；工具卡片本身不再提供重复的“带入聊天”动作。

- **外部 MCP Server**：支持配置个人或全局 MCP Server，保存服务后可刷新工具缓存，并供普通对话和工作流调用。
- **工具库共享权限**：数据库工具共享沿用工作流的单位/个人权限语义，接收者只获得治理后的只读工具，分享弹窗支持统一目标树选择。
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
- **工具包市场**：内置工具、外部 MCP Server 和数据库 MCP 连接会同步为工具包，可按用户权限启停，并影响普通对话、工作流工具列表和 MCP 工具调用。
- **工具策略**：系统设置中的“工具策略”只管理系统工具和全局工具服务；页面按工具卡片平铺展示，每页 18 个工具，卡片启停开关用于控制工具可用状态。
- **治理权限边界**：普通管理员可以查看工具策略但卡片不显示“编辑”入口；内置系统管理员可以修改全局工具启停、风险等级和审批要求，并通过卡片“编辑”打开居中的治理弹窗。个人工具仍按所有者权限、数据库只读限制、审批策略和运行时安全检查生效。

### 4. 应用中心业务工作台

- **公文写作**：支持多文档公文起草、润色、局部改写、审校、批注、版本对比和多格式导出。
- **数据分析**：支持表格数据导入、字段画像、查询、透视、图表、数据比对、智能分析和结果导出。
- **法规查询**：支持共享法规制度库、法规文档上传、版本管理、条文级检索、文档下载、归档治理和基于命中条文的 AI 问答。
- **应用恢复**：刷新页面后会尽量恢复到当前应用工作区，减少长流程操作中断。
### 4. RAG 知识库与中文检索

- **正式工作台**：知识库作为正式功能接入左侧工具入口，整合文档列表、RAG 配置、召回测试、删除审计、批量重建、批量删除、失败重试和上传文档。
- **专题库与标签范围**：知识库支持专题库/集合分组和文档多标签，上传、列表筛选、召回测试和聊天引用均可按范围缩小候选资料；专题库和标签需要先创建后使用，选择专题库后标签会联动过滤，默认仍可使用全部知识库。
- **专题库共享权限**：知识库专题库支持与工作流一致的单位/个人共享目标树，单位选择会联动成员，个人授权可独立保存且不会与单位授权重复。
- **普通对话接入**：聊天输入区提供知识库开关，用户可按本轮问题决定是否检索私有文档。
- **智能体接入**：智能体可按目标调用知识库检索、知识库文档列表和相关上下文。
- **索引状态**：文档记录状态、分块数、已索引分块、进度百分比、错误信息和处理时间；服务重启后会恢复处理中任务。
- **召回测试**：可临时调整相似度阈值、Top K 和候选数量，展示命中文档、分块、相似度分数和命中状态；测试期间按钮禁用并显示加载状态。
- **召回可视化（v0.0.45）**：调试弹窗新增关键词高亮、按相对最高分占比的得分进度条、按源文件聚合的"命中数 / 峰值 / 均值"汇总条以及 `/api/rag/debug-query` 返回的检索耗时，便于普通用户和管理员快速排查检索质量。
- **反馈闭环**：召回结果可提交"有用/无用"反馈，便于分析低质量文档和低命中查询。
- **中文 ngram**：索引时生成中文 1-3 gram token，改善 `unicode61` 对中文短词、单字和词组召回不足的问题。
- **候选预过滤**：`knowledge_chunks_fts` 通过触发器同步分片检索内容，减少向量相似度计算候选数量。
- **结果缓存**：RAG 检索结果支持 TTL 缓存，同一用户重复问题可减少 embedding 调用和数据库排序开销。
- **Embedding 配置**：管理员可维护系统默认向量配置，普通用户可维护个人配置；云端、本机和局域网向量服务均通过 HTTP 接入。
- **知识图谱抽取定位**：当前实体和关系由规则、模式匹配和启发式质量信号生成，适合作为 Graph-RAG 辅助线索；正式知识问答前建议确认低可信关系、合并重复实体，并结合来源文档校验。
- **兼容端点**：支持 OpenAI compatible `/v1/embeddings` 以及 Ollama 常用 `/api/embed`、`/api/embeddings`。

### 5. 效率工具集

- **FTS5 全文搜索系统**：集成 SQLite FTS5 毫秒级检索引擎，支持海量历史消息的关键词搜索，并通过触发器同步索引。
- **角色与规范库**：沉淀常用角色、输出规范、任务方法和工作流节点提示，统一服务聊天与工作流编排。
- **会话管理**：支持多轮会话、置顶、归档、多标签、搜索、导出 Markdown、打印 / 导出 PDF（v0.0.45 新增 `/api/sessions/:id/print` 视图，浏览器内 Ctrl/Cmd+P 即可生成 PDF）和软删除审计。
- **重新回答**：支持一键丢弃错误输出，并结合最新上下文重新生成回答。
- **多模态附件**：聊天会话支持上传图片、PDF、Word、Excel、TXT、Markdown、CSV 等文件，并尽量在上传阶段抽取可读文本。
- **PWA 应用**：支持作为独立应用安装到桌面或移动端，稳定 vendor 资源可缓存，业务页面保持及时更新。

### 6. 系统运营监控

- **实时运营面板**：展示系统活跃度、用量趋势、模型调用、Token 消耗和核心资源状态。
- **健康检查**：`/api/health` 返回不包含路径的轻量存活状态；登录后访问 `/api/health/details` 可获取缓存的数据库、目录、内存和磁盘诊断。
- **维护状态**：系统监控面板展示最近维护任务成功时间、处理条数和错误信息。
- **RAG 指标**：暴露 RAG 检索次数、缓存命中、候选数量、命中数量、Top Score 和检索/入库耗时。
- **Prometheus 指标**：便于接入企业监控体系；默认要求 `Authorization: Bearer <METRICS_TOKEN>`，未配置令牌时接口保持关闭，完全可信的隔离局域网可通过显式开关允许匿名采集。
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
开放注册的 `.env` 值只作为首次初始化默认值；系统运行后请由内置 `admin` 在“系统设置 > 用户管理”页面切换，设置会写入数据库并即时生效。
局域网部署时，通常可以保持 `PUBLIC_URL` 为空，`CORS_ORIGIN` 只填写实际会访问本系统的内网地址；如果是纯 HTTP 内网环境，`COOKIE_SECURE` 保持 `false` 即可。若模型服务、MCP 服务或反向代理使用内网主机名，把它们补到 `PIVOT_LOCAL_MODEL_HOSTS` 和 `MODEL_URL_ALLOWLIST` 里，避免被当成外网地址拦截。

无公网 IPv4/IPv6、无域名和无证书不影响隔离局域网部署，但客户端与服务器之间仍需存在私有 IP、IPv6 字面量或可解析局域网主机名中的至少一种可达地址。监控接入应配置 `METRICS_TOKEN`；未配置时 `/api/metrics` 默认关闭。只有完全可信且隔离的局域网才考虑设置 `METRICS_ALLOW_UNAUTHENTICATED_LAN=true`。

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

# 账号注册策略：首次初始化开放注册默认值，后续可在用户管理页面开关
ALLOW_PUBLIC_REGISTRATION=false

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
AGENT_DAG_NODE_CONCURRENCY=4
AGENT_RUN_TIMEOUT_MS=900000
AGENT_TOOL_TIMEOUT_MS=120000
AGENT_STALE_RUNNING_MINUTES=30
# 是否启用流式 function calling 分支（v0.0.49）；失败自动回退到旧回合制 JSON
AGENT_STREAMING_TOOLS=false

# 后台记忆压缩（v0.0.43）
# 自动压缩触发阈值与保留策略（v0.0.56）
# 仅作为初始化默认值；后续可由管理员在系统设置中调整，保存后即时生效。
MEMORY_THRESHOLD=12000
MEMORY_MIN_MESSAGES_TO_COMPRESS=1
MEMORY_SUMMARY_KEEP_COUNT=6
# 超时（毫秒）与全局并发上限，会话级去重默认开启
MEMORY_COMPRESSION_TIMEOUT_MS=180000
MEMORY_COMPRESSION_MAX_CONCURRENT=2

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
EMBEDDING_REQUEST_TIMEOUT_MS=30000
RAG_INDEX_EMBEDDING_TIMEOUT_MS=120000
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
DB_BACKUP_DIR=
DB_BACKUP_RETENTION_DAYS=7
DB_BACKUP_MAX_VERSIONS=7
PG_DUMP_BIN=pg_dump
PG_DUMP_TIMEOUT_MS=900000

# 本机 GPU 动态保护，仅代表 Pivot 所在服务器
GPU_MONITOR_INTERVAL_MS=15000
GPU_CONCURRENT_MIN=1
GPU_CONCURRENT_MAX=4
GPU_VRAM_SAFE_THRESHOLD=0.85
GPU_VRAM_CRITICAL_THRESHOLD=0.95
GPU_VRAM_REJECT_THRESHOLD=0.97
GPU_VRAM_RECOVER_THRESHOLD=0.90
```

## 验证与运维命令

代码规范与语法检查：

```bash
npm run check
npm run lint
```

全量自动化测试（476 项测试）：

```bash
npm run test:all
```

完整流水线验证（包含检查、代码规范与全量测试）：

```bash
npm run verify
# 或直接运行
npm test
```

E2E 端到端隔离测试（Playwright，支持独立 Schema 与随机端口）：

```bash
npm run test:e2e
```

PostgreSQL 数据库热备份（基于 `pg_dump` 自定义格式，支持超时与版本轮转清理）：

```bash
npm run backup
```

数据库初始化验证：

```bash
node -e "require('./server/db'); console.log('db init ok')"
```

外部链路配置体检（默认只读 `.env` 配置，不请求外部服务）：

```bash
npm run check:external
```

真实外部链路验收（会请求已配置的模型监控 URL、Embedding、外部 MCP 健康检查和数据库只读连通测试）：

```bash
npm run check:external -- --live
```

`npm run verify` 主要验证代码、接口和本地安全回归；模型补全、Embedding、外部 MCP、数据库和 IM Webhook 的真实端到端效果仍依赖 `.env`、数据库内配置和外部服务可用性。为避免误耗额度或误发生产群，模型实际补全、IM 发送和告警投递建议在目标环境中按业务账号手动验收。

## 数据库与迁移

生产环境已全面升级至 **纯 PostgreSQL 14+ / 16+ / 17+** 架构（支持 `pgvector` 向量检索与 `pg_trgm` GIN 索引），并保留 DuckDB 作为独立的高性能列式内存数据分析引擎。

针对生产环境数据库部署与平滑迁移，请查阅以下实施手册：
- **无网络/离线隔离区迁移指南**：[《Pivot 生产环境无网络离线迁移 PostgreSQL 实施指南》](docs/Pivot生产环境无网络离线迁移PostgreSQL实施指南.md)（含离线镜像打包、无外网插件安装、四级深度核验与 5 分钟快速回滚预案）。
- **架构演进与全量方案**：[《Pivot 生产环境迁移 PostgreSQL 实施方案》](Pivot生产环境迁移PostgreSQL实施方案.md)（含 79 张表方言转换规则、1,018 条原生中文注释字典与主键游标无锁流式抽取引擎）。

系统启动时会自动执行 PostgreSQL schema 校验与元数据注释注入，所有历史业务表与字段均幂等兼容。

### v0.1.8 PostgreSQL 迁移与运行兼容说明

`knowledge_chunks`、`memories` 与 `regulation_articles` 的 `embedding` 列在 PostgreSQL 中使用 `pgvector` 的 `vector` 类型；智能体配置、长期记忆来源、RAG 调试记录和知识图谱别名等结构化字段使用 `JSONB`。应用层已经兼容 node-postgres 返回的原生 JSON 对象和数组。

常规迁移保持逐字段无损；如需治理允许为空的历史外键孤儿引用，可在已批准的数据治理窗口执行 `REPAIR_ORPHAN_FOREIGN_KEYS=true node -r dotenv/config scripts/migrate_sqlite_to_pg.js`。该模式仅清空失效引用，不删除业务记录，随后使用 `node -r dotenv/config scripts/verify_pg_migration.js` 与 `node -r dotenv/config scripts/diff_schema_sqlite_pg.js` 校验数据和 schema。

## 目录结构

- `server/`：后端核心程序，包含 Express 路由、SQLite schema、服务层、模型适配、RAG、MCP、智能体运行时和安全中间件。
  - `server/cache.js`：通用 `LruCache` / `TtlCache`（v0.0.43）。
  - `server/security.js`：URL 防 SSRF、文件路径校验、`redactSecrets` 脱敏（v0.0.43）。
  - `server/services/concurrency.js`：信号量、`withTimeout`、`KeyedConcurrencyGuard`（v0.0.43）。
  - `server/services/model-router.js`：模型路由 6 策略、`assessConfidence`、`pickEscalationModel`（v0.0.46 / v0.0.50）。
  - `server/services/streaming-tools.js`：OpenAI tools 流式累加器与辅助函数（v0.0.48）。
  - `server/services/regulations.js`：法规库文档、版本、条文解析、全文检索和 AI 上下文服务（v0.0.168）。
  - `server/services/agent-runtime.js` + `agent-validators.js`：智能体运行时与拆分出的常量/规范化（v0.0.43 拆分）。
- `client/`：前端静态资源，包含聊天页、管理端、工作台、PWA 和本地渲染资源。
  - `client/chat/pivot-core.js`：`window.Pivot` 全局工具命名空间（v0.0.44）。
  - `client/chat/agents-dag-editor.js`：智能体 DAG 可视化编辑器（v0.0.47 / v0.0.51 缩放与小地图）。
  - `client/chat/apps-workbench-regulations.js`：法规查询工作台，承载法规检索、详情、AI 问答和管理员维护入口（v0.0.168）。
  - `client/chat/safe-html.js`：HTML 转义与 DOMPurify 适配。
- `data/`：SQLite 数据库及默认备份目录。
- `uploads/`：用户附件隔离存储目录。
- `scripts/`：语法检查、数据库备份、模型下载等辅助脚本。
- `tests/`：安全、迁移、RAG、MCP、智能体、模型路由、流式工具累加器和系统边界测试。

## 版本记录

详细变更请查看 [CHANGELOG.md](CHANGELOG.md)。

**当前版本**：v0.1.12
