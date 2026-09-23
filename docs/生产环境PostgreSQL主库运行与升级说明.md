# Pivot 生产环境 PostgreSQL 主库运行与升级说明

适用版本：v0.1.155 及后续 PostgreSQL-only 主库版本  
更新日期：2026-09-22（大型历史知识库无阻塞升级说明）

## 1. 适用范围与不可变边界

Pivot 服务端的主业务数据库是 PostgreSQL，涵盖用户、会话、消息、权限、Agent、工作流、知识库、审计和应用数据。服务启动仅使用 `DATABASE_URL` 连接 PostgreSQL；不再提供 SQLite 主库文件、SQLite schema、SQLite 主库迁移或运行时回退。

桌面端的 SQLite 不属于此边界：它仅服务于桌面本机授权、桌面 Agent 局部状态、授权后的本机 SQLite 只读工具和 SQLite 文件数据分析导入。不要把桌面 SQLite 文件当作服务端主库备份，也不要为了本机授权而恢复服务端 SQLite 依赖。

## 2. 前置条件

### PostgreSQL 与扩展

- 使用受运维管理的 PostgreSQL 实例，应用账户通过 `DATABASE_URL` 连接。
- 数据库需具备 UTF-8 编码和 `Asia/Shanghai` 业务时区语义；系统字段以 `TIMESTAMPTZ` 保存。
- 知识库向量与词法检索需要 `vector`（pgvector）和 `pg_trgm` 扩展。应用启动会尝试确认扩展；生产上建议由 DBA 预先安装并授权。

```sql
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
```

### 应用账户权限

首次部署或新 schema 初始化时，应用账户至少需要：

- 在业务 schema 内创建/修改表、列、约束和索引；
- 维护 `schema_migrations` 与 `app_meta`；
- 创建上述扩展，或由 DBA 预创建后授予使用权限；
- 执行 PostgreSQL 逻辑备份所需的 `pg_dump` 读取权限（若使用内置备份命令）。

最小化权限部署时，DBA 应在预生产环境完整执行一次初始化，并确保生产应用账户对所有已建对象拥有后续迁移所需的属主或 `ALTER` 权限；缺失权限会导致 Schema 补齐、索引或迁移无法完成。

## 3. 初始化和升级机制

服务启动顺序固定如下：

```text
连接 PostgreSQL
  → 确认 vector / pg_trgm 扩展
  → 从 pg-schema.snapshot.json 初始化表、遗留列、外键、索引
  → 执行 schema_migrations 中尚未登记的 upPg 迁移
  → 写入 Schema 注释与默认系统配置
```

`server/db/schema/pg-schema.snapshot.json` 是主库的原生 DDL 来源。部署增量能力时，启动过程会继续执行迁移注册表中尚未登记的 PostgreSQL `upPg` 迁移；不要通过手工建表、删表或修改迁移记录替代应用启动迁移。

历史建表和补列已由 schema 快照接管。不要手工把历史 SQLite DDL、FTS5 虚表或 SQLite `PRAGMA` 迁回生产库。

## 4. 升级步骤（v0.1.155 及后续版本）

1. 在维护窗口前备份 PostgreSQL 数据库及 `uploads/` 文件目录；两者应使用同一恢复点标识。
2. 检查 `.env`：

   ```env
   DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>
   ```

3. 确认数据库已安装 `vector` 与 `pg_trgm`，并确认应用账户拥有本次升级所需的 DDL 权限。
4. 部署新服务镜像或代码并启动。首次启动会自动执行 PostgreSQL schema 初始化和未应用迁移；不要并行启动多个未完成初始化的新实例。
5. 在使用同版本代码和生产只读连接配置的受控运维检出环境中，等待健康检查恢复后执行：

   ```powershell
   npm run verify:knowledge-migration -- --strict
   npm run backup
   ```

6. 以管理员账号抽查知识库来源、审核/发布、索引任务和质量评测；以普通账号抽查集合权限、引用预览、原件下载和聊天/Agent 知识检索。
7. 对桌面端抽查一次已授权目录/数据库、SQLite 文件数据分析导入和本机 SQLite 只读工具，确认主库收敛未破坏本机能力。

### 4.1 大型历史 `knowledge_chunks` 的升级处理

