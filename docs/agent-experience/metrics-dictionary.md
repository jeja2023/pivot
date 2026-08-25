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

All dashboards must include tenant, user scope, tool version, task type, time window, sample count, and confidence where applicable.
