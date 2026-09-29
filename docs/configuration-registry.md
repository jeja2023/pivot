# 类型化配置注册表

> 此文档由 `server/config/env-registry.js` 生成；请修改注册表，而不是手工编辑本文档。

## 基础运行

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | enum | `production` | development、production、test | 服务运行环境。 |
| `PORT` | integer | `3000` | 1–65535 | HTTP 服务监听端口。 |

## 日志

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `LOG_LEVEL` | enum | `info` | fatal、error、warn、info、debug、trace、silent | 结构化日志最低输出级别。 |
| `LOG_FILE_MAX_BYTES` | integer | `52428800` | 1048576–1073741824 | 单个日志文件最大字节数。 |
| `LOG_FILE_MAX_ARCHIVES` | integer | `5` | 1–100 | 轮转日志保留份数。 |

## PostgreSQL

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PG_POOL_MAX` | integer | `30` | 1–200 | PostgreSQL 连接池上限。 |
| `PG_STATEMENT_TIMEOUT_MS` | integer | `20000` | 1000–600000 | 普通 SQL 单条执行超时。 |

## PostgreSQL 维护

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PG_ANALYZE_TIMEOUT_MS` | integer | `60000` | 1000–120000 | 单张表 ANALYZE 的执行超时。 |
| `PG_ANALYZE_TOTAL_TIMEOUT_MS` | integer | `600000` | 60000–3600000 | 单轮 ANALYZE 的总时限；到期后从进度游标继续。 |

## 安全

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_EMBED_ALLOWED_ORIGINS` | csv | `` | 逗号分隔的语言标记 | 工作流页面、媒体和 iframe 可使用的外部 Origin 白名单；留空时仅允许同源资源。 |

## PPT 制作

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_PRESENTATION_MAX_BYTES` | integer | `8388608` | 262144–67108864 | 单份演示文稿结构化 IR 的最大字节数，限制页面、文本和内嵌表格数据，避免编辑与渲染耗尽内存。 |
| `PIVOT_PRESENTATION_ASSET_MAX_BYTES` | integer | `20971520` | 1048576–67108864 | 单个 PPT 图片素材允许上传的最大字节数；素材仍受安全上传 MIME、真实文件头与 CAS 归属校验。 |

## 桌面交付

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_ELECTRON_LOCALES` | csv | `zh-CN,en-US` | 逗号分隔的语言标记 | 桌面安装包保留的 Electron 语言包。 |
| `PIVOT_CHROMIUM_LOCALES` | csv | `zh-CN,en-US` | 逗号分隔的语言标记 | 本地 Agent Chromium 运行时保留的语言包。 |

## 对话自适应路由

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_CHAT_AUTO_ROUTE_ENABLED` | boolean | `true` | true / false | 是否启用对话的统一自适应路由总开关。关闭后保留原有 RAG 与 MCP 流程。 |
| `PIVOT_CHAT_AUTO_RAG_ENABLED` | boolean | `true` | true / false | 是否在问题明确要求或确实依赖受控资料时，自动检索并缩小知识库 Collection 范围；普通问答不会触发检索。 |
| `PIVOT_CHAT_AUTO_TOOL_DISCOVERY_ENABLED` | boolean | `true` | true / false | 是否在用户明确需要实时数据、本机文件、指定网页或外部操作时，自动发现受治理的 MCP 工具；普通回答不会触发授权。 |
| `PIVOT_CHAT_ROUTE_SHADOW_MODE` | boolean | `false` | true / false | 是否仅记录路由建议而不改变 RAG 与 MCP 的实际候选范围。 |
| `PIVOT_CHAT_ROUTE_MAX_TOOL_CANDIDATES` | integer | `4` | 1–12 | 自动工具发现传给 MCP Planner 的最大候选工具数。 |
| `PIVOT_CHAT_ROUTE_MAX_COLLECTIONS` | integer | `2` | 1–8 | 自动知识库路由选取的最大 Collection 数。 |
| `PIVOT_CHAT_ROUTE_RAG_THRESHOLD` | number | `0.58` | 0–1 | 自动定向检索 Collection 所需的高置信度阈值。 |
| `PIVOT_CHAT_ROUTE_RAG_GRAY_THRESHOLD` | number | `0.38` | 0–1 | 知识库路由的低置信度阈值；低于该值时跳过自动检索。 |
| `PIVOT_CHAT_ROUTE_TOOL_THRESHOLD` | number | `0.34` | 0–1 | 无强规则命中时，工具候选进入 MCP Planner 的最低综合分。 |
| `PIVOT_CHAT_ROUTE_EMBEDDING_TIMEOUT_MS` | integer | `2500` | 100–30000 | 对话路由等待 Query Embedding 的最大时长；超时后安全降级。 |
| `PIVOT_CHAT_PROMPT_CACHE_ENABLED` | boolean | `true` | true / false | 是否在 Responses API 的兼容模型上请求会话隔离的 Prompt Cache；不支持的端点会自动重试并降级。 |
| `PIVOT_CHAT_PROMPT_CACHE_TTL` | enum | `30m` | 30m | Responses API Prompt Cache 的最短复用时间。 |

