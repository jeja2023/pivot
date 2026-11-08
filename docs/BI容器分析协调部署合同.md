# BI 容器分析协调部署合同

适用范围为 Linux/amd64 单活 API 协调容器、同一 Docker daemon 上的受限分析 Worker，以及独立运行的 PostgreSQL。可选覆盖不改变默认关闭重型建模执行的行为。目标主机验证依用户要求暂缓，本合同与本机证据不能替代 G4—G7 认证。

## 固定制品与离线准备

先按既有构建流程生成并校验 API 制品；以其固定摘要构建 `docker/analysis-controller/Dockerfile`。该可选镜像只从固定官方 29.7.2 Linux/amd64 镜像复制 Docker CLI 和许可，不在应用容器运行 daemon。Worker 使用 `docker/analysis-worker/Dockerfile` 和相同依赖基线。交付时保留 API、协调、Worker 与 CLI 来源的不可变摘要、锁文件、许可、组件和漏洞报告。

离线主机先载入全部镜像；Compose 与 Worker 均禁止自动拉取，构建需要的基础镜像亦须提前保存。镜像/执行协议或必要能力不兼容时，就绪检查拒绝接纳，不在启动后下载引擎、扩展、字体或图形资源。未验证架构不列入支持矩阵。

## 协调身份与共享路径

- API 使用非 root UID/GID，默认 `1000:1000`。Worker 显式采用协调进程同一非 root UID/GID，移除全部 capability、禁止提权，且不继承协调进程的附加 Docker 用户组。Linux root 或主组为 0 的协调身份会被运行时拒绝。
- 分析对象保持目录 `0700`、文件 `0600`；任务输出目录 `0700`。以同一身份和精确文件只读挂载供 Worker 读取，无需将私有内容改成全局可读。
- `PIVOT_BI_ANALYSIS_HOST_DIR` 必须是 daemon 宿主机上的已有绝对目录，并在 API 容器内挂载到相同绝对位置。Docker bind 的来源由 daemon 解释，不能把仅存在于 API 容器的 `/app/data/...` 路径直接传给另一个执行容器。
- 安全日志 `PIVOT_BI_SECURITY_HOST_DIR` 与分离密钥 `PIVOT_BI_SECURITY_KEY_FILE` 均为已有绝对路径，不能位于主数据、分析目录内部或彼此嵌套；权限继续由独立日志预检验证。生产须放在合同要求的故障域和受控存储，本机不同子目录不算独立故障域。
- 宿主机目录事先按实际 UID/GID 配置所有权和权限；覆盖使用 `create_host_path: false`，拼写错误不能由 Compose 静默创建空目录。原 API 数据、上传、日志及共同恢复路径仍按主配置保留。

## Docker 管理边界

`PIVOT_DOCKER_GID` 为宿主机 `/var/run/docker.sock` 的实际组编号。可选覆盖仅向受信任 API 协调进程授予 socket 和附加组；这一身份拥有 Docker 宿主机管理权限，应按运维控制面保护。对普通业务用户提供的是受控建模接口，不提供任意命令、镜像、挂载参数、文件路径或 socket 转发。

Worker 不挂载 socket、数据库或应用密钥，使用只读根、精确只读输入、私有输出、无网络、二 GiB 内存、两 CPU、六十四 PID 和八 GiB 临时溢写。任务取消先确认执行单元结束，再释放持久槽位；终止不能确认时保持占用并告警。本覆盖只支持同机 Unix socket，不隐式配置无 TLS 的远程 Docker TCP。

## 显式启动与预检

在受控部署环境设置以下主机参数，值必须来自该环境的固定制品和目录清单：

```text
PIVOT_BI_CONTROLLER_IMAGE=<已载入的协调镜像@sha256:摘要>
PIVOT_BI_WORKER_IMAGE=<已载入的执行器镜像@sha256:摘要>
PIVOT_DOCKER_GID=<Docker socket实际组编号>
PIVOT_BI_ANALYSIS_HOST_DIR=<分析存储已有绝对目录>
PIVOT_BI_SECURITY_HOST_DIR=<独立安全日志已有绝对目录>
PIVOT_BI_SECURITY_KEY_FILE=<分离安全密钥文件绝对路径>
```

按既有批准流程隔离旧写入者、关闭准入与领取并确认任务排空后，显式叠加：

```powershell
docker compose -f docker-compose.yml -f docker-compose.analysis.yml config
docker compose -f docker-compose.yml -f docker-compose.analysis.yml up -d --no-build
```

`config` 输出含部署配置，应在受控终端查看并避免粘贴含密钥的内容。主配置仍要求其既有网络和 GPU 前置条件；本覆盖不绕过它们。

以当前系统管理员执行 `node scripts/bi_operations.js --admin-id <管理员ID> --preflight`。预检通过真实 Worker 读取刚提升的私有 CAS 文件，并核对随机内容摘要、只读输入/根、输出、网络、身份、无 socket/凭据、capability、禁止提权及真实五秒中断；同时检查迁移、当前安全确认、存储原子提升和剩余空间。CLI、socket、共享路径、权限或必要能力不符合合同时保持拒绝，不能只凭“不能写入输入”判断对象可读。

恢复准入与领取继续使用维护开关的预期修订保护；失败或不明执行单元保留暂停。整个目标环境仍需按[运行手册](BI数据建模运行与事故处置手册.md)完成探针、恢复、告警与责任交接。本机真实链路见[证据报告](reports/BI容器协调链路本地证据-20261107.md)。