`202609200004_knowledge_product_foundation` 已调整为启动时只进行必要的结构补齐，不再把历史 `knowledge_chunks` 的向量列转换、也不在启动事务中回填全部向量元数据。原因是存量分块多时，列重写、全表 `UPDATE` 或外键全表校验会超过普通 SQL 的 `PG_STATEMENT_TIMEOUT_MS`，导致迁移事务回滚并使容器反复启动失败。

- 历史 `embedding` 为 `TEXT` 或 `vector` 均可保留；检索层会安全兼容可解析的历史向量文本。未携带 profile/维度的历史分块只走有限兼容候选，新写入或重建后的分块可正常进入按 profile/维度划分的 HNSW 索引。
- `knowledge_chunks_block_fk` 与 `knowledge_docs_source_fk` 使用 `NOT VALID` 方式挂载：历史记录不会在启动时被全表验证，后续新增或更新仍会受外键约束。
- 遇到 `57014: canceling statement due to statement timeout` 时，先确认部署的镜像包含该修复；**不要**通过增加 `PG_STATEMENT_TIMEOUT_MS`、删除历史分块、修改 `schema_migrations` 或手工把列改为 `vector` 来恢复启动。
- 失败迁移在一个事务内执行，回滚后不会写入迁移记录。换用修复后的镜像启动成功后，使用下列只读 SQL 确认结果：

  ```sql
  SELECT id, description, applied_at
  FROM schema_migrations
  WHERE id = '202609200004_knowledge_product_foundation';
  ```

- 如需验证历史外键数据，可由 DBA 在服务恢复且完成数据核验后、另行安排维护窗口执行；不要把验证放在应用启动路径：

  ```sql
  ALTER TABLE knowledge_chunks VALIDATE CONSTRAINT knowledge_chunks_block_fk;
  ALTER TABLE knowledge_docs VALIDATE CONSTRAINT knowledge_docs_source_fk;
  ```

### 4.2 v0.1.161 权限边界、HNSW 与 Embedding 容量

本版本将知识库跨用户读取统一限定为超级管理员账户 `admin`：普通管理员即使 `role=admin`，只要用户名不是 `admin`，也只能读取本人上传的常规知识库文档、专题、标签、检索结果、数据源、索引任务和图谱。该限制在服务端 SQL 查询中执行，不能通过页面参数或直接请求其他用户的 `docId` 绕过。

- 产品化文档保留必要的受控协作：文档所有者、被明确指定的内容负责人/审核人，以及存在 `knowledge_permissions` 显式授权的主体可按授权访问指定文档；这不是普通管理员的全库读取权限。
- 若需要跨用户运维，请使用超级管理员账户 `admin`，不要把普通管理员账号提升为全局数据读取主体或直接修改数据表。
- 日志出现 `知识库 HNSW 索引创建失败` 且错误为 `syntax error at or near "WITH"` 时，说明运行的是旧镜像中 HNSW DDL 参数与部分索引条件顺序错误的实现。部署本版本后无需删除已有数据；重新索引任一受影响文档或等待补齐队列重试，应用会以正确顺序创建索引。
- 如果 llama.cpp Embedding 服务返回 `input (...) is too large to process. increase the physical batch size (current batch size: 512)`，修改 **Embedding 服务自己的** Compose 启动参数，而不是 Pivot 主服务的 Compose。为 `llama-server` 同时设置 `--batch-size` 和 `--ubatch-size`，例如均为 `2048`；若显存不足可一起降到 `1024`。`--ubatch-size` 是物理批次上限，必须不小于实际单条输入 token 数，且不应大于模型可用上下文窗口。参数定义见 [llama.cpp server 文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)。

部署后可执行以下只读 SQL 确认 profile 对应的 HNSW 索引已创建：

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND tablename = 'knowledge_chunks'
  AND indexname LIKE 'idx_knowledge_chunks_embedding_hnsw_%';
