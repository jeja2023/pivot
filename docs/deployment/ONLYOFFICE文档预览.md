# DOCX 在线预览与 ONLYOFFICE 接入

Pivot 的会话结果文件支持 DOCX 在线查看。未配置 ONLYOFFICE 时，使用当前文件对应的受控 Document IR 生成隔离的 HTML 内容预览，不需要下载；分页、字体及图片可能与 DOCX 原文件不同，图片资产当前显示为占位说明。该预览不适用于没有受控 IR 的任意外部 Word 文件。

生产环境已有 ONLYOFFICE Docs 时，可以使用其只读查看器打开实际 DOCX。当前实现用于会话结果文件的预览，不提供在线编辑、保存回写或通用文件管理。未配置时继续使用上述内容预览；配置错误或 ONLYOFFICE 不可达会显示错误，不会误报成功。

v0.7.81 中，DOCX、图片和 ONLYOFFICE 预览使用右侧非模态面板；桌面宽屏下会话区域相应收窄，窄屏下预览占满屏幕。切换或关闭预览会清理当前查看器或临时图片地址。

## 同机部署配置

1. 在 Pivot 对外的同源反向代理下配置虚拟路径 `/onlyoffice/`，转发到生产机已有的 ONLYOFFICE Docs。应保留 WebSocket 升级，并按 ONLYOFFICE 的虚拟路径配置传递 `X-Forwarded-Host`、`X-Forwarded-Proto`；具体主机、端口和已有网关配置须以现场为准。参考官方 [反向代理说明](https://helpcenter.onlyoffice.com/docs/installation/docs-community-proxy.aspx)及其中的虚拟路径示例。
2. 在 Pivot 主程序环境中配置以下值，并按部署流程更新主程序：

   ```dotenv
   PIVOT_ONLYOFFICE_PATH=/onlyoffice
   PIVOT_ONLYOFFICE_PIVOT_URL=http://pivot:3000
   PIVOT_ONLYOFFICE_JWT_SECRET=通过安全渠道设置与ONLYOFFICE一致的密钥
   ```

   第一项是浏览器访问 Pivot 同源代理的路径，只接受单级路径；第二项必须是 **ONLYOFFICE 服务端实际可访问的 Pivot HTTP 来源地址**，没有 `/api` 或其他路径。`http://pivot:3000` 仅在服务名和端口确实如此、两容器网络互通时有效；同一台宿主机不等于容器内可以用 `localhost` 访问其他容器。第三项使用 ONLYOFFICE Docs 的 JWT 密钥，至少 32 个字符，通过受控配置注入，不填入聊天或提交到仓库。ONLYOFFICE 的 JWT 验证应保持启用。
3. ONLYOFFICE 需要能够回连第二项指定的 Pivot 地址拉取文件。若实际配置阻止私网目标，按现场网络策略检查 ONLYOFFICE 出站设置；官方 Docker 参数 `ALLOW_PRIVATE_IP_ADDRESS` 的默认值及适用范围见 [ONLYOFFICE 安装说明](https://helpcenter.onlyoffice.com/docs/installation/docs-developer-install-docker.aspx)。不要启用元数据地址访问或关闭 JWT 来绕过故障。
4. 反向代理及 ONLYOFFICE 的访问日志不得记录 Pivot 回源 URL 中的 `token`；限制回源接口和文档服务的可访问网络。预览票据有效期五分钟，可在有效期内重试，绑定用户、登录令牌版本和文件；每次读取会重新核验账号状态、文件权限、状态与完整性，但已加载到 ONLYOFFICE 的内容无法远程撤回。

## 现场验收

在受控维护环境先检查代理加载 `/onlyoffice/web-apps/apps/api/documents/api.js`，再用普通用户从自己的会话结果中打开 DOCX，确认浏览器显示 ONLYOFFICE 只读界面及内容。检查无权用户、过期票据、停用账号、失效文件均不能回源；检查同源代理 WebSocket、JWT 和文件地址的实际连通性，再验证不同用户隔离和字体、分页效果。文档敏感性取决于生产部署：ONLYOFFICE 会接收和处理文件内容，因此应纳入同等访问与数据保留管理。

开发环境未连接生产 ONLYOFFICE；单元测试、受控 HTTP 与数据库测试不能替代实际文档服务器、代理及用户浏览器联调。服务器端无法下载文件时，先按官方 [排障说明](https://api.onlyoffice.com/docs/docs-api/more-information/troubleshooting)检查文件地址及服务之间的网络。
