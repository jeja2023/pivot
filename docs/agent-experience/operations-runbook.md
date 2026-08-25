# Agent Experience Operations Runbook

## PostgreSQL migration

Run the normal PostgreSQL bootstrap. Verify `schema_migrations` contains `202608250001_agent_production_control_plane`, then inspect the new release, delivery, and inbox tables.

For disaster recovery, restore only into a staging database with `node scripts/restore-pg-backup.js <backup.dump> --confirm-staging`; validate the schema, migration ledger, release gates, and a representative Agent Run before any production cutover.

## Channel delivery incident

1. Query `agent_channel_deliveries` for `queued` and `dead_letter` rows.
2. Verify binding status and credential reference; never copy a secret into logs.
3. Retry only idempotent rows after endpoint health is restored.
4. Keep dead-letter rows for manual review and audit.

## Release rollback

1. Stop further rollout by setting the release status or rollout percent through the authorized API.
2. Call the release rollback endpoint.
3. Confirm runtime resolution selects the previous published release for a representative user and unit.
4. Preserve validation and release records for audit.

## Recovery drills

Exercise service restart, database short outage, webhook replay, approval expiry, outbox redelivery, sandbox failure, and non-idempotent tool recovery on a staging PostgreSQL database before production rollout.
