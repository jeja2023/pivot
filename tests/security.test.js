// 安全测试聚合入口：由 node:test 执行
require('./security-auth.test');
require('./security-mcp.test');
require('./security-rag.test');
require('./security-agent.test');
require('./security-chat.test');
require('./security-sqlite-write-queue.test');
require('./security-model-runtime.test');
require('./security-gpu-monitor.test');
require('./db-migration-snapshots.test');

require('./security-rag-debug-history.test');
require('./security-desktop-update.test');
require('./enterprise-deployment.test');
