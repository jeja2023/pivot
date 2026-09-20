# Product Scope Freeze and Acceptance Ledger

> 实现冻结版本：v0.1.154（2026-09-20）。发布证据见 [Personal Agent Beta 发布证据](personal-agent-beta-release-evidence.md)；30 条人工评测见 [Personal Agent Beta 评测集](personal-agent-beta-evaluation-set.md)。

## Frozen P0

- Personal profile and memory governance with explicit confirmation, versioning, export and deletion.
- Unified inbox for runs, approvals, failures, budget/tool/release events.
- Scheduled/Webhook active goals with dedupe, cooldown, budget and circuit breaker, including a signed natural-language draft confirmation flow.
- Result feedback and explainable reliability routing, including personal Skill match rationale.
- Versioned Skill/workflow validation, release, rollout and rollback.
- Paired bidirectional Gateway for a configured webhook or IM adapter, with encrypted outbound target reference and durable outbox delivery.
- Tenant/user scope enforcement and PostgreSQL-only persistence for Gateway state.

## P1/P2 sequencing

P1/P2 implementation now includes a governed personal capability catalog, bounded multi-Agent task groups, mobile approval, browser voice input, opt-in image/TTS Providers, controlled web search, selected knowledge-collection context packs, safe inline channel attachments, explicit cross-channel session continuation and Run-derived Skill drafts. Multiple production IM adapters, Provider contracts and trial metrics remain deployment acceptance work, not a bypass around P0 release gates.

## Acceptance evidence

Each item requires unit tests, PostgreSQL integration tests, security tests, failure drills, an audit log sample and a staging demonstration before being marked complete.
