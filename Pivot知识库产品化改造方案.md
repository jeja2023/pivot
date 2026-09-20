# Pivot 知识库产品化改造方案

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| 文档名称 | Pivot 知识库产品化改造方案 |
| 适用版本 | Pivot v0.1.156 及后续版本 |
| 方案日期 | 2026-09-20 |
| 部署边界 | 无互联网环境、局域网、私有化部署 |
| 方案目标 | 将当前“文件上传型 RAG”升级为可维护、可验证、可运营的局域网知识系统 |
| 非目标 | GitHub/GitLab、Slack/Teams、企业微信等公网或 SaaS 连接器 |

## 2. 背景与结论

Pivot 当前已经具备较完整的 RAG 技术底座，包括：

- PDF、Word、Excel、CSV、Markdown、JSON、HTML、图片等文件导入；
- OCR 回退和结构化文档切片；
- 向量检索、词法检索、RRF 融合、MMR 去重；
- 知识图谱、检索反馈、引用可信度；
- 个人知识库、专题库、单位/用户共享；
- 索引暂存、失败重试、质量报告、召回调试和操作审计。

当前主要问题不是缺少单点 RAG 算法，而是还没有形成完整的知识产品闭环：

```text
导入资料 → 解析索引 → 检索问答 → 引用验证 → 内容维护 → 审核发布 → 质量评估
```

现阶段项目更接近“文件上传与 RAG 管理器”，而不是产品级知识库。后续改造应优先补齐以下能力：

1. 持久化索引任务和可恢复的后台处理；
2. 可靠的词法检索与向量 ANN 检索；
3. 文档版本、来源定位和可点击引用；
4. 草稿、审核、发布、验证人和有效期治理；
5. 统一搜索与知识问答入口；
6. 局域网数据源和本地目录增量同步；
7. 黄金问题集、召回指标和答案质量评测；
8. 与局域网部署相适配的安全、备份和多节点能力。

## 3. 范围与边界

### 3.1 本期纳入范围

#### 数据来源

- 本地文件上传；
- 局域网共享目录、NAS、SMB 映射目录；
- 局域网 HTTP/HTTPS 文件或文档接口；
- 局域网 PostgreSQL、MySQL、SQL Server 等业务数据库；
- 局域网内部文档系统、OA、档案系统的 API 或导出目录；
- 人工创建的知识文章、FAQ、术语和操作规程；
- 对话、工作流和 Agent 运行结果沉淀出的知识草稿。

#### 使用场景

- 局域网内部自然语言搜索；
- 知识库问答和结构化总结；
- 制度、流程、法规、产品资料和项目文档检索；
- 文档版本和有效期管理；
- 按单位、角色、用户和知识库授权；
- 离线部署下的索引、备份、恢复和审计；
- Agent 和工作流调用受权限控制的知识上下文。

### 3.2 明确排除范围

以下能力不纳入当前阶段：

- GitHub/GitLab 连接器；
- Slack、Microsoft Teams、企业微信等互联网或 SaaS 连接器；
- 公网搜索和公网知识抓取；
- 面向互联网的知识库广场、公开发布和知识付费；
- 依赖云端 SaaS 的强制能力；
- 将公网 AI 服务作为系统运行前提。

### 3.3 局域网部署原则

1. 默认无互联网也能完成文档解析、词法检索、权限过滤、知识库管理和基础问答。
2. Embedding、重排模型和 OCR 服务支持局域网自部署；外部 HTTP 服务只能作为可选配置。
3. 所有数据源、索引、文件、日志和模型服务可部署在用户内网。
4. 任何联网能力必须显式启用，并在系统设置中可审计、可关闭。
5. 用户、单位、角色和权限全部以本地组织身份为准，不依赖第三方账号映射。

## 4. 当前实现基线

### 4.1 已有能力

现有知识库界面已经包含上传、专题库、标签、状态、启停、批量治理、召回测试和图谱入口，见：

- `client/chat/partials/workspaces/knowledge.html`
- `client/chat/rag-documents.js`
- `client/chat/rag-documents-panels.js`

服务端已有知识库和 RAG 路由，见：

- `server/routes/rag.js`
- `server/services/rag-documents.js`
- `server/services/rag-index/index.js`
- `server/services/rag-chunker.js`
- `server/services/knowledge-graph.js`
- `server/services/knowledge-access.js`

数据库已有：

- `knowledge_collections`
- `knowledge_docs`
- `knowledge_chunks`
- `knowledge_doc_tags`
- `knowledge_tags`
- `rag_feedback`
- `knowledge_entities`
- `knowledge_entity_mentions`
- `knowledge_relations`