## 智能决策与持续学习

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_DECISION_PROVIDER_MODE` | enum | `shadow` | disabled、shadow、active | 统一业务决策器的运行方式；默认影子模式仅记录建议，active 通过策略阈值后才可改变可执行动作。 |
| `PIVOT_DECISION_POLICY_VERSION` | string | `decision-policy-v1` | 逗号分隔的语言标记 | 当前决策策略和校准参数的版本标识，所有决策记录均携带该值以支持回溯和回滚。 |
| `PIVOT_DECISION_EVALUATION_SET_VERSION` | string | `v2` | 逗号分隔的语言标记 | active 灰度与正式比较所需的已导入、已审核冻结评测集版本。 |
| `PIVOT_DECISION_AUTO_THRESHOLD` | number | `0.58` | 0–1 | 低风险业务动作允许由决策策略自动采用的最低校准置信度。 |
| `PIVOT_DECISION_HIGH_RISK_THRESHOLD` | number | `0.85` | 0–1 | 中高风险或需审批动作的决策阈值；需审批动作仍不会被自动执行。 |
| `PIVOT_DECISION_CALIBRATION_SCALE` | number | `1` | 0.1–10 | 决策器分数校准的 logit 缩放参数；只能在离线评测通过后版本化更新。 |
| `PIVOT_DECISION_CALIBRATION_INTERCEPT` | number | `0` | -10–10 | 决策器分数校准的 logit 截距；只能在离线评测通过后版本化更新。 |
| `PIVOT_DECISION_ROLLOUT_PERCENT` | integer | `0` | 0–100 | active 模式中允许策略实际改路由的稳定灰度比例；0 可立即全量回退到影子模式。 |
| `PIVOT_DECISION_ROLLOUT_TENANTS` | csv | `` | 逗号分隔的语言标记 | 允许进入 active 灰度的租户 ID 白名单；留空时不限制租户。 |
| `PIVOT_DECISION_ROLLOUT_SCENARIOS` | csv | `` | 逗号分隔的语言标记 | 允许进入 active 灰度的业务场景白名单；留空时不限制场景。 |
| `PIVOT_DECISION_REQUIRE_ACTIVE_ARTIFACT` | boolean | `true` | true / false | active 灰度是否只允许已通过评测并在模型注册表激活的学习型决策器参与；建议生产保持 true。 |
| `PIVOT_DECISION_USE_ACTIVE_POLICY_ARTIFACT` | boolean | `true` | true / false | 是否在 active 灰度使用已激活、通过评测的策略参数制品；找不到制品时安全降回影子。 |
| `PIVOT_DECISION_ARTIFACT_TIMEOUT_MS` | integer | `100` | 25–5000 | active 灰度读取模型制品激活状态的最大等待时间；超时后学习型提供器安全不参与本轮决策。 |
| `PIVOT_DECISION_PREFERENCES_ENABLED` | boolean | `true` | true / false | 是否启用用户和租户级的显式默认路径偏好；偏好仍受当前允许候选与审批规则约束。 |
| `PIVOT_DECISION_INCLUDE_REDACTED_ROUTING_TEXT` | boolean | `false` | true / false | 是否向 Laya/Qwen 决策器发送有限长度、规则脱敏后的路由文本；该文本不写入决策日志或训练导出，启用前需完成数据治理审批。 |
| `PIVOT_DECISION_PREFERENCE_TIMEOUT_MS` | integer | `100` | 25–5000 | 读取可选用户或租户路由偏好的最大等待时间；超时后安全回退到无偏好策略。 |
| `PIVOT_DECISION_MAINTENANCE_ENABLED` | boolean | `true` | true / false | 是否启用决策学习维护巡检；巡检汇总样本与错误、清理超过保留期的决策记录，但不会自动训练或发布。 |
| `PIVOT_DECISION_BREAKER_ENABLED` | boolean | `true` | true / false | 是否启用决策模型制品熔断巡检；只有评测报告冻结了熔断阈值的 active 制品才会被自动退役。 |
| `PIVOT_DECISION_BREAKER_INTERVAL_MS` | integer | `300000` | 60000–86400000 | 决策模型制品熔断巡检间隔。 |
| `PIVOT_DECISION_BREAKER_WINDOW_MINUTES` | integer | `30` | 1–1440 | 决策模型制品熔断统计窗口。 |
| `PIVOT_DECISION_MAINTENANCE_INTERVAL_MS` | integer | `21600000` | 60000–86400000 | 决策学习维护巡检的运行间隔。 |
| `PIVOT_DECISION_MAINTENANCE_LOOKBACK_DAYS` | integer | `30` | 1–3650 | 决策学习维护报告统计的最近天数。 |
| `PIVOT_DECISION_MIN_VERIFIED_SAMPLES` | integer | `30` | 1–100000 | 场景和租户达到可训练状态所需的最少已核验样本数。 |
| `PIVOT_DECISION_RECORD_RETENTION_DAYS` | integer | `180` | 1–3650 | 决策记录与其结果的保留天数；到期记录在维护巡检中级联删除，模型制品和冻结评测审计不受影响。 |
| `PIVOT_DECISION_ALLOW_GLOBAL_TRAINING` | boolean | `false` | true / false | 是否已取得跨租户脱敏训练的数据治理批准；默认 false，即使 CLI 传入 --allow-global 也会拒绝全局训练。 |
| `PIVOT_LIGHT_DECISION_ENABLED` | boolean | `false` | true / false | 是否启用本地线性轻量决策器；仅加载已通过评测并登记的本地 JSON 模型。 |
| `PIVOT_LIGHT_DECISION_MODEL_ROOT` | string | `data/decision-models` | 逗号分隔的语言标记 | 本地轻量决策模型目录；生产应使用审核导入的只读制品路径。 |
| `PIVOT_LIGHT_DECISION_MODEL_FILE` | string | `` | 逗号分隔的语言标记 | 当前启用的轻量决策模型 JSON 文件名；留空时该提供器安全降级。 |
| `PIVOT_LIGHT_DECISION_WEIGHT` | number | `1` | 0–10 | 本地轻量决策器输出参与策略融合的相对权重。 |
| `PIVOT_QWEN_DECISION_ENABLED` | boolean | `false` | true / false | 是否让当前已选的 Qwen 模型以结构化、无思考模式提供业务决策建议。 |
| `PIVOT_QWEN_DECISION_VERSION` | string | `` | 逗号分隔的语言标记 | 审核通过的 Qwen 决策模型版本或权重哈希；active 灰度时必须与已激活制品一致。 |
| `PIVOT_QWEN_DECISION_MAX_TOKENS` | integer | `256` | 64–1024 | Qwen 结构化业务决策的最大输出 Token，避免与最终生成任务争用过多资源。 |
| `PIVOT_QWEN_DECISION_TIMEOUT_MS` | integer | `1200` | 100–30000 | Qwen 结构化决策的硬超时，包含模型排队；超时后仅保留既有路由。 |
| `PIVOT_QWEN_DECISION_MAX_CONCURRENT` | integer | `1` | 1–100 | 单进程内 Qwen 决策调用最大并发数；默认保留生成容量，达到上限时直接保持既有路由。 |
| `PIVOT_QWEN_DECISION_WEIGHT` | number | `1` | 0–10 | Qwen 结构化决策输出参与策略融合的相对权重。 |
| `PIVOT_LAYA_DECISION_ENABLED` | boolean | `false` | true / false | 是否调用内网 Laya 业务决策服务；首次上线应配合 shadow 模式。 |
| `PIVOT_LAYA_DECISION_URL` | string | `` | 逗号分隔的语言标记 | 内网 Laya 决策服务的 HTTP 地址。服务只接收脱敏后的任务状态和允许动作。 |
| `PIVOT_LAYA_DECISION_VERSION` | string | `` | 逗号分隔的语言标记 | 已审核的 Laya 权重和校准版本（或权重哈希）标识。 |
| `PIVOT_LAYA_DECISION_TIMEOUT_MS` | integer | `1200` | 100–30000 | 调用内网 Laya 决策服务的单次超时；超时不会中断原有聊天链路。 |
| `PIVOT_LAYA_DECISION_HEALTH_URL` | string | `` | 逗号分隔的语言标记 | 内网 Laya 决策服务健康检查地址；留空时仅检查决策服务是否被配置。 |
| `PIVOT_LAYA_DECISION_HEALTH_TIMEOUT_MS` | integer | `800` | 100–30000 | 内网 Laya 健康检查超时；健康检查失败不影响原有聊天回退。 |
| `PIVOT_LAYA_DECISION_MAX_CONCURRENT` | integer | `4` | 1–100 | 单进程内 Laya 决策服务的最大并发调用数；达到上限时自动保持既有路由。 |
| `PIVOT_LAYA_DECISION_WEIGHT` | number | `1` | 0–10 | Laya 输出参与策略融合的相对权重；应依据固定评测集调整。 |

## 长期记忆

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_LONG_TERM_MEMORY_SHADOW_MODE` | boolean | `false` | true / false | 仅影子比较旧版与新版长期记忆排序，不改变实际注入结果；用于灰度前评测。 |
| `LONG_TERM_MEMORY_MIN_RELEVANCE` | number | `0.08` | 0.01–0.95 | 长期记忆进入最终上下文的最低融合相关性，避免仅因重要度而注入无关记忆。 |
| `LONG_TERM_MEMORY_LOW_VALUE_ARCHIVE_DAYS` | integer | `180` | 30–3650 | 低重要度、低置信度且长期未使用的历史片段自动归档天数。 |

