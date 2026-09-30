'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_START = '# >>> PIVOT_TYPED_CONFIG_REGISTRY >>>';
const REGISTRY_END = '# <<< PIVOT_TYPED_CONFIG_REGISTRY <<<';
const ROOT = path.resolve(__dirname, '../..');

const ENV_CONFIG_REGISTRY = Object.freeze({
    NODE_ENV: { group: '基础运行', type: 'enum', defaultValue: 'production', values: ['development', 'production', 'test'], description: '服务运行环境。' },
    PORT: { group: '基础运行', type: 'integer', defaultValue: 3000, min: 1, max: 65535, description: 'HTTP 服务监听端口。' },
    LOG_LEVEL: { group: '日志', type: 'enum', defaultValue: 'info', values: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], description: '结构化日志最低输出级别。' },
    LOG_FILE_MAX_BYTES: { group: '日志', type: 'integer', defaultValue: 52_428_800, min: 1_048_576, max: 1_073_741_824, description: '单个日志文件最大字节数。' },
    LOG_FILE_MAX_ARCHIVES: { group: '日志', type: 'integer', defaultValue: 5, min: 1, max: 100, description: '轮转日志保留份数。' },
    PG_POOL_MAX: { group: 'PostgreSQL', type: 'integer', defaultValue: 30, min: 1, max: 200, description: 'PostgreSQL 连接池上限。' },
    PG_STATEMENT_TIMEOUT_MS: { group: 'PostgreSQL', type: 'integer', defaultValue: 20_000, min: 1_000, max: 600_000, description: '普通 SQL 单条执行超时。' },
    PG_ANALYZE_TIMEOUT_MS: { group: 'PostgreSQL 维护', type: 'integer', defaultValue: 60_000, min: 1_000, max: 120_000, description: '单张表 ANALYZE 的执行超时。' },
    PG_ANALYZE_TOTAL_TIMEOUT_MS: { group: 'PostgreSQL 维护', type: 'integer', defaultValue: 600_000, min: 60_000, max: 3_600_000, description: '单轮 ANALYZE 的总时限；到期后从进度游标继续。' },
    PIVOT_EMBED_ALLOWED_ORIGINS: { group: '安全', type: 'csv', defaultValue: '', description: '工作流页面、媒体和 iframe 可使用的外部 Origin 白名单；留空时仅允许同源资源。' },
    PIVOT_PRESENTATION_MAX_BYTES: { group: 'PPT 制作', type: 'integer', defaultValue: 8_388_608, min: 262_144, max: 67_108_864, description: '单份演示文稿结构化 IR 的最大字节数，限制页面、文本和内嵌表格数据，避免编辑与渲染耗尽内存。' },
    PIVOT_PRESENTATION_ASSET_MAX_BYTES: { group: 'PPT 制作', type: 'integer', defaultValue: 20_971_520, min: 1_048_576, max: 67_108_864, description: '单个 PPT 图片素材允许上传的最大字节数；素材仍受安全上传 MIME、真实文件头与 CAS 归属校验。' },
    PIVOT_ELECTRON_LOCALES: { group: '桌面交付', type: 'csv', defaultValue: 'zh-CN,en-US', itemPattern: /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/, description: '桌面安装包保留的 Electron 语言包。' },
    PIVOT_CHROMIUM_LOCALES: { group: '桌面交付', type: 'csv', defaultValue: 'zh-CN,en-US', itemPattern: /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/, description: '本地 Agent Chromium 运行时保留的语言包。' },
    PIVOT_CHAT_AUTO_ROUTE_ENABLED: { group: '对话自适应路由', type: 'boolean', defaultValue: true, description: '是否启用对话的统一自适应路由总开关。关闭后保留原有 RAG 与 MCP 流程。' },
    PIVOT_CHAT_AUTO_RAG_ENABLED: { group: '对话自适应路由', type: 'boolean', defaultValue: true, description: '是否在问题明确要求或确实依赖受控资料时，自动检索并缩小知识库 Collection 范围；普通问答不会触发检索。' },
    PIVOT_CHAT_AUTO_TOOL_DISCOVERY_ENABLED: { group: '对话自适应路由', type: 'boolean', defaultValue: true, description: '是否在用户明确需要实时数据、本机文件、指定网页或外部操作时，自动发现受治理的 MCP 工具；普通回答不会触发授权。' },
    PIVOT_CHAT_ROUTE_SHADOW_MODE: { group: '对话自适应路由', type: 'boolean', defaultValue: false, description: '是否仅记录路由建议而不改变 RAG 与 MCP 的实际候选范围。' },
    PIVOT_CHAT_ROUTE_MAX_TOOL_CANDIDATES: { group: '对话自适应路由', type: 'integer', defaultValue: 4, min: 1, max: 12, description: '自动工具发现传给 MCP Planner 的最大候选工具数。' },
    PIVOT_CHAT_ROUTE_MAX_COLLECTIONS: { group: '对话自适应路由', type: 'integer', defaultValue: 2, min: 1, max: 8, description: '自动知识库路由选取的最大 Collection 数。' },
    PIVOT_CHAT_ROUTE_RAG_THRESHOLD: { group: '对话自适应路由', type: 'number', defaultValue: 0.58, min: 0, max: 1, description: '自动定向检索 Collection 所需的高置信度阈值。' },
    PIVOT_CHAT_ROUTE_RAG_GRAY_THRESHOLD: { group: '对话自适应路由', type: 'number', defaultValue: 0.38, min: 0, max: 1, description: '知识库路由的低置信度阈值；低于该值时跳过自动检索。' },
    PIVOT_CHAT_ROUTE_TOOL_THRESHOLD: { group: '对话自适应路由', type: 'number', defaultValue: 0.34, min: 0, max: 1, description: '无强规则命中时，工具候选进入 MCP Planner 的最低综合分。' },
    PIVOT_CHAT_ROUTE_EMBEDDING_TIMEOUT_MS: { group: '对话自适应路由', type: 'integer', defaultValue: 2500, min: 100, max: 30000, description: '对话路由等待 Query Embedding 的最大时长；超时后安全降级。' },
    PIVOT_CHAT_PROMPT_CACHE_ENABLED: { group: '对话自适应路由', type: 'boolean', defaultValue: true, description: '是否在 Responses API 的兼容模型上请求会话隔离的 Prompt Cache；不支持的端点会自动重试并降级。' },
    PIVOT_CHAT_PROMPT_CACHE_TTL: { group: '对话自适应路由', type: 'enum', defaultValue: '30m', values: ['30m'], description: 'Responses API Prompt Cache 的最短复用时间。' },
    PIVOT_KNOWLEDGE_WIKI_ENABLED: { group: '知识库 LLM Wiki', type: 'boolean', defaultValue: true, description: '是否启用知识库的派生 LLM Wiki Space、编译和只读检索能力；关闭后不执行新的 Wiki 编译任务。' },
    PIVOT_KNOWLEDGE_WIKI_MAX_SOURCE_BLOCKS: { group: '知识库 LLM Wiki', type: 'integer', defaultValue: 12, min: 1, max: 30, description: '单次 Wiki 编译最多提供给模型的已发布原始资料区块数，避免无界上下文。' },
    PIVOT_KNOWLEDGE_WIKI_MAX_PAGES_PER_RUN: { group: '知识库 LLM Wiki', type: 'integer', defaultValue: 3, min: 1, max: 10, description: '单次 Wiki 编译可生成的候选页面上限；页面仍需来源校验和审核发布。' },
    PIVOT_KNOWLEDGE_WIKI_MAX_OUTPUT_TOKENS: { group: '知识库 LLM Wiki', type: 'integer', defaultValue: 2200, min: 512, max: 8000, description: '单次 Wiki 编译模型输出 Token 上限。' },
    PIVOT_KNOWLEDGE_WIKI_TIMEOUT_MS: { group: '知识库 LLM Wiki', type: 'integer', defaultValue: 120000, min: 10000, max: 600000, description: '单次 Wiki 编译模型调用超时；失败时保留旧已发布页面。' },
    PIVOT_KNOWLEDGE_WIKI_AUTO_COMPILE: { group: '知识库 LLM Wiki', type: 'boolean', defaultValue: false, description: '是否在资料变更后自动创建 Wiki 编译任务；默认关闭，先由管理员手动触发和审核。' },
    PIVOT_KNOWLEDGE_WIKI_REQUIRE_REVIEW: { group: '知识库 LLM Wiki', type: 'boolean', defaultValue: true, description: 'Wiki 候选页面是否必须进入 review 后才能发布；建议生产保持 true。' },
    PIVOT_KNOWLEDGE_WIKI_SEARCH_LIMIT: { group: '知识库 LLM Wiki', type: 'integer', defaultValue: 5, min: 1, max: 20, description: '单次 Wiki 只读检索的最大页面数；原始资料仍保留独立检索与引用校验。' },
    PIVOT_KNOWLEDGE_WIKI_WORKER_ENABLED: { group: '知识库 LLM Wiki', type: 'boolean', defaultValue: true, description: '是否启动可恢复的 Wiki 编译 Worker；关闭后仍可创建任务，但不会由后台自动领取。' },
    PIVOT_KNOWLEDGE_WIKI_WORKER_POLL_INTERVAL_MS: { group: '知识库 LLM Wiki', type: 'integer', defaultValue: 2000, min: 250, max: 60000, description: 'Wiki 编译 Worker 领取任务和恢复失效租约的轮询间隔。' },
    PIVOT_DECISION_PROVIDER_MODE: { group: '智能决策与持续学习', type: 'enum', defaultValue: 'shadow', values: ['disabled', 'shadow', 'active'], description: '统一业务决策器的运行方式；默认影子模式仅记录建议，active 通过策略阈值后才可改变可执行动作。' },
    PIVOT_DECISION_POLICY_VERSION: { group: '智能决策与持续学习', type: 'string', defaultValue: 'decision-policy-v1', description: '当前决策策略和校准参数的版本标识，所有决策记录均携带该值以支持回溯和回滚。' },
    PIVOT_DECISION_EVALUATION_SET_VERSION: { group: '智能决策与持续学习', type: 'string', defaultValue: 'v2', description: 'active 灰度与正式比较所需的已导入、已审核冻结评测集版本。' },
    PIVOT_DECISION_AUTO_THRESHOLD: { group: '智能决策与持续学习', type: 'number', defaultValue: 0.58, min: 0, max: 1, description: '低风险业务动作允许由决策策略自动采用的最低校准置信度。' },
    PIVOT_DECISION_HIGH_RISK_THRESHOLD: { group: '智能决策与持续学习', type: 'number', defaultValue: 0.85, min: 0, max: 1, description: '中高风险或需审批动作的决策阈值；需审批动作仍不会被自动执行。' },
    PIVOT_DECISION_CALIBRATION_SCALE: { group: '智能决策与持续学习', type: 'number', defaultValue: 1, min: 0.1, max: 10, description: '决策器分数校准的 logit 缩放参数；只能在离线评测通过后版本化更新。' },
    PIVOT_DECISION_CALIBRATION_INTERCEPT: { group: '智能决策与持续学习', type: 'number', defaultValue: 0, min: -10, max: 10, description: '决策器分数校准的 logit 截距；只能在离线评测通过后版本化更新。' },
    PIVOT_DECISION_ROLLOUT_PERCENT: { group: '智能决策与持续学习', type: 'integer', defaultValue: 0, min: 0, max: 100, description: 'active 模式中允许策略实际改路由的稳定灰度比例；0 可立即全量回退到影子模式。' },
    PIVOT_DECISION_ROLLOUT_TENANTS: { group: '智能决策与持续学习', type: 'csv', defaultValue: '', description: '允许进入 active 灰度的租户 ID 白名单；留空时不限制租户。' },
    PIVOT_DECISION_ROLLOUT_SCENARIOS: { group: '智能决策与持续学习', type: 'csv', defaultValue: '', description: '允许进入 active 灰度的业务场景白名单；留空时不限制场景。' },
    PIVOT_DECISION_REQUIRE_ACTIVE_ARTIFACT: { group: '智能决策与持续学习', type: 'boolean', defaultValue: true, description: 'active 灰度是否只允许已通过评测并在模型注册表激活的学习型决策器参与；建议生产保持 true。' },
    PIVOT_DECISION_USE_ACTIVE_POLICY_ARTIFACT: { group: '智能决策与持续学习', type: 'boolean', defaultValue: true, description: '是否在 active 灰度使用已激活、通过评测的策略参数制品；找不到制品时安全降回影子。' },
    PIVOT_DECISION_ARTIFACT_TIMEOUT_MS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 100, min: 25, max: 5000, description: 'active 灰度读取模型制品激活状态的最大等待时间；超时后学习型提供器安全不参与本轮决策。' },
    PIVOT_DECISION_GPU_SAMPLE_TIMEOUT_MS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 3000, min: 100, max: 30000, description: '决策基准和发布证据采集等待单次 GPU 采样的最大时长；采样超时只记录不可用，不阻塞发布检查。' },
    PIVOT_DECISION_PREFERENCES_ENABLED: { group: '智能决策与持续学习', type: 'boolean', defaultValue: true, description: '是否启用用户和租户级的显式默认路径偏好；偏好仍受当前允许候选与审批规则约束。' },
    PIVOT_DECISION_INCLUDE_REDACTED_ROUTING_TEXT: { group: '智能决策与持续学习', type: 'boolean', defaultValue: false, description: '是否向 Laya/Qwen 决策器发送有限长度、规则脱敏后的路由文本；该文本不写入决策日志或训练导出，启用前需完成数据治理审批。' },
    PIVOT_DECISION_PREFERENCE_TIMEOUT_MS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 100, min: 25, max: 5000, description: '读取可选用户或租户路由偏好的最大等待时间；超时后安全回退到无偏好策略。' },
    PIVOT_DECISION_MAINTENANCE_ENABLED: { group: '智能决策与持续学习', type: 'boolean', defaultValue: true, description: '是否启用决策学习维护巡检；巡检汇总样本与错误、清理超过保留期的决策记录，但不会自动训练或发布。' },
    PIVOT_DECISION_BREAKER_ENABLED: { group: '智能决策与持续学习', type: 'boolean', defaultValue: true, description: '是否启用决策模型制品熔断巡检；只有评测报告冻结了熔断阈值的 active 制品才会被自动退役。' },
    PIVOT_DECISION_BREAKER_INTERVAL_MS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 300000, min: 60000, max: 86400000, description: '决策模型制品熔断巡检间隔。' },
    PIVOT_DECISION_BREAKER_WINDOW_MINUTES: { group: '智能决策与持续学习', type: 'integer', defaultValue: 30, min: 1, max: 1440, description: '决策模型制品熔断统计窗口。' },
    PIVOT_DECISION_MAINTENANCE_INTERVAL_MS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 21600000, min: 60000, max: 86400000, description: '决策学习维护巡检的运行间隔。' },
    PIVOT_DECISION_MAINTENANCE_LOOKBACK_DAYS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 30, min: 1, max: 3650, description: '决策学习维护报告统计的最近天数。' },
    PIVOT_DECISION_MIN_VERIFIED_SAMPLES: { group: '智能决策与持续学习', type: 'integer', defaultValue: 30, min: 1, max: 100000, description: '场景和租户达到可训练状态所需的最少已核验样本数。' },
    PIVOT_DECISION_RECORD_RETENTION_DAYS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 180, min: 1, max: 3650, description: '决策记录与其结果的保留天数；到期记录在维护巡检中级联删除，模型制品和冻结评测审计不受影响。' },
    PIVOT_DECISION_ALLOW_GLOBAL_TRAINING: { group: '智能决策与持续学习', type: 'boolean', defaultValue: false, description: '是否已取得跨租户脱敏训练的数据治理批准；默认 false，即使 CLI 传入 --allow-global 也会拒绝全局训练。' },
    PIVOT_LIGHT_DECISION_ENABLED: { group: '智能决策与持续学习', type: 'boolean', defaultValue: false, description: '是否启用本地线性轻量决策器；仅加载已通过评测并登记的本地 JSON 模型。' },
    PIVOT_LIGHT_DECISION_MODEL_ROOT: { group: '智能决策与持续学习', type: 'string', defaultValue: 'data/decision-models', description: '本地轻量决策模型目录；生产应使用审核导入的只读制品路径。' },
    PIVOT_LIGHT_DECISION_MODEL_FILE: { group: '智能决策与持续学习', type: 'string', defaultValue: '', description: '当前启用的轻量决策模型 JSON 文件名；留空时该提供器安全降级。' },
    PIVOT_LIGHT_DECISION_WEIGHT: { group: '智能决策与持续学习', type: 'number', defaultValue: 1, min: 0, max: 10, description: '本地轻量决策器输出参与策略融合的相对权重。' },
    PIVOT_QWEN_DECISION_ENABLED: { group: '智能决策与持续学习', type: 'boolean', defaultValue: false, description: '是否让当前已选的 Qwen 模型以结构化、无思考模式提供业务决策建议。' },
    PIVOT_QWEN_DECISION_VERSION: { group: '智能决策与持续学习', type: 'string', defaultValue: '', description: '审核通过的 Qwen 决策模型版本或权重哈希；active 灰度时必须与已激活制品一致。' },
    PIVOT_QWEN_DECISION_MAX_TOKENS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 256, min: 64, max: 1024, description: 'Qwen 结构化业务决策的最大输出 Token，避免与最终生成任务争用过多资源。' },
    PIVOT_QWEN_DECISION_TIMEOUT_MS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 1200, min: 100, max: 30000, description: 'Qwen 结构化决策的硬超时，包含模型排队；超时后仅保留既有路由。' },
    PIVOT_QWEN_DECISION_MAX_CONCURRENT: { group: '智能决策与持续学习', type: 'integer', defaultValue: 1, min: 1, max: 100, description: '单进程内 Qwen 决策调用最大并发数；默认保留生成容量，达到上限时直接保持既有路由。' },
    PIVOT_QWEN_DECISION_WEIGHT: { group: '智能决策与持续学习', type: 'number', defaultValue: 1, min: 0, max: 10, description: 'Qwen 结构化决策输出参与策略融合的相对权重。' },
    PIVOT_LAYA_DECISION_ENABLED: { group: '智能决策与持续学习', type: 'boolean', defaultValue: false, description: '是否调用内网 Laya 业务决策服务；首次上线应配合 shadow 模式。' },
    PIVOT_LAYA_DECISION_URL: { group: '智能决策与持续学习', type: 'string', defaultValue: '', description: '内网 Laya 决策服务的 HTTP 地址。服务只接收脱敏后的任务状态和允许动作。' },
    PIVOT_LAYA_DECISION_VERSION: { group: '智能决策与持续学习', type: 'string', defaultValue: '', description: '已审核的 Laya 权重和校准版本（或权重哈希）标识。' },
    PIVOT_LAYA_DECISION_TIMEOUT_MS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 1200, min: 100, max: 30000, description: '调用内网 Laya 决策服务的单次超时；超时不会中断原有聊天链路。' },
    PIVOT_LAYA_DECISION_HEALTH_URL: { group: '智能决策与持续学习', type: 'string', defaultValue: '', description: '内网 Laya 决策服务健康检查地址；留空时仅检查决策服务是否被配置。' },
    PIVOT_LAYA_DECISION_HEALTH_TIMEOUT_MS: { group: '智能决策与持续学习', type: 'integer', defaultValue: 800, min: 100, max: 30000, description: '内网 Laya 健康检查超时；健康检查失败不影响原有聊天回退。' },
    PIVOT_LAYA_DECISION_MAX_CONCURRENT: { group: '智能决策与持续学习', type: 'integer', defaultValue: 4, min: 1, max: 100, description: '单进程内 Laya 决策服务的最大并发调用数；达到上限时自动保持既有路由。' },
    PIVOT_LAYA_DECISION_WEIGHT: { group: '智能决策与持续学习', type: 'number', defaultValue: 1, min: 0, max: 10, description: 'Laya 输出参与策略融合的相对权重；应依据固定评测集调整。' },
    PIVOT_LONG_TERM_MEMORY_SHADOW_MODE: { group: '长期记忆', type: 'boolean', defaultValue: false, description: '仅影子比较旧版与新版长期记忆排序，不改变实际注入结果；用于灰度前评测。' },
    LONG_TERM_MEMORY_MIN_RELEVANCE: { group: '长期记忆', type: 'number', defaultValue: 0.08, min: 0.01, max: 0.95, description: '长期记忆进入最终上下文的最低融合相关性，避免仅因重要度而注入无关记忆。' },
    LONG_TERM_MEMORY_LOW_VALUE_ARCHIVE_DAYS: { group: '长期记忆', type: 'integer', defaultValue: 180, min: 30, max: 3650, description: '低重要度、低置信度且长期未使用的历史片段自动归档天数。' },
    PIVOT_TOOL_MAX_CONCURRENT_PER_TOOL: { group: '工具库执行治理', type: 'integer', defaultValue: 4, min: 1, max: 100, description: '单进程内同一工具/连接的最大并发执行数；超过后快速拒绝，避免下游雪崩。' },
    PIVOT_TOOL_MAX_CALLS_PER_MINUTE: { group: '工具库执行治理', type: 'integer', defaultValue: 120, min: 1, max: 100000, description: '单进程内同一工具/连接每分钟最大调用数；用于保护下游服务和账号配额。' },
    PIVOT_TOOL_CIRCUIT_FAILURE_THRESHOLD: { group: '工具库执行治理', type: 'integer', defaultValue: 5, min: 1, max: 100, description: '同一工具/连接连续临时失败达到该阈值后开启熔断保护。' },
    PIVOT_TOOL_CIRCUIT_COOLDOWN_MS: { group: '工具库执行治理', type: 'integer', defaultValue: 30000, min: 1000, max: 1800000, description: '工具熔断后的冷却时间；冷却结束只允许一次半开恢复探测。' },
    PIVOT_ALLOW_INSECURE_OAUTH_HTTP: { group: '工具库执行治理', type: 'boolean', defaultValue: false, description: '是否仅为本地开发允许 OAuth 授权端点和回调使用 HTTP；生产环境必须保持 false。' },
    KNOWLEDGE_LOCAL_SOURCE_ROOTS: { group: '知识库局域网来源', type: 'csv', defaultValue: '', description: '允许被本地目录知识源扫描的绝对路径白名单，多个路径用英文逗号分隔；留空时禁用目录同步。' },
    KNOWLEDGE_SOURCE_MAX_FILES: { group: '知识库局域网来源', type: 'integer', defaultValue: 5000, min: 1, max: 100000, description: '单次局域网目录同步最多扫描的文件数，超出后需拆分数据源。' },
    KNOWLEDGE_SOURCE_SCHEDULE_INTERVAL_MS: { group: '知识库局域网来源', type: 'integer', defaultValue: 300000, min: 10000, max: 86400000, description: '后台轮询 scheduled/watch 知识来源的最短间隔；目录 watch 也以安全轮询方式实现。' },
    KNOWLEDGE_EMBEDDING_RECOVERY_INTERVAL_MS: { group: '知识库局域网来源', type: 'integer', defaultValue: 300000, min: 60000, max: 86400000, description: 'Embedding 服务恢复后扫描 lexical_ready 文档并补齐向量索引的间隔。' },
    AGENT_WEB_SEARCH_ENDPOINT: { group: 'Agent 网页检索', type: 'string', defaultValue: '', description: '受控网页检索 Provider 的 HTTPS JSON Endpoint；运行任务仍须在网络策略中显式允许该 Origin。' },
    AGENT_WEB_SEARCH_CREDENTIAL: { group: 'Agent 网页检索', type: 'string', defaultValue: '', description: '可选的工作流凭据引用名；设置后优先用其作为网页检索 Provider 凭据。' },
    AGENT_WEB_SEARCH_API_KEY: { group: 'Agent 网页检索', type: 'string', defaultValue: '', description: '可选网页检索 Provider 密钥；仅在未配置凭据引用时使用，生产环境建议改用凭据引用。' },
    AGENT_WEB_SEARCH_HEADER: { group: 'Agent 网页检索', type: 'string', defaultValue: 'Authorization', description: '网页检索 Provider 凭据请求头名称。' },
    AGENT_WEB_SEARCH_PREFIX: { group: 'Agent 网页检索', type: 'string', defaultValue: 'Bearer', description: '网页检索 Provider 凭据请求头前缀；运行时会自动补一个空格。' },
    AGENT_IMAGE_GENERATION_ENDPOINT: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '受控图片生成 Provider 的 HTTPS JSON Endpoint；运行任务仍须显式允许该 Origin。' },
    AGENT_IMAGE_GENERATION_CREDENTIAL: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '可选图片生成 Provider 凭据引用名；生产环境优先使用凭据引用。' },
    AGENT_IMAGE_GENERATION_API_KEY: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '可选图片生成 Provider 密钥；仅在未设置凭据引用时使用。' },
    AGENT_IMAGE_GENERATION_HEADER: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: 'Authorization', description: '图片生成 Provider 凭据请求头名称。' },
    AGENT_IMAGE_GENERATION_PREFIX: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: 'Bearer', description: '图片生成 Provider 凭据请求头前缀；运行时自动补一个空格。' },
    AGENT_TTS_ENDPOINT: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '受控语音合成 Provider 的 HTTPS JSON Endpoint；运行任务仍须显式允许该 Origin。' },
    AGENT_TTS_CREDENTIAL: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '可选语音合成 Provider 凭据引用名；生产环境优先使用凭据引用。' },
    AGENT_TTS_API_KEY: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: '', description: '可选语音合成 Provider 密钥；仅在未设置凭据引用时使用。' },
    AGENT_TTS_HEADER: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: 'Authorization', description: '语音合成 Provider 凭据请求头名称。' },
    AGENT_TTS_PREFIX: { group: 'Agent 多模态 Provider', type: 'string', defaultValue: 'Bearer', description: '语音合成 Provider 凭据请求头前缀；运行时自动补一个空格。' }
});