### 4.2 已确认的改造问题

#### 问题一：词法检索必须以 PostgreSQL 主路径实现

主数据库已统一为 PostgreSQL，RAG 词法候选不能依赖历史 SQLite FTS5 语法。检索层应固定为：

- PostgreSQL：`tsvector + GIN`，并以 `pg_trgm` 补足模糊匹配；
- 应用层：只负责融合、门控和重排。

#### 问题二：PostgreSQL 向量查询缺少明确的 ANN 索引策略

当前使用 pgvector 距离排序，但没有建立 HNSW/IVFFlat 的完整索引方案。需要固定 embedding profile，并按维度、模型版本管理向量索引。

#### 问题三：Embedding 失败时降级链路不完整

底层可以保留文本 chunk，但完整索引流程会因缺少 embedding 将文档判为错误。应支持：

```text
文本解析成功 + 词法索引成功 = lexical_ready/degraded
向量补齐后 = ready
```

不能让 Embedding 服务故障导致新文档完全不可用。

#### 问题四：索引队列主要在进程内存中

当前 pending/active 索引任务使用内存 Map/Set。进程重启、服务多节点和任务审计场景下需要持久化任务表与租约机制。

#### 问题五：知识库以文件和 chunk 为中心，缺少内容生命周期

当前没有完整的：

- 文档版本；
- 草稿/审核/发布；
- 验证人和责任人；
- 有效期和复核提醒；
- 页面/段落/页码/工作表来源定位；
- 评论和纠错；
- 内容变更记录。

#### 问题六：引用还不是可验证的产品级引用

当前引用主要由文件名、章节和字符范围组成。需要增加稳定 citation ID、页面/Sheet/段落定位、原文预览和局域网文件深链接。

#### 问题七：质量报告还不是检索评测体系

当前质量分主要反映索引状态、重复文档、反馈、图谱等治理信号，还不能量化 Recall@K、MRR、引用准确率和答案事实性。

## 5. 目标产品形态

### 5.1 目标用户体验

用户不应先理解“专题库、chunk、embedding、召回测试”等技术概念，而应得到如下体验：

```text
输入问题
  ↓
系统自动理解问题和权限
  ↓
返回答案、来源、原文片段和可信度
  ↓
可打开原文、追问、纠错或保存为知识文章
```

管理员则需要看到：

```text
数据源 → 同步状态 → 文档版本 → 解析状态 → 索引状态 → 质量指标 → 审核任务
```

### 5.2 目标能力分层

```text
┌─────────────────────────────────────────────┐
│ 用户层：全局搜索、问答、引用、原文预览、反馈 │
├─────────────────────────────────────────────┤
│ 内容层：文章、文件、版本、草稿、审核、发布   │
├─────────────────────────────────────────────┤
│ 来源层：上传、共享目录、内网 API、数据库     │
├─────────────────────────────────────────────┤
│ 处理层：解析、OCR、规范化、切片、Embedding    │
├─────────────────────────────────────────────┤
│ 检索层：FTS、向量、图谱、重排、MMR、引用      │
├─────────────────────────────────────────────┤
│ 治理层：权限、审计、质量评测、有效期、备份     │
└─────────────────────────────────────────────┘
```

## 6. 总体技术架构

### 6.1 推荐架构

```text
                    ┌─────────────────┐
                    │ 全局搜索 / 聊天 │
                    │ Agent / 工作流  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Knowledge API   │
                    │ Search / Ask    │
                    │ Citation / ACL │
                    └────────┬────────┘
                             │
              ┌──────────────▼──────────────┐
              │ Retrieval Orchestrator      │
              │ ACL → Query Rewrite → FTS   │
              │ Dense → Graph → Rerank → MMR│
              └──────┬──────────┬───────────┘
                     │          │
          ┌──────────▼───┐  ┌──▼────────────┐
          │ Lexical Index │  │ Vector Index │
          │ PG tsvector  │  │ pgvector ANN │
          │ PG tsvector  │  │ HNSW/IVFFlat │
          └──────────────┘  └───────────────┘
                             │
                    ┌────────▼────────┐
                    │ Ingestion Jobs  │
                    │ Parse/OCR/Chunk │
                    │ Embed/Publish   │
                    └────────┬────────┘
                             │
          ┌──────────────────▼──────────────────┐
          │ Local files / NAS / LAN API / DB / UI│
          └─────────────────────────────────────┘
```

