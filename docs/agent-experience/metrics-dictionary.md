# Agent Experience Metrics Dictionary

| Metric | Definition | Source |
| --- | --- | --- |
| `agent_task_success_rate` | Completed runs / terminal runs | `agent_runs` |
| `agent_recovery_success_rate` | Recovered runs completed without duplicate side effect | `agent_events`, checkpoints |
| `agent_approval_median_minutes` | Median approval request to decision time | `agent_approval_requests` |
| `agent_tool_error_rate` | Error/denied tool calls / all tool calls | `agent_tool_calls` |
| `agent_active_on_time_rate` | Goal runs started within schedule tolerance | `agent_goals`, `agent_runs` |
| `agent_helpful_rate` | Ratings >= 4 / rated feedback | `agent_feedback` |
| `agent_channel_delivery_rate` | Delivered deliveries / queued deliveries | `agent_channel_deliveries` |
| `agent_release_rollout_error_rate` | Failed runs per release and rollout cohort | releases + run metadata |
| `agent_onboarding_completion_seconds` | 从首次打开设置到保存档案的时长；跳过单独计数 | 前端体验事件 + 审计日志 |
| `agent_first_task_success_rate` | 首次创建任务中完成的比例；按用户/任务类型分层 | `agent_runs` |
| `agent_memory_useful_rate` | 用户标记有用或抽检确认相关的记忆命中 / 被评价记忆命中 | memory usage + feedback |
| `agent_skill_match_rate` | 已验证个人 Skill 在后续相似任务中被服务端匹配的比例 | `agent_runs.metadata.skillMatchReason` |
| `agent_gateway_pair_success_rate` | 成功配对的外部身份 / 配对码提交身份 | `agent_channel_pairings` |
| `agent_gateway_inbound_dedupe_rate` | 被入站幂等键拒绝的重复事件 / 全部入站事件 | `agent_channel_inbound_events` |
| `agent_media_provider_success_rate` | 已获审批的图片/TTS Provider 成功调用 / 已执行调用 | tool ledger + Agent steps |
| `agent_context_pack_acl_denial_rate` | 因已撤销/无权集合被拒绝的资料包任务 / 资料包任务 | Run creation + RAG audit |

All dashboards must include tenant, user scope, tool version, task type, time window, sample count, and confidence where applicable.
