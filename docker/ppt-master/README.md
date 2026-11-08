# PPT Master 完整引擎

独立执行镜像统一命名为 `ppt-master:6.8.0`，名称不绑定宿主项目，其他项目可按同一 JSON 协议接入。镜像保留固定上游完整技能发行包，以非特权用户、无网络、只读根文件系统运行。Pivot 宿主继续使用 Capability Worker 的镜像摘要、签名、时限和取消策略，不开放普通技能包执行脚本。

## 构建

日常发布优先使用`npm run release:ppt-master -- --checkout <固定上游仓库> --output <新发布目录>`。工具自动准备/构建、实际核对、导出`ppt-master.tar`并签名；生产首次登记公钥后单命令更新，见[一键离线更新](../../docs/deployment/PPT引擎一键离线更新.md)。下面保留单独构建入口，供排查与开发使用。

```powershell
python scripts/prepare_ppt_master.py --checkout <已固定提交的本地仓库>
python scripts/build_ppt_master.py --checkout <已固定提交的本地仓库> --tag ppt-master:6.8.0
docker image inspect ppt-master:6.8.0 --format '{{json .RepoDigests}}'
```

未提供 checkout 时，准备器只在构建阶段从登记仓库获取固定提交。已有输出目录不会被覆盖。构建使用完整发行包与精确版本的 Python 依赖；上游文件不修改，运行时不联网安装或更新。

构建器从固定 Git 归档生成最小 tar 上下文，避免完整开发目录与缓存进入 Docker 扫描；也可按专用 Dockerfile 的上下文规则直接构建。配置和验收细节见[部署与验收](../../docs/deployment/完整PPT制作引擎部署与验收.md)。

PyMuPDF 的 PDF 源转换依赖未安装，PDF/Word 等文本提取由宿主完成后传入已授权文本快照；Pivot 复用现有文档处理底座。其他库及字体许可随镜像元数据保留；源包中的归属门禁必须通过。

## 配置

准备不可变的 image@sha256 引用后登记到原有 Worker 签名信任清单；配置 `PIVOT_CAPABILITY_WORKER_ENABLED=true`、`PIVOT_PPT_MASTER_ENABLED=true` 和 `PIVOT_PPT_MASTER_IMAGE`。生产继续要求已签名清单；未准备运行时的平台显示不可用，不回退到宿主 Python 或 Shell。

执行入口只接受 JSON 协议。`health` 验证完整包摘要与归属门禁；`read_runtime` 读取工作流参考，任务文本读写不允许脚本，`run` 仅调用登记的上游工具；`deliver` 要求最近成功的上游导出与当前源稿、文件摘要一致。

PPTX 与项目源包通过既有 Artifact/CAS 交付，复杂对象保留在 PowerPoint/上游项目中，不伪称全部转换成 Pivot 画布元素。独立 Office 渲染仍是单独的验证范围。