### 6.2 服务边界

建议将知识库服务拆成以下逻辑模块，暂时仍可运行在同一个 Node 进程内：

1. `knowledge-source-service`：管理上传、目录、内网 API、数据库数据源；
2. `knowledge-content-service`：管理文章、文件、版本、块和元数据；
3. `knowledge-ingestion-service`：解析、OCR、规范化、切片和 embedding；
4. `knowledge-index-service`：FTS、向量、图谱索引；
5. `knowledge-retrieval-service`：权限过滤、召回、融合、重排和引用；
6. `knowledge-governance-service`：审核、验证、有效期、质量、审计；
7. `knowledge-evaluation-service`：黄金问题集、评测运行和回归报告。

## 7. 数据模型改造

### 7.1 数据源表

新增 `knowledge_sources`：

| 字段 | 说明 |
|---|---|
| id | 数据源 ID |
| user_id | 创建人/所有者 |
| name | 数据源名称 |
| kind | upload、local_dir、lan_http、database、internal_api |
| config_ref | 加密配置引用，不保存明文凭据 |
| collection_id | 默认归属专题库 |
| sync_mode | manual、scheduled、watch |
| sync_cursor | 增量同步游标 |
| last_sync_at | 最近同步时间 |
| status | active、paused、error、disabled |
| error_message | 最近错误 |
| created_at / updated_at | 时间字段 |

局域网目录数据源必须支持：

- 根目录白名单；
- 文件扩展名白名单；
- 路径穿越防护；
- 文件 hash 去重；
- 文件删除同步；
- 文件修改时间同步；
- 手工扫描和定时扫描。

### 7.2 文档与版本表

新增或演进为：

#### `knowledge_documents`

保存文档稳定身份，不随版本变化：

- `id`
- `source_id`
- `collection_id`
- `title`
- `canonical_uri`
- `mime_type`
- `owner_user_id`
- `owner_unit`
- `current_version_id`
- `visibility_status`
- `deleted_at`

#### `knowledge_document_versions`

保存每次内容版本：

- `id`
- `document_id`
- `version_no`
- `content_hash`
- `source_size`
- `source_updated_at`
- `parser_version`
- `chunker_version`
- `embedding_profile`
- `status`
- `draft_content_path`
- `published_at`
- `published_by`
- `created_at`

现有 `knowledge_docs` 可以作为兼容层保留，逐步将当前文档迁移为 `knowledge_documents + knowledge_document_versions`。

### 7.3 内容块和来源定位表

新增 `knowledge_blocks`，替代仅以 chunk 表达内容来源的方式：

- `id`
- `version_id`
- `parent_block_id`
- `block_type`
- `block_order`
- `heading_path`
- `content`
- `page_no`
- `sheet_name`
- `slide_no`
- `char_start`
- `char_end`
- `bbox_json`
- `source_locator_json`

`knowledge_chunks` 继续作为检索投影表，保存：

- `block_id`
- `content`
- `search_content`
- `embedding`
- `embedding_profile`
- `embedding_dimensions`
- `chunk_index`
- `char_start`
- `char_end`

这样可以同时满足检索性能和精确引用。

### 7.4 权限表

新增 `knowledge_permissions`：

| 字段 | 说明 |
|---|---|
| resource_type | source、collection、document、version |
| resource_id | 资源 ID |
| principal_type | user、unit、role、group |
| principal_id | 主体 ID |
| permission | owner、manager、editor、commenter、viewer |
| inherited | 是否继承 |
| created_by | 授权人 |
| expires_at | 可选有效期 |

所有以下操作都必须调用统一权限服务：

- 文档列表；
- 文档详情；
- 检索；
- 图谱查询；
- 引用预览；
- 下载原文；
- Agent 上下文注入；
- 文章发布；
- 数据源同步。

### 7.5 索引任务表

新增 `knowledge_ingestion_jobs`：

```text
id
source_id
document_id
version_id
job_type
stage
status
attempts
max_attempts
priority
idempotency_key
next_retry_at
locked_by
locked_at
error_code
error_message
created_at
updated_at
```

推荐阶段：

```text
queued
downloaded
parsed
ocr_processing
normalized
chunked
lexical_indexed
embedding_processing
vector_indexed
graph_indexed
quality_checked
published
degraded
failed
```

## 8. 检索系统改造

### 8.1 查询流程

