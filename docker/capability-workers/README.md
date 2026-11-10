# Pivot Capability Workers

这些 Worker 是高风险执行面的唯一生产执行器。控制面会在启动 Docker 前验证：不可变镜像摘要、短期 Execution Grant、输入摘要、用户/运行/工具/工作区绑定与单次消费账本。Worker 容器自身不接收授权令牌、业务凭据或宿主环境变量。

| Worker | 协议 | 允许能力 |
| --- | --- | --- |
| `code-runner` | `{version:1, action:"code", code, vars}` → `{ok,result}` | 在无挂载、断网、只读根容器中同步计算 |
| `foreach-runner` | `{version:1, action:"foreach", ...}` → `{ok,result}` | 有界批处理动态代码 |
| `terminal-runner` | `{version:1, action:"exec", command, args, scriptPath}` 或受限 `read/write/list` 文件协议 | Node/Python 与只读 Git/ripgrep；工作区挂载为唯一可写位置，文件协议拒绝符号链接 |

## 构建和发布

v0.7.144 起，终端所需 Git、ripgrep 与协议脚本由默认主镜像完整提供，见[版本发布说明](../../docs/releases/v0.7.144-Docker单镜像完整打包与运行依赖修复.md)。

从仓库根目录执行。构建底座必须是组织已审计、可追溯的 Pivot/Node 运行时镜像摘要；本机验证可使用预置的 `pivot:latest`，但发布流水线不得依赖该可变标签：

主镜像默认包含 Node、Python、Git、ripgrep 和 `/runner/runner.js`，在仓库根目录执行 `docker build -t pivot:latest .` 即可完整打包，并通过非 root 命令自检；不需要额外构建终端镜像。终端 Worker 可复用同一主镜像的已登记不可变身份，执行命令为 `node,/runner/runner.js`。主应用镜像默认仍启动 Web 服务，实际执行由现有隔离 Worker 控制面创建独立容器。

`code-runner` 和 `foreach-runner` 默认使用 `node:22-bookworm-slim`，只依赖 Node 内置模块；离线构建可通过 `--build-arg BASE_IMAGE=<已加载的 Node 镜像>` 覆盖。下列 `terminal-runner` 构建只用于需要独立标签或默认终端入口的兼容交付，直接继承主镜像内的完整工具；正式发布应将底座固定为已审核的镜像摘要。

```sh
docker build -f docker/capability-workers/code-runner/Dockerfile -t registry.example/pivot/code-runner:build .
docker build -f docker/capability-workers/foreach-runner/Dockerfile -t registry.example/pivot/foreach-runner:build .
docker build --build-arg BASE_IMAGE=pivot:latest -f docker/capability-workers/terminal-runner/Dockerfile -t registry.example/pivot/terminal-runner:build .
```

安全扫描、签名、推送到受控 registry 后，部署时必须将 manifest digest（`image@sha256:...`）填入对应 `PIVOT_AGENT_*_WORKER_IMAGE` 环境变量；禁止使用标签或 `latest`。每次镜像升级都要在隔离探针、协议回归和签名校验通过后创建新的能力发布记录。

`terminal-runner` 发布基线要求镜像内提供 `node`、`python3`、`git`、`rg` 和终端协议脚本；这些均由主镜像提供。更新时只需重新构建并导出主镜像，终端镜像登记可复用新主镜像的身份；已部署旧摘要仍须按原信任流程更新，不会自动切换。使用独立终端标签的部署也可继续构建上面的兼容镜像。运行期间不会安装宿主依赖。

对应的 `*_WORKER_COMMAND` 必须与已登记的执行协议一致：code/terminal 使用 `node,/runner/runner.js`，foreach 使用 `node,/runner/agent-foreach-worker.js`。终端复用主镜像时由控制面显式传入终端命令，镜像的默认 CMD 仍用于 Web 服务。Capability Worker 不依赖 Docker `ENTRYPOINT` 拼接业务命令。

## 已签名信任清单

v0.7.133起也接受完整`sha256:64位镜像ID`作为不可变身份，适合Docker离线导入；该ID仍须在正式签名清单中，执行保持`--pull=never`及原有隔离参数。它与仓库摘要是两种明确身份，不接受标签、短ID或tar文件校验值作为执行镜像。PPT一键工具使用独立信任文件，不替换这里其他Worker的清单。

生产部署将 `PIVOT_CAPABILITY_WORKER_SIGNATURE_REQUIRED=true`，并配置包含 `images` 和 detached `signature` 的 JSON 清单及对应 PEM 公钥。清单的签名前正文采用递归字典序 JSON，签名算法固定为 `RSA-SHA256`（清单不能自行降级）；每个条目必须同时锁定 `image@sha256` 和允许的命令串，例如：

```json
{
  "version": 1,
  "images": [{
    "image": "registry.example/pivot/code-runner@sha256:<64位摘要>",
    "commands": ["node,/runner/runner.js"]
  }],
  "signatureAlgorithm": "RSA-SHA256",
  "signature": "<base64签名>"
}
```

Worker 在 Docker 启动前验证清单签名、镜像摘要和入口命令；缺少清单、签名无效、摘要或命令未登记都会 fail-closed。运行命令固定为 `docker run --pull=never`，因此通过签名验证的镜像仍必须由部署流水线预置到目标节点；缺失时不会访问 registry，而是在任何 Worker 副作用前失败。禁止将私钥放入 Pivot 运行环境。

部署前运行 `npm run preflight:capability-workers`。该夹具只输出 Worker 名称、镜像摘要、签名信任模式和预置状态，不输出公钥、签名或任何秘密；生产环境中任一已配置镜像缺失、签名无效，或所有高风险 Worker 均未配置时都会返回失败。

## 隔离演练（5 分验收前置）

预检只证明配置和本机镜像存在，不能替代实际容器隔离证据。每个 Windows Docker 与 Linux Worker staging 节点必须在已启用、已签名并预置镜像后运行：

```sh
npm run drill:capability-workers -- --confirm-staging
```

演练复用正式 Worker 的 `--pull=never`、`--network none`、只读根文件系统、`cap-drop ALL`、`no-new-privileges`、PID/内存/CPU 限制与非 root UID。容器内探针必须同时证明非 root、根文件系统不可写、有效 Linux capabilities 为零、外网不可达；任一项失败即返回非零。命令在 `NODE_ENV=production` 下硬拒绝，不能以生产数据作演练。将成功输出作为“沙箱与本机执行”的非功能/灰度证据，并另行完成真实 Windows/Linux 逃逸探针、完整灰度周期与委员会签署，才可申请 5 分。
