# Pivot (智枢) —— AI 智能中枢管理系统

![版本](https://img.shields.io/badge/%E7%89%88%E6%9C%AC-0.0.31-%2310b981)
![授权](https://img.shields.io/badge/%E6%8E%88%E6%9D%83-%E5%85%A8%E6%A0%88%E7%89%88-blue)

**Pivot (智枢)** 是一款面向私有化、离线化和企业内网场景的全栈 AI 对话与智能体工作平台。系统集成多模型接入、知识库检索、MCP 工具调用、智能体任务、第三方 OpenAI-compatible API、审计日志、系统监控、数据维护和企业级权限治理能力，目标是在可控环境中提供稳定、安全、可审计的 AI 工作入口。

## 最新版本：0.0.31

- **智能体工作台升级**：智能体从任务弹窗升级为独立工作台，右侧主工作区集中承载任务执行、模板库、计划队列、通知中心、结果沉淀和能力清单。
- **模板库与计划任务**：可保存并复用目标、运行模式、MCP 策略、工具白名单、审批策略、Token 预算、失败重试和上下文来源；支持立即运行、每日和每周计划。
- **上下文来源管理**：任务可选择自动、最近会话、知识库优先、自定义说明或不扩展上下文，运行时会把配置注入规划提示。
- **任务闭环增强**：支持断点续跑、重新运行、审批通过/拒绝、Markdown 导出、结果沉淀、任务通知和删除审计。
- **数据库 MCP 内置化**：统一“数据库 MCP Server”入口，支持 PostgreSQL、MySQL/MariaDB、SQL Server、SQLite 和 MongoDB，通过表单填写连接信息即可生成可调用工具。
- **普通对话接入工具**：知识库和 MCP 均可在普通对话输入区按开关启用，附件、知识库、MCP 和发送按钮形成统一操作组。
- **知识库正式化**：知识库已作为正式功能接入普通对话与智能体任务，不再作为实验功能显示开关。
- **模型能力展示优化**：模型配置和选择器支持文本、视觉、推理等能力图标展示，并收紧私有模型可见性边界。
- **企业级数据结构**：补齐 `agent_templates`、`agent_schedules`、`agent_artifacts`、`agent_notifications` 表，并为 `agent_runs` 增加模板、计划、上下文和续跑字段。
- **验证状态**：当前 `npm run check`、`npm run lint`、`node tests/security.test.js` 均已通过，安全测试通过 `61/61`。

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
- **运行模式**：支持标准、深度、审查三类模式，规划提示会根据模式调整检索深度、证据约束和风险表达。
- **工具范围控制**：支持仅内置工具、内置 + MCP、工具白名单和管理员工具隔离。
- **MCP 审批**：高风险 MCP 调用可挂起等待用户批准或拒绝，数据库只读 MCP 可按策略安全执行。
- **预算与重试**：支持 Token 预算、失败重试、任务运行超时、单次工具调用超时和运行心跳检测。
- **任务审计**：任务详情保留目标、模型、步骤、工具输入输出、错误信息、Token 用量、耗时和最终结果。
- **模板库**：可保存常用目标与运行参数，形成个人或共享模板。
- **计划任务**：支持每日、每周和手动计划，服务端定时扫描到期计划并入队执行。
- **通知中心**：任务完成、失败、停止、等待审批、计划入队和结果沉淀均会生成用户级通知。
- **结果沉淀**：任务最终答案或错误摘要可保存为结果资产，并在工作台中展示最近沉淀。
- **断点续跑**：失败或中断任务可基于上一轮状态、错误和最近步骤继续执行，避免只能从头重跑。

### 3. MCP 工具接入

- **外部 MCP Server**：支持配置个人或全局 MCP Server，保存服务后可刷新工具缓存，并供普通对话和智能体任务调用。
- **数据库 MCP Server**：内置数据库 MCP 预设，通过可视化表单填写类型、主机、端口、数据库名、用户名、密码、Schema、SSL 和最大返回行数。
- **统一数据库入口**：数据库类型作为连接字段选择，不再按数据库种类拆成多个工具入口。
- **支持数据库类型**：PostgreSQL、MySQL/MariaDB、SQL Server、SQLite 和 MongoDB。
- **只读安全边界**：SQL 数据库提供表列表、结构查看和只读查询；MongoDB 提供集合列表、样本读取和聚合读取。
- **SQL 限制**：只允许单语句读取类 SQL，例如 `SELECT`、`WITH`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`，写入、DDL 和管理类关键字会被拦截。
- **SQLite 路径约束**：SQLite 文件路径限制在允许目录内，并以只读方式打开。
- **连接测试**：新增测试连接按钮，保存或编辑前可确认数据库连接是否可用。
- **工具缓存**：刷新服务后展示已缓存可调用工具，工具名称和说明尽量使用中文语义。

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

# RAG 检索与缓存
EMBEDDING_MODE=http
EMBEDDING_API_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=text-embedding-3-small
RAG_CANDIDATE_LIMIT=300
RAG_CACHE_TTL_MS=300000
RAG_CACHE_MAX_ITEMS=500
RAG_SCORE_THRESHOLD=0.4

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
- 知识库文档状态、分块、FTS 索引、反馈和 RAG 配置字段。
- MCP 服务、数据库 MCP 连接、工具缓存和刷新状态字段。
- 智能体任务治理字段、模板、计划、通知和结果沉淀表。

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

**当前版本**：v0.0.31 (Enterprise Agent Workbench Upgrade)
