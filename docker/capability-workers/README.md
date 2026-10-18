# Pivot Capability Workers

这些 Worker 是高风险执行面的唯一生产执行器。控制面会在启动 Docker 前验证：不可变镜像摘要、短期 Execution Grant、输入摘要、用户/运行/工具/工作区绑定与单次消费账本。Worker 容器自身不接收授权令牌、业务凭据或宿主环境变量。

| Worker | 协议 | 允许能力 |
| --- | --- | --- |
| `code-runner` | `{version:1, action:"code", code, vars}` → `{ok,result}` | 在无挂载、断网、只读根容器中同步计算 |
| `foreach-runner` | `{version:1, action:"foreach", ...}` → `{ok,result}` | 有界批处理动态代码 |
| `terminal-runner` | `{version:1, action:"exec", command, args, scriptPath}` 或受限 `read/write/list` 文件协议 | Node/Python 与只读 Git/ripgrep；工作区挂载为唯一可写位置，文件协议拒绝符号链接 |

## 构建和发布

从仓库根目录执行。构建底座必须是组织已审计、可追溯的 Pivot/Node 运行时镜像摘要；本机验证可使用预置的 `pivot:latest`，但发布流水线不得依赖该可变标签：

```sh
docker build --build-arg BASE_IMAGE=pivot:latest -f docker/capability-workers/code-runner/Dockerfile -t registry.example/pivot/code-runner:build .
docker build --build-arg BASE_IMAGE=pivot:latest -f docker/capability-workers/foreach-runner/Dockerfile -t registry.example/pivot/foreach-runner:build .
docker build --build-arg BASE_IMAGE=pivot:latest -f docker/capability-workers/terminal-runner/Dockerfile -t registry.example/pivot/terminal-runner:build .
```

安全扫描、签名、推送到受控 registry 后，部署时必须将 manifest digest（`image@sha256:...`）填入对应 `PIVOT_AGENT_*_WORKER_IMAGE` 环境变量；禁止使用标签或 `latest`。每次镜像升级都要在隔离探针、协议回归和签名校验通过后创建新的能力发布记录。

首个发布基线要求镜像内提供 `node`、`python3`、`git` 和 `rg`。`terminal-runner` 不会因缺少工具安装宿主依赖；若镜像不满足基线，对应命令会失败并由发布前探针阻断镜像登记。

对应的 `*_WORKER_COMMAND` 必须与镜像的 CMD 协议一致：code/terminal 使用 `node,/runner/runner.js`，foreach 使用 `node,/runner/agent-foreach-worker.js`。Capability Worker 不使用 Docker `ENTRYPOINT` 拼接业务命令，避免镜像入口和平台登记命令产生二义性。

## 已签名信任清单

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
