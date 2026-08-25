# Pivot Agent Experience Delivery Ledger

This ledger is the executable scope record for the Hermes/OpenClaw-style Agent plan. Every item links to a code contract, data contract, verification command, owner role, and dependency.

| ID | Scope | Contract | Owner | Dependency | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P0-01 | Profile and memory governance | Profile/field versions, policy versions, memory source/usage | Runtime + Web | PostgreSQL migrations | `agent-personal-control.test.js` | Implemented |
| P0-02 | Unified inbox | Notifications, approvals, runs, evolution, budget/tool/release events | Runtime + Web | `agent_inbox_events` | Inbox integration tests | In progress |
| P0-03 | Goals and active runs | Timer/Webhook, dedupe, cooldown, budget, circuit breaker | Runtime | Agent Run + Outbox | Goal integration tests | Implemented |
| P0-04 | Governed capability release | Manifest, signature, dependencies, supply chain, sandbox, evaluation, release, rollout, rollback | Platform Security | Sandbox + Evaluation | Release security suite | In progress |
| P0-05 | Feedback and routing | User/tenant/tool-version/task-type signals with sample/confidence | Runtime | Tool ledger + feedback | Reliability tests | In progress |
| P0-06 | Data lifecycle | User export/delete, tenant boundary and audit | Platform | Enterprise access | Data lifecycle suite | In progress |
| P1-01 | Channel adapter | Webhook/IM/email delivery, chunking, attachments, retry, dead letter | Platform + Integrations | Credential references + Outbox | Channel adapter suite | In progress |
| P1-02 | File/database triggers | Unified goal event adapters with stable-write/watermark semantics | Runtime | Existing trigger pollers | Trigger fault suite | Existing partial |
| P1-03 | Admin quality | Reliability, success, recovery, approval, latency dashboards | QA + Ops | Metrics/event schema | Dashboard contract suite | Pending |
| P1-04 | Mobile approval | Responsive approval actions over same server authority | Web | Inbox + approval API | Playwright mobile | Pending |
| P2-01 | Skill market/shared catalog | Organization-scoped releases and discovery | Platform | Tenant release model | Catalog security suite | Pending |
| P2-02 | Multi-Agent collaboration | Explicit parent/child runs and control mailbox | Runtime | Existing AgentControl | Collaboration fault suite | Existing partial |

## Release conditions

- A capability is runtime-visible only through a `published` release selected by rollout policy.
- Failed signature, dependency, supply-chain, sandbox, or fixed-evaluation checks block publication.
- Every release has an operator, source version, validation record, rollout rule, and rollback target.
- Every channel delivery is idempotent, bounded, retryable, and dead-lettered after the configured attempt limit.
- Tenant and user scope are checked before reads, writes, delivery, evaluation, and reliability aggregation.
