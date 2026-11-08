# PPT Master独立服务与标准回退验证

日期：2026-11-08。关联版本：v0.7.135。

## 变更与边界

完整引擎新增独立服务入口和稳定协议1，Pivot通过内网鉴权接口传递输入快照、固定动作并下载文件，主应用的账号权限、模型调用、确认、预算、任务租约、CAS及下载令牌保持原有职责。服务版本和引擎提交由服务自己的完整包校验确认，Pivot按协议与能力检查接入；正在处理的任务固定运行包身份，不跨升级混用。

独立服务不挂载Docker socket或Pivot任务目录，服务端只接受不可猜测任务标识、固定入口和文件类型。输入、输出、动作JSON与日志都有对应限制；重复动作标识只能读取同一请求的完成结果，中断动作不会自动重放。密钥不进入动作进程环境。Landlock只允许读取运行库并写入自身任务与临时目录，拒绝其他任务和服务进程凭据；libseccomp拒绝Internet socket及进程内存读取，保留LibreOffice所需本地Unix socket。

服务未配置或不可用时，标准PPT创建、编辑、故事线及导出不调用完整服务。依赖完整引擎的原稿和视频功能明确显示不可用，不把该状态描述为本地原稿引擎已经就绪。

## 已完成验证

- 最终54项Node/PostgreSQL相关回归全部通过，无跳过，包括服务协议/鉴权、取消转发、文件摘要与大小、重定向拒绝、标准可用性提示，以及既有Master、原稿、模板、故事线和直接Docker兼容回归。
- 最终Linux隔离/任务测试11项通过，无跳过，实际核对自身目录写入、其他任务文件读取/删除拒绝、服务凭据拒绝、Internet socket拒绝、本地IPC可用、链接重定向拒绝、输入不可覆盖、取消与动作重放规则。
- 真实浏览器最终1项通过：服务地址不可连接时，完整制作窗口可带入目标切换标准制作，AI自由设计仍完成大纲与三页创建、结构编辑、PPTX及PDF导出和令牌下载。使用本机确定性模型夹具，不据此判断真实模型设计质量。
- 从正式Dockerfile完整构建最终服务镜像成功；交付工具实际启动检查后生成固定名称`ppt-master.tar`、独立Compose、配置示例和部署说明，不需要发布签名或修改Pivot镜像身份配置。
- 最终实际服务容器完整验收通过：上游工具真实生成原生PPTX与项目源包并通过HTTP下载，原稿读取实际生成PNG预览，文件摘要和页面文字一致；匿名访问、跨用户输入和越界路径被拒绝，网络与文件隔离实际生效，没有挂载Docker socket或共享工作区。
- 真实视频编码动作被取消后任务锁释放；同镜像容器重启后输入和任务保留。使用相同服务地址、密钥和数据卷替换为兼容协议的另一镜像，保持同一个Node客户端进程，旧运行身份任务明确拒绝，新任务执行通过。升级夹具只改变服务代码标记，用于验证镜像身份切换与接口兼容，不计为对任意上游新版本的认证。
- `npm run check`、定向ESLint、TypeScript、源码语法和差异空白检查通过。首次原稿预览曾因LibreOffice固定`/tmp` IPC清理权限不足失败；定位后仅放行IPC创建/清理，保持文档和凭据边界，再完成真实预览回归。并发构建下的一次冷启动等待超时与一次浏览器模块加载等待不足均保留失败记录，最终复测通过，不累计为额外成功用例。

本机证据：[54项回归](../../artifacts/ppt-service-release-0.7.135/node-tests.log)、[Linux隔离测试](../../artifacts/ppt-service-release-0.7.135/python-tests.log)、[服务离线浏览器](../../artifacts/ppt-service-release-0.7.135/browser.log)、[正式镜像构建](../../artifacts/ppt-service-release-0.7.135/image-build.log)、[交付包生成](../../artifacts/ppt-service-release-0.7.135/package.log)、[最终容器报告](../../artifacts/ppt-service-acceptance/ppt-service-acceptance-ed03f835076c/report.json)、[实际原稿预览](../../artifacts/ppt-service-acceptance/ppt-service-acceptance-ed03f835076c/native-preview.png)、[实际PPTX](../../artifacts/ppt-service-acceptance/ppt-service-acceptance-ed03f835076c/service.pptx)。

## 未扩大结论

当前没有部署目标生产服务器，没有运行全仓全部测试、真实模型质量盲评或全面Office/WPS渲染矩阵。服务升级需保持协议1及实际消费能力兼容，任意不兼容的上游版本不能靠替换标签保证兼容。运行中的动作在服务重启时会中断并保留状态，不能称为无中断升级。

当前服务镜像验收为Linux/amd64且内核已启用Landlock。缺少必要隔离能力时服务停止启动。Pivot主应用源代码与实际HTTP调用路径已回归，但本轮没有重新生成Pivot完整主镜像，不把独立引擎镜像构建等同于主应用构建。
