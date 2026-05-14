# Pivot (智枢) —— AI 智能中枢管理系统

![版本](https://img.shields.io/badge/%E7%89%88%E6%9C%AC-0.0.24-%2310b981)
![授权](https://img.shields.io/badge/%E6%8E%88%E6%9D%83-%E5%85%A8%E6%A0%88%E7%89%88-blue)

**Pivot (智枢)** 是一款专为私有化、离线化环境设计的全栈 AI 对话管理平台。它集成了多模型对接、全链路安全加固、资产归属追踪及高性能持久化存储，致力于为用户提供一个安全、稳定且美观的 AI 交互门户。

## 最新版本：0.0.24

- 内置应用级 SQLite 热备份：维护服务默认每 24 小时调用 `db.backup()` 生成东八区毫秒级时间戳备份到 `data/backups/`，并按 7 天、最多 7 个版本滚动清理；同一秒连续备份会自动避让重名文件。
- 自动维护闭环增强：软删除附件、知识库源文件、知识库分块、FTS 索引和历史消息会在保留期后被物理清理，并配套执行 `PRAGMA optimize` 与增量 vacuum；物理文件删除失败时会保留数据库引用，等待后续维护重试。
- 安全防护继续收紧：管理员重置密码会吊销目标用户全部 refresh token；模型探测接口、上传接口和 RAG/外部模型出站探测均补齐限流与 SSRF 防护。
- 第三方 API 网关补齐向量转发：持有 Pivot API Key 的客户端现在可通过 OpenAI-compatible `/v1/embeddings` 调用当前用户可用的 RAG 向量模型，`/v1/models` 与 API 接入管理页都会暴露已配置的 embedding 模型。
- 前端 CSP 治理推进：`client/chat` 已清除全部 `onclick=` 内联事件，模型、提示词、附件、API Key 和会话菜单均改为 `data-*` 事件委托；管理员重置密码、模型密钥查看校验和加密文档密码输入已迁移到应用内 `showInputPrompt()`，不再依赖原生 `prompt()`。
- 表格渲染安全组件化起步：表格空态、加载态和错误态新增 DOM API 渲染工具，减少裸 `innerHTML` 提示行。
- 流式输出与上传体验增强：SSE 解析按标准事件边界处理，长思考输出节流渲染，大文件上传增加进度反馈，模型选择器补齐键盘导航。
- RAG 配置开放 Chunk Size 与 Overlap，可按业务文档调优分块策略；保存后自动清空相关缓存。
- 当前验证命令为 `npm run verify`，覆盖语法检查、ESLint 和安全测试，测试通过 `47/47`。

- Sidebar session infinite scroll now uses cursor-based pagination (`nextCursor`) instead of `page + OFFSET`, reducing duplicate or skipped sessions when conversations are created, updated, or pinned while scrolling. The list footer also shows loading, empty, completed, and error states.
- PWA 更新机制继续收紧：Service Worker 不再拦截页面导航请求，仅缓存稳定 vendor 资源，业务页面、脚本、API 与版本清单交回服务端和浏览器处理。
- 系统设置主弹窗关闭入口移至侧边栏底部“关闭设置”，避免与数据概览、系统监控、审计报表等页面右上角操作按钮堆叠。
- API Key 子弹窗、第三方 API 调用记录弹窗统一使用文字“关闭”按钮，移除浮动 `X`，第三方 API 调用记录弹窗禁止点击遮罩误关闭。
- 超级管理员用户输入输出记录弹窗新增分页，每页 15 条；后端 `/admin/users/:id/messages` 支持 `page`、`limit` 并返回总数。
- 第三方 API 调用记录弹窗明确分页状态，继续按每页 15 条展示，并区分输入 Token 与输出 Token。
- 同步更新内联兜底脚本，降低旧缓存或懒加载脚本未及时刷新时导致记录按钮、弹窗或分页缺失的概率。
- 用户管理列表为内置 `admin` 超级管理员新增“记录”入口，可按用户查看聊天输入、模型输出、Token、会话和已删除历史消息。
- API 接入管理页的超级管理员入口明确为“API 调用记录”，可查看第三方 API Key 调用的请求内容、响应内容、输入 Token、输出 Token 和状态。
- 优化第三方 API 调用记录弹窗宽度与表格布局，去除右侧空白和不必要的水平滚动条。
- 会话历史列表改为标题右侧显示相对时间，悬停时切换为三点操作按钮，并移除重复日期分组标题。
- 重构 PWA 更新策略：Service Worker 仅缓存稳定 vendor 资源，业务页面和 `/chat/*` 脚本始终走网络；前端通过 `/version.json` 检测更新并提示刷新，必要时可访问 `/pwa-reset` 手动清理。
- 用户删除聊天消息、会话或附件时改为软删除，保留审计日志、用量统计、用量明细和附件元数据，删除用户也不再物理清空历史数据。
- 将内置用户名 `admin` 明确为超级管理员：可查看所有用户元数据、附件和已删除数据；普通管理员保留用户管理、审计日志、系统监控和审计报表权限，但不开放用户具体数据。
- 超级管理员附件库新增“用户”列，显示附件所属用户名/昵称，便于跨用户归属核对。
- 第三方 API Key 调用新增请求与响应内容留痕，仅内置 `admin` 超级管理员可在 API 接入管理页查看和检索。
- 修复 PWA 缓存导致旧版管理端脚本不刷新问题，改为服务端 `no-store`、Service Worker 清旧缓存和业务资源网络优先。
- 继续统一后台数据表、Token 单位、模型配置布局、审计报表时间筛选和 API Key 输入/输出 Token 统计等管理端体验。

## 核心特性

### 1. 效率工具集 (Efficiency Suite)
- **FTS5 全文搜索系统**：集成 SQLite FTS5 毫秒级检索引擎，支持海量历史消息的精准关键词搜索，内置触发器实现索引自动同步。
- **RAG 知识库检索增强**：基于 SQLite + FTS5 + embedding 相似度排序实现知识库问答，内置候选预过滤、TTL 缓存和中文 ngram 检索预处理，改善中文短词、单字与词组召回。
- **PWA 离线化应用**：支持将 Pivot 作为独立应用 (Standalone) 安装至桌面或移动端，核心资源全量预缓存，实现“秒开”访问。
- **指令中心 (Prompt Center)**：内置常用指令模板，支持 AI 角色（System Prompt）一键切换。
- **会话管理进阶**：支持对话置顶（Pin）、归档（Archive）、多标签管理及 **会话一键导出为 Markdown**。
- **动态交互工具**：内置消息“重新回答 (Regenerate)”机制，支持一键丢弃错误输出并结合最新上下文进行重建。

### 2. 系统运营监控 (Ops & Analytics)
- **高性能异步架构**：重构会话记忆压缩逻辑为异步非阻塞模式，确保长对话场景下的极致流畅响应。
- **数据库自动维护**：内置每日 `PRAGMA optimize`、审计/API 调用日志清理、过期刷新令牌清理与维护状态追踪，确保系统长期运行不卡顿、不膨胀。
- **实时运营面板**：单行展示 8 大核心指标，实时监控系统活跃度与资源消耗。
- **精准用量统计**：多维度分析用户及模型的 Token 使用趋势，支持最后活动时间追踪。
- **统一 API 用量口径**：网页聊天与 OpenAI 兼容 `/v1/chat/completions` 调用统一计入模型每日额度、后台报表和 Prometheus 指标。
- **RAG 质量与性能指标**：暴露 RAG 检索次数、缓存命中、候选数量、命中数量、Top Score 与检索/入库耗时，便于持续调优。
- **健康检查与维护状态**：`/api/health` 返回数据库、数据目录、上传目录、内存和磁盘检查结果；系统监控面板展示最近维护任务成功时间。
- **模型连通性监测**：可视化模型 API 状态，支持一键探测延迟（ms）并具备并发保护。
- **远端模型端点保护**：支持为每个模型端点配置并发上限、健康检查 URL、排队与熔断保护；用户排队时会在当前回复气泡中看到前面等待请求数、当前生成占用数和最长等待时间。
- **细粒度访问控制**：支持模型级别的每日额度限制，并可按部门（Unit）分配模型使用权限。
- **专业模型参数调优**：可视化配置模型专属 Temperature 与 Max Tokens 限制。
- **模型能力标识**：模型配置、模型列表和聊天下拉会展示文本/视觉能力，便于用户在发起附件请求前选择合适模型。

### 3. 极致交互体验
- **流式响应与性能监测**：支持 SSE 实时输出，动态显示推理耗时、Token 长度及 TPS。
- **并发排队提醒**：当全局 AI 并发或模型端点并发已满时，聊天页会区分“前面等待请求数”和“正在生成占用数”，并在队列满、超时或端点繁忙时展示明确错误原因。
- **思维链 (Thought) 深度集成**：完美解析并流畅展现模型思考推演全过程。
- **多模态附件读取**：支持 PDF、Word、Excel、图片等内容抽取，并提供扫描件视觉兜底。
- **模型视觉能力配置**：模型可显式开启“视觉输入（图片/扫描件）”，未开启的文本模型会提前拦截图片/扫描件请求，普通文档仍按文本抽取链路处理。
- **UI/UX 性能优化**：引入 `content-visibility: auto` 与 GPU 加速，大长会话列表滑动性能提升 300%。
- **离线级强悍渲染**：集成完全本地化的防御性渲染引擎与原生 **KaTeX** 数学公式支持。
- **UI/UX 深度优化**：1450px 宽屏管理面板，全系统自定义弹窗，10+ 子系统的前端彻底模块化重构。

### 4. 安全、存储与审计报表
- **精细化内容安全策略 (CSP)**：深度加固 Helmet 配置，严防 XSS 攻击，同时完美兼容 PWA 架构。
- **附件令牌绑定与过期机制**：附件访问链接引入自动过期，并在校验时绑定完整用户、会话和文件路径，确保同一 token 只能访问对应附件。
- **全链路审计日志**：完整记录敏感操作与 IP 地址，支持多维度条件筛选与同步导出。
- **生产级日志管理**：自动切换高性能 JSON 模式，具备 API Key、密码等敏感数据全局脱敏能力。
- **第三方 API 接入 (OpenAI 兼容)**：实现标准 `/v1` 接口，支持用户自主管理 API Key、聊天补全、向量生成与消费统计。
- **文档解析安全上限**：DOCX/XLSX ZIP 解析内置 entry 数量、单文件解压大小和总解压大小限制，降低压缩炸弹风险。
- **智能模型探测**：支持一键获取上游服务模型列表，极大简化了配置流程。
- **资产确权隔离**：上传文件按“用户/会话”路径物理隔离存储，支持图片压缩与文档预处理。
- **自动灾备方案**：内置数据库字段自动迁移逻辑与定时快照备份脚本。
- **配置标准化体系**：提供全注释的 `.env.example` 模板，支持详尽的并发控制及审计粒度设置。

## 多模态与附件上传

聊天会话支持直接多选上传图片和文档，当前上传队列最多保留 5 个附件。系统会尽量在上传阶段完成文档文本抽取，并把可读内容随用户问题一并发送给模型。

### 支持格式
- 图片：`png`、`jpg`、`jpeg`、`gif`、`webp`、`bmp`
- 文档：`pdf`、`txt`、`md`、`csv`、`doc`、`docx`、`xls`、`xlsx`

### 处理策略
- PDF 优先抽取文本；扫描 PDF 无文本时会尝试渲染页面为图片交给视觉模型。
- Word/Excel 通过 `word-extractor` 与 `xlsx` 解析，兼容新旧 Office 格式。
- 加密文件需要提供密码；无法解密时会在上传阶段提示。
- 图片会被限制大小、像素和输出体积，避免超大图造成 OOM 风险。
- 当前多模态模型按“每次最多 1 张图片”发送；多余图片会被跳过并提示。
- 模型配置中可显式开启“视觉输入（图片/扫描件）”。未开启的模型收到图片或扫描件兜底图片时会直接提示该模型不具备视觉能力，不再把视觉请求转发给上游；普通 Word、Excel、文本型 PDF 会先抽取文字，不依赖该开关。

## RAG 知识库与中文检索

RAG 当前仍采用 SQLite 存储和现有 embedding 排序逻辑，适合私有化、离线化和轻量部署场景。系统会把知识库文档拆分为 `knowledge_chunks`，先通过 SQLite FTS5 召回候选分片，再用 embedding 相似度进行最终排序和注入。

### 管理与运维
- 知识库文档支持启用/停用、批量删除、批量重建索引、失败重试、详情查看和分块预览。
- 索引过程记录状态、分块数、已索引分块、进度百分比、错误信息和处理时间；服务重启后会自动恢复卡在处理中的任务。
- RAG 调试面板支持临时调整相似度阈值、topK 和候选数量，展示命中文档、分块、相似度分数和命中状态。
- 调试结果可提交“有用/无用”反馈，便于后续分析低质量文档和低命中查询。
- RAG 上传、删除、启停、重建、批量操作和反馈会写入审计日志；调试接口带速率限制，避免 embedding 服务被过度压测。
- RAG 删除确认、批量确认和文档详情已统一为系统内自定义弹窗，不再依赖浏览器原生 `alert/confirm`。
- 管理员可在实验室设置中配置 RAG 相似度阈值、命中数量和候选数量；保存后会清空 RAG 缓存，确保新参数立即生效。
- Embedding 可在知识管理页配置为统一的 `HTTP 服务`：管理员可维护系统默认配置，普通用户也可维护自己的个人配置；云端、本机和局域网向量服务都通过 HTTP 接入，支持 OpenAI 兼容 `/v1/embeddings` 以及 Ollama 常用的 `/api/embed`、`/api/embeddings`；配置弹窗可按 Base URL 自动获取模型 ID，实际索引请求会在需要时自动补全 `/v1/embeddings`。

### 检索链路
- **候选预过滤**：`knowledge_chunks_fts` 通过触发器自动同步分片检索内容，减少每次查询需要做向量相似度计算的候选数量。
- **中文 ngram 预处理**：索引时会生成 `search_content`，将原文与中文 1-3 gram token 一起写入 FTS 表，改善 `unicode61` 对中文短词、单字和词组召回不足的问题。
- **查询端展开**：用户问题会同步生成中文 ngram 检索词，短中文查询可以更稳定命中知识库候选。
- **结果缓存**：RAG 检索结果支持 TTL 缓存，同一用户的重复问题可以减少 embedding 调用和数据库排序开销。

### 后续演进
- 当前实现不依赖 `sqlite-jieba` 或原生 SQLite 扩展，跨平台部署更稳。
- 当知识库规模继续增大时，可进一步评估 `sqlite-vec`、独立向量库或更成熟的 embedding 索引层。
- 如果中文语义分词质量成为主要瓶颈，可在现有 `rag-tokenizer` 基础上替换为 jieba 类分词器，同时保留当前 ngram 作为召回兜底。

## 远端模型监控与控制

系统监控页中的本机 GPU 指标只代表 Pivot 所在服务器。如果大模型部署在其他服务器，本机 `nvidia-smi` 无法反映远端 GPU 负载。远端模型建议通过模型配置中的以下字段进行保护：

- **端点并发上限**：限制 Pivot 对同一个模型端点同时发起的请求数量。局域网多模态模型如果一次只可靠处理一张图片，建议设置为 `1`。
- **远端健康检查 URL**：填写远端模型服务提供的健康接口，例如 `http://192.168.1.20:8000/health`。

系统会在“系统监控 > 模型端点状态”中展示远端端点的健康探针、并发、排队、失败次数和熔断状态。模型配置中的端点并发填 `0` 时会使用 `MODEL_ENDPOINT_DEFAULT_CONCURRENCY`，当前模板默认值为 `1`。连续失败时会短暂熔断，避免持续压垮远端模型服务。

## 部署指南 (离线/容器化)

### 1. 镜像打包 (需联网环境)
```bash
docker build -t pivot:latest .
docker save -o pivot.tar pivot:latest
```

### 2. 离线部署 (目标局域网)
将 `pivot.tar` 和 `docker-compose.yml` 拷贝至目标服务器：
```bash
docker load -i pivot.tar
docker network create ai-bridge
docker-compose up -d
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

本项目启动时会自动执行数据库迁移。升级到包含视觉能力配置的版本后，历史数据库会自动补齐 `models.supports_vision` 字段。可用以下命令确认容器内代码和数据库字段是否已更新：
```bash
docker exec pivot grep -R "supports_vision" -n /app/server/db/migrate.js
docker exec pivot node -e "const { db } = require('/app/server/db'); console.log(db.prepare('PRAGMA table_info(models)').all().map(c=>c.name))"
docker logs pivot --tail=200
```

如果字段没有出现，通常说明容器仍在运行旧镜像、没有重建容器，或 `/app/data` 挂载目录权限导致 SQLite 迁移失败。

## 快速启动 (开发环境)

1.  **安装依赖**：`npm install`
2.  **配置环境**：复制 `.env.example` 为 `.env` 并配置 `JWT_SECRET`；`.env.example` 只是模板，实际运行读取 `.env`
3.  **启动服务**：`node server/index.js`
4.  **访问系统**：`http://localhost:3000` (默认管理员账号: admin / admin123)

## 关键环境变量

```env
# 登录态有效期
ACCESS_TOKEN_EXPIRES_MINUTES=480
REFRESH_TOKEN_EXPIRES_DAYS=30

# 自动维护
AUDIT_LOG_RETENTION_DAYS=180
API_CALL_LOG_RETENTION_DAYS=30
STORAGE_GC_RETENTION_DAYS=30
STORAGE_GC_BATCH_SIZE=100
SQLITE_INCREMENTAL_VACUUM_PAGES=200
DB_BACKUP_DIR=
DB_BACKUP_RETENTION_DAYS=7
DB_BACKUP_MAX_VERSIONS=7

# 全局 AI 并发与排队
MAX_CONCURRENT_AI_REQUESTS=1
MAX_AI_QUEUE_SIZE=20
AI_QUEUE_TIMEOUT_MS=300000

# 模型端点默认并发上限（模型里填 0 时使用）
MODEL_ENDPOINT_DEFAULT_CONCURRENCY=1
MODEL_ENDPOINT_QUEUE_TIMEOUT_MS=300000

# 本机 GPU 动态保护，仅代表 Pivot 所在服务器
GPU_MONITOR_INTERVAL_MS=15000
GPU_CONCURRENT_MIN=1
GPU_CONCURRENT_MAX=4
GPU_VRAM_REJECT_THRESHOLD=0.97

# RAG 检索与缓存
EMBEDDING_MODE=http
EMBEDDING_API_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=text-embedding-3-small
RAG_CANDIDATE_LIMIT=300
RAG_CACHE_TTL_MS=300000
RAG_CACHE_MAX_ITEMS=500
RAG_SCORE_THRESHOLD=0.4
```


`.env.example` 是配置模板，实际服务启动时读取 `.env`。建议两者保持配置项结构一致，生产部署修改 `.env` 后需要重启服务，新的登录有效期需要重新登录后才会体现在 Cookie 中。

## 目录结构
- `server/`: 后端核心程序 (Express + SQLite)
- `client/`: 前端静态资源 (完全本地化)
- `data/`: 数据库及自动备份存储
- `uploads/`: 用户附件隔离存储

---
## 最近更新
- **后台数据表统一**：用户管理、模型设置、审计日志、附件库、用量统计和用量明细统一紧凑表格、截断提示和每页 15 条展示。
- **Token 统计增强**：输入 Token、输出 Token、总 Token 统计贯通模型调用、用户用量、用量明细和第三方 API Key，所有后台报表统一使用 `K`、`M`、`B` 等短单位。
- **模型配置增强**：模型配置新增输入 Token 上限与思考模型能力，视觉/思考等能力在列表和选择器中改为图标展示。
- **审计与历史用量保留**：删除会话或用户时保留审计日志、用量统计和用量明细记录，确保历史数据可追溯。
- **账号安全边界**：非 `admin` 用户不能重置内置 `admin` 账号密码，账户安全页面表单居中优化。
- **视觉能力配置**：模型配置新增“视觉输入（图片/扫描件）”开关；图片与扫描件请求会提前检查模型能力，普通文档继续走文本抽取链路。
- **模型配置弹窗优化**：编辑模型弹窗改为更宽的两列布局，降低纵向高度，长输入项保留整行展示。
- **并发排队提醒**：聊天请求进入全局或模型端点队列时会显示前面等待请求数、当前生成占用数和最长等待时间，队列满/超时/端点繁忙会展示明确错误原因。
- **排队超时延长**：全局队列和模型端点队列默认等待时间统一调整为 `300000ms`。
- **数据库迁移说明**：文档补充容器升级后检查 `supports_vision` 字段和确认新镜像生效的命令。
- **默认并发收紧**：全局 AI 并发与模型端点默认并发均调整为 `1`，模型端点配置填 `0` 时跟随系统默认。
- **模型标识标准化**：优化兼容接口标识符，支持更直观的第三方客户端接入。
- **消息时间戳与会话分组**：新增消息发送时间显示，并支持侧边栏会话按日期智能分组。
- **UI 细节优化**：登录页增加密码显隐切换，优化 API Key 管理与生成弹窗交互。

**当前版本**: v0.0.24 (Security, Maintenance, Backup & Frontend Hardening)
