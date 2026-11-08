# PPT引擎一键离线更新

本文保留v0.7.133直接Docker执行部署的维护方法。v0.7.135起优先使用[PPT Master独立服务](PPTMaster独立服务部署与更新.md)，首次配置地址和密钥后只更新服务镜像，主应用无需PPT用途Docker权限、共享目录或镜像签名设置。

适用v0.7.133起的Linux/amd64单活Docker部署。构建机需要Node.js、Python 3.12、Git和Docker；生产宿主机需要Python 3.10或更新版本、OpenSSL及Docker Compose v2。生产更新不会下载依赖或访问镜像仓库。

## 构建机：一条命令发布

在Pivot源码目录运行，指定已包含锁定提交的上游仓库：

```powershell
npm run release:ppt-master -- --checkout E:/ppt-master-upstream --output E:/releases/ppt-master-20261108
```

工具复用固定发行包准备器与镜像构建器，实际核对完整运行包和原稿协议，自动导出固定文件名`ppt-master.tar`、签名清单、发布元数据、公钥和本说明。输出目录必须是新的目录；当前已准备的上游包与锁定版本不同会明确停止，不覆盖历史包。

首次执行自动在当前发布账号的`.pivot-release-keys/ppt-master.pem`创建RSA发布私钥，后续继续复用；可用`--signing-key`指定已有正式RSA私钥。私钥不进入交付包。发布输出显示公钥指纹，应通过可信渠道提供给生产管理员。更换构建账号或迁移构建机时须迁移原发布密钥，不能无声创建新密钥替换生产信任。

已有通过核对的本机镜像时，可直接验收并打包：

```powershell
npm run release:ppt-master -- --skip-build --image ppt-master:6.8.0 --output E:/releases/ppt-master-20261108
```

离线包签名绑定完整Docker镜像ID、tar文件字节数和SHA-256、引擎提交/内容摘要/协议及Worker固定入口。执行使用完整`sha256:...`镜像ID，导入后再次核对，不依赖离线传输可能缺失的仓库摘要，也不把镜像ID冒充仓库摘要。原有`仓库@sha256:...`路径继续支持，标签与短ID仍不能执行。

## 生产：首次接入

先更新并运行包含本功能的Pivot主镜像。主镜像已带固定版本Docker客户端、许可证、引擎锁和部署探针；默认Compose仍不授予Docker权限，只有显式安装此功能时才增加协调进程的Docker socket和用户组。Docker socket权限等同宿主机管理权限，仅授予受信任的Pivot协调进程，PPT执行容器不获得socket。

将整个发布目录复制到生产，例如`/data/releases/ppt-master-20261108`。以下在既有Pivot部署目录`/data/pivot`执行：

```bash
docker cp pivot:/app/ppt-master-deploy ./ppt-master-deploy
sudo python3 ppt-master-deploy/deploy_ppt_master.py /data/releases/ppt-master-20261108 --trust-key /可信渠道取得的/publisher-public.pem
```

第一条从已安装且受信任的主镜像取出更新工具，不执行更新包中自带的任意安装程序。首次`--trust-key`是一次性信任登记；请核对发布方提供的公钥指纹。更新包中的公钥文件仅供分发，工具不会自动信任它。生产不保存发布私钥，也无需手填镜像摘要、公钥正文或签名。

安装器自动核对签名、物料、Linux平台、固定引擎合同和单活服务；拒绝仍在制作或等待确认的任务。核对通过后导入镜像，登记PPT独立公钥和清单，配置Docker用户组、同绝对路径任务目录及只读信任目录，生成`docker-compose.ppt-master.yml`并把它追加到`.env`的`COMPOSE_FILE`。业务配置、原有Compose叠加项及其他Worker信任保留。

随后使用当前正在运行的应用镜像重建Pivot服务，避免同名应用标签被更新时顺带切换主应用；实际执行完整包健康检查和任务目录双向读写探针，通过后解除PPT维护接纳并记录新版本。临时主镜像固定不写入日常`COMPOSE_FILE`，以后仍可独立更新Pivot。默认数据卷及数据库不迁移。任务执行继续无网络、只读根、非root和固定资源限制。

## 生产：以后更新或回退

复制新发布目录后执行一条命令：

```bash
sudo python3 ppt-master-deploy/deploy_ppt_master.py /data/releases/ppt-master-下一版
```

更新工具沿用已登记公钥，签名不匹配拒绝更新，不自动信任新公钥。版本或架构不匹配、物料损坏均在切换前停止；实际运行检查失败则恢复旧Compose、原`.env`和原应用容器镜像。首次接入失败也会移除新增的Compose覆盖，恢复原服务。检查运行中任务失败时不重启服务。

更新会短暂重建Pivot主服务，请在维护窗口执行；工具自动核对PPT任务，不替代其他业务的维护安排。签名认可且已存在的镜像会复用，无需重复导入。

显式回退上次PPT配置：

```bash
sudo python3 ppt-master-deploy/deploy_ppt_master.py --rollback
```

更新过程使用主机文件锁和持久恢复记录；进程中断后再次执行命令会先恢复上次未完成切换。不要手工删除恢复记录、版本目录或仍被使用的旧镜像。已切换的原稿/制作检查点不能跨镜像混用，需新建任务。

## 范围

当前支持本机`/var/run/docker.sock`、非root数字UID:GID、一个Pivot服务和固定Linux/amd64镜像。远程Docker、跨主机工作区、其他架构与多活部署需要独立适配，不能用此脚本宣称已经验证。配置文件中包含动态变量的`COMPOSE_FILE`须先改成明确文件列表；已有数据库、素材和私有配置不包含在PPT更新包。

普通Pivot界面更新可以独立进行；今后重建主服务时保留安装器登记的`COMPOSE_FILE`。PPT上游提交或协议改变时，先更新Pivot锁定合同与适配并验收，再生成配套引擎包，生产不能直接替换任意上游最新版。
