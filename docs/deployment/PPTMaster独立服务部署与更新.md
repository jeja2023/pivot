# PPT Master独立服务部署与更新

PPT Master作为独立常驻HTTP服务运行，Pivot只通过内网服务协议调用，不需要Docker socket、共享任务目录、镜像摘要或发布签名配置。默认标准PPT创建、结构化编辑和导出不依赖这个服务；服务未部署、停机或不兼容时，AI自由设计进入标准工作台。

当前交付验收基线为Linux/amd64，内核需启用Landlock（Linux 5.13起提供）；其他CPU架构或裁剪内核需要匹配构建与独立验证。缺少目录隔离能力时服务会明确停止启动，不降低隔离规则运行。

## 构建与离线交付

在构建机Pivot源码目录运行：

```powershell
npm run build:ppt-master-service -- --checkout E:/ppt-master-upstream --output E:/releases/ppt-master-service
```

镜像默认使用 `ppt-master:6.10.0`，可通过 `--image` 指定本批独立标签。以随包 `image.json` 的镜像 ID 和 `ppt-master.tar.sha256` 区分交付批次。已有与当前源码锁定信息一致的服务镜像时可加 `--skip-build --image <镜像标签>`。打包工具检查服务启动、上游版本、交付核验、修页和快照能力，导出 `ppt-master.tar` 及其 SHA-256，附独立 Compose 和配置示例。旧的仅 stdin 动作镜像需要首次更新为带 HTTP 服务的新镜像。

## 首次启动服务

生产服务器创建服务目录，例如`/data/ppt-master`，将交付文件放入目录。首次生成一次访问密钥：

```bash
cd /data/ppt-master
printf 'PPT_MASTER_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker network inspect ai-bridge >/dev/null 2>&1 || docker network create ai-bridge
docker load -i ppt-master.tar
docker compose -f docker-compose.ppt-master.yml up -d --no-build --pull never
```

默认只在`ai-bridge`内网暴露8502端口，不映射公网端口；服务以非root、只读根、固定CPU/内存和进程数运行，持久任务放在独立命名卷，升级不清卷。动作子进程不继承访问密钥，通过Landlock只读运行库并仅写入自身任务与临时目录，拒绝其他任务和服务进程凭据访问；seccomp拒绝Internet网络socket和进程内存读取，LibreOffice本地Unix socket可用。接口需要Bearer访问密钥，不接收Shell或任意路径。

LibreOffice固定使用公共`/tmp`放置IPC socket，隔离规则仅允许其创建和清理；不开放普通文件读写或目录枚举。文档和动作临时文件保存在各自的`/data`任务子目录，服务会拒绝把任务数据根目录配置到`/tmp`。

v0.7.136起推荐由系统`admin`在前端配置连接：进入“设置 → 应用服务 → PPT Master制作服务”，启用服务、填写`http://ppt-master:8502`和上述同一访问密钥，点击“测试连接”，再“保存并应用”。保存即时生效，无需重启Pivot；更换地址须填写新密钥，旧密钥不会被自动发往新地址。运行或等待确认的PPT任务须先结束再切换。

未保存页面设置时，也可继续通过Pivot生产`.env`提供初始默认值：

```dotenv
PIVOT_PPT_MASTER_SERVICE_URL=http://ppt-master:8502
PIVOT_PPT_MASTER_SERVICE_TOKEN=与PPT_MASTER_TOKEN相同的密钥
```

仅使用环境配置时，首次重建Pivot以加载默认值：

```bash
cd /data/pivot
docker compose up -d --no-build --pull never --force-recreate pivot
```

这条服务路径不需要开启`PIVOT_CAPABILITY_WORKER_ENABLED`或`PIVOT_PPT_MASTER_ENABLED`。如以前安装了v0.7.133直接Docker协调覆盖，请从Pivot的`COMPOSE_FILE`移除旧`docker-compose.ppt-master.yml`覆盖并重建Pivot，撤销PPT用途socket和共享目录挂载；保留其他业务仍需要的Docker配置。新的服务Compose独立放在`/data/ppt-master`，不要作为Pivot的覆盖文件叠加。