## 工具库执行治理

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_TOOL_MAX_CONCURRENT_PER_TOOL` | integer | `4` | 1–100 | 单进程内同一工具/连接的最大并发执行数；超过后快速拒绝，避免下游雪崩。 |
| `PIVOT_TOOL_MAX_CALLS_PER_MINUTE` | integer | `120` | 1–100000 | 单进程内同一工具/连接每分钟最大调用数；用于保护下游服务和账号配额。 |
| `PIVOT_TOOL_CIRCUIT_FAILURE_THRESHOLD` | integer | `5` | 1–100 | 同一工具/连接连续临时失败达到该阈值后开启熔断保护。 |
| `PIVOT_TOOL_CIRCUIT_COOLDOWN_MS` | integer | `30000` | 1000–1800000 | 工具熔断后的冷却时间；冷却结束只允许一次半开恢复探测。 |
| `PIVOT_ALLOW_INSECURE_OAUTH_HTTP` | boolean | `false` | true / false | 是否仅为本地开发允许 OAuth 授权端点和回调使用 HTTP；生产环境必须保持 false。 |

## 知识库局域网来源

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `KNOWLEDGE_LOCAL_SOURCE_ROOTS` | csv | `` | 逗号分隔的语言标记 | 允许被本地目录知识源扫描的绝对路径白名单，多个路径用英文逗号分隔；留空时禁用目录同步。 |
| `KNOWLEDGE_SOURCE_MAX_FILES` | integer | `5000` | 1–100000 | 单次局域网目录同步最多扫描的文件数，超出后需拆分数据源。 |
| `KNOWLEDGE_SOURCE_SCHEDULE_INTERVAL_MS` | integer | `300000` | 10000–86400000 | 后台轮询 scheduled/watch 知识来源的最短间隔；目录 watch 也以安全轮询方式实现。 |
| `KNOWLEDGE_EMBEDDING_RECOVERY_INTERVAL_MS` | integer | `300000` | 60000–86400000 | Embedding 服务恢复后扫描 lexical_ready 文档并补齐向量索引的间隔。 |

## Agent 网页检索

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `AGENT_WEB_SEARCH_ENDPOINT` | string | `` | 逗号分隔的语言标记 | 受控网页检索 Provider 的 HTTPS JSON Endpoint；运行任务仍须在网络策略中显式允许该 Origin。 |
| `AGENT_WEB_SEARCH_CREDENTIAL` | string | `` | 逗号分隔的语言标记 | 可选的工作流凭据引用名；设置后优先用其作为网页检索 Provider 凭据。 |
| `AGENT_WEB_SEARCH_API_KEY` | string | `` | 逗号分隔的语言标记 | 可选网页检索 Provider 密钥；仅在未配置凭据引用时使用，生产环境建议改用凭据引用。 |
| `AGENT_WEB_SEARCH_HEADER` | string | `Authorization` | 逗号分隔的语言标记 | 网页检索 Provider 凭据请求头名称。 |
| `AGENT_WEB_SEARCH_PREFIX` | string | `Bearer` | 逗号分隔的语言标记 | 网页检索 Provider 凭据请求头前缀；运行时会自动补一个空格。 |

## Agent 多模态 Provider

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `AGENT_IMAGE_GENERATION_ENDPOINT` | string | `` | 逗号分隔的语言标记 | 受控图片生成 Provider 的 HTTPS JSON Endpoint；运行任务仍须显式允许该 Origin。 |
| `AGENT_IMAGE_GENERATION_CREDENTIAL` | string | `` | 逗号分隔的语言标记 | 可选图片生成 Provider 凭据引用名；生产环境优先使用凭据引用。 |
| `AGENT_IMAGE_GENERATION_API_KEY` | string | `` | 逗号分隔的语言标记 | 可选图片生成 Provider 密钥；仅在未设置凭据引用时使用。 |
| `AGENT_IMAGE_GENERATION_HEADER` | string | `Authorization` | 逗号分隔的语言标记 | 图片生成 Provider 凭据请求头名称。 |
| `AGENT_IMAGE_GENERATION_PREFIX` | string | `Bearer` | 逗号分隔的语言标记 | 图片生成 Provider 凭据请求头前缀；运行时自动补一个空格。 |
| `AGENT_TTS_ENDPOINT` | string | `` | 逗号分隔的语言标记 | 受控语音合成 Provider 的 HTTPS JSON Endpoint；运行任务仍须显式允许该 Origin。 |
| `AGENT_TTS_CREDENTIAL` | string | `` | 逗号分隔的语言标记 | 可选语音合成 Provider 凭据引用名；生产环境优先使用凭据引用。 |
| `AGENT_TTS_API_KEY` | string | `` | 逗号分隔的语言标记 | 可选语音合成 Provider 密钥；仅在未设置凭据引用时使用。 |
| `AGENT_TTS_HEADER` | string | `Authorization` | 逗号分隔的语言标记 | 语音合成 Provider 凭据请求头名称。 |
| `AGENT_TTS_PREFIX` | string | `Bearer` | 逗号分隔的语言标记 | 语音合成 Provider 凭据请求头前缀；运行时自动补一个空格。 |