```text
用户问题
  ↓
问题规范化与意图识别
  ↓
权限范围计算
  ↓
查询改写/关键词提取
  ↓
FTS 候选召回 + 向量候选召回 + 图谱候选召回
  ↓
RRF 融合
  ↓
可选局域网重排模型
  ↓
权限再次校验
  ↓
MMR 去重
  ↓
上下文预算控制
  ↓
答案和结构化 citations
```

### 8.2 词法索引

PostgreSQL：

- 增加 `tsvector` 字段或生成列；
- 创建 GIN 索引；
- `pg_trgm` 作为模糊匹配补充；
- 不再把 trigram similarity 直接称为 BM25。

### 8.3 向量索引

推荐引入 embedding profile：

```json
{
  "id": "local-bge-m3-1024-v1",
  "provider": "lan_http",
  "model": "bge-m3",
  "dimensions": 1024,
  "metric": "cosine",
  "version": 1
}
```

策略：

- 同一向量索引只允许固定维度；
- 不同模型不能混用同一 ANN 索引；
- PostgreSQL 优先使用 HNSW；
- 数据量较小时可保留精确搜索；
- 数据量达到阈值后自动创建或切换 ANN 索引；
- 局域网大规模部署优先使用 PostgreSQL + pgvector。

### 8.4 词法降级策略

Embedding 未配置或不可用时：

1. 继续执行 FTS；
2. 标记检索模式为 `lexical_only`；
3. 回答中显示“当前基于关键词检索”；
4. 不调用不存在的向量结果；
5. 后台恢复后自动补齐向量；
6. 记录降级次数和影响的文档数量。

### 8.5 引用结构

检索服务返回：

```json
{
  "chunkId": 123,
  "documentId": 10,
  "versionId": 7,
  "blockId": 88,
  "title": "采购管理办法",
  "locator": {
    "page": 12,
    "headingPath": "第三章 › 采购审批",
    "charStart": 3021,
    "charEnd": 3410
  },
  "preview": "……",
  "score": 0.87,
  "citationConfidence": 0.91,
  "openUrl": "/api/knowledge/documents/10/versions/7/blocks/88"
}
```

## 9. 内容管理与治理改造

### 9.1 文档生命周期

建议统一为：

```text
导入 → 解析 → 草稿 → 待审核 → 已发布 → 已过期 → 已归档
```

不同状态对检索的影响：

| 状态 | 是否参与问答 | 说明 |
|---|---:|---|
| 草稿 | 否 | 仅作者和审核人可预览 |
| 待审核 | 可配置 | 默认不参与正式问答 |
| 已发布 | 是 | 正式知识来源 |
| 已过期 | 可配置 | 默认降低排序或排除 |
| 已归档 | 否 | 仅审计和历史版本可见 |

### 9.2 验证和新鲜度

每个文档或文章增加：

- `verified_status`：verified、unverified、expired；
- `verifier_user_id`；
- `verified_at`；
- `review_due_at`；
- `freshness_policy`；
- `content_owner_user_id`；
- `content_owner_unit`。

检索结果展示：

- 已验证；
- 待复核；
- 已过期；
- 最近更新时间；
- 责任人。

### 9.3 重复与冲突治理

当前已有 hash 重复检测，应扩展为：

- 文件完全重复；
- 内容近似重复；
- 同一主题多版本冲突；
- 新旧制度同时有效；
- 旧文档引用新文档；
- 过期文档仍被高频召回。

冲突策略：

1. 同一文档的最新已发布版本优先；
2. 有效期内的制度优先；
3. 已验证版本优先；
4. 冲突时在回答中明确提示多份来源存在差异；
5. 不允许模型自行选择而不显示冲突。

## 10. 局域网数据源设计

### 10.1 本地文件上传

保留现有上传接口，并增加：

- 文件 hash 幂等检查；
- 原始文件和规范化文件分离存储；
- 文件 MIME 二次检测；
- 上传用户和来源记录；
- 版本自动生成；
- 失败文件可重新处理；
- 文件导入预览和解析摘要。

### 10.2 局域网共享目录

新增目录数据源配置：

```text
目录路径
扫描频率
文件扩展名
是否递归
默认专题库
默认标签规则
删除同步策略
权限映射策略
```

扫描方式：

- Windows：定时扫描 + 文件系统变更通知；
- Linux：inotify + 定时全量校验；
- NAS/SMB：定时扫描为主；
- 任何时候都必须保留全量重新扫描按钮。

### 10.3 局域网 HTTP/HTTPS 数据源

支持：

- 内网文档下载 URL；
- 内网 REST API；
- 基于 Token、Basic Auth 或 mTLS 的认证；
- ETag/Last-Modified 增量判断；
- 证书校验可配置但默认开启；
- SSRF 内网白名单；
- 请求超时、限速和响应大小限制。

