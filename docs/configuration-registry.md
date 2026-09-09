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

## 桌面交付

| 环境变量 | 类型 | 默认值 | 校验 | 说明 |
| --- | --- | --- | --- | --- |
| `PIVOT_ELECTRON_LOCALES` | csv | `zh-CN,en-US` | 逗号分隔的语言标记 | 桌面安装包保留的 Electron 语言包。 |
| `PIVOT_CHROMIUM_LOCALES` | csv | `zh-CN,en-US` | 逗号分隔的语言标记 | 本地 Agent Chromium 运行时保留的语言包。 |

