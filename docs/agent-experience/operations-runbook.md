# Agent Experience Operations Runbook

## PostgreSQL migration

Run the normal PostgreSQL bootstrap. Verify `schema_migrations` contains `202608250001_agent_production_control_plane`, `202609200001_agent_channel_gateway`, and `202609200002_agent_channel_gateway_target`, then inspect the new release, delivery, inbox, pairing, session and inbound-event tables.

For disaster recovery, restore only into a staging database with `node scripts/restore-pg-backup.js <backup.dump> --confirm-staging`; validate the schema, migration ledger, release gates, and a representative Agent Run before any production cutover.

## Channel delivery incident

1. Query `agent_channel_deliveries` for `queued` and `dead_letter` rows.
2. Verify binding status and credential reference; never copy a secret into logs.
3. Retry only idempotent rows after endpoint health is restored.
4. Keep dead-letter rows for manual review and audit.

## Bidirectional Gateway incident

1. Pause the affected binding before rotating its credential; do not delete inbound-event evidence first.
2. Verify the external request timestamp and HMAC signature before inspecting the pairing/session row.
3. A `revoked` pairing or session must remain rejected; issue a new pairing code instead of changing a stored external identity.
4. `outbound_target_encrypted` and outbox `outboundTargetEncrypted` are encrypted references. Never attempt to copy their contents into logs or an external console.
5. After endpoint recovery, retry only the queued/dead-letter delivery. Do not replay its originating Agent Run.

## Search and media Provider incident

1. Disable or clear the Provider Endpoint to remove the tool from new Run catalogs while investigating.
2. Check the task-level `allowed_origins` includes the Provider and, for media, the returned CDN Origin.
3. Keep `DATA_ENCRYPTION_KEY` and Provider credentials in credential references; do not place either in Agent task text or channel config JSON.

## Release rollback

1. Stop further rollout by setting the release status or rollout percent through the authorized API.
2. Call the release rollback endpoint.
3. Confirm runtime resolution selects the previous published release for a representative user and unit.
4. Preserve validation and release records for audit.

## Recovery drills

Exercise service restart, database short outage, webhook replay, approval expiry, outbox redelivery, sandbox failure, and non-idempotent tool recovery on a staging PostgreSQL database before production rollout.
