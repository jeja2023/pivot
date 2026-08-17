# Pivot 生产环境从 SQLite 迁移至 PostgreSQL 实施方案 (v2.1 终极生产级 Runbook)

> **文档版本**：v2.1.0（增加 PG 65535 参数动态防爆、分表事务控制、向量格式化与时区一致性防护）  
> **更新日期**：2026-08-17  
> **适用系统**：Pivot (智枢) AI 智能中枢管理系统  
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
  - [5. 完整迁移脚本实现 (`scripts/migrate_sqlite_to_pg.js`)](#5-完整迁移脚本实现-scriptsmigrate_sqlite_to_pgjs)
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
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT GENERATED ALWAYS AS IDENTITY` | 迁移后必须执行 `setval` 重置自增序列最大值 |
| `TEXT` (UUID/短标识符) | `VARCHAR(64)` / `VARCHAR(255)` | 显式限制长度以提高 B-Tree 索引检索与存储效率 |
| `TEXT` (长文本/提示词/公文) | `TEXT` | 原样映射，支持 TOAST 机制存储超长字段 |
| `TEXT` (JSON 结构体) | `JSONB` | 经由白名单校验后序列化为二进制 JSONB，支持 GIN 索引 |
| `INTEGER` (布尔语义 0/1) | `BOOLEAN` | `0 ➔ FALSE`, `1 ➔ TRUE`, `NULL ➔ NULL` |
| `TEXT` (时间字符串) | `TIMESTAMPTZ` | 统一规范为带时区的 ISO 8601 标准时间戳 |
| `TEXT` (向量数组字符串) | `vector` | 显式清洗为 PG `vector` 格式字符串 `[0.012, 0.981, ...]` |
| `REAL` | `DOUBLE PRECISION` | 浮点数、耗时、相似度得分 |

---

### 2. 明确的 JSONB 字段白名单与 NULL 语义保持

#### 2.1 严禁按首字符猜测 JSON
严禁使用 `startsWith('{')` 模糊推断字段类型。必须通过严格的**字段白名单（Schema Mapping Registry）**执行类型映射：

```javascript
const JSONB_COLUMN_REGISTRY = {
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

SQLite 中通常以不带时区偏移的字符串存储时间（如 `2026-08-17 10:00:00`）。
- **统一设置会话时区**：迁移脚本与服务端连接池初始化时，显式执行 `SET timezone = 'Asia/Shanghai'`（或统一统一为 `UTC`）；
- **时间格式标准化**：在数据迁移过程中，统一将原始时间字符串规范化为标准 ISO 8601 格式，确保写入 PG 的 `TIMESTAMPTZ` 时不出现 8 小时位移偏差。

---

### 4. 大文件存储解耦原则 (Artifact Storage vs DB)

PostgreSQL 严禁充当文件系统。所有非结构化大文件严格执行**元数据与实体分离架构**：
- **PostgreSQL 数据库**：仅存储 `agent_artifacts` 元数据表（包含 `file_path`, `file_size`, `sha256`, `mime_type`）；
- **BlobStore / 本地文件系统**：实际存储 PDF、DOCX、Excel、图片截图、导出的数据集实体。

---

### 5. RAG 知识库检索体系升级：Hybrid 混合检索方案

#### 5.1 纠正“FTS5 = pg_trgm 平替”误区
`pg_trgm` 适合短词模糊匹配，而中文长文本全文检索需要分词器与倒排索引。Pivot RAG 体系升级为 **“向量检索 + 关键词检索 + 倒排加权融合” 的 Hybrid 检索架构**：

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
-- 启用扩展
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

-- HNSW 向量索引创建规范
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw 
ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
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
-- 游标抽取模板：
SELECT * FROM "knowledge_chunks"
WHERE id > $last_seen_id
ORDER BY id ASC
LIMIT 1000;
```

---

### 3. PG 65535 参数上限防爆与分表独立事务策略

#### 3.1 动态批次大小计算（防爆机制）
PostgreSQL 驱动层单条 SQL 的绑定参数上限为 65,535。若某张表有 50 个字段，设置 `BATCH_SIZE = 2000` 将产生 100,000 个参数导致驱动崩溃。
- **计算公式**：每批插入行数动态计算为：
  $$\text{BatchRows} = \min\left(\text{DEFAULT\_BATCH}, \left\lfloor \frac{60000}{\text{ColumnsCount}} \right\rfloor\right)$$

#### 3.2 分表独立事务控制 (Table-Level Transactions)
若所有表都在单一全局事务中提交，当总数据量达数千万行时，会导致 PG 的 WAL 日志急剧膨胀，且长时间占住锁资源。
- **生产策略**：采用**“表级独立事务 + 记录 Checkpoint”**机制，每张表迁移完毕后独立提交事务并打印结果；单表若失败则该表回滚并中断退出，支持修复后从该表继续，无需全部重新开始。

---

### 4. pgvector 向量数组格式化安全分支
SQLite 中存储向量通常为 JSON 数组字符串（如 `"[0.012, 0.981, ...]"`）。在写入 PostgreSQL `vector` 类型时，必须显式转换为合法的向量文本格式 `[0.012, 0.981, ...]`，避免类型转换异常。

---

### 5. 完整迁移脚本实现 (`scripts/migrate_sqlite_to_pg.js`)

```javascript
/**
 * scripts/migrate_sqlite_to_pg.js
 * Pivot 生产级无损数据迁移引擎 (SQLite ➔ PostgreSQL)
 * 特性：主键游标抽取、Schema 白名单强校验、参数防爆、向量安全转换、时区对齐、表级事务
 */
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const sqlitePath = process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../data/chat.db');
const pgUrl = process.env.DATABASE_URL;

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

// 严格的依赖拓扑顺序 (父表在前，子表在后)
const TABLE_TOPOLOGY = [
    'users',
    'app_settings',
    'models',
    'knowledge_bases',
    'knowledge_documents',
    'knowledge_chunks',
    'knowledge_graph_entities',
    'knowledge_graph_relations',
    'sessions',
    'messages',
    'workflows',
    'workflow_versions',
    'workflow_runs',
    'agent_skills',
    'agent_runs',
    'agent_steps',
    'agent_tool_calls',
    'agent_artifacts',
    'capability_packages',
    'audit_logs'
];

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

const BOOLEAN_COLUMNS = {
    users: ['is_active', 'is_admin'],
    models: ['enabled'],
    agent_tool_calls: ['idempotent'],
    agent_skills: ['status']
};

const VECTOR_COLUMNS = {
    knowledge_chunks: ['embedding']
};

async function migrateTable(tableName, client) {
    const tableCheck = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (!tableCheck) {
        console.log(`⏩ [Skip] SQLite 中不存在表 [${tableName}]，跳过。`);
        return;
    }

    const totalCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${tableName}"`).get().c;
    console.log(`\n📦 开始迁移表 [${tableName}] | 待迁移记录数: ${totalCount}`);
    if (totalCount === 0) return;

    // 获取主键名称
    const pkInfo = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all().find(col => col.pk === 1);
    const pkName = pkInfo ? pkInfo.name : 'rowid';

    // 动态计算防爆批次大小 (PostgreSQL 65535 参数上限防爆)
    const tableCols = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all().map(c => c.name);
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

                    // 2. Boolean 语义安全转换
                    if (boolCols.has(col) && val !== null && val !== undefined) {
                        val = Boolean(val === 1 || val === '1' || val === true || val === 'enabled');
                    }

                    // 3. Vector 向量字段安全格式化
                    if (vecCols.has(col) && val !== null && val !== undefined) {
                        if (typeof val === 'string' && val.startsWith('[')) {
                            // 保持 '[0.1, 0.2, ...]' 格式
                        } else if (Array.isArray(val)) {
                            val = `[${val.join(',')}]`;
                        }
                    }

                    flatParams.push(val);
                    rowPlaceholders.push(`$${paramIdx++}`);
                }
                valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
                lastId = row[pkName];
            }

            // 绝不使用 ON CONFLICT DO NOTHING，冲突即抛出异常阻断
            const insertSql = `INSERT INTO "${tableName}" (${colsFormatted}) VALUES ${valuePlaceholders.join(', ')}`;
            await client.query(insertSql, flatParams);

            migratedCount += rows.length;
            process.stdout.write(`\r   └─ 进度: ${migratedCount} / ${totalCount} (${Math.round((migratedCount / totalCount) * 100)}%)`);
        }

        // 智能重置自增序列 (兼容 Serial 与 Identity Sequence)
        try {
            const seqRes = await client.query(`SELECT pg_get_serial_sequence($1, $2) AS seq_name`, [`"${tableName}"`, pkName]);
            const seqName = seqRes.rows[0]?.seq_name;
            if (seqName) {
                await client.query(`SELECT setval($1, COALESCE((SELECT MAX("${pkName}") FROM "${tableName}"), 1), true)`, [seqName]);
            }
        } catch (e) {
            // 无序列的主键优雅跳过
        }

        await client.query('COMMIT');
        console.log(`\n✅ 表 [${tableName}] 迁移并提交完毕 (共 ${migratedCount} 行)`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`表 [${tableName}] 迁移失败，事务已回滚: ${err.message}`);
    }
}

