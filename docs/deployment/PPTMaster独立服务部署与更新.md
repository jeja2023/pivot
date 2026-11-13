# PPT Master独立服务部署与更新

PPT Master作为独立常驻HTTP服务运行，Pivot只通过内网服务协议调用，不需要Docker socket、共享任务目录、镜像摘要或发布签名配置。默认标准PPT创建、结构化编辑和导出不依赖这个服务；服务未部署、停机或不兼容时，AI自由设计进入标准工作台。

当前交付验收基线为Linux/amd64，内核需启用Landlock（Linux 5.13起提供）；其他CPU架构或裁剪内核需要匹配构建与独立验证。缺少目录隔离能力时服务会明确停止启动，不降低隔离规则运行。

## 构建与离线交付

在构建机Pivot源码目录运行：

```powershell
npm run build:ppt-master-service -- --checkout E:/ppt-master-upstream --output E:/releases/ppt-master-service
```

已有新服务镜像时可加`--skip-build --image ppt-master:6.8.0`。工具检查实际服务启动并导出固定文件名`ppt-master.tar`，附独立Compose和配置示例。旧的仅stdin动作镜像需要首次更新为带HTTP服务的新镜像。

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

## 以后只更新服务镜像

等待完整制作和原稿任务结束后，复制新版`ppt-master.tar`，只执行：

```bash
cd /data/ppt-master
docker load -i ppt-master.tar
docker compose -f docker-compose.ppt-master.yml up -d --no-build --pull never --force-recreate ppt-master
```

服务使用相同镜像标签时无需改Pivot。使用其他标签则只改服务目录`.env`的`PPT_MASTER_IMAGE`。访问密钥与数据卷保留，正常兼容协议1的升级不需要重新构建或重启Pivot。协议不兼容时Pivot明确禁用完整引擎，标准功能继续可用；正在进行或旧检查点的任务不会跨新旧运行包混用，需要新建任务。

v0.7.159归档的模板校验修复：模板制作反复提示“所选模板未通过上游工作区校验”时，旧版服务的模板适配器可能仍把工作区限定为`/workspace`，与独立服务的`/data/jobs/<任务标识>/workspace`不一致。修复需要使用包含更新后`runner.py`和`template_adapter.py`的源码重新构建并更新PPT Master服务镜像；仅更新Pivot页面或重启旧服务不会生效。更新后新建制作任务，模板继续由固定上游校验器检查，不能通过放宽任务目录边界绕过校验。上游技能仍固定为6.8.0，服务协议仍为1，源码版本不替代镜像自身的运行身份。

同版本的服务卡片修复随Pivot主应用部署：全站配置已启用且完整时，可查看应用服务的账号默认统一显示绿色；绿色是配置状态，不是持续健康探测，系统`admin`仍通过“测试”检查当前连接。地址脱敏、密钥保密与配置权限保持原规则。完整升级范围及验收限制见[v0.7.159发布说明](../releases/v0.7.159-PPT模板校验监控明细与数据分析布局优化.md)。

## 功能范围

服务承接原有完整制作、模板工具、原稿对象编辑和离线页面视频；模型调用、用户权限、用量、任务确认、版本和产物下载仍由Pivot负责。服务操作保持现有固定工具和参数白名单。HTTP服务只接收授权输入快照和受控动作，返回文件后仍由Pivot执行原有CAS交付与账号鉴权。

关闭服务或移除连接配置后，标准大纲/页面生成、在线结构化编辑、故事线调整和标准PPTX/PDF导出仍可使用；依赖完整引擎的原稿往返和离线视频会明确提示不可用。已有交付文件与持久原稿版本保留在Pivot，不依赖服务临时目录。服务任务闲置24小时后自动清理。

默认Compose用于同机Docker内网。跨主机时由部署方用受控内网TLS代理暴露服务，并将Pivot地址改为代理根地址；不要把访问密钥或服务接口直接开放到公网。
