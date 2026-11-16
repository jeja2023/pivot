# Windows 独立助手远程 HTTP 直连兼容记录

日期：2026-11-16。功能验证及制品基线：v0.7.164，兼容改动后续归档于[v0.7.165发布说明](../releases/v0.7.165-智能路由与助手HTTP下载体验优化.md)。状态：实现、构建及本地专项验证完成，未部署生产；本次归档不改变已有制品版本。

## 行为与边界

用户要求保持远程 HTTP 直连。原助手仅允许 HTTPS 和 HTTP 回环地址，配对前的地址校验会拒绝远程 HTTP。

本次在助手中增加按地址确认的 HTTP 兼容路径：

- 用户填写远程 HTTP 服务根地址后，先在本机原生弹窗确认具体 Origin 和明文传输说明，默认选择取消。确认前不向该地址发送配对信息；取消保留原有账号连接。
- 接受后继续原账号确认、设备密钥创建和配对流程。连接状态持续显示“HTTP 明文直连”，每次本机操作仍需确认，账号切换仍撤销旧连接并清空应用授权。
- HTTP 确认只随当前连接保存在系统加密存储中。恢复时必须匹配完整 Origin；更换地址或重新配对重新确认，不跟随重定向、不静默从 HTTPS 降级。HTTP 用户信息、查询参数和额外路径仍被拒绝。
- 页面仍通过既有服务端接口操作助手，助手不新增本机监听端口，不降低渲染页面的 CSP、沙箱或上下文隔离。
- 不增加主界面表单行或窗口高度；保留紧凑布局及无页面滚动的尺寸边界。

HTTP 不提供传输机密性，也不能提供等同 TLS 的服务端身份及完整性保护。设备签名、浏览器绑定、一次性挑战和应用授权边界保留，但配对凭据、截图和操作内容仍可能被网络窃听或篡改；本机确认中明确说明此点。

改动位于 `desktop/helper/runtime.js`、`main.js` 和 `renderer.js`。没有新增依赖、服务端接口或数据库迁移；已部署既有助手配对接口的 HTTP 站点只需升级助手。浏览器与助手填写的协议、主机、端口须一致，HTTP 站点的登录 Cookie 配置须与协议相匹配。

## 实际验证

HTTP 与既有助手专项最终批次16项通过，0失败、0跳过：

```powershell
node scripts/run_node_tests.js tests/web-local-helper-http.test.js tests/web-local-helper-e2e.test.js tests/web-local-helper.test.js tests/web-local-helper-ui.test.js
```

覆盖默认拒绝未确认远程 HTTP、确认拒绝时不发送配对信息且保留原连接、确认顺序、Origin 绑定、恢复和重新配对、禁止重定向、HTTPS/回环兼容、跨浏览器拒绝、退出撤销及账号切换。

端到端使用真实 Chromium、Electron、HTTP 接口、隔离 PostgreSQL 与 Windows 可访问性驱动。将合成域名 `pivot-http.invalid` 在隔离测试进程中解析到本机测试服务器，使用普通 HTTP 页面，并确认 `window.isSecureContext=false`；未将该 Origin 强制标记为安全。HTTP 配对后成功领取签名任务，在专用验收窗口实际输入文字并核对结果。原生确认只在测试主进程替换为受控响应；正式助手继续显示原生确认。

更新安装包的补充验收最终批次2项通过，0失败、0跳过；其中远程 HTTP 用例与上面批次重叠，不合并为唯一通过数：

```powershell
$env:PIVOT_HELPER_INSTALLER_ACCEPTANCE='true'
node scripts/run_node_tests.js '--test-name-pattern=远程 HTTP 直连|独立助手安装包' tests/web-local-helper-e2e.test.js tests/web-local-helper-installer.test.js
```

实际执行 NSIS 安装、从安装目录启动、HTTP 原生确认拒绝路径和卸载；卸载器临时文件隔离到本次测试目录，等待目录清理完成。早期补充批次因 Windows 临时文件占用出现清理错误，隔离后最终批次正常退出。一个早期残留测试目录的手动删除被自动审批策略阻止，保留于 `C:\Users\HP\AppData\Local\Temp\pivot-node-tests-1-hR0v4M`，不作为交付文件。

真实 Electron 窗口在620×620、540×600、760×680三组尺寸和明暗主题下验证，包括带 HTTP 前缀的长状态及长账号，无页面横向或纵向溢出。远程连接截图：[remote-http-connected.png](../../output/local-helper/remote-http-connected.png)。

相关文件 ESLint、开发规范、文本完整性及差异空白检查通过。发行目录 ASAR 内的5个助手主文件与当前源码逐字节一致。

## 构建制品与使用

构建命令：`npm run build:local-helper -- --unsigned`。

- 安装包：`E:\pivot\dist-local-helper\build-1794834378714\PivotLocalHelper-Dev-Setup-0.7.164.exe`
- 大小：113,062,470字节。
- SHA-256：`5F62CFDB0455D2EB1D475DAC6DB5A29A81311DDD1CE7F6AC18C4087AEBCCFCC4`
- 签名状态：`NotSigned`。这是明确标记 Dev 的开发验证包，正式发布仍需既有发布者签名流程。

退出旧助手，安装新包后重新生成配对码，填写与浏览器相同的 `http://服务器:端口`，确认 HTTP 地址、账号并重新授权应用。原有 HTTP 服务无需增加 HTTPS 入口或隧道。

## 未验证范围

未连接真实生产服务器、部署主应用镜像或执行真实业务应用操作；本次合成域名验证不能代替生产 DNS、网络、账号策略及业务应用验收。未执行全仓测试或完成正式签名发布。
