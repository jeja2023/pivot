# 对话能力关键词误拒答修复记录

日期：2026-11-16。状态：源码修复与本地专项验证完成，未部署生产。

功能批次在v0.7.164源码下完成，后续归档于[v0.7.165发布说明](../releases/v0.7.165-智能路由与助手HTTP下载体验优化.md)；以下原测试批次和策略版本按执行阶段保留，不因升版改写为新一轮验证。

## 问题与根因

聊天路由完成语义判断后，仍调用 `detectUnsupportedCapability`，按图片、视频、语音或实时检索正则生成固定回复并结束 SSE。OpenAI 兼容接口存在同类分支。该判断不能准确区分实际执行请求与文字中的能力术语，且不能代表已授权工具的完整可用性。

已有标准附件正文分隔和来源范围限制继续复用；旧媒体正则对引文、代码等文字仍可能命中。修复目标是移除这条会覆盖用户意图的拒答路径，而非增加另一组关键词豁免。

## 修改

- 移除聊天和 OpenAI 兼容接口的关键词提前拒答，删除仅供该分支使用的本机浏览器例外判断。
- 语义入口及决策上下文统一使用 `currentUserText`，将当前提示词与附件正文、附件链接文件名分开；附件名称、来源标识保留在来源元数据中，正文继续进入正常回答或任务来源读取。
- 语义决策指引区分分析、翻译、解释、编写提示词与实际生成、联网查证，按目标和交付物判断所需能力。
- 回答上下文复用执行器现有可用性函数，仅说明未配置的 Pivot 内置接口，不传配置地址或凭据，不据此推断全部外部或客户端工具不可用。确实无法执行的部分说明具体限制，继续完成同一请求中的其余工作；禁止虚构检索、生成和交付结果。
- 保留视觉输入校验、工具策略、网络白名单、权限审批和服务未配置时的执行错误。未增加依赖、配置或数据库迁移。

## 实际验证

以下单次最终批次经项目 PostgreSQL 隔离测试入口运行，205 项通过，0 失败：

```powershell
node scripts/run_node_tests.js tests/chat-capability-intent-http.test.js tests/chat-source-scope.test.js tests/chat-source-analysis-http.test.js tests/chat-intent-understanding.test.js tests/agent-media-generation.test.js tests/agent-web-search.test.js tests/local-browser-connector-tools.test.js tests/security-chat.test.js
```

覆盖媒体术语解释、翻译、概念比较、代码、实时信息文字概括、附件正文保留、明确图片生成任务交接、OpenAI 流式与非流式转发，以及聊天编排和来源权限回归。无媒体服务时实际执行仍返回 `AGENT_MEDIA_UNAVAILABLE`，不伪造成功。

ESLint（本次相关源码和测试）、`npm run check:standards`、死导出门禁及 `git diff --check` 通过；文本完整性检查通过。

## 未验证范围与上线

HTTP 回归使用模拟上游模型，证明请求到达正常处理路径、能力上下文正确传递及响应协议保持正常，不代表真实模型的语义识别或回答质量已完成验收。测试装置清理期间出现部分异步决策日志的外键告警，最终批次测试通过；本次未修改该日志生命周期。

未运行全仓测试、真实媒体服务或生产模型验收。部署须更新并重启后端服务；生产应复测包含能力术语的实际文档，以及同时包含文字任务和真实执行要求的提示词。

## 追加修复：SVG 图片被误认为媒体生图

用户反馈生产模型仍拒绝“生成 SVG 格式的图片”。上一轮移除了固定关键词拦截，但尚未在语义判断和回答中明确 SVG 源码可由文本模型编写；全局“不要用其他编程语言代码画图”的指引也过宽，容易影响用户指定格式的源码请求。

本次通过共享 `svg-generation-guidance.js` 同步聊天/OpenAI 能力上下文、语义决策及默认任务规划。仅展示或编写 SVG 使用普通回答和完整 `svg` 代码块，不申请 `media.image_generate`；明确要求可下载 SVG 时使用受控任务、`viz.render` 和现有 `diagram.render_svg`。说明历史助手的生图拒绝不能阻止当前 SVG 源码创作；另行要求的真实媒体操作继续检查工具与权限。

修正聊天全局绘图规则，保留真实业务数据必须有来源的要求；补齐 SVG 工具描述，保留脚本、事件处理器和外部资源的安全限制。语义策略标识更新为 `chat-intent-v7`，默认规划核心更新为 `planner-core-v3`；未新增配置、依赖或迁移，未改变管理员已发布的自定义核心提示词。生产若使用自定义核心，需按既有治理流程在该版本中同步 SVG 边界。

本次最终专项批次 200 项通过，0 失败：

```powershell
node scripts/run_node_tests.js tests/chat-capability-intent-http.test.js tests/chat-intent-understanding.test.js tests/chat-source-scope.test.js tests/agent-prompt-registry.test.js tests/security-chat.test.js tests/code-svg-delivery.test.js tests/code-delivery-language.test.js
```

覆盖无生图服务且历史曾拒绝的 SVG 聊天请求、可下载 SVG 任务交接、OpenAI 流式/非流式指引传递、真实 SVG 代码文件的下载授权及安全拒绝。此处模型回复来自模拟上游，只证明处理路径、指引传递与响应协议，不等同于生产模型语义质量验收。

另运行 `presentation-task-tools.test.js` 的“原始 SVG 源码可直接登记图片结果，不要求用户自己创建受控图片引用”用例，1 项通过：实际 SVG 文件成功登记，恶意脚本输入被拒绝。ESLint（本次相关文件）、开发规范、死导出和文本完整性门禁通过。本次未部署生产，也未访问生产模型。
