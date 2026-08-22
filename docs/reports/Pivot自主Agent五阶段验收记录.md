# Pivot 自主 Agent 五阶段验收记录

日期：2026-08-21

本记录对应《Pivot全自主Agent改造方案设计.md》路线图的五个阶段。每一阶段均有实现入口、自动化验收和安全边界；路线图中的 16 项计划已全部完成。

## 阶段一：Runtime、状态机与 PEP

- 实现：`desktop/agent-runtime/runtime.js`、`desktop/agent-runtime/state-store.js`。
- 能力：SQLite WAL 状态库、状态迁移、步骤/工具账本、Checkpoint、TaskBudget、Tool Contract、PEP、审批暂停恢复、操作键幂等重放和崩溃恢复。
- 验收：`node --test tests/desktop-agent-runtime.test.js tests/autonomous-agent-contracts.test.js`，结果 `20/20`；包含审批恢复、非幂等调用重新审批、预算落库、看门狗和操作键输入摘要校验。

## 阶段二：OS 隔离、DuckDB、Python 与自愈

- 实现：`server/services/agent-os-isolation.js`、`server/services/agent-sandbox.js`、`server/services/agent-data-adapter.js`、`server/services/agent-python.js`、`server/services/agent-diagnosis.js`。
- 能力：Windows Job Object、Linux cgroup/网络命名空间探测与严格模式、Workspace Jail、CSV/Parquet/Excel/SQLite 数据适配、受限 Python Worker、分类诊断和指数退避恢复计划。
- 验收：`node --test tests/agent-sandbox-python.test.js tests/agent-data-adapter.test.js tests/autonomous-agent-contracts.test.js`，结果 `22/22`；包含真实 Python、DuckDB CSV/Excel 查询和符号链接越权拒绝。

## 阶段三：离线 Chromium、网络白名单与凭证隔离

- 实现：`server/services/agent-browser.js`、`scripts/package_browser_runtime.js`、`server/services/agent-tools.js`。
- 能力：独立持久化 Profile、离线 Chromium 解析/打包、下载与 Service Worker 禁止、Origin/端口/重定向/私网 SSRF 防护、受控登录、DOM 优先和视觉截图回退定位、凭证读取阻断。
- 验收：`node --test tests/agent-browser.test.js`，结果 `3/3`；`node scripts/package_browser_runtime.js --dry-run` 成功解析 Chromium。

## 阶段四：Skill 生态与运行时资源分发

- 实现：`server/services/agent-skill-packages.js`、`server/services/agent-runtime-packs.js`、`server/routes/agents.js`。
- 能力：`.skill.zip` 安全解包、`SKILL.yaml` 校验、SHA256/ detached RSA 签名、权限最小化审计、重复/越权路径拒绝、Data Pack/Browser Pack LAN 白名单同步和摘要校验。
- 验收：`node --test tests/agent-skill-packages.test.js`，结果 `6/6`；覆盖真实 ZIP、签名、路径穿越、重复条目、权限、魔数和 LAN 白名单/摘要校验。

## 阶段五：Trace 编译、端云固化与故障演练

- 实现：`server/services/agent-trace-compiler.js`、Agent Trace/Workflow Draft API、桌面 Runtime 的 `compileWorkflowDraft()`。
- 能力：Trace 清洗过滤、语义步骤提取、参数化、DAG 草稿生成、端云联调、Checkpoint 崩溃恢复、非幂等重新审批、并发压力和网络安全探针。
- 验收：`node --test tests/agent-acceptance.test.js`，结果 `3/3`；包含 32 路并发压力、Crash Recovery、Trace→DAG 和 SSRF/白名单安全拒绝。

## 综合回归

阶段专项合计 `39/39` 通过，ESLint 对新增和修改模块无错误。该阶段验收基线版本为 `0.1.21`；后续 Harness 治理、协议基线和恢复矩阵增量已发布为 `v0.1.22`，变更记录见 `CHANGELOG.md`。

服务端运行与数据表按 PostgreSQL-only 口径验收；数据库生命周期/Trace 集成夹具（`tests/agent-runtime-lifecycle.test.js`、`tests/agent-trace-contracts.test.js`）需要 `DATABASE_URL` 或显式 `PIVOT_TEST_DB_SYNC=postgres`。当前工作区未配置该连接，因此未将这部分计入专项通过数。桌面 Runtime 的 SQLite State DB 是客户端本地任务状态存储，不属于服务端业务数据库迁移。

本轮补强验收新增：桌面 Runtime 工具看门狗与预算持久化、Workspace Jail 符号链接越权拒绝、白名单企业内网地址放行、Skill ZIP 上传魔数校验、完整 YAML 解析、Skill 最小权限 PEP 拦截。