页面配置使用现有`DATA_ENCRYPTION_KEY`整体加密，服务地址和密钥不写入普通审计详情。仅系统`admin`可以修改和测试，其他账号不获得服务地址和密钥。测试草稿不改变配置；页面停用后以停用状态为准，不自动回退环境中的旧服务。服务镜像更新仍按下面的独立更新步骤，不需要随前端配置功能重建服务镜像。

## 更新服务镜像与主应用

### v0.7.191 PPT 制作推进与草稿工作台优化

1. 构建并更新 Pivot 主应用镜像，保留兼容的 PPT Master v6.10.0 独立服务、访问配置和任务数据卷。主应用启动时复查 Artifacts 既有迁移字段，缺失时自动执行原迁移。
2. 更新后从 `/version.json` 核对 Pivot 版本。用受控材料分别验证 AI 制作及按模板制作，确认「首次页面写入」出现后能导出、下载并在「我的演示文稿」找到初稿。
3. 复验需要续作的旧任务时，确认其检查点、权限和原工作区仍有效。按页修复后核对未选页和导出文件。遇到生产模型再次报错时记录任务编号、轮次及错误代码，便于区分动作校验、指引读取和产物复检问题。

[v0.7.191 发布说明](../releases/v0.7.191-PPT制作推进与草稿工作台优化.md) · [保留原数据卷和任务](#保留原数据卷和任务)

### v0.7.189 模板清单恢复与逐轮计时

1. **构建并更新 Pivot 主应用镜像**，在原 Compose 工程中替换 `pivot` 容器。保留当前兼容的 PPT Master v6.10.0 独立服务、访问配置和任务数据卷。本版无需重新打包独立镜像或执行数据库迁移。
2. 更新后刷新浏览器，从 `/version.json` 核对主应用版本。打开原失败任务，查看「待核对的引文」是否逐项列出原因。具备原工作区与权限时，可在补充原文或切换模型后沿用保存的清单续跑。历史记录缺少计时字段时显示「未记录」。
3. 用生产同配置模型和受控材料分别验证 AI 制作和按模板制作。核对自动校验、首次页面写入、初稿预览与 PPTX 下载，确认按要求生成的新稿可回查旧版本。打开停在旧确认环节的任务时可点击「继续制作」。用「每轮模型用量明细」核对计时和失败重试记录。

[v0.7.189 发布说明](../releases/v0.7.189-PPTMaster模板清单恢复与逐轮计时.md) · [保留原数据卷和任务](#保留原数据卷和任务)

### v0.7.188 制作过程弹窗优化

本次更新仅涉及 Pivot 主应用前端页面与管理员用户记录弹窗，不改变独立执行服务接口或镜像依赖：

1. **直接更新 Pivot 主应用即可**，现有独立服务容器、数据卷与检查点继续使用，无需重建独立服务镜像或执行数据库迁移。
2. 更新后刷新浏览器（经反向代理缓存时清缓存），在「完整制作过程」中核对「查看材料与提纲」按钮和「每轮模型用量明细」弹窗：弹窗应完整显示在窗口内，不被底部遮挡。

[v0.7.188 发布说明](../releases/v0.7.188-PPT制作过程弹窗优化与管理员记录默认视图.md) · [保留原数据卷和任务](#保留原数据卷和任务)

### v0.7.187 逐轮步骤与异常诊断

本次更新仅涉及 Pivot 主应用后端与前端页面，不改变独立执行服务接口或镜像依赖：

1. **直接更新 Pivot 主应用即可**，现有 `ppt-master:6.10.0-pivot0.7.186`（或兼容的 v6.10.0）独立服务容器、数据卷与已有检查点均可继续使用，无需重建独立服务镜像或执行数据库迁移。
2. 更新后打开任意正在执行或已失败的历史任务，可在「完整制作过程」直接查看**本步工作**与**轮次异常记录**，并点开「查看每轮模型用量」核对每一轮的执行动作、分页偏移、自动重试与脱敏异常诊断。

[v0.7.187 发布说明](../releases/v0.7.187-PPT制作逐轮步骤与异常诊断.md) · [保留原数据卷和任务](#保留原数据卷和任务)

### v0.7.186 制作链路与过程回顾

1. **先更新主应用并处理旧任务。** 保留匹配的原执行器镜像、工作区、服务地址和密钥。更新后可查看旧失败记录中已有的材料读取证据和方案，在原运行身份下续跑。只有任务仍有有效权限、原工作区及匹配引擎时，才能继续制作。
2. **再切换独立执行服务。** 使用当前源码构建镜像，构建时可指定独立标签 `--image ppt-master:6.10.0-pivot0.7.186`。宿主预建项目、单页与原稿复检参数、执行端源包限额随本批镜像提供。参照下方的数据卷保留步骤切换，保持原检查点及已交付文件可查。
3. **用新任务验收。** 从带鉴权的 `GET /v1/info` 核对上游版本 `6.10.0`、`managedProject: 1`、`boundedSourceBundle: 1` 和 `currentExport: 1`。使用生产同配置模型和一页合成材料，依次核对首次方案、批准清单、首张 SVG、正式 PPTX 下载。可在「完整制作过程」查看已保留的读材料、方案及每轮诊断。

[v0.7.186 发布说明](../releases/v0.7.186-PPT制作链路与过程回顾.md) · [保留原数据卷和任务](#保留原数据卷和任务)

若独立服务无法通过启动探针，先查看容器启动日志。运行期探针通过动作执行器核对 Landlock 和网络隔离，镜像构建期的运行包检查与之分开。遇到隔离初始化失败，检查宿主内核和容器安全策略是否允许启用 Landlock。若 LibreOffice 或 ffmpeg 明确报告文件描述符耗尽，请保留失败的操作、页数及素材规模供复查。模型端点预检失败时，核对该端点能否接受 JSON 对象模式并返回有效 JSON。

### v0.7.185 检查点续跑与稳定性

1. **先更新主应用，在原引擎上续跑。** 保留原服务地址、密钥、镜像和对应数据卷。打开因 `PPT_MASTER_NO_PROGRESS` 停止的任务，从已有检查点继续。续跑会保留已批准方案、累计用量和步骤，并核对原有权限与引擎身份。
2. **处理完待续跑任务后再切换独立服务。** Quick 无锁文件文字校准和内置图标同步需要用 v0.7.185 源码重新构建独立镜像。构建时可用 `--image ppt-master:6.10.0-pivot0.7.185` 为本批制品指定独立标签。
3. **切换后用新任务验收。** 从带鉴权的独立服务 `GET /v1/info` 核对 `version: "6.10.0"`、`textCalibrationRoles: 1` 及 `tools` 中的 `icon_sync`，再新建 Quick 任务验证校准、出稿和正式交付。已有检查点继续绑定其创建时的运行身份。

[v0.7.185 发布说明](../releases/v0.7.185-PPTMaster制作续跑与稳定性修复.md) · [保留原数据卷和任务](#保留原数据卷和任务)

### v0.7.182 模板预览中文字体修复

本次修复随 Pivot 主应用镜像部署。模板预览的 PNG 由主应用渲染，字体由主镜像注册。已部署 `ppt-master:6.10.0-pivot0.7.181` 的环境继续使用这份独立镜像。若同时从更早版本升级完整制作引擎，按下节核对主应用和独立服务版本。[v0.7.182 发布说明](../releases/v0.7.182-PPT模板预览中文字体修复.md)

### v0.7.181 上游 v6.10.0

将 Pivot 主应用与 `ppt-master:6.10.0-pivot0.7.181` 配套更新。先在旧环境处理待续跑任务，保留原服务的 Compose 项目、访问密钥和 `/data` 命名卷。更新后登录查看 `GET /api/apps/presentations/master/info`，确认 `engine.version` 为 `6.10.0`，且 `engine.currentExportReady`、`engine.pageRepairReady` 和 `engine.progressSnapshotsReady` 均为 `true`。[v0.7.181 发布说明](../releases/v0.7.181-PPTMaster-v6.10.0升级.md)

### v0.7.180 模板库预览

预览页面和接口均由 Pivot 主应用提供。部署时使用同一次构建的前端资源和后端，并在主应用更新后用登录账号分别检查内置模板的版式图和 PPT Master 的风格图。如果出现「当前服务未提供模板预览接口」，先核对主应用进程的版本和代理转发路径。独立服务的升级要求按下方 v0.7.179 的完整制作能力判断。[v0.7.180 发布说明](../releases/v0.7.180-PPT模板库预览与布局优化.md)

### v0.7.179 自动修页和交付核验

本批需配套更新主应用及包含最新修订稿核验的独立服务。安装后，以登录请求 `GET /api/apps/presentations/master/info` 核对 `engine.currentExportReady` 和 `engine.pageRepairReady`，再使用新任务验收模板应用、自动修页及正式文件下载。源码升版不代表生产镜像已构建或部署；正式制品及生产模型仍须按发布流程验收。[v0.7.179 发布说明](../releases/v0.7.179-PPT自动修页与交付核验.md)

本批 Linux/amd64 离线包的镜像标签为 `ppt-master:6.8.0-pivot0.7.179`。升级时使用随包校验文件和 `image.json` 核对归档与镜像身份，并在原服务目录将 `PPT_MASTER_IMAGE` 设置为本批标签。包内「离线升级」说明包含导入、保留原卷、重建和回退步骤。

### v0.7.178 制作快照和引文恢复

将主应用更新到 v0.7.178 后，以登录请求 `GET /api/apps/presentations/master/info` 返回的能力判断是否需要换镜像。

| 当前独立服务能力 | 更新方式 |
| --- | --- |
| `engine.progressSnapshotsReady: true` | 只更新主应用，继续使用当前已具备快照能力的镜像。 |
| `engine.enabled: true`，但 `progressSnapshotsReady` 缺失或为 `false` | 如需制作快照、通过页 PPTX 和转存独立原稿，用支持快照的 `ppt-master:6.8.0` 替换独立服务。标签相同也应核对镜像 ID。 |

用户补充来源、引文修复失败后的续作和制作记录导航随主应用更新。标准工作台的草稿保存随主应用数据库迁移生效。构建身份和普通账号验收见 [v0.7.178 发布说明](../releases/v0.7.178-PPT制作快照与引文恢复.md)。

### 历史版本说明

v0.7.177 扩展了主应用的整份重新生成入口。已运行 v0.7.176 批次的 `ppt-master:6.8.0` 且支持逐页修复时，只需更新主应用。更早的 `ppt-master:6.8.0` 也可能使用同一个标签，请按交付清单确认实际镜像，并检查主应用的 `engine.pageRepairReady`。需要换镜像时按下述步骤保留任务。[v0.7.177 发布说明](../releases/v0.7.177-PPTMaster修复后重新生成与本地验收.md)

### 保留原数据卷和任务

启用已批准清单的自动修页时，请配套更新 Pivot 主应用与独立执行镜像。用已登录账号访问 `GET /api/apps/presentations/master/info`，核对 `engine.currentExportReady` 和 `engine.pageRepairReady` 均为 `true`。修订稿的本次导出摘要、模板安装核验和未选页保留检查由执行镜像提供。旧任务需要续跑时，按对应版本说明在匹配的引擎上处理，再按下述步骤切换。

制作快照随主应用数据库和产物存储持久化。保留原任务和已保存快照需要两者配套备份。继续执行旧检查点还需要原引擎身份、连接配置和任务卷。

1. **换镜像前处理在途任务。** 在原引擎上完成正在制作、等待确认或仍需续跑的任务，下载重要成品、项目源包和可下载草稿。任务记录在 Pivot 的 PostgreSQL 中，已交付文件在主应用的产物存储中，PPT Master 工作区在独立服务的 `/data` 卷中。安排维护窗口，把数据库、主应用持久数据目录（含产物存储和上传目录）、PPT Master 数据卷备份到同一业务时点，另行保管现用 `.env`、`DATA_ENCRYPTION_KEY`、服务地址和访问密钥。若需要换引擎，在导入同名标签前保存原镜像，便于回退。
2. **在原 Compose 项目中只重建目标服务。** 沿用部署目录、原 Compose 项目名、原配置文件和卷映射。替换主应用时也沿用其 PostgreSQL 连接与持久目录。需要更新 PPT Master 时，校验归档后导入，并仅重建 `ppt-master` 服务。避免 `docker compose down -v`、清卷和从新目录用默认项目名启动。保留原服务地址和 `PPT_MASTER_TOKEN`，以便原环境继续定位存量工作区。
3. **复核挂载和任务。** 重启后核对 `/data` 的实际卷名、镜像身份、管理员连接测试，以及旧任务列表和已交付文件下载。再新建测试任务核对逐页修复和重生成。参数、密钥和文件保留后，原任务记录可继续查看。旧检查点仍与原地址、密钥及引擎运行身份绑定，换镜像后不能直接续跑。需要恢复这类任务时，应使用原服务配置、原镜像和对应工作区备份。工作区闲置 24 小时会被清理，重要的待核验草稿和材料应在切换前保存。

以下示例适用于生产已使用 `docker-compose.ppt-master.yml` 的独立服务。先在旧容器上确认原 Compose 项目名，将 `PPT_PROJECT` 替换为该值。在已完成备份、且确实需要换镜像时执行。保留原 `.env` 中的密钥，并按升级包 `image.json` 的 `image` 值设置 `PPT_MASTER_IMAGE`。

```bash
cd /data/ppt-master
PPT_PROJECT='替换为原 Compose 项目名'
ppt_compose=(docker compose -p "$PPT_PROJECT" -f docker-compose.ppt-master.yml)
volume_at_data() {
  docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$1"
}

old_container=$("${ppt_compose[@]}" ps -q ppt-master)
old_volume=$(volume_at_data "$old_container")
test -n "$old_volume" || exit 1
sha256sum -c ppt-master.tar.sha256 &&
  docker load -i ppt-master.tar &&
  "${ppt_compose[@]}" up -d --no-build --pull never --force-recreate ppt-master || exit 1
new_container=$("${ppt_compose[@]}" ps -q ppt-master)
test "$(volume_at_data "$new_container")" = "$old_volume" || exit 1
```

可用 `docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' <旧容器名>` 查询项目名。重建后若卷名有变化，暂停验收，按原部署参数恢复挂载后再接受新任务。主应用可在其原部署目录和原 Compose 项目中更新镜像后，仅重建 `pivot` 服务。

v0.7.176 的逐页核验与选页修复需要同时更新主应用和独立服务。独立镜像仍使用 `ppt-master:6.8.0`，导入前核对本批归档摘要。更新后检查服务报告 `pageRepair: 1`，并用带有源页映射的失败导出复验。任务检查点继续绑定原引擎身份，请先处理在途与待恢复任务，再切换镜像并保留数据卷。[v0.7.176 发布说明](../releases/v0.7.176-PPTMaster逐页核验与修复.md)

v0.7.175 的引文和重复检查自动修复随主应用更新。待核验草稿使用同批交付的 `ppt-master:6.8.0` 镜像和新版主应用。已有检查点绑定原引擎身份。可以先更新主应用，在原镜像上处理在途和待恢复任务，再安排独立服务换镜像。保留服务数据卷和连接配置。若既有配置使用其他标签，请将 `PPT_MASTER_IMAGE` 改为本次镜像标签。[v0.7.175 发布说明](../releases/v0.7.175-PPTMaster自动修复与待核验草稿.md)

升级到 Pivot v0.7.172 时，使用该版源码重建 PPT Master 服务镜像，使其包含更新后的 `runner.py`、`tool_catalog.py` 和 `delivery_checklist.py`，并同时更新 Pivot 主应用。建议在切换前结束运行中或等待确认的任务，保存已有交付文件。服务数据卷与现有连接配置可继续使用；运行身份改变后，原检查点需在原运行环境完成，切换后按需新建任务。[v0.7.172 发布说明](../releases/v0.7.172-PPTMaster分阶段确认与交付核验.md)

等待完整制作和原稿任务结束后，复制新版 `ppt-master.tar` 和 `docker-compose.ppt-master.yml` 到现有服务目录，在 `.env` 中按随包 `.env.example` 设置 `PPT_MASTER_IMAGE`，并配置 `PPT_MASTER_TOKEN`。现有部署可以沿用已单独配置的密钥。曾使用旧模板固定密钥的部署应生成新密钥，并在 Pivot 的 PPT Master 服务设置中同步更新。保留现有命名卷，再替换服务容器。

随包提供 `ppt-master.tar.sha256` 时，在服务目录执行 `sha256sum -c ppt-master.tar.sha256`，通过后再导入镜像。

```bash
cd /data/ppt-master
docker load -i ppt-master.tar
docker compose -f docker-compose.ppt-master.yml up -d --no-build --pull never --force-recreate ppt-master
```

使用其他镜像标签时修改服务目录 `.env` 的 `PPT_MASTER_IMAGE`。访问密钥与数据卷保留。仅升级运行包且兼容当前 Pivot 时，可独立替换服务镜像。v0.7.172 部署后，管理员先测试连接，再检查已登录请求 `GET /api/apps/presentations/master/info` 返回 `engine.checklistReady: true`。协议不兼容时 Pivot 会禁用完整引擎，标准功能继续可用。

### 引文或交付核验失败时恢复

如果页面提示某页某项引文与材料原文不一致，先核对该项指向的原材料，保留任务编号、失败提示及任务工作区。通过“从检查点继续”复用已有进度，按原文修订清单并重新确认。若上游已成功导出且页面提供“下载待核验草稿”，所有者可以先保存草稿，再处理核验提示。草稿用于复核，正式交付仍需通过已批准清单的检查。

草稿支持随 Pivot 主应用和独立执行镜像一起更新。执行镜像身份与检查点绑定，安排升级前先处理在途和待恢复任务，并保留独立服务的数据卷及已有产物。旧版失败记录按其原有检查点处理。

按页修复需要执行服务支持 `pageRepair: 1`。升级主应用与独立镜像后，从一次带有页面源稿映射的导出失败开始验收。确认页面列出具体未通过项，选页修复后其余页及所用资源保持一致，整稿重新通过已批准清单。旧失败记录若只有错误代码和检查点，请在原服务处理，或使用仍可用的原材料重新生成整份。

v0.7.159归档的模板校验修复：模板制作反复提示“所选模板未通过上游工作区校验”时，旧版服务的模板适配器可能仍把工作区限定为`/workspace`，与独立服务的`/data/jobs/<任务标识>/workspace`不一致。修复需要使用包含更新后`runner.py`和`template_adapter.py`的源码重新构建并更新PPT Master服务镜像；仅更新Pivot页面或重启旧服务不会生效。更新后新建制作任务，模板继续由固定上游校验器检查，不能通过放宽任务目录边界绕过校验。上游技能仍固定为6.8.0，服务协议仍为1，源码版本不替代镜像自身的运行身份。

同版本的服务卡片修复随Pivot主应用部署：全站配置已启用且完整时，可查看应用服务的账号默认统一显示绿色；绿色是配置状态，不是持续健康探测，系统`admin`仍通过“测试”检查当前连接。地址脱敏、密钥保密与配置权限保持原规则。完整升级范围及验收限制见[v0.7.159发布说明](../releases/v0.7.159-PPT模板校验监控明细与数据分析布局优化.md)。

## 功能范围

服务承接原有完整制作、模板工具、原稿对象编辑和离线页面视频；模型调用、用户权限、用量、任务确认、版本和产物下载仍由Pivot负责。服务操作保持现有固定工具和参数白名单。HTTP服务只接收授权输入快照和受控动作，返回文件后仍由Pivot执行原有CAS交付与账号鉴权。

关闭服务或移除连接配置后，标准大纲/页面生成、在线结构化编辑、故事线调整和标准PPTX/PDF导出仍可使用；依赖完整引擎的原稿往返和离线视频会明确提示不可用。已有交付文件与持久原稿版本保留在Pivot，不依赖服务临时目录。服务任务闲置24小时后自动清理。

默认Compose用于同机Docker内网。跨主机时由部署方用受控内网TLS代理暴露服务，并将Pivot地址改为代理根地址；不要把访问密钥或服务接口直接开放到公网。
