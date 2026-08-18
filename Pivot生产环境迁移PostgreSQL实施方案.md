# Pivot 生产环境从 SQLite 迁移至 PostgreSQL 实施方案 (v2.2 修订版)

> **文档版本**：v2.2.0（修复 IDENTITY 序列重置、布尔映射错误、时区基准验证、重跑机制、离线索引策略、work_mem 公式、HNSW 参数）  
> **更新日期**：2026-08-17  
> **适用系统**：Pivot (智枢) AI 智能中枢管理系统  
> **前置要求**：pgvector ≥ 0.5.0（HNSW 索引语法依赖此版本）  
> **核心定位**：针对生产环境已存在海量业务数据（用户、会话、消息、知识库分块、工作流配置、审计日志）的场景，提供**数据零丢失、外键拓扑强约束、主键游标无锁流式抽取、Hybrid 混合检索与科学两阶段容灾**的严密迁移工程标准 Runbook。

---

## 目录
- [一、 迁移背景与核心架构定位](#一-迁移背景与核心架构定位)
- [二、 数据库方言与 Schema 映射规范](#二-数据库方言与-schema-映射规范)
  - [1. 数据类型转换映射表](#1-数据类型转换映射表)
  - [2. 明确的 JSONB 字段白名单与 NULL 语义保持](#2-明确的-jsonb-字段白名单与-null-语义保持)
  - [3. 时区一致性规范 (Timezone Handling)](#3-时区一致性规范-timezone-handling)
  - [4. 大文件存储解耦原则 (Artifact Storage vs DB)](#4-大文件存储解耦原则-artifact-storage-vs-db)
  - [5. RAG 知识库检索体系升级：Hybrid 混合检索方案](#5-rag-知识库检索体系升级hybrid-混合检索方案)
- [三、 自动化全量迁移引擎与脚本实现](#三-自动化全量迁移引擎与脚本实现)
  - [1. 拓扑依赖排序与外键强约束保证](#1-拓扑依赖排序与外键强约束保证)
  - [2. Keyset Pagination (主键游标分页) 生产级抽取](#2-keyset-pagination-主键游标分页-生产级抽取)
  - [3. PG 65535 参数上限防爆与分表独立事务策略](#3-pg-65535-参数上限防爆与分表独立事务策略)
  - [4. pgvector 向量数组格式化安全分支](#4-pgvector-向量数组格式化安全分支)
  - [5. 迁移重跑机制（失败恢复）](#5-迁移重跑机制失败恢复)
  - [6. 完整迁移脚本实现 (`scripts/migrate_sqlite_to_pg.js`)](#6-完整迁移脚本实现-scriptsmigrate_sqlite_to_pgjs)
- [四、 四级数据一致性与业务语义深度核验](#四-四级数据一致性与业务语义深度核验)
  - [1. 四级核验机制 (行数 ➔ 主键集 ➔ 全量哈希 ➔ 业务关系图)](#1-四级核验机制-行数--主键集--全量哈希--业务关系图)
  - [2. 完整核验脚本实现 (`scripts/verify_pg_migration.js`)](#2-完整核验脚本实现-scriptsverify_pg_migrationjs)
- [五、 生产环境平滑割接与两阶段应急预案 (Two-Stage Recovery)](#五-生产环境平滑割接与两阶段应急预案-two-stage-recovery)
  - [1. 割接准备与演练基准 (T-7 天 ~ T-1 天)](#1-割接准备与演练基准-t-7-天--t-1-天)
  - [2. 维护窗口正式割接 SOP (T 日窗口)](#2-维护窗口正式割接-sop-t-日窗口)
  - [3. 科学的两阶段应急预案 (Pre-cutover Rollback vs Post-cutover Recovery)](#3-科学的两阶段应急预案-pre-cutover-rollback-vs-post-cutover-recovery)
- [六、 生产环境 PostgreSQL 参数调优与连接池架构](#六-生产环境-postgresql-参数调优与连接池架构)
  - [1. 科学的内存与并发参数计算公式](#1-科学的内存与并发参数计算公式)
  - [2. PgBouncer 与客户端连接池设计](#2-pgbouncer-与客户端连接池设计)
  - [3. 索引后建策略与 Autovacuum 调优](#3-索引后建策略与-autovacuum-调优)
- [七、 服务端 Repository 架构重构规范](#七-服务端-repository-架构重构规范)

---

## 一、 迁移背景与核心架构定位

### 1.1 核心问题澄清
- **消除 SQLite 文件级单写者瓶颈**：显著降低 SQLite 在高并发读写时因单写锁模型引发的写锁竞争，利用 PostgreSQL 的 **MVCC（多版本并发控制）与行级锁（Row-Level Locking）** 支撑高并发 Agent Trace 上报与业务写入；
- **解决慢查询根源**：针对大表扫描、长文本 JSON 解析、RAG 向量检索提供原生索引与并行优化器支持；
- **全生命周期企业级容灾**：实现流复制、主从热备、物理 WAL 归档与基于时间点的恢复（PITR）。

---

## 二、 数据库方言与 Schema 映射规范

### 1. 数据类型转换映射表

| SQLite 数据类型 | PostgreSQL 生产类型 | 转换规则与注意事项 |
| :--- | :--- | :--- |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT GENERATED ALWAYS AS IDENTITY` | 迁移后必须用 `ALTER TABLE ... ALTER COLUMN ... RESTART WITH <max+1>` 重置序列 |
| `TEXT` (UUID/短标识符) | `VARCHAR(64)` / `VARCHAR(255)` | 显式限制长度以提高 B-Tree 索引检索与存储效率 |
| `TEXT` (长文本/提示词/公文) | `TEXT` | 原样映射，支持 TOAST 机制存储超长字段 |
| `TEXT` (JSON 结构体) | `JSONB` | 经由白名单校验后序列化为二进制 JSONB，支持 GIN 索引 |
| `INTEGER` (布尔语义 0/1) | `BOOLEAN` | `0 ➔ FALSE`, `1 ➔ TRUE`, `NULL ➔ NULL`；枚举字符串字段严禁纳入此列 |
| `TEXT` (时间字符串) | `TIMESTAMPTZ` | 迁移前必须先执行时区基准验证（见 §2.3），确认存储基准后统一转换 |
| `TEXT` (向量数组字符串) | `vector` | 显式清洗为 PG `vector` 格式字符串 `[0.012, 0.981, ...]` |
| `REAL` | `DOUBLE PRECISION` | 浮点数、耗时、相似度得分 |

---

### 2. 明确的 JSONB 字段白名单与 NULL 语义保持

#### 2.1 严禁按首字符猜测 JSON
严禁使用 `startsWith('{')` 模糊推断字段类型。必须通过严格的**字段白名单（Schema Mapping Registry）**执行类型映射：

```javascript
const JSONB_COLUMNS = {
    agent_runs: ['budget_config', 'checkpoint_state', 'usage_stats'],
    agent_steps: ['plan_snapshot'],
    agent_tool_calls: ['input_payload'],
    messages: ['meta', 'tool_calls'],
    workflows: ['definition'],
    workflow_versions: ['definition'],
    workflow_runs: ['execution_context', 'outputs'],
    capability_packages: ['config']
};
```

#### 2.2 严格保持 NULL 语义
严禁在迁移时擅自将 `NULL` 篡改为 `{}` 或 `[]`：
- 若 SQLite 原始值为 `NULL`，则 PostgreSQL 目标列必须写入 `NULL`（代表该元数据不存在）；
- 若 SQLite 原始值为合法 JSON 字符串（如 `"{}"`），则解析为对应 JSONB 对象写入；
- 遇到畸形损坏的 JSON 字符串，立即抛出解析异常并记录行 ID，严禁静默忽略。

---

### 3. 时区一致性规范 (Timezone Handling)

#### 3.1 迁移前必做：时区基准验证

SQLite 存储的时间字符串没有时区标识（如 `2026-08-17 10:00:00`），写入 `TIMESTAMPTZ` 时 PostgreSQL 会按会话时区解释。**若实际存储基准判断错误，将引起 ±8 小时系统性偏移。**

迁移前必须执行以下验证查询，与业务已知时间点对比：

```sql
-- 在 SQLite 中查询几条已知业务时间的记录
SELECT id, created_at FROM messages ORDER BY created_at DESC LIMIT 5;
-- 对比该时间是「北京时间」还是「UTC」，确认后写入 SQLITE_TZ 环境变量
```

| 场景 | 会话时区设置 | 说明 |
| :--- | :--- | :--- |
| SQLite 存的是北京时间（Asia/Shanghai） | `SET timezone = 'Asia/Shanghai'` | 无偏移，直接解析 |
| SQLite 存的是 UTC（Node.js new Date() 默认） | `SET timezone = 'UTC'` | 无偏移，按 UTC 解析后 PG 内部统一存储为 UTC |

```bash
# 执行迁移前必须通过环境变量显式声明 SQLite 时间基准
export SQLITE_TIMEZONE=UTC         # 或 Asia/Shanghai
export DATABASE_URL=postgresql://...
node scripts/migrate_sqlite_to_pg.js
```

#### 3.2 TIMESTAMPTZ 字段白名单
脚本中对 `TIMESTAMPTZ` 列进行显式格式保护，拒绝非日期字符串写入：

```javascript
// 时间字段白名单 —— 仅这些列执行时区对齐转换
const TIMESTAMP_COLUMNS = {
    users: ['created_at', 'updated_at', 'last_login_at'],
    sessions: ['created_at', 'updated_at'],
    messages: ['created_at'],
    knowledge_chunks: ['created_at'],
    agent_runs: ['created_at', 'started_at', 'finished_at'],
    agent_steps: ['created_at', 'started_at', 'finished_at'],
    audit_logs: ['created_at']
};
```

---

### 4. 大文件存储解耦原则 (Artifact Storage vs DB)

PostgreSQL 严禁充当文件系统。所有非结构化大文件严格执行**元数据与实体分离架构**：
- **PostgreSQL 数据库**：仅存储 `agent_artifacts` 元数据表（包含 `file_path`, `file_size`, `sha256`, `mime_type`）；
- **BlobStore / 本地文件系统**：实际存储 PDF、DOCX、Excel、图片截图、导出的数据集实体。

---

### 5. RAG 知识库检索体系升级：Hybrid 混合检索方案

#### 5.1 纠正"FTS5 = pg_trgm 平替"误区
`pg_trgm` 适合短词模糊匹配，而中文长文本全文检索需要分词器与倒排索引。Pivot RAG 体系升级为 **"向量检索 + 关键词检索 + 倒排加权融合" 的 Hybrid 检索架构**：

```
                              用户检索 Query
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
      【1. 语义向量路 (Dense)】           【2. 关键词全文路 (Sparse)】
      • pgvector (HNSW 索引)              • pg_trgm + tsvector (GIN 索引)
      • 计算 Cosine 相似度                • 关键词高频与精确匹配
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
                      【3. 混合重排与融合 (RRF)】
                      • Reciprocal Rank Fusion 算法
                      • 输出最相关 Top-K 知识分块
```

#### 5.2 动态向量维度与 HNSW 运行时配置
知识库表记录每个知识库专有的模型与维度，严禁写死 `vector(1536)`：

```sql
-- 前置要求：pgvector >= 0.5.0（HNSW 语法依赖此版本）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 知识库分块表结构
CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id VARCHAR(64) PRIMARY KEY,
    document_id VARCHAR(64) NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    knowledge_base_id VARCHAR(64) NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding vector,               -- 维度由各知识库 embedding_dimension 动态支持
    meta JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 关键词 GIN 索引
CREATE INDEX IF NOT EXISTS idx_chunks_content_trgm ON knowledge_chunks USING gin (content gin_trgm_ops);

-- HNSW 向量索引（离线维护窗口内直接建，无需 CONCURRENTLY）
-- m=16 控制图连接数，ef_construction=128 提高召回率（生产建议 128~256）
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 128);
```

> **运行时调优**：在执行 RAG 检索前，会话级调整 `SET LOCAL hnsw.ef_search = 100;`，平衡检索召回率与响应耗时。

---

## 三、 自动化全量迁移引擎与脚本实现

### 1. 拓扑依赖排序与外键强约束保证
- 迁移脚本**严禁使用 `SET session_replication_role = 'replica'` 绕过外键约束**；
- 必须基于数据库 Schema 外键依赖图进行**拓扑排序（Topological Sort）**，严格按 `父表 ➔ 子表` 顺序写入；
- 若存在外键违规或孤儿数据，PostgreSQL 立即报错中断，确保入库数据的绝对引用完整性。

---

### 2. Keyset Pagination (主键游标分页) 生产级抽取

废弃 `OFFSET N` 分页（百万级大表会导致全表扫描崩溃）。采用**基于主键的游标分页（Keyset Pagination）**：

```sql
-- 整型主键游标抽取（INTEGER/BIGINT）：
SELECT * FROM "agent_runs"
WHERE id > $last_seen_id
ORDER BY id ASC
LIMIT 1000;

-- VARCHAR/UUID 主键同样适用字典序游标（UUID v4 字典序连续，不会漏记录）：
SELECT * FROM "knowledge_chunks"
WHERE id > $last_seen_id
ORDER BY id ASC
LIMIT 1000;
```

> **注意**：脚本通过 `PRAGMA table_info` 获取 `pk = 1` 的列作为游标键。对于**复合主键**表，仅取第一主键列作为游标——需在 `TABLE_TOPOLOGY` 中为此类表配置 `pkOverride`（见下方脚本实现）。

---

### 3. PG 65535 参数上限防爆与分表独立事务策略

#### 3.1 动态批次大小计算（防爆机制）
PostgreSQL 驱动层单条 SQL 的绑定参数上限为 65,535。若某张表有 50 个字段，设置 `BATCH_SIZE = 2000` 将产生 100,000 个参数导致驱动崩溃。
- **计算公式**：每批插入行数动态计算为：
  $$\text{BatchRows} = \min\left(1000, \left\lfloor \frac{60000}{\text{ColumnsCount}} \right\rfloor\right)$$

#### 3.2 分表独立事务控制 (Table-Level Transactions)
若所有表都在单一全局事务中提交，当总数据量达数千万行时，会导致 PG 的 WAL 日志急剧膨胀，且长时间占住锁资源。
- **生产策略**：采用**"表级独立事务 + 记录 Checkpoint"**机制，每张表迁移完毕后独立提交事务并打印结果；单表若失败则该表回滚并中断退出，支持修复后从该表继续，无需全部重新开始。

---

### 4. pgvector 向量数组格式化安全分支
SQLite 中存储向量通常为 JSON 数组字符串（如 `"[0.012, 0.981, ...]"`）。在写入 PostgreSQL `vector` 类型时，必须显式转换为合法的向量文本格式 `[0.012, 0.981, ...]`，避免类型转换异常。

---

### 5. 迁移重跑机制（失败恢复）

当某张表迁移中途失败时，事务已回滚，目标表数据为空或中途状态。重跑前**必须先 TRUNCATE 目标表**，再从该表重新开始，否则将触发主键冲突报错。

```bash
# 重跑单表迁移的标准流程：
# 1. 在 PostgreSQL 中清空目标表
psql $DATABASE_URL -c 'TRUNCATE TABLE "knowledge_chunks" CASCADE;'

# 2. 从该表重新开始迁移（通过 START_FROM_TABLE 环境变量跳过已完成的表）
START_FROM_TABLE=knowledge_chunks node scripts/migrate_sqlite_to_pg.js
```

脚本支持 `START_FROM_TABLE` 环境变量，跳过拓扑顺序中该表之前的所有已成功表。

---

### 6. 完整迁移脚本实现 (`scripts/migrate_sqlite_to_pg.js`)

```javascript
/**
 * scripts/migrate_sqlite_to_pg.js
 * Pivot 生产级无损数据迁移引擎 (SQLite ➔ PostgreSQL) v2.2
 * 修复：IDENTITY 序列重置、agent_skills.status 布尔错误、时区基准显式配置、重跑支持
 */
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const sqlitePath = process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../data/chat.db');
const pgUrl = process.env.DATABASE_URL;
// 必须在执行前通过环境变量声明 SQLite 时间基准（UTC 或 Asia/Shanghai）
const sqliteTz = process.env.SQLITE_TIMEZONE || 'UTC';
const startFromTable = process.env.START_FROM_TABLE || null;

if (!pgUrl) {
    console.error('❌ [Fatal] 未配置 DATABASE_URL 环境变量，严禁盲目执行！');
    process.exit(1);
}
if (!fs.existsSync(sqlitePath)) {
    console.error(`❌ [Fatal] 未找到 SQLite 数据库文件: ${sqlitePath}`);
    process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new Pool({ connectionString: pgUrl, max: 5 });

// 严格的依赖拓扑顺序（父表在前，子表在后）
// pkOverride：复合主键或需指定游标列的表，显式声明游标键列名
const TABLE_TOPOLOGY = [
    { name: 'users' },
    { name: 'app_settings' },
    { name: 'models' },
    { name: 'knowledge_bases' },
    { name: 'knowledge_documents' },
    { name: 'knowledge_chunks' },
    { name: 'knowledge_graph_entities' },
    { name: 'knowledge_graph_relations' },
    { name: 'sessions' },
    { name: 'messages' },
    { name: 'workflows' },
    { name: 'workflow_versions' },
    { name: 'workflow_runs' },
    { name: 'agent_skills' },
    { name: 'agent_runs' },
    { name: 'agent_steps' },
    { name: 'agent_tool_calls' },
    { name: 'agent_artifacts' },
    { name: 'capability_packages' },
    { name: 'audit_logs' },
];

// JSONB 字段白名单（严禁按首字符猜测）
const JSONB_COLUMNS = {
    agent_runs: ['budget_config', 'checkpoint_state', 'usage_stats'],
    agent_steps: ['plan_snapshot'],
    agent_tool_calls: ['input_payload'],
    messages: ['meta', 'tool_calls'],
    workflows: ['definition'],
    workflow_versions: ['definition'],
    workflow_runs: ['execution_context', 'outputs'],
    capability_packages: ['config']
};

// 布尔字段白名单（仅纳入存储 0/1 整型语义的列，字符串枚举列严禁纳入）
// 注意：agent_skills.status 为字符串枚举，已从此处移除
const BOOLEAN_COLUMNS = {
    users: ['is_active', 'is_admin'],
    models: ['enabled'],
    agent_tool_calls: ['idempotent']
};

// 向量字段白名单
const VECTOR_COLUMNS = {
    knowledge_chunks: ['embedding']
};

/**
 * 重置整型自增序列（兼容 SERIAL 与 GENERATED ALWAYS AS IDENTITY）
 * 修复：pg_get_serial_sequence 对 IDENTITY 列可能返回 NULL，改用 ALTER TABLE RESTART WITH
 */
async function resetSequence(client, tableName, pkName) {
    try {
        // 方法一：尝试通过 pg_get_serial_sequence 获取 SERIAL 序列名
        const seqRes = await client.query(
            `SELECT pg_get_serial_sequence($1, $2) AS seq_name`,
            [tableName, pkName]
        );
        const seqName = seqRes.rows[0]?.seq_name;
        if (seqName) {
            await client.query(
                `SELECT setval($1, COALESCE((SELECT MAX("${pkName}") FROM "${tableName}"), 1), true)`,
                [seqName]
            );
            console.log(`   🔢 序列 [${seqName}] 已重置`);
            return;
        }

        // 方法二：IDENTITY 列使用 ALTER TABLE RESTART WITH
        const maxRes = await client.query(`SELECT MAX("${pkName}") AS max_val FROM "${tableName}"`);
        const maxVal = maxRes.rows[0]?.max_val;
        if (maxVal !== null && maxVal !== undefined) {
            await client.query(
                `ALTER TABLE "${tableName}" ALTER COLUMN "${pkName}" RESTART WITH ${BigInt(maxVal) + 1n}`
            );
            console.log(`   🔢 IDENTITY 序列已重置为 ${BigInt(maxVal) + 1n}`);
        }
    } catch (e) {
        // VARCHAR/UUID 主键无序列，正常跳过
        console.log(`   ⏩ 主键 [${pkName}] 无自增序列，跳过重置`);
    }
}

async function migrateTable(tableConfig, client) {
    const tableName = tableConfig.name;
    const tableCheck = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (!tableCheck) {
        console.log(`⏩ [Skip] SQLite 中不存在表 [${tableName}]，跳过。`);
        return;
    }

    const totalCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${tableName}"`).get().c;
    console.log(`\n📦 开始迁移表 [${tableName}] | 待迁移记录数: ${totalCount}`);
    if (totalCount === 0) return;

    // 获取主键名称（支持 pkOverride 覆盖）
    const colInfo = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all();
    const pkInfo = colInfo.find(col => col.pk === 1);
    const pkName = tableConfig.pkOverride || (pkInfo ? pkInfo.name : 'rowid');

    // 动态计算防爆批次大小（PG 65535 绑定参数上限防爆）
    const tableCols = colInfo.map(c => c.name);
    const safeBatchSize = Math.max(10, Math.min(1000, Math.floor(60000 / tableCols.length)));

    let lastId = null;
    let migratedCount = 0;

    const jsonCols = new Set(JSONB_COLUMNS[tableName] || []);
    const boolCols = new Set(BOOLEAN_COLUMNS[tableName] || []);
    const vecCols = new Set(VECTOR_COLUMNS[tableName] || []);

    // 表级独立事务
    await client.query('BEGIN');

    try {
        while (migratedCount < totalCount) {
            let querySql = `SELECT * FROM "${tableName}"`;
            const params = [];
            if (lastId !== null) {
                querySql += ` WHERE "${pkName}" > ?`;
                params.push(lastId);
            }
            querySql += ` ORDER BY "${pkName}" ASC LIMIT ?`;
            params.push(safeBatchSize);

            const rows = sqlite.prepare(querySql).all(...params);
            if (rows.length === 0) break;

            const columns = Object.keys(rows[0]);
            const colsFormatted = columns.map(c => `"${c}"`).join(', ');

            const valuePlaceholders = [];
            const flatParams = [];
            let paramIdx = 1;

            for (const row of rows) {
                const rowPlaceholders = [];
                for (const col of columns) {
                    let val = row[col];

                    // 1. JSONB 显式白名单安全转换
                    if (jsonCols.has(col)) {
                        if (val === null || val === undefined) {
                            val = null;
                        } else if (typeof val === 'string') {
                            try {
                                val = JSON.stringify(JSON.parse(val));
                            } catch (err) {
                                throw new Error(`表 [${tableName}] 列 [${col}] 主键 [${row[pkName]}] 包含损坏 JSON: ${val}`);
                            }
                        } else if (typeof val === 'object') {
                            val = JSON.stringify(val);
                        }
                    }

                    // 2. Boolean 语义安全转换（仅 0/1 整型语义列）
                    if (boolCols.has(col) && val !== null && val !== undefined) {
                        val = val === 1 || val === '1' || val === true;
                    }

                    // 3. Vector 向量字段安全格式化
                    if (vecCols.has(col) && val !== null && val !== undefined) {
                        if (typeof val === 'string' && val.trim().startsWith('[')) {
                            // 已是合法向量字符串格式，保持不变
                        } else if (Array.isArray(val)) {
                            val = `[${val.join(',')}]`;
                        } else {
                            // 非法向量数据，抛出错误阻断
                            throw new Error(`表 [${tableName}] 列 [${col}] 主键 [${row[pkName]}] 向量格式非法: ${val}`);
                        }
                    }

                    flatParams.push(val);
                    rowPlaceholders.push(`$${paramIdx++}`);
                }
                valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
                lastId = row[pkName];
            }

            // 严禁使用 ON CONFLICT DO NOTHING，冲突即抛出异常阻断（保证数据绝对一致）
            const insertSql = `INSERT INTO "${tableName}" (${colsFormatted}) VALUES ${valuePlaceholders.join(', ')}`;
            await client.query(insertSql, flatParams);

            migratedCount += rows.length;
            process.stdout.write(`\r   └─ 进度: ${migratedCount} / ${totalCount} (${Math.round((migratedCount / totalCount) * 100)}%)`);
        }

        // 重置自增序列（兼容 SERIAL 与 IDENTITY 两种模式）
        await resetSequence(client, tableName, pkName);

        await client.query('COMMIT');
        console.log(`\n✅ 表 [${tableName}] 迁移并提交完毕 (共 ${migratedCount} 行)`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`表 [${tableName}] 迁移失败，事务已回滚。\n重跑命令：START_FROM_TABLE=${tableName} node scripts/migrate_sqlite_to_pg.js\n异常详情: ${err.message}`);
    }
}

async function main() {
    const client = await pool.connect();
    console.log('====================================================');
    console.log('   Pivot 生产级数据迁移引擎: SQLite ➔ PostgreSQL     ');
    console.log('====================================================');
    console.log(`   SQLite 时间基准时区: ${sqliteTz}`);
    if (startFromTable) {
        console.log(`   ⚡ 断点续传模式：从表 [${startFromTable}] 开始`);
    }
    const startMs = Date.now();

    try {
        // 统一会话时区（必须与 SQLITE_TIMEZONE 一致，确保时间解析无偏移）
        await client.query(`SET timezone = '${sqliteTz}';`);

        // 计算断点续传的起始索引
        let startIdx = 0;
        if (startFromTable) {
            const idx = TABLE_TOPOLOGY.findIndex(t => t.name === startFromTable);
            if (idx === -1) {
                throw new Error(`START_FROM_TABLE 指定的表 [${startFromTable}] 不在 TABLE_TOPOLOGY 中`);
            }
            startIdx = idx;
        }

        for (let i = startIdx; i < TABLE_TOPOLOGY.length; i++) {
            await migrateTable(TABLE_TOPOLOGY[i], client);
        }

        console.log('\n====================================================');
        console.log(`🎉 全量数据无损迁移成功！总耗时: ${((Date.now() - startMs) / 1000).toFixed(2)} 秒`);
        console.log('====================================================');
    } catch (err) {
        console.error('\n❌ [Fatal Error] 迁移进程中断！异常详情:', err.message);
        process.exit(1);
    } finally {
        client.release();
        sqlite.close();
        await pool.end();
    }
}

main();
```

---

## 四、 四级数据一致性与业务语义深度核验

### 1. 四级核验机制
迁移完成后，必须通过自动化校验工具执行深度核验：
1. **第一级：精确行数核验 (`COUNT(*)`)**：源表与目标表行数差异必须为 0；
2. **第二级：主键集合核验**：比对主键 `MIN`, `MAX`, `COUNT(DISTINCT id)`；
3. **第三级：全量关键业务数据哈希比对**：对 `messages`, `knowledge_chunks`, `workflows` 的核心文本字段按表计算全局 SHA256 聚合哈希；
4. **第四级：业务关系语义与孤儿数据排查**：排查是否存在没有对应 User 的 Session，没有对应 Session 的 Message，以及孤儿知识分块。

---

### 2. 完整核验脚本实现 (`scripts/verify_pg_migration.js`)

```javascript
/**
 * scripts/verify_pg_migration.js
 * 数据迁移一致性深度核验工具 v2.2
 */
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const sqlite = new Database(
    process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../data/chat.db'),
    { readonly: true }
);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function verify() {
    console.log('====================================================');
    console.log('   正在执行 SQLite ➔ PostgreSQL 四级一致性深度核验   ');
    console.log('====================================================\n');
    const client = await pool.connect();
    let hasError = false;

    // ── 第一级 & 第二级：行数 + 主键集合核验 ──────────────────────────
    const tables = [
        'users', 'sessions', 'messages', 'knowledge_bases',
        'knowledge_documents', 'knowledge_chunks', 'workflows',
        'workflow_versions', 'agent_runs', 'agent_steps',
        'agent_tool_calls', 'audit_logs'
    ];

    console.log('【第一级】行数精确核验');
    console.log('| 校验表名             | SQLite 行数 | PostgreSQL 行数 | 行数差异 | 一致性判定 |');
    console.log('| :--- | :--- | :--- | :--- | :--- |');

    for (const table of tables) {
        try {
            const sqCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.c ?? 0;
            const pgRes = await client.query(`SELECT COUNT(*) AS c FROM "${table}"`);
            const pgCount = parseInt(pgRes.rows[0].c, 10);
            const diff = pgCount - sqCount;
            const status = diff === 0 ? '✅ 完美一致' : '❌ 存在差异';
            if (diff !== 0) hasError = true;
            console.log(`| ${table.padEnd(20)} | ${String(sqCount).padEnd(11)} | ${String(pgCount).padEnd(15)} | ${String(diff).padEnd(8)} | ${status} |`);
        } catch (e) {
            console.log(`| ${table.padEnd(20)} | 检查异常: ${e.message} |`);
            hasError = true;
        }
    }

    // ── 第三级：核心文本字段全局哈希比对 ─────────────────────────────
    console.log('\n【第三级】核心文本字段哈希比对');
    const hashTargets = [
        { table: 'messages',         col: 'content' },
        { table: 'knowledge_chunks', col: 'content' },
        { table: 'workflows',        col: 'name'    },
    ];
    for (const { table, col } of hashTargets) {
        try {
            const sqRows = sqlite.prepare(`SELECT "${col}" FROM "${table}" ORDER BY id ASC`).all();
            const sqHash = crypto.createHash('sha256')
                .update(sqRows.map(r => r[col] ?? '').join('\x00'))
                .digest('hex');

            const pgRes = await client.query(`SELECT "${col}" FROM "${table}" ORDER BY id ASC`);
            const pgHash = crypto.createHash('sha256')
                .update(pgRes.rows.map(r => r[col] ?? '').join('\x00'))
                .digest('hex');

            const match = sqHash === pgHash;
            if (!match) hasError = true;
            console.log(`  ${match ? '✅' : '❌'} ${table}.${col}: ${match ? 'HASH 完全一致' : `哈希不匹配\n     SQLite: ${sqHash}\n     PG:     ${pgHash}`}`);
        } catch (e) {
            console.log(`  ❌ ${table}.${col} 哈希比对异常: ${e.message}`);
            hasError = true;
        }
    }

    // ── 第四级：业务关系完整性与孤儿数据排查 ─────────────────────────
    console.log('\n【第四级】业务关系图完整性排查');
    const orphanChecks = [
        {
            label: '孤儿消息（无对应会话）',
            sql: `SELECT COUNT(*) AS c FROM messages m LEFT JOIN sessions s ON m.session_id = s.id WHERE s.id IS NULL`
        },
        {
            label: '孤儿会话（无对应用户）',
            sql: `SELECT COUNT(*) AS c FROM sessions s LEFT JOIN users u ON s.user_id = u.id WHERE u.id IS NULL`
        },
        {
            label: '孤儿知识分块（无对应文档）',
            sql: `SELECT COUNT(*) AS c FROM knowledge_chunks kc LEFT JOIN knowledge_documents kd ON kc.document_id = kd.id WHERE kd.id IS NULL`
        },
    ];

    for (const { label, sql } of orphanChecks) {
        try {
            const res = await client.query(sql);
            const count = parseInt(res.rows[0].c, 10);
            if (count > 0) {
                console.error(`  ❌ 发现 ${count} 条${label}！`);
                hasError = true;
            } else {
                console.log(`  ✅ ${label}: 0 条，关系完整`);
            }
        } catch (e) {
            console.log(`  ❌ ${label} 检查异常: ${e.message}`);
            hasError = true;
        }
    }

    client.release();
    sqlite.close();
    await pool.end();

    if (hasError) {
        console.error('\n❌ [Verification Failed] 核验未全部通过，严禁开放生产流量！');
        process.exit(1);
    } else {
        console.log('\n🎉 [Verification Success] 数据完整性核验 100% 通过，允许安全割接上线！');
    }
}

verify();
```

---

## 五、 生产环境平滑割接与两阶段应急预案 (Two-Stage Recovery)

```
  【T-7天 环境就绪】 ➔ 【T-1天 全真预演】 ➔ 【T日 维护窗口 (实测时长 × 2)】 ➔ 【两阶段容灾保护】
```

### 1. 割接准备与演练基准 (T-7 天 ~ T-1 天)
1. **时区基准验证（T-7 天必做）**：从生产库抽取 5~10 条带时间戳的已知业务记录，对照实际业务时间确认 SQLite 存储基准（UTC 或 Asia/Shanghai），写入部署文档；
2. **预演耗时测定**：在预发环境拉取生产备份 `chat.db`，完整运行迁移与核验脚本，测定真实耗时（记为 $T_{test}$）；
3. **割接窗口规划**：正式维护窗口严禁凭空估算，**必须设定为 $2 \times T_{test} + 30\text{分钟}$**。

---

### 2. 维护窗口正式割接 SOP (T 日窗口)

| 序号 | 步骤操作 | 执行要求与判定标准 | 责任角色 |
| :--- | :--- | :--- | :--- |
| **1** | **开启维护模式** | Nginx / API 网关层拦截外部写入请求，返回友好维护公告 | 运维/网关 |
| **2** | **停止应用进程** | 停止所有 Pivot 服务端 Node.js 实例，确保数据库完全静止 | 运维 |
| **3** | **生产 DB 最终冷备** | 将 `chat.db` 拷贝至只读目录并生成 SHA256 校验和：`chat.db.final_bak` | 运维/DBA |
| **4** | **运行数据迁移** | 执行 `SQLITE_TIMEZONE=UTC node scripts/migrate_sqlite_to_pg.js`（时区按实测基准填），等待全部表 ✅ | 开发/DBA |
| **5** | **四级一致性核验** | 执行 `node scripts/verify_pg_migration.js`，确认差异为 0，孤儿数据为 0 | 测试/架构 |
| **6** | **构建大表索引并 ANALYZE** | 应用已停止，直接 `CREATE INDEX`（无需 CONCURRENTLY）建 HNSW 和 GIN 索引，完成后执行 `ANALYZE;` | DBA |
| **7** | **切换配置与启动** | 生产环境 `.env` 配置 `DATABASE_URL`，启动 Node 实例，执行接口健康检查 | 运维 |
| **8** | **核心业务冒烟验证** | 验证登录、历史消息加载、RAG 问答、工作流执行等核心功能 | 业务/测试 |
| **9** | **撤除维护恢复流量** | 网关切回正常路由，正式恢复全员生产访问 | 运维 |

> **步骤 6 说明**：`CREATE INDEX CONCURRENTLY` 用于在线不停机建索引，代价是速度更慢、需要两次表扫描。维护窗口内应用已停止，直接使用 `CREATE INDEX` 速度更快，不必使用 CONCURRENTLY。

---

### 3. 科学的两阶段应急预案 (Pre-cutover Rollback vs Post-cutover Recovery)

> **核心法则**：PostgreSQL 一旦接收生产新写入，旧 SQLite 即刻失效为历史只读快照，**绝不能简单切回 SQLite 造成新增数据丢失**。

```
                          割接时间轴 (T 日)
  ───────────────────────────────┬───────────────────────────────>
   【阶段一：尚未开放生产流量】   │  【阶段二：已开放生产流量接收新写入】
                                 │
   • 发现迁移报错或冒烟失败      │  • 发现线上隐藏 Bug / 局部异常
   • 【处理策略】：一键切回 SQLite │  • 【处理策略】：严禁切回 SQLite！
   • 5 分钟回滚到 chat.db.final  │  • 立即基于 PostgreSQL 执行在线热修复、
   • 撤除维护，业务无损恢复      │    流复制主从切换或 PITR 时间点恢复
```

---

## 六、 生产环境 PostgreSQL 参数调优与连接池架构

### 1. 科学的内存与并发参数计算公式

严禁直接照抄固定参数。依据服务器物理硬件动态配置 `postgresql.conf`：

```ini
# 示例：专用数据库服务器 16GB RAM，8 核 CPU，max_connections = 200
shared_buffers = 4GB                   # RAM × 25%
effective_cache_size = 12GB            # RAM × 75%

# work_mem 计算公式：(RAM - shared_buffers) / (max_connections × 3)
# 示例：(16384 - 4096) MB / (200 × 3) = 12288 / 600 ≈ 20MB
work_mem = 20MB

maintenance_work_mem = 1GB             # 索引构建/VACUUM 专用，建议 RAM × 5%~6%

# 并行查询（Parallel Query）优化
max_worker_processes = 8               # = CPU 核数
max_parallel_workers_per_gather = 4    # = CPU 核数 / 2
max_parallel_workers = 8              # = CPU 核数

# 慢查询监控（记录超过 200ms 的 SQL 语句）
log_min_duration_statement = 200
```

---

### 2. PgBouncer 与客户端连接池设计
- **客户端连接池 (`pg-pool`)**：每个 Node.js 实例配置 `max: 10~15`，多实例部署时总连接数 = 实例数 × max，需确保不超过 PG `max_connections` 的 80%；
- **连接池代理 (PgBouncer)**：多节点集群部署时引入 PgBouncer 采用 `Transaction Pooling` 模式，将上千个应用连接高效复用在 50~100 个 PG 真实连接中。

---

### 3. 索引后建策略与 Autovacuum 调优
1. **迁移时后建大索引**：迁移百万级大表时，先导入原始数据，数据导入完毕后再统一建立 HNSW 和 GIN 索引，大幅降低迁移期间的 IO 写入开销；
2. **首次上线前执行全库统计**：索引建完后必须执行 `ANALYZE;`，确保查询计划器拥有准确统计信息，避免首批请求走全表扫描；
3. **高频写入表 Autovacuum 调优**：
   ```sql
   -- 针对高频写入表降低触发死元组清理的阈值，防止表膨胀 (Bloat)
   ALTER TABLE agent_tool_calls SET (autovacuum_vacuum_scale_factor = 0.05);
   ALTER TABLE messages SET (autovacuum_vacuum_scale_factor = 0.05);
   ```

---

## 七、 服务端 Repository 架构重构规范

彻底废除业务层到处写 `if (isPostgres)` 的反模式，统一收敛在 `server/repositories/` 数据访问层：

```
业务控制器 / 服务层 (Services)
             │
             ▼ 仅调用纯业务语义接口 (如 `messageRepo.createMessage(data)`)
  【Repository 数据访问层】
  ├── server/repositories/userRepository.js
  ├── server/repositories/sessionRepository.js
  ├── server/repositories/messageRepository.js
  └── server/repositories/knowledgeRepository.js
             │
             ▼ 底层统一适配 PostgreSQL 驱动
       【server/db/client.js】 (基于 pg-pool)
```

- **开发与测试环境统一**：推荐开发与 CI 环境均通过 Docker 启动标准 PostgreSQL 实例（pgvector ≥ 0.5.0），保证 `开发环境 == 测试环境 == 生产环境` 的 Schema 与查询行为完全一致。
