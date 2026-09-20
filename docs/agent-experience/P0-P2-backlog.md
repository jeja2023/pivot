# Pivot Agent Experience Delivery Ledger

> 2026-09-20 更新：本台账以根目录《Pivot达到Hermes个人Agent体验改造与落地方案.md》与 [Personal Agent Beta 发布证据](personal-agent-beta-release-evidence.md) 为状态源。`Implemented` 表示代码、迁移和自动测试已经闭环；真实渠道、试点样本和运营指标仍须按发布证据执行，不能仅凭代码改为“已发布”。

This ledger is the executable scope record for the Hermes/OpenClaw-style Agent plan. Every item links to a code contract, data contract, verification command, owner role, and dependency.

| ID | Scope | Contract | Owner | Dependency | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P0-01 | Profile and memory governance | Profile/field versions, policy versions, memory source/usage | Runtime + Web | PostgreSQL migrations | `agent-personal-control.test.js`、`personal-workbench.test.js` | Implemented |
| P0-02 | Unified inbox | Notifications, approvals, runs, evolution, budget/tool/release events | Runtime + Web | `agent_inbox_events` | Inbox integration tests | Implemented |
| P0-03 | Goals and active runs | Timer/Webhook, dedupe, cooldown, budget, circuit breaker | Runtime | Agent Run + Outbox | `agent-goal-drafts.test.js`、目标租约集成测试 | Implemented |
| P0-04 | Governed capability release | Manifest, signature, dependencies, supply chain, sandbox, evaluation, release, rollout, rollback | Platform Security | Sandbox + Evaluation | Release security suite | In progress |
| P0-05 | Feedback and routing | User/tenant/tool-version/task-type signals with sample/confidence | Runtime | Tool ledger + feedback | Reliability + Skill match tests | Implemented |
| P0-06 | Data lifecycle | User export/delete, tenant boundary and audit | Platform | Enterprise access | Data lifecycle suite | In progress |
| P1-01 | Channel adapter | Webhook/IM/email delivery, chunking, attachments, retry, dead letter | Platform + Integrations | Credential references + Outbox | `agent-channel-gateway.test.js`、PostgreSQL gateway integration | Implemented; real platform acceptance pending |
| P1-02 | File/database triggers | Unified goal event adapters with stable-write/watermark semantics | Runtime | Existing trigger pollers | Trigger fault suite | Existing partial |
| P1-03 | Admin quality | Reliability, success, recovery, approval, latency dashboards | QA + Ops | Metrics/event schema | Dashboard contract suite | Existing; beta sample collection pending |
| P1-04 | Mobile approval | Responsive approval actions over same server authority | Web | Inbox + approval API | `mobile-approval-contract.test.js` | Implemented |
| P2-01 | Skill market/shared catalog | Organization-scoped releases and discovery | Platform | Tenant release model | `agent-capability-catalog.test.js` | Implemented (受控目录，不自动安装社区包) |
| P2-02 | Multi-Agent collaboration | Explicit parent/child runs and control mailbox | Runtime | Existing AgentControl | `agent-collaboration-batch.test.js` | Implemented |
| P2-03 | Multimodal and context packs | Browser voice input, controlled image/TTS Provider, selected knowledge packs | Runtime + Web | Network policy + Knowledge ACL | `agent-media-generation.test.js`、`agent-context-packs.test.js` | Implemented; Provider staging acceptance pending |

## Release conditions

- A capability is runtime-visible only through a `published` release selected by rollout policy.
- Failed signature, dependency, supply-chain, sandbox, or fixed-evaluation checks block publication.
- Every release has an operator, source version, validation record, rollout rule, and rollback target.
- Every channel delivery is idempotent, bounded, retryable, and dead-lettered after the configured attempt limit.
- Tenant and user scope are checked before reads, writes, delivery, evaluation, and reliability aggregation.