### 10.4 局域网数据库数据源

第一阶段只允许管理员配置，并采用只读连接：

- PostgreSQL；
- MySQL；
- SQL Server。

必须支持：

- 只读账号；
- 表和字段白名单；
- SQL 模板而非任意 SQL；
- 增量字段；
- 数据脱敏规则；
- 结果 hash；
- 数据来源标识；
- 同步审计。

## 11. API 改造建议

### 11.1 搜索 API

```http
POST /api/knowledge/search
```

请求：

```json
{
  "query": "采购审批需要哪些材料？",
  "scope": {
    "collectionIds": [1],
    "tagNames": ["采购"]
  },
  "filters": {
    "documentType": "policy",
    "verified": true,
    "updatedAfter": "2026-01-01"
  },
  "mode": "hybrid",
  "topK": 10
}
```

响应包含：

- 检索模式；
- 总候选数；
- 结果列表；
- 高亮片段；
- 来源定位；
- 权限裁剪信息；
- 延迟和索引状态。

### 11.2 问答 API

```http
POST /api/knowledge/ask
```

响应：

```json
{
  "answer": "……",
  "confidence": 0.88,
  "retrievalMode": "hybrid",
  "citations": [],
  "warnings": [],
  "followups": [],
  "canSaveAsArticle": true
}
```

### 11.3 内容生命周期 API

```http
POST   /api/knowledge/documents
GET    /api/knowledge/documents/:id
PATCH  /api/knowledge/documents/:id
POST   /api/knowledge/documents/:id/versions
POST   /api/knowledge/versions/:id/submit-review
POST   /api/knowledge/versions/:id/approve
POST   /api/knowledge/versions/:id/publish
POST   /api/knowledge/versions/:id/archive
GET    /api/knowledge/versions/:id/diff
```

### 11.4 数据源 API

```http
GET    /api/knowledge/sources
POST   /api/knowledge/sources
PATCH  /api/knowledge/sources/:id
POST   /api/knowledge/sources/:id/sync
POST   /api/knowledge/sources/:id/rebuild
GET    /api/knowledge/sources/:id/runs
POST   /api/knowledge/sources/:id/pause
POST   /api/knowledge/sources/:id/resume
```

### 11.5 评测 API

```http
GET    /api/knowledge/evaluations/cases
POST   /api/knowledge/evaluations/cases
POST   /api/knowledge/evaluations/runs
GET    /api/knowledge/evaluations/runs/:id
GET    /api/knowledge/evaluations/compare
```

## 12. 前端工作台改造

### 12.1 普通用户入口

增加独立的知识搜索/问答工作区：

- 全局搜索框；
- 自然语言问题输入；
- 知识库范围选择；
- 来源类型筛选；
- 验证状态筛选；
- 时间和单位筛选；
- 结果高亮；
- 来源预览；
- 引用展开；
- 有用/无用/引用错误反馈；
- 保存为知识文章；
- 继续追问。

### 12.2 管理员入口

现有知识库管理页保留，但调整为四个区域：

1. **内容**：文档、文章、版本、草稿和发布状态；
2. **来源**：上传、共享目录、内网 API、数据库；
3. **治理**：审核、验证、过期、重复、冲突；
4. **质量**：索引状态、评测、反馈、延迟和成本。

### 12.3 文档详情页

文档详情不应只显示 chunk 列表，还应显示：

- 来源和原始路径；
- 当前版本；
- 历史版本；
- 解析摘要；
- 页码/Sheet/章节导航；
- 索引阶段；
- 责任人；
- 验证人；
- 有效期；
- 召回次数；
- 负反馈；
- 相似和冲突文档。

## 13. 分阶段实施计划

### P0：可靠性和正确性，预计 2-4 周

#### P0-1 持久化索引任务

- 新增 `knowledge_ingestion_jobs`；
- 任务租约；
- 重试和退避；
- 进程重启恢复；
- 任务优先级；
- 幂等 key；
- 管理员查看任务详情。

#### P0-2 检索索引修正

- PostgreSQL 增加 tsvector/GIN；
- 评估并创建 HNSW；
- 建立 embedding profile；
- 增加检索模式字段。

#### P0-3 Embedding 降级

- 支持 `lexical_ready`；
- 支持 `degraded`；
- 后台补齐 embedding；
- 前端展示降级原因；
- 记录降级指标。

#### P0-4 引用最小闭环

