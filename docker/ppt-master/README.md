# PPT Master 完整引擎

镜像统一命名为`ppt-master:6.8.0`，默认启动独立HTTP服务，其他项目可按服务协议1接入。服务以非特权用户和只读根运行，动作进程通过seccomp拒绝Internet socket，继续使用固定上游完整技能包和工具白名单。Pivot只配置服务地址和密钥，不需要Docker socket或共享工作区；原stdin执行入口仍可显式调用，供兼容旧部署。

## 构建

日常构建优先使用`npm run build:ppt-master-service -- --checkout <固定上游仓库> --output <新发布目录>`。工具准备/构建、检查实际服务启动并导出`ppt-master.tar`和独立Compose；生产以后只导入并重建该服务，见[独立服务部署](../../docs/deployment/PPTMaster独立服务部署与更新.md)。下面保留单独构建入口，供排查与开发使用。

```powershell
python scripts/prepare_ppt_master.py --checkout <已固定提交的本地仓库>
python scripts/build_ppt_master.py --checkout <已固定提交的本地仓库> --tag ppt-master:6.8.0
docker image inspect ppt-master:6.8.0 --format '{{json .RepoDigests}}'
```

未提供 checkout 时，准备器只在构建阶段从登记仓库获取固定提交。已有输出目录不会被覆盖。构建使用完整发行包与精确版本的 Python 依赖；上游文件不修改，运行时不联网安装或更新。

构建器从固定 Git 归档生成最小 tar 上下文，避免完整开发目录与缓存进入 Docker 扫描；也可按专用 Dockerfile 的上下文规则直接构建。配置和验收细节见[部署与验收](../../docs/deployment/完整PPT制作引擎部署与验收.md)。

PyMuPDF 的 PDF 源转换依赖未安装，PDF/Word 等文本提取由宿主完成后传入已授权文本快照；Pivot 复用现有文档处理底座。其他库及字体许可随镜像元数据保留；源包中的归属门禁必须通过。

## 配置

优先独立执行`docker compose -f docker-compose.ppt-master.yml up -d --no-build --pull never`，首次设置服务`PPT_MASTER_TOKEN`并在Pivot填写`PIVOT_PPT_MASTER_SERVICE_URL`及`PIVOT_PPT_MASTER_SERVICE_TOKEN`。后续兼容服务协议的更新无需修改Pivot。以下不可变镜像与Worker签名配置只用于原有直接Docker执行兼容路径。

准备不可变的 image@sha256 引用后登记到原有 Worker 签名信任清单；配置 `PIVOT_CAPABILITY_WORKER_ENABLED=true`、`PIVOT_PPT_MASTER_ENABLED=true` 和 `PIVOT_PPT_MASTER_IMAGE`。生产继续要求已签名清单；未准备运行时的平台显示不可用，不回退到宿主 Python 或 Shell。

执行入口只接受 JSON 协议。`health` 验证完整包摘要与归属门禁；`read_runtime` 读取工作流参考，任务文本读写不允许脚本，`run` 仅调用登记的上游工具；`deliver` 要求最近成功的上游导出与当前源稿、文件摘要一致。

PPTX 与项目源包通过既有 Artifact/CAS 交付，复杂对象保留在 PowerPoint/上游项目中，不伪称全部转换成 Pivot 画布元素。独立 Office 渲染仍是单独的验证范围。
