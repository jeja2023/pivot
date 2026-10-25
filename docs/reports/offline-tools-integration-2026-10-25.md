# 两项外部依赖测试的补测记录

日期：2026-10-25。对应此前完整回归中跳过的两个用例；它们属于项目离线工具链，不是 PostgreSQL 或思维导图保存功能。

## 原跳过项与原因

| 测试文件 | 实际检查 | 原跳过条件 |
|---|---|---|
| `tests/offline-tools-live.test.js` | 启动真实 Python FastMCP 服务；匿名请求 401、超大请求 413、MCP 握手/工具目录、规则扫描及空输入处理 | 未设置 `PIVOT_OFFLINE_TOOLS_PYTHON` |
| `tests/offline-tools-docker.test.js` | 在 Docker 内通过真实 MCP 协议执行源码扫描、Mermaid 与 Graphviz，结果继续通过 Pivot 的 SVG 安全清洗 | 未设置 `PIVOT_OFFLINE_TOOLS_CONTAINER`，且需要 Kroki 与 Mermaid 服务 |

本次发现本机依赖实际已经具备：Docker Desktop Linux 引擎可用；三个固定标签镜像已预置；`.tmp/offline-tools-venv` 包含 Python 3.12 与 `mcp=1.26.0`、`httpx=0.28.1`、`uvicorn=0.54.0`，与项目锁文件对应版本一致。因此此前的跳过是测试入口没有启用专用环境，不是本机没有能力运行这些测试。

## 本次实际执行

新增 `scripts/run_offline_tools_integration.js` 和命令：

```powershell
# 补测两项真实集成
npm run test:offline-tools:integration

# 同时启用两项外部依赖，运行全部 Node 回归
npm run test:offline-tools:integration -- --all
```

入口自动检测含 MCP 依赖的 Python，优先采用显式环境变量，再尝试工作区现有虚拟环境和系统 Python；不会自动改写业务配置。缺少依赖时返回失败并说明原因，不伪造通过，也不静默跳过。

容器使用预置镜像的实际 SHA-256 ID 启动，禁止自动拉取；绑定当前工作区离线工具源码为只读，以验证当前代码。三个容器位于本次专属的内部网络，不映射宿主端口，不接入既有业务容器网络。测试密钥随机生成，仅以临时只读文件挂载，不输出到日志；容器设定资源上限、移除 capabilities 并禁特权提升，工具服务使用非 root 和只读根文件系统。

原两项定向补测结果：**2 项通过、0 失败、0 跳过**。已验证真实扫描和绘图，不使用协议或图形输出打桩。结束后本轮三个容器、内部网络与临时密钥文件均清理，已有业务容器未变动。

随后实际执行 `npm run test:offline-tools:integration -- --all`，两个隔离 PostgreSQL 分组分别为 1274 项和 1036 项，最终结果：**2310 项通过、0 失败、0 跳过**。两项外部服务用例在完整回归中也实际执行通过，未修改断言或用模拟结果替代。完整运行退出码为 0，三个测试容器、内部网络和临时密钥均已清理。

`npm run check`、新增入口及修改测试文件的 ESLint、增量开发规范和文本检查同时通过。测试使用当前工作区代码，尚未提交或远程发布。

## 复现所需环境

- 本机或可连接的 Docker Linux 引擎；预置 `pivot-offline-tools:1.0.0`、`yuzutech/kroki:0.28.0`、`yuzutech/kroki-mermaid:0.28.0`。镜像获取与构建沿用项目现有离线部署流程，本入口不联网拉取镜像。
- Python 环境安装 `docker/offline-tools/requirements.lock` 对应依赖。已有环境可通过 `PIVOT_OFFLINE_TOOLS_PYTHON` 指定解释器；也可按项目约定创建 `.tmp/offline-tools-venv`，使用 `pip install --require-hashes -r docker/offline-tools/requirements.lock` 安装。
- Node 依赖和可用的项目 PostgreSQL 连接。测试复用现有运行器，在临时 schema 内初始化、迁移并执行，结束后清理，不用业务表作夹具。

执行摘要：`.tmp/offline-tools-integration-report.json`，含镜像摘要、运行时版本、退出码和清理结果，不含密钥。定向日志：`.tmp/offline-tools-enabled-tests.log`；启用全部依赖的完整日志：`.tmp/offline-tools-full-enabled.log`。普通 `npm run test:all` 仍允许不具备这些依赖的环境跳过，但现在会显示明确原因及补测命令。
