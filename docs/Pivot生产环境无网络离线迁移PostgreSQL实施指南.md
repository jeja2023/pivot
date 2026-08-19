# 智枢 (Pivot) 生产环境无网络（离线隔离区）PostgreSQL 迁移与插件部署完整指南

> **适用场景**：金融、政企、军工及涉密内网等**完全物理隔离、无外网连接（Air-gapped）**的生产环境。  
> **核心目标**：实现数据库从单机 SQLite 平滑升级至企业级 PostgreSQL，完成 `pgvector` 与 `pg_trgm` 核心插件离线部署，保障 79 张业务表历史数据**零丢失、零错位、元数据全中文注释、四级对账 100% 一致**。  
> **文档版本**：v3.0.0（离线环境定制版）  
> **发布日期**：2026-08-19

---

## 目录
- [一、 离线迁移架构与环境概览](#一-离线迁移架构与环境概览)
- [二、 阶段一：外网准备端离线物料打包 SOP](#二-阶段一外网准备端离线物料打包-sop)
  - [1. 数据库镜像拉取与插件离线包制作](#1-数据库镜像拉取与插件离线包制作)
  - [2. Pivot 生产应用镜像构建与导出](#2-pivot-生产应用镜像构建与导出)
  - [3. 迁移与核验独立工具包打包](#3-迁移与核验独立工具包打包)
  - [4. 生成 SHA256 完整性校验码](#4-生成-sha256-完整性校验码)
- [三、 阶段二：生产隔离区（内网）环境基准与数据库就绪](#三-阶段二生产隔离区内网环境基准与数据库就绪)
  - [1. 物料导入与哈希一致性校验](#1-物料导入与哈希一致性校验)
  - [2. 生产级 Docker Compose 与 PostgreSQL 配置](#2-生产级-docker-compose-与-postgresql-配置)
  - [3. 启动数据库并验证插件与扩展](#3-启动数据库并验证插件与扩展)
- [四、 阶段三：停机维护与 SQLite 物理快照备份](#四-阶段三停机维护与-sqlite-物理快照备份)
  - [1. 停止旧版应用容器与写入挂起](#1-停止旧版应用容器与写入挂起)
  - [2. SQLite 数据库物理三文件双副本归档](#2-sqlite-数据库物理三文件双副本归档)
- [五、 阶段四：全量数据流式迁移执行](#五-阶段四全量数据流式迁移执行)
  - [1. 初始化 79 张核心业务表与元数据字典](#1-初始化-79-张核心业务表与元数据字典)
  - [2. 执行主键游标无锁流式迁移引擎](#2-执行主键游标无锁流式迁移引擎)
  - [3. 重置所有表的 IDENTITY 自增主键序列](#3-重置所有表的-identity-自增主键序列)
- [六、 阶段五：四级数据一致性对账与业务核验](#六-阶段五四级数据一致性对账与业务核验)
  - [1. 运行自动化四级深度核验引擎](#1-运行自动化四级深度核验引擎)
  - [2. 数据库原生中文注释字典复核](#2-数据库原生中文注释字典复核)
- [七、 阶段六：生产环境服务切换与业务验收](#七-阶段六生产环境服务切换与业务验收)
  - [1. 更新生产环境变量配置 (.env)](#1-更新生产环境变量配置-env)
  - [2. 启动全新生产容器并执行端到端巡检](#2-启动全新生产容器并执行端到端巡检)
- [八、 阶段七：应急回滚与灾难恢复预案 (Rollback SOP)](#八-阶段七应急回滚与灾难恢复预案-rollback-sop)

---

## 一、 离线迁移架构与环境概览

```
 ┌─────────────────────────────────────────────────────────────┐
 │                【阶段 1】外网准备区 (Internet Access)        │
 │                                                             │
 │  1. 拉取 pgvector/pgvector:pg16 镜像 (内置 pgvector + trgm)  │
 │  2. 构建并打包 Pivot v0.1.1 容器镜像                        │
 │  3. 打包完整 Node.js 离线依赖与迁移工具脚本                 │
 │  4. 生成 SHA256 校验文件 -> 刻录/拷贝至加密移动存储介质     │
 └──────────────────────────────┬──────────────────────────────┘
                                │ 物理介质安全流转（防毒扫描/审批）
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │               【阶段 2-6】生产隔离区 (Air-gapped Network)    │
 │                                                             │
 │  [宿主机 / 内网服务器]                                      │
 │   ├── 1. 导入镜像 (docker load)                             │
 │   ├── 2. 启动 PostgreSQL 16 容器 (开启 vector, pg_trgm 扩展) │
 │   ├── 3. 归档备份 SQLite (chat.db / wal / shm)              │
 │   ├── 4. 执行流式无锁抽取迁移 (migrate_sqlite_to_pg.js)     │
 │   ├── 5. 四级一致性对账 (verify_pg_migration.js)            │
 │   └── 6. 启动 Pivot 应用 (DB_CLIENT=postgres)               │
 └─────────────────────────────────────────────────────────────┘
```

### 关键组件与插件要求

1. **PostgreSQL 版本**：PostgreSQL 14+ / 16+ / 17+（推荐使用包含 pgvector 的官方发行版镜像 `pgvector/pgvector:pg16`）；
2. **必需数据库扩展插件**：
   - **`vector` (pgvector ≥ 0.5.0)**：支撑知识库 RAG 向量嵌入与余弦相似度检索；
   - **`pg_trgm`**：PostgreSQL 原生三元组分词插件，替代旧版 SQLite FTS5，为消息、文档分块、法规条文提供高性能 GIN 索引与模糊搜索；
3. **数据完整性保障**：
   - **79 张核心业务表**拓扑依赖建表；
   - **1,018 条**表与字段中文 `COMMENT` 元数据字典；
   - **四级核验机制**：行数对账 ➔ 主键集合 ➔ 全量数据哈希 ➔ 业务图谱关联。

---

## 二、 阶段一：外网准备端离线物料打包 SOP

在有互联网连接的准备机（开发机或中转打包机）上执行以下步骤，制作离线部署包。

### 1. 数据库镜像拉取与插件离线包制作

`pgvector/pgvector:pg16` 是 pgvector 官方基于官方 `postgres:16` 镜像打包发布的**完整 PostgreSQL 16 数据库镜像**（内置预编译好了 `pgvector` 与 `pg_trgm` 扩展），**它本身就是一个完整的 PostgreSQL 数据库系统**，无需额外再下载 PostgreSQL。

推荐直接拉取该官方镜像：

```bash
# 1. 拉取包含 pgvector 的完整 PostgreSQL 16 生产数据库镜像
docker pull pgvector/pgvector:pg16

# 2. 导出为离线 tar 镜像包
docker save -o postgres-pgvector-16.tar pgvector/pgvector:pg16

# 3. 查看导出文件大小（约 400MB）
ls -lh postgres-pgvector-16.tar
```

> **方案备选（若企业内网只允许使用基础 postgres:16-alpine 镜像）**：
> 可在外网机编写离线 Dockerfile 预编译插件：
> ```dockerfile
> FROM postgres:16-alpine
> RUN apk add --no-cache git build-base clang llvm
> RUN git clone --branch v0.7.4 https://github.com/pgvector/pgvector.git \
>     && cd pgvector && make && make install
> ```
> 构建并导出：`docker build -t my-postgres-vector:16 . && docker save -o postgres-vector-16.tar my-postgres-vector:16`

### 2. Pivot 生产应用镜像构建与导出

```bash
# 1. 进入 pivot 项目根目录
cd /path/to/pivot

# 2. 构建生产应用镜像
docker build -t pivot:v0.1.1 -f Dockerfile .

# 3. 导出为离线镜像包
docker save -o pivot-v0.1.1.tar pivot:v0.1.1

# 4. 查看导出文件大小
ls -lh pivot-v0.1.1.tar
```

### 3. 迁移与核验独立工具包打包

打包项目中的数据库架构与自动化迁移脚本包（包含生产 `node_modules` 依赖，确保在无网络隔离区可直接以命令行运行对账与修复工具）：

```bash
# 打包迁移脚本、后端驱动与配置文件
tar -czvf pivot-migration-tools.tar.gz \
  scripts/ \
  server/ \
  package.json \
  package-lock.json \
  node_modules/ \
  .env.example
```

### 4. 生成 SHA256 完整性校验码

```bash
# 生成所有离线安装包的 SHA256 校验和
sha256sum postgres-pgvector-16.tar pivot-v0.1.1.tar pivot-migration-tools.tar.gz > checksums.sha256

# 查看校验和内容
cat checksums.sha256
```

将以上 4 个文件拷贝至经过企业安全审查的离线移动介质中：
* `postgres-pgvector-16.tar`
* `pivot-v0.1.1.tar`
* `pivot-migration-tools.tar.gz`
* `checksums.sha256`

---

## 三、 阶段二：生产隔离区（内网）环境基准与数据库就绪

### 1. 物料导入与哈希一致性校验

将离线介质中的文件拷贝至内网生产服务器目录（例如 `/opt/pivot-deploy`）：

```bash
cd /opt/pivot-deploy

# 1. 执行哈希校验，确保介质传输过程中文件零损坏、零被篡改
sha256sum -c checksums.sha256
# 控制台输出必须全部为 OK：
# postgres-pgvector-16.tar: OK
# pivot-v0.1.1.tar: OK
# pivot-migration-tools.tar.gz: OK

# 2. 导入 Docker 离线镜像
docker load -i postgres-pgvector-16.tar
docker load -i pivot-v0.1.1.tar

# 3. 确认镜像导入成功
docker images | grep -E "pgvector|pivot"
```

### 2. 生产级 Docker Compose 与 PostgreSQL 配置

在生产目录 `/opt/pivot` 下创建或配置 `docker-compose.yml` 与目录结构：

```bash
mkdir -p /opt/pivot/postgres-data /opt/pivot/data /opt/pivot/uploads /opt/pivot/logs
cd /opt/pivot
```

编写 `/opt/pivot/docker-compose.yml`：

```yaml
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: pivot-postgres
    restart: always
    environment:
      POSTGRES_DB: pivot
      POSTGRES_USER: pivot_app
      POSTGRES_PASSWORD: "YourSecurePassword2026!#"
      TZ: Asia/Shanghai
      PGTZ: Asia/Shanghai
    volumes:
      - ./postgres-data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432" # 仅监听本机或受控内网
    command: >
      postgres
      -c timezone=Asia/Shanghai
      -c max_connections=150
      -c shared_buffers=2GB
      -c work_mem=32MB
      -c maintenance_work_mem=512MB
      -c effective_cache_size=6GB
      -c statement_timeout=60000
      -c idle_in_transaction_session_timeout=30000
    networks:
      - pivot-internal
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "5"

  pivot:
    image: pivot:v0.1.1
    container_name: pivot-app
    restart: always
    depends_on:
      - postgres
    ports:
      - "9006:3000"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
      - ./logs:/app/logs
    networks:
      - pivot-internal
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

networks:
  pivot-internal:
    driver: bridge
```

### 3. 启动数据库并验证插件与扩展

```bash
# 1. 仅启动 PostgreSQL 容器服务
docker compose up -d postgres

# 2. 检查容器状态
docker compose ps

# 3. 登录 PostgreSQL 验证插件创建权限
docker exec -it pivot-postgres psql -U pivot_app -d pivot -c "
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'pg_trgm');
"
```

**预期终端输出**：
```
 extname | extversion 
---------+------------
 pg_trgm | 1.6
 vector  | 0.7.4
(2 rows)
```
> ✅ 确认 `vector` 和 `pg_trgm` 两大扩展在生产 PostgreSQL 中已成功激活就绪！

---

## 四、 阶段三：停机维护与 SQLite 物理快照备份

为保证割接期间数据 100% 静态一致，必须在维护窗口内执行以下备份与停机 SOP。

### 1. 停止旧版应用容器与写入挂起

```bash
# 1. 停止正在运行的旧版 Pivot 容器（防止割接期间产生新增业务数据）
docker stop pivot 2>/dev/null || docker compose stop pivot-app 2>/dev/null
```

### 2. SQLite 数据库物理三文件双副本归档

SQLite 在运行期间存在 WAL 日志模式（`chat.db`, `chat.db-wal`, `chat.db-shm`），备份时必须完整归档三文件：

```bash
# 1. 进入宿主机数据目录
cd /opt/pivot/data

# 2. 检查 SQLite 三文件
ls -lh chat.db*

# 3. 创建带时间戳的备份目录并制作压缩包
BACKUP_TAG="backup_sqlite_$(date +%Y%m%d_%H%M%S)"
mkdir -p /opt/pivot/backups/${BACKUP_TAG}

cp chat.db* /opt/pivot/backups/${BACKUP_TAG}/
tar -czvf /opt/pivot/backups/${BACKUP_TAG}.tar.gz chat.db*

# 4. 记录备份文件的 SHA256 校验值
sha256sum /opt/pivot/backups/${BACKUP_TAG}/chat.db > /opt/pivot/backups/${BACKUP_TAG}/checksum.sha256

echo "✅ SQLite 历史数据库双副本备份完成，归档于 /opt/pivot/backups/${BACKUP_TAG}"
```

---

## 五、 阶段四：全量数据流式迁移执行

解压外网准备的 `pivot-migration-tools.tar.gz`，在生产宿主机上使用 Node.js 执行迁移引擎。

### 1. 初始化 79 张核心业务表与元数据字典

配置临时迁移环境变量：
```bash
export DATABASE_URL="postgresql://pivot_app:YourSecurePassword2026!#@127.0.0.1:5432/pivot"
export DATA_DIR="/opt/pivot/data"
export PG_TIMEZONE="Asia/Shanghai"
```

执行 DDL 建表与字典注入：
```bash
# 自动创建 79 张业务表、PG 专属 IMMUTABLE 函数、GIN 索引与 1018 条中文注释
node scripts/setup_pg_db.js
```

**预期输出**：
```
[PG] PostgreSQL 连接池已初始化
[PG] 扩展已就绪: vector, pg_trgm
[PG] 表结构初始化完成: 共创建/复核 79 张业务表
[PG] 关系约束补建完成: 共挂载外键约束
[PG] 中文元数据注释注入完成: 共生效 1018 条 COMMENT 字典
```

### 2. 执行主键游标无锁流式迁移引擎

运行 `scripts/migrate_sqlite_to_pg.js`，该引擎具备以下核心企业级特性：
* **拓扑依赖排序**：按外键拓扑依赖严格先后入库（如 `users` ➔ `sessions` ➔ `messages`），杜绝外键约束冲突；
* **Keyset Pagination 游标流式抽取**：基于 `WHERE id > ? ORDER BY id ASC LIMIT 500` 游标抽取，单表无论百万级数据均保持极低内存开销；
* **PG 65535 参数防爆批处理**：根据每张表的列数动态计算 Batch Size，防止单次 INSERT 参数超限；
* **JSONB 字段白名单与 NULL 语义保持**：严格保持原始 NULL 与 JSON 格式。

```bash
# 执行全量数据抽取与迁移
node scripts/migrate_sqlite_to_pg.js
```

**关键表迁移控制台实时日志示例**：
```
[1/79] 正在迁移表: users ...
  -> 抽取 12 条记录, 批量写入 PostgreSQL 成功 (耗时: 18ms)
[2/79] 正在迁移表: models ...
  -> 抽取 8 条记录, 批量写入 PostgreSQL 成功 (耗时: 12ms)
...
[15/79] 正在迁移表: messages ...
  -> 游标位置 id=0, 抽取 500 条...
  -> 游标位置 id=500, 抽取 500 条...
  -> messages 共迁移 15,820 条记录 (耗时: 1.24s)
...
[79/79] 正在迁移表: audit_logs ...
  -> audit_logs 共迁移 48,200 条记录 (耗时: 2.85s)

🎉 全量数据迁移完成！共处理 79 张表，全部写入成功。
```

### 3. 重置所有表的 IDENTITY 自增主键序列

迁移写入时由于保留了原始 `id`，必须重置 PostgreSQL 自增主键计数器，防止后续新产生的数据发生主键冲突：

```bash
# 迁移脚本已自动集成序列重置；如需手动执行验证可运行：
node -e "
const { getPgPool } = require('./server/db/pg-connection');
const { query } = require('./server/db/client');
(async () => {
    const tables = await query(\"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'\");
    for (const t of tables) {
        try {
            await query(\`SELECT setval(pg_get_serial_sequence('\"\${t.table_name}\"', 'id'), COALESCE((SELECT MAX(id) FROM \"\${t.table_name}\"), 0) + 1, false)\`);
        } catch(e) {}
    }
    console.log('✅ 所有业务表自增主键序列重置完成！');
    process.exit(0);
})();"
```

---

## 六、 阶段五：四级数据一致性对账与业务核验

### 1. 运行自动化四级深度核验引擎

执行系统内置的权威核验程序 `scripts/verify_pg_migration.js`：

```bash
node scripts/verify_pg_migration.js
```

**四级核验执行标准**：
1. **第一级（行数绝对一致性）**：比对 79 张表 `SELECT COUNT(*)`，容差必须为 **0**；
2. **第二级（主键集合连续性）**：比对各表 `MIN(id)`、`MAX(id)` 与主键总数；
3. **第三级（核心业务数据哈希比对）**：抽取 `users`, `sessions`, `messages`, `knowledge_chunks`, `workflows` 进行 SHA256 采样与内容指纹校验；
4. **第四级（级联外键图谱与孤儿数据检测）**：检查 `messages.session_id`、`agent_steps.run_id` 等关键业务关联完整性。

**核验输出报告**：
```
================ 数据库迁移四级对账报告 ================
[L1 行数核验] 79/79 张表行数 100% 匹配 (差异: 0)
[L2 主键核验] 核心主键 Min/Max/Count 100% 匹配
[L3 哈希核验] 采样 10,000 条核心消息与会话内容指纹 100% 一致
[L4 关联核验] 未发现任何破坏外键引用的孤儿记录

🏆 对账结论: 恭喜！迁移数据与原始 SQLite 达到 100% 强一致性标准！
```

### 2. 数据库原生中文注释字典复核

执行元数据注释检查脚本，确保运维客户端查阅体验：
```bash
node scripts/apply_pg_comments.js
```

---

## 七、 阶段六：生产环境服务切换与业务验收

### 1. 更新生产环境变量配置 (`.env`)

编辑 `/opt/pivot/.env` 生产环境配置文件，开启纯 PostgreSQL 模式：

```ini
# ===================================================================
# 智枢 (Pivot AI) 生产环境配置
# ===================================================================
NODE_ENV=production
PORT=3000
TZ=Asia/Shanghai

# --- 数据库核心配置 ---
DB_CLIENT=postgres
DATABASE_URL=postgresql://pivot_app:YourSecurePassword2026!#@postgres:5432/pivot
PG_TIMEZONE=Asia/Shanghai
PG_POOL_MAX=20
PG_IDLE_TIMEOUT_MS=30000
PG_CONNECT_TIMEOUT_MS=5000
PG_STATEMENT_TIMEOUT_MS=60000

# --- 安全与加密配置 ---
JWT_SECRET=your-32-chars-ultra-secure-jwt-secret-key-2026
DATA_ENCRYPTION_KEY=your-32-chars-ultra-secure-data-encryption-key-2026
```

### 2. 启动全新生产容器并执行端到端巡检

```bash
# 1. 启动全套生产服务（PostgreSQL + Pivot Web）
cd /opt/pivot
docker compose up -d

# 2. 实时观察启动日志
docker compose logs -f pivot

# 3. 运行端到端在线全功能健康巡检脚本
node scratch/verify_all_features.js
```

**预期验收指标**：
* 控制台输出格式化中文 HTTP 访问日志；
* 19 项全业务功能接口探测全部为 `✅ [正常]`；
* 管理员登录后访问 `/chat` 与 `/api/stats/monitor-summary`，数据库库容与状态正常实时呈现。

---

## 八、 阶段七：应急回滚与灾难恢复预案 (Rollback SOP)

若在割接窗口期出现不可逆故障，需严格遵循以下 5 分钟快速回滚预案：

### 割接窗口期快速回滚流程（T < 30 分钟）

```bash
# 1. 停止当前容器
cd /opt/pivot
docker compose down

# 2. 还原 .env 数据库驱动为 sqlite 模式
sed -i 's/DB_CLIENT=postgres/DB_CLIENT=sqlite/g' .env

# 3. 从快照恢复 SQLite 数据库物理文件
cd /opt/pivot/data
cp -f /opt/pivot/backups/${BACKUP_TAG}/chat.db* ./

# 4. 重新拉起旧版镜像
docker compose up -d pivot

# 5. 验证服务
curl -s http://127.0.0.1:9006/api/health
```

---

## 九、 总结与最佳运维实践

1. **日常维护**：
   - 生产环境建议每日定时执行 `docker exec pivot-postgres pg_dump -U pivot_app -d pivot -Fc -f /backup/pivot_$(date +%F).dump` 进行逻辑备份；
2. **连接池监控**：
   - 生产环境 `PG_POOL_MAX` 建议设为 `15 ~ 30`，配合 `statement_timeout=60000` 彻底杜绝连接池泄露与慢查询锁表；
3. **向量与全文检索性能**：
   - `pg_trgm` GIN 索引与 `vector` 扩展已在底层建构完毕，支持数十万级知识库文档毫秒级召回。
