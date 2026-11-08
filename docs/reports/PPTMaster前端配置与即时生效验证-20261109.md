# PPT Master前端配置与即时生效验证

日期：2026-11-09。关联版本：v0.7.136。

## 变更

PPT Master全站连接进入现有“模型配置”服务卡片，权限、表单、按钮和弹窗复用项目模式。仅系统`admin`可以修改或测试；其他账号的公开响应隐藏地址和密钥。数据库保存完整加密配置，环境变量仅作为未保存页面配置时的默认值。

连接切换采用数据库修订比较并与PPT任务接纳共用事务锁；不覆盖并发新值，也不切断运行或等待确认的任务。关闭服务后不静默使用环境或直接Docker旧连接。实际请求复用安全HTTP客户端和DNS检查，并继续核对响应大小、文件摘要及固定服务协议。

## 已完成验证

- 最终40项Node/PostgreSQL相关测试全部通过，无跳过：加密与公开字段、URL和密钥校验、并发修订、运行任务拒绝切换、当前保存配置立即进入真实HTTP调用、停用与新实例读取、角色权限，以及既有PPT服务、Master、原稿、接纳和语音设置回归；包括两项帮助导航门禁回归。
- 最终真实浏览器2项通过：管理员草稿连接测试、保存、实际PPT服务可用性读取、更换地址时阻止旧密钥发送、新密钥应用、刷新保留、密钥不回显、停用及窄屏无溢出；关闭后旧响应不能覆盖重新打开时的输入。前端连接测试目标是本机协议夹具，不计为真实模型成稿质量验证。
- 实际独立PPT服务镜像回归通过，使用本轮安全HTTP传输客户端真实生成并下载原生PPTX、项目源包和原稿PNG预览，校验文件摘要、取消和重启恢复。该回归使用测试连接配置，不修改生产或页面保存的数据；数据库中的配置解析和即时调用另由上述真实PostgreSQL/HTTP测试覆盖。
- 已实际查看桌面与390px窄屏截图，字段、说明和操作按钮完整可见，没有密钥回显。
- `npm run check`、定向ESLint、TypeScript和差异空白检查通过。检查曾把正常状态描述“任务运行时”误判成旧导航入口，现按入口名称/上下文识别并用正反例回归，旧入口仍被拒绝；没有放宽SQL、权限或密钥门禁。

证据：[40项回归](../../artifacts/ppt-master-settings-release-0.7.136/tests.log)、[2项浏览器](../../artifacts/ppt-master-settings-release-0.7.136/browser.log)、[通用检查](../../artifacts/ppt-master-settings-release-0.7.136/check.log)、[ESLint](../../artifacts/ppt-master-settings-release-0.7.136/lint.log)、[TypeScript](../../artifacts/ppt-master-settings-release-0.7.136/typecheck.log)、[桌面配置](../../artifacts/ppt-master-settings-acceptance/desktop.png)、[窄屏配置](../../artifacts/ppt-master-settings-acceptance/mobile.png)、[实际服务报告](../../artifacts/ppt-service-acceptance/ppt-service-acceptance-c15490ce4a69/report.json)。

## 范围

未部署生产、未重新打包Pivot主镜像、未运行全仓全部测试和真实模型质量评测。本轮不改变PPT Master服务镜像协议或容器启动方式；首次使用前端设置需先更新Pivot主应用，服务镜像可保留。
