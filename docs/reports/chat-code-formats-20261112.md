# 聊天代码块格式补充检查（2026-11-12）

本轮功能验证在源码 v0.7.153 工作区执行，后续启用 v0.7.154；原始日志与截图保留执行时身份，升版不表示重新执行这些业务验收。版本范围和升级说明见[v0.7.154发布说明](../releases/v0.7.154-聊天图形预览与代码文件保存补齐.md)。

## 问题与改动

- 生产反馈的 SVG 代码块原先只显示源码，且受控保存白名单缺少 SVG；已接入既有图形预览、放大、下载及本机保存，前后端检查静态 SVG，兼容 `viewBox` 或固定宽高，保留流式、错误和资源释放行为。
- SVG 修复后的扩展检查发现：HTML、CSV/TSV、常见配置格式无法从代码块保存；`csharp` 等前后端别名不一致；未标注或未知语言也会直接报不支持。
- 浏览器和服务端共用 `client/common/code-formats.js`。补齐 HTML、CSV/TSV、JSONL、INI/TOML 和语言/MIME 别名；未知语言只允许保存为 TXT，不根据未知标记放开任意扩展名。HTM、Markdown、NDJSON 文件名归一为 HTML、MD、JSONL。
- HTML/HTM 默认显示静态预览，可切回源码；复用现有安全 HTML 工具、代码工具栏及主题。独立 iframe 无脚本、无同源权限，内容策略禁止网络，移除链接、资源地址、表单等主动行为；原始源码仅用于查看、复制和文件交付。
- 普通代码块新增浏览器“下载文件”，与本机保存共用 Artifact → CAS → Rendition 链。下载继续通过账号鉴权和短期令牌，本机交付继续经过设备身份、目录授权及扩展名白名单。
- 保留代码块内连续空行，避免改变 CSV 引号字段及源码；下载与保存回调绑定原账号、节点和内容，过期回调不继续下载或提交本机交付。

## 格式检查范围

| 类型 | 回复展示 | 文件处理 |
| --- | --- | --- |
| SVG、Mermaid | 既有图形预览、源码切换、放大 | SVG 安全检查；Mermaid 源码继续保存为 TXT |
| HTML/HTM | 静态沙箱预览、源码切换 | 保留原始 HTML 源码下载或受控本机保存 |
| CSV/TSV、JSON/JSONL、YAML、XML、INI/TOML | 源码 | 使用对应扩展名及 MIME；不执行或转换内容 |
| Python、JS/TS、C/C++/C# 等既有源码 | 源码 | 统一语言别名、格式校验和保存 |
| 未标注、未知语言 | 源码 | 明确回退 TXT，拒绝改为可执行或其他扩展名 |
| Markdown、公式、普通图表 | 保留既有渲染 | 此次不增加新的渲染引擎或格式转换器 |

## 验证与边界

专项覆盖共享格式表全部别名、MIME 与桌面白名单一致性，真实接口创建和下载、匿名与越权拦截、错误扩展名、空白和错误参数类型，浏览器静态预览、源码下载、交付请求、流式等待、超限、账号切换、节点移除、窄屏布局与原有 Mermaid/Markdown 回归。浏览器本机交付使用模拟设备；真实接口及内容存储使用隔离 PostgreSQL 测试环境。

最终串行专项 46/46 通过，命令为 `node scripts/run_node_tests.js tests/code-preview-browser.test.js tests/mermaid-preview-browser.test.js tests/code-delivery-language.test.js tests/code-delivery-client.test.js tests/code-svg-delivery.test.js tests/chat-markdown-rendering.test.js tests/chat-markdown-layout.test.js tests/desktop-delivery.test.js`。

`npm run check`、相关文件 ESLint、`npm run typecheck`、静态资源检查和 `git diff --check` 通过。共享格式表目前包含 80 个语言/MIME 标记和 35 种文本/源码格式；测试逐项检查其映射、MIME 与桌面格式许可，浏览器截图覆盖 1280 和 390 像素宽度。

本记录不表示生产环境验收完成。未部署生产，未在真实 Electron 客户端执行文件落盘，未执行全仓 `npm test`；复杂动态 HTML、第三方依赖、未登记绘图语言和二进制格式不在本次渲染扩展范围内。新增 CSV/TSV、JSONL、INI/TOML 的本机交付需要同步更新桌面客户端中的格式白名单；浏览器下载只需服务端和页面更新。