- citation ID；
- 文档/版本/chunk 关联；
- 字符区间和章节；
- 原文预览接口；
- 聊天引用可点击。

#### P0-5 权限统一

- 抽象 effective permission；
- 检索、详情、预览、下载统一检查；
- 增加越权回归测试；
- 补充读取审计。

### P1：知识内容产品化，预计 4-8 周

- 文档版本表；
- 文章和 FAQ 编辑器；
- 草稿/审核/发布；
- 验证人和责任人；
- 有效期与复核提醒；
- 版本 diff；
- 内容评论和纠错；
- AI 摘要、标签和标题；
- 问答结果保存为知识文章；
- 结构化来源定位。

### P1：局域网数据源，预计 4-8 周

- 局域网共享目录同步；
- NAS/SMB 定时扫描；
- 内网 HTTP/HTTPS 文件同步；
- 内网 API 连接器基类；
- 局域网数据库只读连接；
- 增量游标和删除同步；
- 数据源健康监控。

### P2：质量评估和智能运营，预计 3-6 周

- 黄金问题集；
- Recall@K、MRR、nDCG；
- 答案引用准确率；
- 答案事实性评估；
- 负反馈自动聚类；
- 未覆盖问题统计；
- 文档缺口建议；
- 版本/模型变更回归评测；
- 知识库质量趋势图。

### P2：规模化和多节点，预计 4-8 周

- PostgreSQL + pgvector 主部署模式；
- 独立索引 Worker；
- 多节点任务租约；
- 内网对象存储或共享存储；
- 分库/分租户索引隔离；
- 索引构建和切换无感知；
- 备份恢复演练；
- 大规模压测。

## 14. 迁移策略

### 14.1 兼容原则

不立即删除现有表和接口：

1. 保留 `knowledge_docs` 和 `knowledge_chunks`；
2. 新增版本、任务、来源和权限表；
3. 旧文档自动生成 version 1；
4. 旧集合权限映射为新权限记录；
5. 旧 RAG 查询继续工作；
6. 新搜索 API 逐步接管聊天和 Agent 调用。

### 14.2 迁移步骤

```text
备份数据库和上传目录
  ↓
创建新表和索引
  ↓
为历史 knowledge_docs 生成 source/document/version
  ↓
为历史 chunks 补充 block/provenance
  ↓
校验文档数、chunk 数和权限数
  ↓
双写新旧字段
  ↓
灰度切换搜索 API
  ↓
观察一周
  ↓
关闭旧路径的新增写入
```

### 14.3 数据校验

每次迁移必须核对：

- 文档数量；
- 已发布文档数量；
- chunk 数量；
- 有向量 chunk 数量；
- 词法索引数量；
- 文件 hash 数量；
- 权限记录数量；
- 可检索文档数量；
- 删除文档不可检索；
- 共享文档越权不可见。

## 15. 安全设计

### 15.1 文件安全

- 扩展名、MIME、文件内容三重校验；
- ZIP/Office 解压限制；
- PDF/OCR 页数限制；
- 单文件和批量总大小限制；
- 原始文件路径白名单；
- 文件名规范化；
- 病毒扫描接口预留；
- 原始文件和索引文本分离存储。

### 15.2 局域网出站安全

默认禁止公网出站。局域网连接器必须：

- 配置允许网段；
- 禁止访问云元数据地址；
- 禁止任意用户自定义 URL；
- 限制重定向；
- 校验证书；
- 记录目标地址和调用人；
- 记录响应大小和耗时。

### 15.3 知识注入安全

- 文档内容视为不可信输入；
- 防止提示词注入影响系统规则；
- 引用内容和系统指令严格分层；
- 对外部/低可信来源增加警告；
- Agent 执行前重新校验知识权限；
- 不允许通过引用 URL 绕过下载权限。

## 16. 可观测性和运营指标

### 16.1 索引指标

- 每日新增文档数；
- 解析成功率；
- OCR 使用率；
- 平均解析耗时；
- 平均 embedding 耗时；
- 失败任务数；
- 队列等待时间；
- lexical-only 文档数；
- embedding 缺失数；
- 重复文档数；
- 过期文档数。

### 16.2 检索指标

- 查询总数；
- 空结果率；
- 命中率；
- lexical-only 查询率；
- 缓存命中率；
- Top-K 平均分；
- 负反馈率；
- 引用点击率；
- 引用错误率；
- P50/P95/P99 延迟。

### 16.3 产品指标

