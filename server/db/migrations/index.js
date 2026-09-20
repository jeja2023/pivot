'use strict';

// 主数据库已收敛为 PostgreSQL；
// 表结构由 pg-schema.snapshot.json 管理，以下仅保留对已部署 PG 库有效的
// 约束、数据回填和控制面演进迁移。
const migrationModules = [
    require('./autonomous-runtime-foundations'),
    require('./workflow-credential-user-visibility'),
    require('./chat-agent-run-message-link'),
    require('./personal-agent'),
    require('./personal-agent-control-plane'),
    require('./agent-production-control-plane'),
    require('./agent-skill-governance'),
    require('./agent-artifact-delivery'),
    require('./agent-standalone-artifacts'),
    require('./agent-artifact-cas-refcounts'),
    require('./agent-local-connector'),
    require('./agent-learning'),
    require('./official-writing-documents'),
    require('./agent-goal-dispatch-lease'),
    require('./agent-context-audit-contract'),
    require('./model-tool-call-capabilities'),
    require('./rag-operations-observability'),
    require('./rag-precision-signals'),
    require('./auth-token-version'),
    require('./approval-callback-binding'),
    require('./api-key-scope-expiry'),
    require('./agent-step-unique-index'),
    require('./rag-chunk-locations'),
    require('./agent-run-retry-schedule'),
    require('./drop-redundant-log-indexes'),
    require('./refresh-token-device-binding'),
    require('./message-context-token-count'),
    require('./agent-channel-delivery-claims'),
    require('./refresh-token-reuse-detection'),
    require('./model-usage-events-fkey-soften'),
    require('./api-call-logs-fkey-soften'),
    require('./agent-run-metadata-jsonb-compatibility'),
    require('./agent-dag-reuse-provenance'),
    require('./agent-dag-output-refcounts'),
    require('./agent-evaluation-case-snapshots'),
    require('./agent-workflow-invocations'),
    require('./workflow-api-operations'),
    require('./agent-run-concurrency-leases'),
    require('./agent-dag-error-info'),
    require('./agent-channel-gateway-migrations'),
    require('./agent-workflow-iteration-items'),
    require('./agent-workflow-trigger-events'),
    require('./agent-workflow-release-review'),
    require('./tool-library-product-control-plane'),
    require('./chat-adaptive-routing'),
    require('./knowledge-product-foundation'),
    require('./knowledge-product-governance'),
    require('./knowledge-database-query-templates')
];

module.exports = migrationModules
    .flat()
    .filter(migration => typeof migration?.upPg === 'function');
