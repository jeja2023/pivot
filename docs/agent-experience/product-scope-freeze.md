# Product Scope Freeze and Acceptance Ledger

## Frozen P0

- Personal profile and memory governance with explicit confirmation, versioning, export and deletion.
- Unified inbox for runs, approvals, failures, budget/tool/release events.
- Scheduled/Webhook active goals with dedupe, cooldown, budget and circuit breaker.
- Result feedback and explainable reliability routing.
- Versioned Skill/workflow validation, release, rollout and rollback.
- Tenant/user scope enforcement and PostgreSQL-only persistence.

## P1/P2 sequencing

P1 adds file/database goal adapters, one enterprise IM adapter, admin quality dashboards and mobile approval. P2 adds shared catalog/market, multiple channels, multi-Agent orchestration and long-term goal reasoning. No item may bypass P0 release gates or policy enforcement.

## Acceptance evidence

Each item requires unit tests, PostgreSQL integration tests, security tests, failure drills, an audit log sample and a staging demonstration before being marked complete.