```

## 5. v0.1.155 知识库检查清单

| 检查项 | 预期结果 |
| --- | --- |
| `schema_migrations` | 已登记 `202609200004_knowledge_product_foundation`、`202609200005_knowledge_product_governance`、`202609200006_knowledge_database_query_templates`。 |
| 知识对账 | `npm run verify:knowledge-migration -- --strict` 返回零一致性错误。 |
| 可恢复索引 | `knowledge_ingestion_jobs` 中失败任务有可诊断原因、受限重试时间和租约状态；Embedding 不可用时仍可保持词法检索。 |
| 访问控制 | 无权限用户不能读取集合、引用、原件或将其作为 Agent 资料包。 |
| 局域网来源 | 目录仅访问白名单路径；HTTP/API 不发生越权重定向；数据库来源只使用已审核只读模板。 |
| 质量评测 | 黄金问题集、评测运行和指标结果可读取，且不将空答案误计为成功。 |

### v0.1.157 工具库控制面增量检查

`v0.1.157` 会自动应用 `202609200004_tool_library_product_control_plane`，新增工具 Catalog Release、目录项/别名/向量索引、连接器与连接账户、授权请求、工具任务、调用事件、评测与工具包供应链表。迁移保留既有 `mcp_servers` 和 `mcp_tool_cache`；后者继续作为 active Catalog Release 的兼容读模型，因此无需在停机窗口手工迁移已有服务配置。

| 检查项 | 预期结果 |
| --- | --- |
| `schema_migrations` | 已登记 `202609200004_tool_library_product_control_plane`。 |
| 首次目录刷新 | 每个已配置外部 MCP 服务至少生成一个 `tool_catalog_releases` 记录；刷新失败时既有 active release 和缓存仍可用。 |
| OAuth 安全 | 生产连接器的授权端点、令牌端点和回调地址均使用 HTTPS；`PIVOT_ALLOW_INSECURE_OAUTH_HTTP` 保持 `false`。 |
| 连接账户 | `connection_accounts` 只保存加密凭据引用；管理/API 响应、工具 Schema、调用日志和模型上下文不出现令牌原文。 |
| 工作流兼容 | 若新 Release 标记为破坏性变更，相关已发布工作流显示 stale，重新确认后才可再次发布。 |
| 运行治理 | 工具调用事件可关联 actor、release、策略决定、Trace 和安全摘要；任务取消、限流和熔断不绕过统一策略入口。 |

### v0.1.164 PPT 制作应用增量检查

`v0.1.164` 会自动应用 `202609220001_presentation_workbench_foundation`，新增 `presentation_documents`、`presentation_versions`、`presentation_templates`、`presentation_assets` 和 `presentation_exports`。该迁移只新增演示文稿的业务表和索引；可下载的 PPTX、PDF、PNG 继续使用既有 `agent_artifacts`、`agent_artifact_objects`、`agent_artifact_renditions` 与下载交付表，不会创建面向浏览器暴露的文件路径。

| 检查项 | 预期结果 |
| --- | --- |
| `schema_migrations` | 已登记 `202609220001_presentation_workbench_foundation`。 |
| 文稿隔离 | `presentation_documents`、模板与素材查询均按 `tenant_id + owner_user_id` 过滤；不同账号不能凭文稿 ID 或 CAS 引用读取内容。 |
| Artifact 链路 | 新建文稿有独立 `agent_artifacts` 记录；导出后存在对应 `agent_artifact_renditions` 与 `presentation_exports` 记录。 |
| 渲染结果 | 在 PowerPoint/WPS 抽样打开 PPTX，并抽样比对应用预览、PDF 与 PNG 的中文字形、文本位置和图表显示。 |
| 素材治理 | 素材对象使用 `presentation_asset` 类型的 CAS 记录；不存在直接暴露的 `storage_key`、绝对路径或任意远程图片 URL。 |

升级前备份 PostgreSQL 与现有 Artifact/CAS 存储目录。生产镜像或桌面安装包重新构建前应运行 `npm ci`，确保使用锁定的 `pptxgenjs@4.0.1`；若应用账户没有创建表、索引或外键的权限，迁移会在事务内失败且不会写入 `schema_migrations`，应先修正权限后重启，不要手工插入迁移记录。


### v0.1.168 PPT 产品级验收收口增量检查

`v0.1.168` 会自动应用 `202609230003_presentation_quality_metadata`。该迁移在 `presentation_assets` 增加 `pixel_width`、`pixel_height`，并新增 `presentation_documents` 的租户更新时间索引；不迁移、不复制、不向浏览器暴露已有 CAS 对象内容。

| 检查项 | 预期结果 |
| --- | --- |
| `schema_migrations` | 已登记 `202609230003_presentation_quality_metadata`。 |
| 素材质量元数据 | 新上传图片保存宽高像素值；历史图片保留 `0`，只是不参与低分辨率提示，不影响既有导出。 |
| 文稿库筛选 | 创建者、更新时间、模板、状态、标签和收藏均只在当前租户与授权文稿范围内生效；搜索中的 `%`、`_` 作为普通文字处理。 |
| 导出变体 | 16:9/4:3、备注、页码、来源标记、字体策略和图片质量均通过受控 IR 变体生成；不得以客户端 CSS 或裸下载地址伪造导出设置。 |
| 4:3 兼容 | PPTX 使用 PptxGenJS 的 `LAYOUT_4x3`；上线后在安装 PowerPoint/WPS/LibreOffice 的目标机抽样执行真实打开、保存、重开验证。 |

升级时先完成 PostgreSQL 与 Artifact/CAS 备份，部署后重启服务，并在 `/version.json` 或前端更新提示中确认版本为 `v0.1.168`。未安装 Office 的服务器只能完成 OOXML、PDF、PNG 和服务端渲染验收，不得将其记作 Office 实机验收通过。

## 6. 禁止执行的旧流程

下列已删除脚本及其等价流程不适用于 v0.1.155：

- `scripts/migrate_sqlite_to_pg.js`
- `scripts/verify_pg_migration.js`
- `scripts/diff_schema_sqlite_pg.js`
- 基于 SQLite 主库文件、FTS5 虚表、`sqlite_master`、`PRAGMA table_info` 的服务端主库维护脚本

已完成历史 SQLite→PostgreSQL 数据切换的系统可直接升级。仍持有 SQLite 主业务库但尚未切换的系统，不应直接部署 v0.1.155；请在隔离环境使用经审核的一次性迁移方案完成数据核验、业务演练和切换，避免把桌面本机 SQLite 误当作业务库来源。

## 7. 备份、恢复与回滚

### 备份

升级前后均建议从受控运维检出环境或维护镜像执行 PostgreSQL 逻辑备份，并保留原始上传文件备份：

```powershell
npm run backup
```

备份文件只可先恢复到 staging 验证。除数据库外，`uploads/`、受控文件交付目录和组织既有的文件备份策略必须保持一致。

### 回滚

PostgreSQL 版本迁移不提供自动 down migration。若升级后必须回退：

1. 停止业务写入并记录切换时点；
2. 在 staging 先恢复升级前 PostgreSQL 备份和同一恢复点的文件备份；
3. 验证登录、会话、知识引用、Agent 运行和索引任务；
4. 仅在验证完成后恢复与备份匹配的软件版本和生产数据。

禁止用删除新表、手工删除列或修改 `schema_migrations` 记录替代恢复。这样会破坏历史投影、引用和审计关联。

## 8. 容量与日常运维

- 生产容量结论应基于目标局域网硬件、真实 embedding profile、数据规模、ACL 密度和 PostgreSQL 参数；开发机测试不能替代 10 万 chunk 级别的 P95 验收。
- 关注连接池、慢查询、索引任务积压、向量覆盖率、检索命中/缓存命中、引用质量和来源同步失败。
- 定期执行 PostgreSQL 备份与上传目录垃圾回收；从受控运维检出环境对知识库变更执行 `npm run verify:knowledge-migration -- --strict`，并在真实黄金问题集上复测。
- 多实例部署应共用 PostgreSQL 与文件存储；索引任务通过数据库租约协调，不能依赖单实例内存队列。

## 9. 关联文档

- [v0.1.155 发布记录](releases/v0.1.155-知识库产品化与PostgreSQL主库收敛.md)
- [v0.1.157 工具库产品化控制面与受控连接发布记录](releases/v0.1.157-工具库产品化控制面与受控连接.md)
- [工具库产品级差距分析与升级方案](../工具库产品级差距分析与升级方案.md)
- [工具包发布与签名规范](工具包发布与签名规范.md)
- [知识库产品化改造方案](../Pivot知识库产品化改造方案.md)
- [生产环境离线部署](生产环境离线部署.md)
- [历史 SQLite→PostgreSQL 一次性迁移方案（归档）](../Pivot生产环境迁移PostgreSQL实施方案.md)
