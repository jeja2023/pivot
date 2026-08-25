# Security Regression Matrix

| Area | Regression |
| --- | --- |
| Skill | Invalid signature, missing lockfile, path traversal, lifecycle script, sandbox timeout, failing fixed test, unpublished runtime lookup |
| Workflow | Side-effect in preview, missing evaluation gate, unauthorized release scope, stale dependency binding, rollout mismatch, rollback |
| Channel | SSRF/private host, invalid credential reference, oversized attachment, chunk duplication, retry storm, dead letter, approval interaction |
| Goals | Webhook replay/signature, duplicate event, file path outside roots, write SQL, budget/cooldown/failure circuit |
| Data | User/tenant cross-read, field version conflict, sensitive memory, export/delete audit, reliability minimum sample |
| Runtime | Restart, checkpoint replay, approval re-request, outbox duplicate, provider timeout, database outage |

The matrix is executable through `tests/agent-production-control.test.js`, `tests/agent-fault-drills.test.js`, `tests/agent-postgres-integration.test.js`, existing security suites, and the staging drills in `scripts/agent-production-drill.js` and `scripts/agent-load-drill.js`.