function normalizeInteger(value, definition) {
    const parsed = Number.parseInt(value, 10);
    const fallback = Number(definition.defaultValue);
    const candidate = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(definition.max, Math.max(definition.min, candidate));
}

function normalizeNumber(value, definition) {
    const parsed = Number.parseFloat(value);
    const fallback = Number(definition.defaultValue);
    const candidate = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(definition.max, Math.max(definition.min, candidate));
}

function normalizeBoolean(value, definition) {
    if (value === undefined || value === null || String(value).trim() === '') return Boolean(definition.defaultValue);
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return Boolean(definition.defaultValue);
}

function normalizeCsv(value, definition) {
    const raw = String(value ?? definition.defaultValue ?? '');
    const values = raw.split(',').map(item => item.trim()).filter(Boolean);
    const valid = values.filter(item => !definition.itemPattern || definition.itemPattern.test(item));
    return [...new Set(valid.length ? valid : String(definition.defaultValue || '').split(',').map(item => item.trim()).filter(Boolean))];
}

function readTypedEnv(name, env = process.env) {
    const definition = ENV_CONFIG_REGISTRY[name];
    if (!definition) throw new Error(`未登记的类型化环境变量：${name}`);
    const raw = env[name];
    if (definition.type === 'integer') return normalizeInteger(raw, definition);
    if (definition.type === 'number') return normalizeNumber(raw, definition);
    if (definition.type === 'boolean') return normalizeBoolean(raw, definition);
    if (definition.type === 'csv') return normalizeCsv(raw, definition);
    if (definition.type === 'enum') {
        const value = String(raw || definition.defaultValue || '').trim();
        return definition.values.includes(value) ? value : definition.defaultValue;
    }
    return String(raw ?? definition.defaultValue ?? '');
}

