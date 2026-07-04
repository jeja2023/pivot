# Pivot Optimization And Extension Roadmap

This document records optimization work that is intentionally staged instead of forced into one risky rewrite.

## Release Snapshot

- v0.0.190 (2026-07-04) 收口系统监控 AI 并发口径：区分全局保存配置上限与 GPU 临时保护下的当前有效上限，保存全局参数后清理监控摘要缓存，并补充并发/GPU/运行时设置回归测试。
- v0.0.189 (2026-07-04) 收口智能体“能力与结果”弹窗滚动问题：可用工具与结果沉淀改为独立受限面板，旧的 `overflow: visible` 兼容规则不再作用于弹窗，并通过 Playwright 布局指标与 `npm run check` 验证。
- v0.0.188 (2026-07-03) completes the actionable follow-up pass: `chat.ui` / `chat.attachments` module migration, stored RAG debug history and observability warnings, runnable Playwright E2E smoke tests, desktop update feed policy validation, and enterprise/multi-node schema plus provider placeholders.
- v0.0.187 (2026-07-03) completes the second-stage architecture pass: chat orchestration services, agent run state machine, RAG retrieval score and queue diagnostics, frozen `window.*` baseline guard, permission capability matrix, and deployment profile contract.
- v0.0.186 (2026-07-03) shipped the completed guardrails from the full-project optimization pass: guarded uploads, safe outbound HTTP, runtime settings cache invalidation, agent lock renewal, chat observability, Electron origin hardening, `Pivot.modules` migration helpers, safe HTML rendering, and CI checks for raw `innerHTML` usage.
- Remaining frontend state work should continue feature by feature: expose new APIs through `Pivot.exposeModule()`, move callers to `Pivot.modules.*`, then remove legacy `window.*` aliases once references are gone.

## Completed Guardrails

- Uploads use a shared guarded Multer wrapper with multipart limits, file-count limits, aborted-request cleanup, and magic-byte validation for both chat attachments and RAG documents.
- Server-side JSON HTTP calls are routed through `safe-http-client` or `model-forwarder`, which enforce SSRF checks, restricted agents, timeouts, `proxy: false`, and JSON-only payloads.
- Runtime settings use a short-lived in-memory snapshot and invalidate after admin saves.
- Agent queue workers renew running locks, validate run status transitions, record retry reasons, and expose active-run and oldest-queue-age metrics.
- Chat generation is split into preflight, context assembly, model stream, and persistence services while emitting observability traces for slow or failed requests.
- RAG debug query responses expose chunk ids, dense/fused/FTS/MMR score components, selected chunks, hybrid weights, applied scope, and index queue state; debug queries are now stored in `rag_debug_queries` and surfaced in the debug modal history.
- 智能体“能力与结果”弹窗内容已使用受限面板，长工具列表和结果沉淀列表会在弹窗内滚动，不再向外撑开视口。
- Frontend code can migrate from loose `window.*` globals into `Pivot.registerModule()` / `Pivot.getModule()` incrementally; `chat.ui` and `chat.attachments` now publish module APIs with legacy global aliases during migration.
- Chat frontend rendering routes raw HTML updates through `PivotSafeHtml.setHtml()`, `npm run check:safe-html` blocks raw `innerHTML`, and `npm run check:window-globals` blocks new legacy `window.*` exposure.
- Permission capability payloads now expose policy object types, data classification levels, and organization/team placeholders.
- Deployment profile payloads describe SQLite WAL single-node defaults, provider contract status, and the Postgres/object-storage/distributed-queue/distributed-lock prerequisites for multi-node mode.
- CI uses `npm run audit:policy` so new high/critical advisories fail while known no-fix `form-data` and `multer` advisories remain documented exceptions.
- E2E smoke coverage has a runnable Playwright path through `npm run test:e2e`; `npm run check:e2e-smoke` keeps the E2E config, spec, dependency, and runner script present in lightweight checks.

## Next Architecture Milestones

1. Chat orchestration tests
   - Add route-level tests around quota rejection, RAG hits, memory hits, stream failure, and context trimming.
   - Keep the route as a thin SSE transport layer as more model/tool transports are added.

2. RAG quality and operations
   - Add stored debug history and embedding latency trend charts.
   - Add per-collection retrieval presets for legal, regulations, official writing, and data-analysis workloads.
   - Surface retrieval diagnostics in the admin observability view, not only the debug modal.

3. Enterprise persistence path
   - Implement the persistence adapter before adding PostgreSQL for sessions, audit logs, agent runs, and observability events.
   - Move uploads and generated artifacts behind an object-storage adapter before multi-node deployment.
   - Replace in-process locks and queues with distributed providers when more than one server instance is enabled.

4. Permission expansion
   - Add organization/team ownership tables for models, RAG collections, MCP services, and agent workflows.
   - Implement policy objects for model usage, tool approval, data classification, retention, and audit export execution.
   - Keep super-admin break-glass access auditable and disabled by default for tenant-owned secrets.

5. Frontend hardening
   - Move feature files into `Pivot.registerModule()` one workspace at a time.
   - Continue replacing legacy `window.*` exports with `Pivot.exposeModule()` one workspace at a time, then remove aliases after callers move to `Pivot.modules.*`.
   - Expand Playwright coverage beyond the current smoke path to login, chat streaming, upload, settings, RAG document indexing, and core workspaces.

6. Desktop distribution
   - Keep Electron sandbox enabled by default.
   - Configure `allowedExternalOrigins` for trusted documentation/update domains.
   - Use a signed update feed in production and keep auto-update disabled until the feed URL is controlled.
