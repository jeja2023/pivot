# Personal Agent Beta 评测集与证据矩阵

> 版本：v0.1.154 实现基线（2026-09-20）  
> 执行方式：每个任务在独立测试账号/租户中执行；记录 Run、审批、投递和用户评价。不得把样本不足写成达标。

## 运行规则

- 每条记录至少保存：账号/租户、模型、时间窗、允许工具、预期、实际、评分、Run ID、投递 ID（如有）。
- 任何带 `安全/故障` 标签的用例必须通过后才可进入试点；这些用例不用于计算“有用率”。
- 敏感信息、真实密钥、生产手机号和未脱敏客户附件不得进入评测集。

| ID | 场景 | 操作 | 预期 | 标签/自动化证据 |
| --- | --- | --- | --- | --- |
| PA-01 | 首次设置 | 从个人工作台打开 3 分钟设置并填写称呼、语言、详略 | 档案保存且只作用于当前账号 | `personal-workbench.test.js`、`agent-personal-control.test.js` |
| PA-02 | 设置跳过 | 打开设置后跳过，再次进入继续填写 | 不覆盖既有字段；可以继续配置 | 人工 UI 回归 |
| PA-03 | 首个任务 | 从任务编辑器运行“整理待办” | 任务入队、可打开详情、无须先建 Skill | `agent-run-actions.js`、`agent-control.test.js` |
| PA-04 | 显式记忆 | 在聊天输入稳定偏好并点“记住当前输入” | 写入有来源的个人记忆，敏感内容被拒绝 | `agent-personal-control.test.js` |
| PA-05 | 记忆纠正 | 在记忆中心更正一条偏好后运行相似任务 | 新版本生效，旧值不再注入 | `agent-personal-control.test.js` |
| PA-06 | 记忆暂停/删除 | 暂停或删除一条命中记忆后重跑 | 下一 Run 不再使用该记忆 | `agent-personal-control.test.js` |
| PA-07 | 历史会话回忆 | 使用 `sessions.search` 查询自己的历史结论 | 返回标题、片段和当前用户的会话来源 | Agent tool ACL 回归 |
| PA-08 | 跨用户隔离 | 用另一账号搜索相同关键词 | 不返回另一账号会话或记忆 | 安全 RAG/会话回归 |
| PA-09 | 经验生成 | 完成三次同类资料整理任务并请求学习 | 至多形成一个可审计个人候选 | `agent-postgres-integration.test.js` |
| PA-10 | Skill 命中解释 | 运行相似任务 | 详情显示 Skill、匹配理由和匹配词 | `agent-skills`、运行详情回归 |
| PA-11 | Skill 撤销 | 停用已命中的个人 Skill 后重跑 | 新 Run 不再匹配，历史版本保留 | Skill release 集成回归 |
| PA-12 | 权限差异 | 为候选增加网络/写入权限 | 不自动启用，必须重新验证和审批 | Skill 安全回归 |
| PA-13 | 自然语言目标 | 输入“每个工作日 09:00 检查项目风险并通知我” | 返回草案；未确认前不创建 active 目标 | `agent-goal-drafts.test.js` |
| PA-14 | 模糊数据源 | 输入“每天查数据库并汇报” | 明确提示缺少数据源，不推断 SQL/连接 | `agent-goal-drafts.test.js` |
| PA-15 | 目标确认 | 确认含签名令牌的草案 | 只按服务端签发的草案创建目标 | `agent-goal-drafts.test.js` |
| PA-16 | 重复触发 | 对同一目标发送相同触发键 | 只创建一个 Run | 目标调度租约集成回归 |
| PA-17 | 投递故障 | 模拟渠道 5xx/超时 | Run 和 delivery 分离，delivery 重试/死信可见 | Channel adapter fault suite |
| PA-18 | 渠道配对 | 为 Gateway 建配对码并从外部身份首次发消息 | 只有签名+未过期配对码可建立身份 | `agent-postgres-integration.test.js` |
| PA-19 | 渠道会话续接 | 同一外部会话连续发送两条消息 | 映射同一个 Pivot Session | `agent-postgres-integration.test.js` |
| PA-20 | 渠道重放 | 重发同一个外部 event ID | 幂等返回，不创建第二个 Run | `agent-channel-gateway.test.js` |
| PA-21 | 渠道撤销 | 撤销配对后继续从原身份发消息 | 拒绝接入，已撤销会话不可回复 | `agent-postgres-integration.test.js` |
| PA-22 | 加密回复目标 | 完成渠道 Run 并检查 outbox | 外部 conversation ID 不以明文写入 session/outbox | `agent-postgres-integration.test.js` |
| PA-23 | 能力发现 | 搜索“项目审查”能力目录 | 只见已授权的内置、Skill、MCP 或受控连接 | `agent-capability-catalog.test.js` |
| PA-24 | 未配置能力 | 请求图片、TTS 或网页搜索且 Provider 未配置 | 显示可操作的能力未接入说明，不伪造结果 | `agent-media-generation.test.js`、`agent-web-search.test.js` |
| PA-25 | 网页检索 | 在 Run 白名单中配置检索 Provider 并调用 | 返回来源证据；凭据不出现在输出 | `agent-web-search.test.js` |
| PA-26 | 图片生成 | 白名单同时允许 Provider 和媒体 CDN | 工具暂停等待审批，确认后只返回安全媒体 URL | `agent-media-generation.test.js` |
| PA-27 | 语音输入/TTS | 用浏览器语音输入，随后运行经审批的 TTS | 语音输入由浏览器处理；TTS 走受控 Provider | `chat.memoryActions`、`agent-media-generation.test.js` |
| PA-28 | 项目资料包 | 选择两个资料集合并调用 `rag.search` | 检索只在所选集合内，运行详情显示快照 | `agent-context-packs.test.js` |
| PA-29 | 权限回收 | 资料包被共享者撤销后重试任务 | 创建或检索阶段拒绝，不泄露资料 | 资料 ACL + context-pack 回归 |
| PA-30 | 并行协作 | 建立三个子任务及 JSON 输出契约 | 权限/预算继承，至多一次修正并回传主管 | `agent-collaboration-batch.test.js` |

## 安全与故障覆盖清单

本集中的 PA-06、PA-08、PA-12、PA-14、PA-16、PA-17、PA-20、PA-21、PA-22、PA-29 是首轮 10 条强制安全/故障用例。还必须在预发布环境追加一次真实渠道的签名失败、网络断开、审批过期和 outbox 多实例竞争演练。

## 当前证据状态

- 自动化代码与 PostgreSQL 集成测试已覆盖核心状态机、签名、ACL、幂等、媒体 Provider 边界和委派契约。
- 真实 IM/Provider 的开发者账号、试点用户、30 条人工评分和 Beta 指标样本属于部署/运营验收，不能由本地代码测试替代。