function formatDefault(definition) {
    return Array.isArray(definition.defaultValue) ? definition.defaultValue.join(',') : String(definition.defaultValue ?? '');
}

function renderEnvRegistryBlock() {
    const groups = new Map();
    Object.entries(ENV_CONFIG_REGISTRY).forEach(([name, definition]) => {
        const values = groups.get(definition.group) || [];
        values.push([name, definition]);
        groups.set(definition.group, values);
    });
    const lines = [REGISTRY_START, '# 以下核心参数由 server/config/env-registry.js 统一定义和校验。'];
    groups.forEach((entries, group) => {
        lines.push(`# --- ${group} ---`);
        entries.forEach(([name, definition]) => {
            lines.push(`# ${definition.description}`);
            lines.push(`${name}=${formatDefault(definition)}`);
        });
    });
    lines.push(REGISTRY_END);
    return `${lines.join('\n')}\n`;
}

function renderRegistryDocumentation() {
    const lines = [
        '# 类型化配置注册表',
        '',
        '> 此文档由 `server/config/env-registry.js` 生成；请修改注册表，而不是手工编辑本文档。',
        ''
    ];
    const groups = new Map();
    Object.entries(ENV_CONFIG_REGISTRY).forEach(([name, definition]) => {
        const values = groups.get(definition.group) || [];
        values.push([name, definition]);
        groups.set(definition.group, values);
    });
    groups.forEach((entries, group) => {
        lines.push(`## ${group}`, '', '| 环境变量 | 类型 | 默认值 | 校验 | 说明 |', '| --- | --- | --- | --- | --- |');
        entries.forEach(([name, definition]) => {
            const validation = ['integer', 'number'].includes(definition.type)
                ? `${definition.min}–${definition.max}`
                : definition.type === 'enum' ? definition.values.join('、') : definition.type === 'boolean' ? 'true / false' : '逗号分隔的语言标记';
            lines.push(`| \`${name}\` | ${definition.type} | \`${formatDefault(definition)}\` | ${validation} | ${definition.description} |`);
        });
        lines.push('');
    });
    return `${lines.join('\n')}\n`;
}

