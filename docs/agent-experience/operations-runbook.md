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

## Capability Worker isolation drill

After a signed Worker image has been preloaded on every staging node, run `npm run preflight:capability-workers` and then `npm run drill:capability-workers -- --confirm-staging` separately on Windows Docker and Linux Worker nodes. Attach the resulting redacted JSON to the domain acceptance evidence. The drill is intentionally blocked in production; do not weaken it or use an unpinned/tagged image to obtain a passing result.


## 浏览器控制的网络与会话排查

受控浏览器使用本地临时网络代理，按任务或本机授权的站点和端口检查页面及后台工作线程的连接；禁止 WebRTC，Chromium 禁用 QUIC。依赖这些能力的网站可能无法正常运行。不得将该代理视为替代容器、主机防火墙或生产网络隔离。

Agent 浏览器会话绑定创建任务；网络策略变化后需要创建新会话。写操作后若出现待人工恢复，先核实旧执行器已停止和网站实际结果，再按提示确认重新观察，不自动重放操作。本机浏览器同一隔离配置正在执行任务时，后续操作返回忙状态，等待后重试。

默认功能使用 DOM 和无障碍目标定位；视觉坐标回调仅是可选扩展钩子，未配置真实视觉定位器时不会自动启用。Windows 可见 Chromium 与 Microsoft Edge、隔离 PostgreSQL 和本地测试站点的自动回归不能替代生产网络、真实网站、Firefox 和 Linux 桌面验收。
