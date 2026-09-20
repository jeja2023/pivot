# Personal Agent Beta 发布证据与外部验收

## 已完成的代码证据（v0.1.154）

| 体验链路 | 实现证据 | 自动验证 |
| --- | --- | --- |
| 个人入口、档案、记忆 | 个人工作台助手卡、首次引导、直接开始、聊天显式/自然语言记忆、命中理由与记忆治理 | `personal-workbench.test.js`、`agent-personal-control.test.js`、`agent-personal-journeys.test.js` |
| 自动学习与经验复用 | 个人 Skill 验证/发布、自动匹配理由、用户纠正和 Run-derived Skill 草稿 | `agent-postgres-integration.test.js`、`agent-personal-journeys.test.js` |
| 主动目标 | 自然语言草案、HMAC 确认令牌、测试运行、模型/权限/时区/投递快照、调度/租约/outbox | `agent-goal-drafts.test.js`、`agent-channel-delivery-reliability.test.js` |
| 双向消息 | 签名、一次性配对、会话映射/显式接续、事件幂等、加密回复目标、安全内联附件、outbox | `agent-channel-gateway.test.js`、`agent-postgres-integration.test.js` |
| 能力与协作 | 授权能力目录、受限并行委派、协作状态可视化、结构化契约和一次修正 | `agent-capability-catalog.test.js`、`agent-collaboration-batch.test.js` |
| 多模态与项目上下文 | 受控网页检索、图片/TTS Provider、浏览器语音输入、资料包 ACL 快照 | `agent-web-search.test.js`、`agent-media-generation.test.js`、`agent-context-packs.test.js` |

## 发布前仍需由部署负责人执行的外部步骤

1. 在 PostgreSQL staging 运行应用启动迁移；确认 `202609200001_agent_channel_gateway` 与 `202609200002_agent_channel_gateway_target` 出现在迁移台账。
2. 配置 `DATA_ENCRYPTION_KEY`，为 Gateway/检索/媒体 Provider 创建凭据引用；禁止把密钥写入环境模板、渠道配置 JSON 或聊天内容。
3. 配置每个 Provider Origin 到任务级白名单；图片/TTS 的媒体 CDN Origin 也必须单独加入。未配置时工具保持不可见。
4. 用真实测试账号执行 PA-18 至 PA-22，并补充附件、渠道审批身份绑定和跨端接续；记录配对、乱序/重放、撤销、回复、超时和死信证据。
5. 以 `personal-agent-beta-evaluation-set.md` 执行至少 30 条人工任务和 10 条强制安全/故障用例；仅在样本量满足方案指标时报告成功率与有用率。

## 回滚

- 暂停或删除渠道绑定会立刻阻止新的 Gateway 入站；已入队投递按 outbox 状态人工处理。
- 停用媒体/搜索 Endpoint 后，相应工具不再出现在新 Run 的工具目录。
- 暂停个人 Skill、目标或记忆会阻止后续匹配/触发；历史审计与版本保留。