function replaceRegistryBlock(source) {
    const block = renderEnvRegistryBlock().trimEnd();
    const pattern = new RegExp(`${REGISTRY_START}[\\s\\S]*?${REGISTRY_END}`);
    if (!pattern.test(source)) throw new Error('`.env.example` 缺少类型化配置注册表标记块。');
    const replaced = source.replace(pattern, block);
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
}

function writeRegistryArtifacts(rootDir = ROOT) {
    const root = path.resolve(rootDir);
    const envPath = path.join(root, '.env.example');
    const docsPath = path.join(root, 'docs', 'configuration-registry.md');
    fs.writeFileSync(envPath, replaceRegistryBlock(fs.readFileSync(envPath, 'utf8')), 'utf8');
    fs.writeFileSync(docsPath, renderRegistryDocumentation(), 'utf8');
}

function assertRegistryArtifacts(rootDir = ROOT) {
    const root = path.resolve(rootDir);
    const envPath = path.join(root, '.env.example');
    const docsPath = path.join(root, 'docs', 'configuration-registry.md');
    const expectedEnv = replaceRegistryBlock(fs.readFileSync(envPath, 'utf8'));
    if (fs.readFileSync(envPath, 'utf8') !== expectedEnv) throw new Error('`.env.example` 的类型化配置块已过期；请运行 npm run generate:config-docs。');
    if (!fs.existsSync(docsPath) || fs.readFileSync(docsPath, 'utf8') !== renderRegistryDocumentation()) {
        throw new Error('`docs/configuration-registry.md` 已过期；请运行 npm run generate:config-docs。');
    }
}

module.exports = {
    assertRegistryArtifacts,
    readTypedEnv,
    writeRegistryArtifacts
};