- 搜索到答案的平均耗时；
- 原文打开率；
- 答案追问率；
- 保存为文章次数；
- 文档复核完成率；
- 过期文档占比；
- 未覆盖问题数；
- 知识库活跃用户数。

## 17. 测试方案

### 17.1 单元测试

- 文件类型识别；
- 文档切片；
- 中文 n-gram；
- FTS 查询构造；
- 向量维度校验；
- RRF、MMR 和重排；
- citation 定位；
- 版本状态机；
- 权限继承；
- 有效期计算。

### 17.2 集成测试

- 上传到发布全流程；
- Embedding 不可用时 lexical-only；
- OCR 失败重试；
- 任务进程重启恢复；
- 目录增量同步；
- 文件删除同步；
- 版本发布后缓存失效；
- 权限修改后检索结果变化；
- 文档软删除后不可召回。

### 17.3 安全测试

- 单位越权；
- 指定用户越权；
- 文档级越权；
- 图谱越权；
- 引用预览越权；
- 下载接口越权；
- 路径穿越；
- SSRF；
- Office/ZIP 炸弹；
- 提示词注入；
- 删除后缓存泄露。

### 17.4 评测测试

至少建立以下数据集：

1. 制度流程问题；
2. 法规条款问题；
3. 项目资料问题；
4. 表格查询问题；
5. 多文档综合问题；
6. 无答案问题；
7. 权限隔离问题；
8. 新旧版本冲突问题。

## 18. 验收标准

### P0 验收

- 服务重启后索引任务可恢复；
- Embedding 服务不可用时文档仍可关键词检索；
- PostgreSQL 使用可验证的向量索引策略；
- 检索结果全部经过统一权限过滤；
- 引用可打开到文档、版本和具体片段；
- 删除文档在缓存和检索中均不可见；
- 越权测试为 0；
- 现有知识库 API 兼容。

### P1 验收

- 文档可创建草稿、提交审核、发布和归档；
- 可查看版本历史和差异；
- 可配置责任人、验证人和复核时间；
- 局域网目录可增量同步；
- 同一文件重复同步不会重复生成文档；
- 文档变化能够触发重新索引；
- 旧版本不会默认覆盖新版本。

### P2 验收

- 黄金问题集支持自动评测；
- 评测报告可比较模型、切片和检索参数变化；
- 10 万 chunk 下 P95 检索延迟不超过 1 秒；
- 多节点索引任务不重复执行；
- 备份恢复后文档、索引和权限一致。

## 19. 建议的首批开发任务拆分

### 后端

1. 创建 `knowledge_ingestion_jobs` 迁移；
2. 创建任务租约和恢复 Worker；
3. 增加 lexical-only 状态；
4. 增加 PostgreSQL tsvector/GIN；
6. 设计 embedding profile；
7. 增加 pgvector ANN 索引迁移；
8. 增加 document/version/block 模型；
9. 增加 citation API；
10. 抽象统一权限服务；
11. 增加评测 case/run 表；
12. 增加局域网目录 Connector。

### 前端

1. 增加统一知识搜索页；
2. 增加答案和 citation 卡片；
3. 增加原文片段预览；
4. 增加文档版本页；
5. 增加审核/发布流程；
6. 增加责任人和复核时间；
7. 增加数据源管理页；
8. 增加索引任务详情；
9. 增加评测工作台；
10. 将聊天中的知识库引用接入统一 citation 组件。

### 测试与运维

1. 建立知识库黄金问题集；
2. 增加权限矩阵测试；
3. 增加任务重启恢复测试；
4. 增加大规模检索压测；
5. 增加索引和备份巡检脚本；
6. 增加局域网出站审计；
7. 增加升级前后数据对账；
8. 增加生产回滚预案。

## 20. 最终建议

Pivot 的知识库改造不应继续围绕“增加更多 RAG 参数”展开，而应围绕以下主线推进：

```text
先保证可用
  → 再保证可验证
  → 再保证可维护
  → 再扩展局域网数据源
  → 最后提升规模和智能化
```

最优先的四项工作是：

1. 持久化索引队列和 lexical-only 降级；
2. FTS5/tsvector/ANN 索引治理；
3. 文档版本、来源定位和可点击引用；
4. 审核、验证、新鲜度和黄金问题评测。

完成 P0 后，项目可以从“知识库功能可用”提升到“知识库检索可信”；完成 P1 后，才具备产品级知识资产管理能力；完成 P2 后，才适合在局域网多部门、多节点环境中规模化推广。

## 21. 实施完成记录（2026-09-20）

