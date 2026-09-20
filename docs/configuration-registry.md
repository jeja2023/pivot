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

## 桌面交付

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_ELECTRON_LOCALES` | csv | `zh-CN,en-US` | 逗号分隔的语言标记 | 桌面安装包保留的 Electron 语言包。 |
| `PIVOT_CHROMIUM_LOCALES` | csv | `zh-CN,en-US` | 逗号分隔的语言标记 | 本地 Agent Chromium 运行时保留的语言包。 |

## 对话自适应路由

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_CHAT_AUTO_ROUTE_ENABLED` | boolean | `true` | true / false | 是否启用对话的统一自适应路由总开关。关闭后保留原有 RAG 与 MCP 流程。 |
| `PIVOT_CHAT_AUTO_RAG_ENABLED` | boolean | `true` | true / false | 是否允许路由器自动缩小知识库 Collection 范围。 |
| `PIVOT_CHAT_AUTO_TOOL_DISCOVERY_ENABLED` | boolean | `true` | true / false | 是否允许路由器自动缩小已授权 MCP 工具候选集合。 |
| `PIVOT_CHAT_ROUTE_SHADOW_MODE` | boolean | `false` | true / false | 是否仅记录路由建议而不改变 RAG 与 MCP 的实际候选范围。 |
| `PIVOT_CHAT_ROUTE_MAX_TOOL_CANDIDATES` | integer | `4` | 1–12 | 自动工具发现传给 MCP Planner 的最大候选工具数。 |
| `PIVOT_CHAT_ROUTE_MAX_COLLECTIONS` | integer | `2` | 1–8 | 自动知识库路由选取的最大 Collection 数。 |
| `PIVOT_CHAT_ROUTE_RAG_THRESHOLD` | number | `0.58` | 0–1 | 自动定向检索 Collection 所需的高置信度阈值。 |
| `PIVOT_CHAT_ROUTE_RAG_GRAY_THRESHOLD` | number | `0.38` | 0–1 | 知识库路由的低置信度阈值；低于该值时跳过自动检索。 |
| `PIVOT_CHAT_ROUTE_TOOL_THRESHOLD` | number | `0.34` | 0–1 | 无强规则命中时，工具候选进入 MCP Planner 的最低综合分。 |
| `PIVOT_CHAT_ROUTE_EMBEDDING_TIMEOUT_MS` | integer | `2500` | 100–30000 | 对话路由等待 Query Embedding 的最大时长；超时后安全降级。 |
| `PIVOT_CHAT_PROMPT_CACHE_ENABLED` | boolean | `true` | true / false | 是否在 Responses API 的兼容模型上请求会话隔离的 Prompt Cache；不支持的端点会自动重试并降级。 |
| `PIVOT_CHAT_PROMPT_CACHE_TTL` | enum | `30m` | 30m | Responses API Prompt Cache 的最短复用时间。 |

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

