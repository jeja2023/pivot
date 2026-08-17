# Pivot 全自主 Agent 改造方案与工程实施规范 (v4.0 终极生产级架构规范)

> **文档版本**：v4.0.0（生产级技术架构与工程实施规范定稿版）  
> **更新日期**：2026-08-17  
> **适用系统**：Pivot (智枢) AI 智能中枢管理系统  
> **核心定位**：**“全自主决策 + 受控执行”**。在 Web 控制面（Control Plane）与桌面 Agent 执行面（Execution Plane）双引擎架构下，构建工业级 **Agent Runtime 状态机、不可绕过的 Policy Enforcement Point (PEP)、OS 级沙箱隔离、三层 Trace 语义提取器与 Air-Gapped 离线治理**。

---

## 目录
- [一、 顶层架构决策与定位（全自主决策 + 受控执行）](#一-顶层架构决策与定位全自主决策--受控执行)
- [二、 整体系统架构与控制面/执行面划分](#二-整体系统架构与控制面执行面划分)
- [三、 Agent Runtime 核心架构与状态机模型](#三-agent-runtime-核心架构与状态机模型)
  - [1. Agent 核心状态机 (Runtime State Machine)](#1-agent-核心状态机-runtime-state-machine)
  - [2. 崩溃恢复与断点续跑机制 (Crash Recovery & Checkpoint)](#2-崩溃恢复与断点续跑机制-crash-recovery--checkpoint)
  - [3. 综合预算与风险熔断引擎 (Task Budget & Risk Engine)](#3-综合预算与风险熔断引擎-task-budget--risk-engine)
- [四、 工业级安全模型与不可绕过的策略执行点 (PEP/PDP)](#四-工业级安全模型与不可绕过的策略执行点-peppdp)
  - [1. 权限分层治理架构 (Capability ➔ PDP ➔ PEP ➔ Broker ➔ Sandbox)](#1-权限分层治理架构-capability--pdp--pep--broker--sandbox)
  - [2. OS 级进程隔离沙箱与 Workspace Jail (彻底纠正 Hook 误区)](#2-os-级进程隔离沙箱与-workspace-jail-彻底纠正-hook-误区)
  - [3. 统一 Tool 契约模型 (Tool Contract Specification)](#3-统一-tool-契约模型-tool-contract-specification)
- [五、 数据处理架构与 Data Source Adapter (DuckDB + Python)](#五-数据处理架构与-data-source-adapter-duckdb--python)
- [六、 浏览器安全架构与防凭证泄漏模型 (Playwright Agent)](#六-浏览器安全架构与防凭证泄漏模型-playwright-agent)
- [七、 深度错误诊断分类学与自愈回路 (Diagnose Taxonomy)](#七-深度错误诊断分类学与自愈回路-diagnose-taxonomy)
- [八、 三层 Trace 架构与工作流编译器 (Trace ➔ Workflow Specification)](#八-三层-trace-架构与工作流编译器-trace--workflow-specification)
- [九、 企业级 Skill 规范与供应链安全 (Supply Chain Security)](#九-企业级-skill-规范与供应链安全-supply-chain-security)
- [十、 纯内网（Air-Gapped）分层运行时与数据安全边界](#十-纯内网air-gapped分层运行时与数据安全边界)
- [十一、 存储架构与数据库表结构设计 (PostgreSQL + SQLite + BlobStore)](#十一-存储架构与数据库表结构设计-postgresql--sqlite--blobstore)
- [十二、 演进路线图：从 MVP 到生产级发布 (5大阶段)](#十二-演进路线图从-mvp-到生产级发布-5大阶段)

---

## 一、 顶层架构决策与定位（全自主决策 + 受控执行）

### 1.1 核心原则
自主 Agent 不等于“无限操作系统权限”。Pivot 确立的根本工程准则为：**全自主决策，受控执行**。

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Agent 决策与执行边界法则                         │
├───────────────────────────────────┬────────────────────────────────────┤
│         【允许自主决策】           │          【严禁自主突破】          │
│ • 动态拆解目标与调整任务步骤      │ • 越权读写非授权目录与敏感系统盘   │
│ • 自主选择并调度授权的 Tool 集合   │ • 绕过网络白名单访问内网未知主机   │
│ • 自主生成数据分析与处理代码      │ • 绕过人工审批直接执行副作用动作   │
│ • 深度诊断执行错误并自愈重试      │ • 读取用户个人浏览器的明文凭证/Token│
│ • 提炼有效工作路径为工作流草稿    │ • 动态自我提权或篡改安全策略规则   │
└───────────────────────────────────┴────────────────────────────────────┘
```

### 1.2 资源与负载边界
- **Web 端（Control Plane）**：承载统一模型接入与网关、集中权限与策略治理、企业知识库 RAG（结合 PostgreSQL pgvector）、**确定性 DAG 工作流引擎、定时调度流水线（Cron）**与集中审计。中心服务端**统一采用 PostgreSQL 数据库**，彻底杜绝 SQLite 高并发写锁与慢查询瓶颈。
- **桌面客户端（Execution Plane）**：承载 **Agent Runtime、本地代码解释器、Playwright 浏览器、本地文件处理与 Tool 执行**。桌面端继续采用单文件轻量的 **SQLite** 承载本地状态。
- **准确资源划分**：客户端承担 Agent 工具执行与本地环境的 CPU/内存/磁盘消耗，中心服务不承担浏览器渲染、代码解释和本地文件计算负载；LLM 推理请求由内网 GPU 服务器或配置的模型端点统一承载。

---

## 二、 整体系统架构与控制面/执行面划分

```
                                  Pivot 智枢系统
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
     【Web 控制面 (Control Plane)】                  【桌面端执行面 (Execution Plane)】
  ┌─────────────────────────────────┐             ┌───────────────────────────────────┐
  │ • 模型网关 (Model Gateway)       │             │           Agent Runtime           │
  │ • 集中权限治理 (IAM & Policy)   │             │ ┌───────────────────────────────┐ │
  │ • 企业 RAG 知识库与图谱检索      │             │ │ State Machine    Task Planner │ │
  │ • 确定性 DAG 工作流引擎 (Workflow)│             │ │ Task Budget      Context Memory│ │
  │ • 集中审计与安全告警中心         │             │ └───────────────┬───────────────┘ │
  └────────────────┬────────────────┘             │                 ▼                 │
                   │                              │  Policy Enforcement Point (PEP)   │
                   │ 同步策略 / 沉淀工作流         │ ┌───────────────────────────────┐ │
                   │                              │ │ Capability Context & Validator│ │
                   │                              │ └───────────────┬───────────────┘ │
                   │                              │                 ▼                 │
                   │                              │        Execution Broker           │
                   │                              └─────────────────┬─────────────────┘
                   │                                                ▼
                   │                             ┌──────────────────┼──────────────────┐
                   │                             ▼                  ▼                  ▼
                   │                      【Code Worker】    【Browser Worker】  【File Worker】
                   │                      • DuckDB Adapter   • Playwright        • Workspace Jail
                   │                      • OS Sandbox Py    • Network Policy    • File Sandbox
                   │                                         • Isolated Profile
                   │                                                │
                   │                                                ▼
                   │                                    三层 Trace & 事件总线
                   │                                                │
                   │                                                ▼
                   │                             【Workflow Compiler & Simplifier】
                   │                               • 语义提取 ➔ 依赖图 ➔ DAG 编译
                   └────────────────────────────────────────────────┘
```

---

## 三、 Agent Runtime 核心架构与状态机模型

### 1. Agent 核心状态机 (Runtime State Machine)

Agent 运行严格受状态机约束，禁止隐式状态流转：

```
       ┌───────────┐
       │  QUEUED   │ (排队等待资源与配额)
       └─────┬─────┘
             ▼
       ┌───────────┐
       │ PLANNING  │ ◄──────────────────────────────┐
       └─────┬─────┘                                │
             ▼                                      │
       ┌───────────┐                                │
       │ EXECUTING │ (调用 Tool Runtime / Broker)    │
       └─────┬─────┘                                │
             ▼                                      │
       ┌───────────┐                                │ (重新规划)
       │ OBSERVING │                                │
       └─────┬─────┘                                │
             ▼                                      │
       ┌───────────┐                                │
       │DIAGNOSING │ ──(有错误需自愈)──> ┌───────────┴──┐
       └─────┬─────┘                    │  REPLANNING   │
             │(执行正常)                └───────────────┘
             ▼
    [需要人工介入?] ──是──> ┌──────────────────┐ ──(批准)──> ┌──────────┐
             │              │ WAITING_APPROVAL │             │ RESUMING │
             否             └────────┬─────────┘             └────┬─────┘
             ▼                       │(拒绝)                      │
       ┌───────────┐                 ▼                            ▼
       │ COMPLETED │           ┌───────────┐               (回到执行流)
       └───────────┘           │ CANCELLED │
                               └───────────┘
```

### 2. 崩溃恢复与断点续跑机制 (Crash Recovery & Checkpoint)

1. **每步状态持久化**：每次 Tool 执行前后，原子性写入本地 SQLite 任务检查点（Checkpoint）；
2. **幂等性判定 (Idempotency Check)**：
   - 客户端重启后，扫描未决任务（`status IN ('running', 'executing')`）；
   - 根据最后一个已提交 Tool Call 的 `idempotent` 属性判断：
     - 若该 Tool **具备幂等性**（如 `filesystem.read`, `duckdb.query`）：自动安全恢复重试；
     - 若该 Tool **产生非幂等副作用**（如 `database.insert`, `im.send_message`）：自动挂起为 `WAITING_APPROVAL`，提示用户确认是否继续或跳过。

### 3. 综合预算与风险熔断引擎 (Task Budget & Risk Engine)

每个任务必须显式绑定综合预算约束，杜绝死循环与资源耗尽：

```json
{
  "max_steps": 40,
  "max_tool_calls": 80,
  "max_consecutive_errors": 3,
  "max_runtime_seconds": 1800,
  "max_python_timeout_seconds": 30,
  "max_tokens_total": 128000,
  
  "risk_budget": 20,
  "max_external_side_effects": 0,
  "max_file_writes": 100,
  "max_network_requests": 50
}
```

---

## 四、 工业级安全模型与不可绕过的策略执行点 (PEP/PDP)

### 1. 权限分层治理架构 (Capability ➔ PDP ➔ PEP ➔ Broker ➔ Sandbox)

> **核心法则**：LLM 输出的 `tool_call` 永远不可信，严禁直接交由底层系统执行。必须经过独立的 Policy Enforcement Point。

```
  [LLM 生成 Tool 调用请求]
             │
             ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Policy Decision Point (PDP)                                 │
 │ • 计算当前任务 CapabilityContext                             │
 │ • 综合评估用户角色、系统策略版本 (policy_version) 与 Risk Level │
 └─────────────────────────────┬───────────────────────────────┘
                               ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Policy Enforcement Point (PEP) [不可绕过拦截点]              │
 │ • ALLOW: 放行至 Broker                                      │
 │ • DENY: 拦截并直接向 Agent 反馈 PolicyError (不可执行)       │
 │ • REQUIRE_APPROVAL: 挂起状态机，向用户弹出风险确认弹窗       │
 └─────────────────────────────┬───────────────────────────────┘
                               ▼ (ALLOW 或 用户已批准)
 ┌─────────────────────────────────────────────────────────────┐
 │ Execution Broker ➔ OS Sandbox (底层隔离执行)                │
 └─────────────────────────────────────────────────────────────┘
```

---

### 2. OS 级进程隔离沙箱与 Workspace Jail (彻底纠正 Hook 误区)

#### 2.1 为什么不能依赖 Python 内部 Hook？
Python 的 `sys.modules`, `builtins`, `ctypes`, `importlib` 存在无数种动态突破和绕过路径，**Hook 仅能作为代码辅助校验，绝不能当作安全沙箱**。

#### 2.2 真正的操作系统级沙箱（OS-Level Sandboxing）
执行环境由独立的 **Worker 子进程** 承载，并施加操作系统内核级限制：

1. **Windows 平台**：
   - 使用 **Windows Job Object** 施加硬性内存限额（如 512MB）、超时强制杀死整个子进程树；
   - 使用 **Restricted Token** 去除管理员权限与敏感 SID，禁用网络句柄继承；
   - 目录 ACL 严格锁定在任务独立工作区（`data/workspace/<task_id>/`）。
2. **Linux 平台**：
   - 使用 **Mount Namespace** 创建独立只读根目录，仅将工作区目录挂载为读写；
   - 使用 **Network Namespace** 断开网络（纯本地脚本默认无网络访问能力）；
   - 使用 **seccomp** 严格过滤系统调用白名单，拦截 `ptrace`, `chroot`, `mount` 等高危 Syscall。

---

### 3. 统一 Tool 契约模型 (Tool Contract Specification)

所有工具（内置工具、MCP 工具、本地工具）必须遵循强类型的 Tool Contract：

```yaml
tool:
  name: "code.python_execute"
  version: "1.0.0"
  title: "本地 Python 脚本执行器"
  risk_level: 3                      # 0:纯计算, 1:读文件, 2:写文件, 3:执行脚本, 4:网络交互, 5:高危修改
  capabilities:
    - "code.execute"
    - "filesystem.read_workspace"
  idempotent: false
  side_effect: true
  network: false
  approval_required: false           # 是否默认强制要求用户确认
  timeout:
    default_seconds: 30
    max_seconds: 120
  input_schema:
    type: "object"
    properties:
      script_content: { type: "string" }
      target_inputs: { type: "array" }
    required: ["script_content"]
  output_schema:
    type: "object"
    properties:
      stdout: { type: "string" }
      generated_files: { type: "array" }
```

---

## 五、 数据处理架构与 Data Source Adapter (DuckDB + Python)

针对海量数据分析，建立**“数据适配器 ➔ DuckDB 过滤聚合 ➔ Python 深度建模”**的流水线，严禁将未筛选的完整数据集直接全量加载到 Python 内存中：

```
 多格式业务数据源 (CSV / Parquet / Excel / SQLite / JSON)
                           │
                           ▼
               【Data Source Adapter 层】
               • CSV Adapter ➔ DuckDB Native
               • Parquet Adapter ➔ DuckDB Native
               • Excel Adapter ➔ Arrow/Parquet 中转 ➔ DuckDB
                           │
                           ▼
               【DuckDB 高性能分析引擎】
               • 高效执行 SQL 过滤、JOIN、GROUP BY、字段投影
               • 处理几百兆/几千兆数据，输出轻量级聚合结果集
                           │
                           ▼ (轻量结果集，通常小于 5000 行)
               【Python 深度计算与绘图引擎】
               • 统计学回归、机器学习、复杂业务算法
               • 调用 Matplotlib/Seaborn 绘图，OpenPyXL 生成正式格式报表
```

---

## 六、 浏览器安全架构与防凭证泄漏模型 (Playwright Agent)

### 1. 深度网络安全策略 (Network Security Policy)
针对内网环境下的 SSRF、DNS 重绑定与越权风险，建立纵深策略：

```yaml
network_policy:
  allowed_origins:
    - "https://oa.corp.local"
    - "https://erp.corp.local"
  allowed_ports: [80, 443, 8080]
  allow_redirect: false               # 严禁跨域隐式重定向
  allowed_redirect_origins:
    - "https://sso.corp.local"
  block_private_ranges: true          # 封禁非白名单私有 IP
  block_loopback: true                # 严禁访问 127.0.0.1 / localhost
  block_link_local: true              # 严禁访问 169.254.169.254 (云凭据端点)
  max_download_size_bytes: 52428800   # 最大下载文件 50MB
```

### 2. 凭证防泄漏隔离屏障
1. **独立 Browser Profile**：严禁挂载用户日常个人浏览器的 Profile 与 Cookie 存储；
2. **受控登录流程**：需要登录内网系统时，调起受控的前端 WebView 弹窗供用户手动完成登录（支持扫码/二次验证），Agent 仅继承当前受限会话；
3. **JS 读取隔离**：底层禁止 Agent 注入 JS 读取 `document.cookie`、`localStorage`、`sessionStorage` 及敏感密码表单输入框的真实值。

---

## 七、 深度错误诊断分类学与自愈回路 (Diagnose Taxonomy)

发生异常时，自愈引擎先进行标准化错误归类（Diagnose），再派发针对性反思策略：

| 错误类别 (Category) | 典型触发场景 | 自愈反思指导策略 (Remediation Prompt) |
| :--- | :--- | :--- |
| **`syntax`** | Python 代码缩进错误、SQL 语法错误 | 定位具体代码行数，指出语法规范，直接修复语法 |
| **`schema`** | DataFrame 列名不存在 (`KeyError`) | 提示先使用 DuckDB 查看表头实际字段列表，校正字段名 |
| **`data_quality`** | 字段包含非法空值或类型转换失败 | 引导在代码中添加 `.fillna()` 或类型防御断言 |
| **`permission`** | 尝试写入非工作区目录被沙箱拦截 | 明确指出越权路径，引导将文件存入指定的 `workspace` 目录 |
| **`policy`** | 工具调用被 PEP 策略拦截 | 提示该能力受限，引导使用替代合法工具或提出合规建议 |
| **`network`** | 请求内网系统超时或 HTTP 502 | 触发带指数退避的重试，或检查系统存活性 |
| **`resource`** | 内存超出 512MB 限额被沙箱终止 | 提示数据量过大，引导改用 DuckDB 分批聚合，禁止全量加载 |
| **`timeout`** | 单步脚本执行超过 30 秒 | 引导优化算法复杂度，或拆分为多步执行 |

---

## 八、 三层 Trace 架构与工作流编译器 (Trace ➔ Workflow Specification)

### 1. 三层 Trace 架构与落库规范
彻底分离“推理日志”与“业务事实”，**不落库冗长 CoT 思维链**，改为结构化摘要：

1. **Thought & Planning Trace**：
   - 存储：`plan_snapshot` (当前 Todo 清单), `decision_summary` (本步决策摘要), `reasoning_summary` (决策理由), `error_diagnosis` (错误归类与分析)；
2. **Tool Execution Trace**：
   - 存储：`tool_name`, `input_payload`, `output_payload_ref` (指向 BlobStore), `policy_decision`, `status`, `duration_ms`；
3. **Artifact Trace**：
   - 存储：任务生成的所有资产元数据（文件路径、SHA256、大小、类型）。

### 2. 工作流编译器流水线 (Trace ➔ Workflow Draft)

```
  原始 Tool Execution Trace (包含试错、重试、反思)
                         │
                         ▼
             【Trace Normalizer (轨迹规范化)】
             • 剔除报错重试（如失败 2 次后成功的第 3 次调用）
             • 过滤纯探索性只读动作（如探测字段结构的临时查询）
                         │
                         ▼
             【Semantic Step Extraction (语义提取)】
             • 提取核心有效节点及其输入输出参数关系
                         │
                         ▼
             【Workflow Specification 生成 (YAML)】
             • 将具体硬编码值参数化为模板变量 (如 `{{inputs.file_path}}`)
             • 识别分支条件、人工审批节点与循环逻辑
                         │
                         ▼
             【DAG Compiler (工作流编译器)】
             • 编译生成标准 Web 端 DAG 节点图与连接线
                         │
                         ▼
            【Workflow Draft (待人工审核与发布)】
```

---

## 九、 企业级 Skill 规范与供应链安全 (Supply Chain Security)

### 1. 标准化 Skill 清单规范 (`SKILL.yaml`)
```yaml
id: "corp.skills.financial_report"
name: "financial_report_analysis"
version: "1.2.0"
publisher: "Pivot Financial Team"
digest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
min_runtime_version: "v4.0.0"

permissions:
  - "filesystem.read"
  - "filesystem.write"
  - "code.duckdb_query"
  - "code.python_execute"

tools:
  - "tool.duckdb.query"
  - "tool.python.execute"

inputs:
  financial_excel: { type: "file", extensions: [".xlsx", ".csv"], required: true }

outputs:
  analysis_report: { type: "file", format: "docx" }
```

### 2. 供应链安全保障
- **签名校验 (Signature Verification)**：离线 `.skill.zip` 导入时自动校验数字签名与 SHA256 摘要；
- **权限最小化强制约束**：Skill 声明的权限在安装和运行时经过 PEP 强校验，**严禁 Skill 自行提升或越权要求未声明的权限**。

---

## 十、 纯内网（Air-Gapped）分层运行时与数据安全边界

### 1. 分层运行时打包策略 (按需分发)
避免构建超过 1GB 的巨型单体安装包，采用**模块化运行时分层**：
- **Core Runtime**（随客户端打包）：Electron + Node.js + SQLite (FTS5) + DuckDB 原生引擎；
- **Base Python Runtime**（离线 `.bundle`）：嵌入式 Python 核心（仅标准库）；
- **Data Pack**（离线 `.bundle`）：Pandas, NumPy, OpenPyXL, XlsxWriter；
- **Browser Pack**（离线 `.bundle`）：Chromium 离线无头内核。

### 2. 严谨的企业级安全合规表述
> **安全声明**：在无外网网络连接（Air-Gapped）条件下，Pivot 通过严格的本地网络隔离、域名白名单策略、凭证隔离以及数据访问控制，确保业务数据不经公网传输，完全自闭环于组织内部受控网络边界中。

---

## 十一、 存储架构与数据库表结构设计 (PostgreSQL + SQLite + BlobStore)

### 1. 三级存储架构划分
- **Web 中心服务端 (PostgreSQL 生产库)**：承载全量业务数据、全员高并发 Agent 任务运行表、Tool Calls 审计流、JSONB 策略配置与全局长期审计日志；支持 `pgvector` 原生向量检索与 `pg_trgm` 中文加速；
- **客户端 SQLite (State DB)**：仅承载当前桌面端单用户任务状态机、短期 Trace 缓存与断点恢复 Checkpoint；
- **本地/服务端 BlobStore (文件存储)**：实际存储超过 64KB 的工具输出大文本与任务中间产物文件。

### 2. 核心数据表结构 (PostgreSQL 生产版 DDL)

```sql
-- 1. Agent 任务运行表 (PostgreSQL)
CREATE TABLE IF NOT EXISTS agent_runs (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(64),
    title VARCHAR(255) NOT NULL,
    goal TEXT NOT NULL,
    status VARCHAR(32) NOT NULL,    -- queued | planning | executing | observing | diagnosing | replanning | waiting_approval | completed | failed | cancelled
    run_mode VARCHAR(32) DEFAULT 'auto',
    budget_config JSONB NOT NULL,   -- 原生 JSONB 支撑高速检索与解析
    checkpoint_state JSONB,         -- 恢复状态机用的上下文快照
    usage_stats JSONB,              -- Token、耗时与步骤用量
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_status ON agent_runs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(created_at DESC);

-- 2. Agent 步骤与决策摘要表 (Thought & Plan Trace)
CREATE TABLE IF NOT EXISTS agent_steps (
    id VARCHAR(64) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    phase VARCHAR(32) NOT NULL,     -- plan | diagnose | replan | summarize
    plan_snapshot JSONB,            -- 当前 Todo 清单快照
    decision_summary TEXT,          -- 本步决策摘要
    reasoning_summary TEXT,         -- 决策理由摘要 (非完整 CoT)
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run_step ON agent_steps(run_id, step_number);

-- 3. Tool 执行审计表 (Tool Execution Trace - 包含完整治理元数据)
CREATE TABLE IF NOT EXISTS agent_tool_calls (
    id VARCHAR(64) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    step_id VARCHAR(64) NOT NULL,
    tool_name VARCHAR(128) NOT NULL,
    capability VARCHAR(128) NOT NULL,
    risk_level INTEGER NOT NULL,
    policy_decision VARCHAR(32) NOT NULL, -- allow | require_approval | denied
    policy_version VARCHAR(32) NOT NULL,  -- 关联的策略版本号
    approval_id VARCHAR(64),              -- 审批单 ID
    idempotent BOOLEAN DEFAULT FALSE,     -- 幂等性标识
    input_payload JSONB,                  -- 小参数直接存 JSONB，支持 GIN 索引
    input_hash VARCHAR(64),               -- 输入参数 SHA256
    output_payload_ref TEXT,              -- 指向 BlobStore 的大输出句柄
    output_hash VARCHAR(64),              -- 输出结果 SHA256
    status VARCHAR(32) NOT NULL,          -- success | error | blocked
    error_category VARCHAR(32),           -- syntax | schema | data_quality | permission | policy | network | resource | timeout | unknown
    error_message TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_run ON agent_tool_calls(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_tool ON agent_tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_input_gin ON agent_tool_calls USING gin(input_payload);

-- 4. 任务产物表 (Artifact Trace)
CREATE TABLE IF NOT EXISTS agent_artifacts (
    id VARCHAR(64) PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_artifacts_run ON agent_artifacts(run_id);

-- 5. 企业级 Skill 注册表
CREATE TABLE IF NOT EXISTS agent_skills (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) UNIQUE NOT NULL,
    version VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    publisher VARCHAR(128),
    digest VARCHAR(64) NOT NULL,
    manifest_yaml TEXT NOT NULL,
    instructions_md TEXT NOT NULL,
    scope VARCHAR(32) DEFAULT 'user',
    user_id VARCHAR(64),
    status VARCHAR(32) DEFAULT 'enabled',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 十二、 演进路线图：从 MVP 到生产级发布 (5大阶段)

```
Phase 1: Runtime 核心与 PEP ➔ Phase 2: 沙箱隔离与数据双引擎 ➔ Phase 3: 浏览器与网络安全 ➔ Phase 4: Skill 生态与分发 ➔ Phase 5: Trace 编译器与端云固化
```

### 阶段一：Agent Runtime 核心、状态机与 PEP 拦截点 (MVP 核心)
- [ ] 搭建 `desktop/agent-runtime/`，实现标准状态机（10 种状态流转与 Checkpoint 持久化）。
- [ ] 建立 `Policy Enforcement Point (PEP)` 架构与 `ToolRegistry`，接入强类型 Tool Contract。
- [ ] 实现 `TaskBudget` 预算与看门狗熔断机制。
- [ ] 落地持久化数据模型（`agent_runs`, `agent_steps`, `agent_tool_calls`）。

### 阶段二：OS 级沙箱隔离与数据处理双引擎 (DuckDB + Python)
- [ ] 实现 Windows Job Object / Linux cgroups 进程硬隔离与 Workspace Jail。
- [ ] 接入 `@duckdb/node-api` 与 Data Source Adapter（CSV/Parquet/Excel）。
- [ ] 接入 Base Python 运行环境，打通数据分析处理流水线。
- [ ] 实现基于标准化分类学（Diagnose Taxonomy）的错误自愈引擎。

### 阶段三：浏览器自动化、网络白名单与凭证隔离 (Playwright)
- [ ] 打包离线 Chromium，构建独立的 `AgentBrowserContext`。
- [ ] 实施严密的 `NetworkPolicy`（防 SSRF、阻断非白名单私有 IP、阻断跨域重定向）。
- [ ] 实现受控用户登录流与 DOM + 视觉截屏双引擎定位。

### 阶段四：企业级 Skill 体系与按需运行时分发
- [ ] 实现 `SKILL.yaml` 解析、SHA256 签名校验与权限最小化审计。
- [ ] 实现局域网按需资源包（Data Pack / Browser Pack）同步。

### 阶段五：Trace 语义提取器与工作流编译器 (Trace ➔ DAG)
- [ ] 开发 `Trace Normalizer` 清洗过滤器与 `Workflow Compiler`。
- [ ] 实现客户端自主任务“一键编译为 Web 端 DAG 工作流草稿”。
- [ ] 完成端云协同联调、Crash Recovery 故障演练与企业内网环境压力/安全渗透测试。