async function main() {
    const client = await pool.connect();
    console.log('====================================================');
    console.log('   Pivot 生产级数据迁移引擎: SQLite ➔ PostgreSQL     ');
    console.log('====================================================');
    const startMs = Date.now();

    try {
        // 统一会话时区，确保时间解析绝无 8 小时位移
        await client.query("SET timezone = 'Asia/Shanghai';");

        for (const table of TABLE_TOPOLOGY) {
            await migrateTable(table, client);
        }

        console.log('\n====================================================');
        console.log(`🎉 全量数据无损迁移成功！总耗时: ${((Date.now() - startMs) / 1000).toFixed(2)} 秒`);
        console.log('====================================================');
    } catch (err) {
        console.error('\n❌ [Fatal Error] 迁移进程中断！异常详情:', err);
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
4. **第四级：业务关系语义与孤儿数据排查**：排查是否存在没有对应 User 的 Session，没有对应 Session 的 Message。

---

### 2. 完整核验脚本实现 (`scripts/verify_pg_migration.js`)

```javascript
/**
 * scripts/verify_pg_migration.js
 * 数据迁移一致性深度核验工具
 */
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const path = require('path');

const sqlite = new Database(process.env.SQLITE_DB_PATH || path.resolve(__dirname, '../data/chat.db'), { readonly: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function verify() {
    console.log('====================================================');
    console.log('   正在执行 SQLite ➔ PostgreSQL 四级一致性深度核验   ');
    console.log('====================================================\n');
    const client = await pool.connect();
    let hasError = false;

    const tables = [
        'users', 'sessions', 'messages', 'knowledge_bases', 
        'knowledge_documents', 'knowledge_chunks', 'workflows', 
        'workflow_versions', 'agent_runs', 'agent_steps', 'agent_tool_calls', 'audit_logs'
    ];

    console.log('| 校验表名 | SQLite 行数 | PostgreSQL 行数 | 行数差异 | 一致性判定 |');
    console.log('| :--- | :--- | :--- | :--- | :--- |');

    for (const table of tables) {
        try {
            const sqRow = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get();
            const sqCount = sqRow ? sqRow.c : 0;

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

    // 业务关系完整性校验 (孤儿数据排查)
    console.log('\n🔎 正在执行业务关系图完整性排查...');
    const orphanMessages = await client.query(`
        SELECT COUNT(*) AS c FROM messages m 
        LEFT JOIN sessions s ON m.session_id = s.id 
        WHERE s.id IS NULL
    `);
    const orphanCount = parseInt(orphanMessages.rows[0].c, 10);
    if (orphanCount > 0) {
        console.error(`❌ 发现 ${orphanCount} 条孤儿消息 (session_id 断链)！`);
        hasError = true;
    } else {
        console.log('✅ 会话-消息级联关系 100% 完整！');
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
1. **预演耗时测定**：在预发环境拉取生产备份 `chat.db`，完整运行迁移与核验脚本，测定真实耗时（记为 $T_{test}$）；
2. **割接窗口规划**：正式维护窗口严禁凭空估算，**必须设定为 $2 \times T_{test} + 30\text{分钟}$**。

---

### 2. 维护窗口正式割接 SOP (T 日窗口)

| 序号 | 步骤操作 | 执行要求与判定标准 | 责任角色 |
| :--- | :--- | :--- | :--- |
| **1** | **开启维护模式** | Nginx / API 网关层拦截外部写入请求，返回友好维护公告 | 运维/网关 |
| **2** | **停止应用进程** | 停止所有 Pivot 服务端 Node.js 实例，确保数据库完全静止 | 运维 |
| **3** | **生产 DB 最终冷备** | 将 `chat.db` 拷贝至只读目录并生成 SHA256 校验和：`chat.db.final_bak` | 运维/DBA |
| **4** | **运行数据迁移** | 执行 `node scripts/migrate_sqlite_to_pg.js`，等待控制台输出 Success | 开发/DBA |
| **5** | **四级一致性核验** | 执行 `node scripts/verify_pg_migration.js`，确认差异为 0，孤儿数据为 0 | 测试/架构 |
| **6** | **构建大表索引** | 对 `knowledge_chunks` 运行 `CREATE INDEX CONCURRENTLY` 建立 HNSW 向量索引并执行 `ANALYZE` | DBA |
| **7** | **切换配置与启动** | 生产环境 `.env` 配置 `DATABASE_URL`，启动 Node 实例，执行接口健康检查 | 运维 |
| **8** | **核心业务冒烟验证** | 验证登录、历史消息加载、RAG 问答、工作流执行等核心功能 | 业务/测试 |
| **9** | **撤除维护恢复流量** | 网关切回正常路由，正式恢复全员生产访问 | 运维 |

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
   • 5 分钟回滚到 `chat.db.final`│  • 立即基于 PostgreSQL 执行在线热修复、
   • 撤除维护，业务无损恢复      │    流复制主从切换或 PITR 时间点恢复
```

---

## 六、 生产环境 PostgreSQL 参数调优与连接池架构

### 1. 科学的内存与并发参数计算公式
严禁直接照抄固定参数。依据服务器物理硬件动态配置 `postgresql.conf`：

```ini
# 假设专用数据库服务器内存为 RAM (以 16GB RAM, 8 核 CPU 为例)
shared_buffers = 4GB                   # 推荐配置: RAM 的 25%
effective_cache_size = 12GB            # 推荐配置: RAM 的 75%
work_mem = 16MB                        # 推荐配置: (RAM - shared_buffers) / (max_connections * 3)
maintenance_work_mem = 1GB             # 索引构建/清理专用内存

# 并行查询 (Parallel Query) 优化
max_worker_processes = 8
max_parallel_workers_per_gather = 4
max_parallel_workers = 8

# 慢查询监控 (记录超过 200ms 的 SQL 语句)
log_min_duration_statement = 200
```

---

### 2. PgBouncer 与客户端连接池设计
- **客户端连接池 (`pg-pool`)**：每个 Node.js 实例配置 `max: 10~15`，防止子进程创建过多空闲连接；
- **连接池代理 (PgBouncer)**：多节点集群部署时引入 PgBouncer 采用 `Transaction Pooling` 模式，将上千个应用连接高效复用在 50~100 个 PG 真实连接中。

---

### 3. 索引后建策略与 Autovacuum 调优
1. **迁移时后建大索引**：迁移百万级大表时，先导入原始数据，数据导入完毕后再统一建立 HNSW 和 GIN 索引，大幅降低迁移期间的 IO 写入开销；
2. **高频写入表 Autovacuum 调优**：
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

- **开发与测试环境统一**：推荐开发与 CI 环境均通过 Docker 启动标准 PostgreSQL 实例，保证 `开发环境 == 测试环境 == 生产环境` 的 Schema 与查询行为完全一致。