本方案的功能性改造已落地到项目代码。主数据库、主 schema、迁移与服务端测试均以 PostgreSQL 为唯一运行时；SQLite 只保留为桌面端明确授权的本机文件数据源、桌面 Agent 状态存储和数据分析文件格式，不参与 Pivot 主数据库运行。

| 目标 | 已交付实现 |
|---|---|
| 可恢复索引 | `knowledge_ingestion_jobs`、抢占租约、心跳续租、退避重试、重启恢复、多实例 `SKIP LOCKED` 抢占及任务工作台。 |
| 检索与降级 | PostgreSQL `tsvector + GIN`、trigram 回退、RRF/MMR、`lexical_ready`、向量恢复巡检；向量按 `embedding_profile + dimensions` 隔离，HNSW partial index 并发创建。 |
| 内容与引用 | 稳定文档、版本、内容块、草稿/审核/发布/归档、责任人、验证人、有效期、版本差异、评论纠错、稳定 citation key、片段预览和原件下载授权。 |
| 权限与安全 | 集合共享、用户/单位/角色文档 ACL、引用/下载/Agent 检索统一校验；本地目录白名单、禁止符号链接逃逸、内网 HTTP SSRF 防护、无重定向、受控凭据引用。 |
| 局域网来源 | 上传、目录/NAS/SMB 映射路径、内网 HTTP/API manifest、数据库来源；目录与 API 的 hash/ETag 增量、删除归档、同步运行记录和健康状态。数据库来源必须引用管理员批准的只读 SQL 模板。 |
| 质量运营 | 黄金问题集、Recall@K、MRR、nDCG、引用精确率/召回率/F1、答案关键点覆盖、拒答准确率、运行比较与知识缺口报告。 |
| 工作台体验 | 首页以资料列表、摘要和质量提示为主；搜索问答、内容生命周期、局域网来源、索引任务和质量评测按需进入独立治理工作台，支持键盘 Tab 切换和移动端滚动。 |
| 迁移与运行 | 版本化 PostgreSQL 迁移、历史投影回填、启动对账、数据库备份、上传目录垃圾回收和只读迁移对账命令。 |

### 21.1 关键运行命令

```powershell
# 部署后只读核对旧 RAG 投影、产品身份、向量、引用和授权一致性
npm run verify:knowledge-migration -- --strict

# 运行完整静态门禁、语法、资产与 E2E 合同检查
npm run check

# 运行完整测试集
npm test

# PostgreSQL 逻辑备份（原始上传目录应放在已纳入企业文件备份的共享存储）
npm run backup
```

### 21.2 本次验证证据

- 产品化定向测试覆盖：迁移补齐、文章审核发布、引用/权限、来源删除同步、数据库只读模板、任务心跳与退避、HNSW/FTS 边界、评测指标；
- 主库 PostgreSQL 收敛回归覆盖 Schema 快照、仅 `upPg` 迁移、聊天 Agent 终态消息幂等，以及旧 SQLite 主库入口移除；
- 桌面 SQLite 边界回归覆盖本机授权、受控本机只读 SQLite 数据源和 SQLite 文件数据分析导入；
- PostgreSQL schema 初始化结果：104 张表、184 个外键、172 个索引；
- 68 条 PostgreSQL 迁移覆盖、关键索引、治理阈值、语法、配置注册表、`npm run check` 与 ESLint 均通过；
- 完整 `npm test` 通过 1,179 项（两个隔离 PostgreSQL schema 分组：513 + 666），零失败。

### 21.3 上线验收边界

“10 万 chunk 下 P95 小于 1 秒”属于环境容量验收，必须在目标局域网硬件、真实 embedding profile、实际 ACL 密度及 PostgreSQL 参数下测量，不能用开发机结果替代。上线前使用上述对账命令、真实问题集评测和压测记录签署容量结论；其余 P0/P1/P2 功能闭环均已具备代码、迁移和回归测试支持。

### 21.4 发布与升级记录

本方案的核心产品化能力已随 `v0.1.155` 发布；资料列表优先与按需治理工作台布局已随 `v0.1.156` 发布。完整功能、主库 PostgreSQL-only 兼容边界、桌面 SQLite 保留范围、升级/回滚条件与验证记录见 [v0.1.155 知识库产品化与 PostgreSQL 主库收敛发布记录](docs/releases/v0.1.155-知识库产品化与PostgreSQL主库收敛.md) 和 [v0.1.156 知识库治理工作台布局优化发布记录](docs/releases/v0.1.156-知识库治理工作台布局优化.md)。
