# Enterprise Beta Release Checklist

- [ ] PostgreSQL staging migration applied and `agent-production-drill.js --confirm-staging` passes.
- [ ] Skill package signatures, dependency locks, supply-chain paths and strict sandbox failures are tested.
- [ ] Fixed evaluation suites pass before Skill/workflow publication.
- [ ] Rollout cohort is documented; representative users resolve the intended release; rollback is tested.
- [ ] Channel delivery test covers webhook, IM, email endpoint/SMTP, chunks, attachment metadata, retry and dead letter.
- [ ] Inbox approval, snooze, mute, release, budget, tool-error and dead-letter events are visible and auditable.
- [ ] Tenant scope, personal export/delete, field-level profile conflicts and cross-user reliability aggregation are tested.
- [ ] Restart, database outage, webhook replay, approval expiry, outbox duplicate, non-idempotent tool recovery and sandbox timeout drills are recorded.
- [ ] Metrics targets, operator ownership, rollback owner and manual takeover contact are documented.
