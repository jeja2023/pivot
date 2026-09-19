const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getAgentGovernanceMetricsSnapshot,
    recordDagCacheResult,
    recordDagNodeResult,
    recordWorkflowInvocationResult,
    recordWorkflowIterationItemResult,
    resetAgentGovernanceMetrics
} = require('../server/services/agent-governance-metrics');
const { appendAgentGovernanceMetrics } = require('../server/metrics');

test('工作流运行指标按低基数结果累积并输出 Prometheus 文本', () => {
    resetAgentGovernanceMetrics();
    recordDagNodeResult({ tool: 'workflow.template', status: 'completed' });
    recordDagCacheResult('hit');
    recordWorkflowInvocationResult({ status: 'completed' });
    recordWorkflowIterationItemResult({ status: 'error' });
    const snapshot = getAgentGovernanceMetricsSnapshot();
    assert.equal(snapshot.workflow.dagNodeTotal['workflow.template|completed'], 1);
    assert.equal(snapshot.workflow.cacheTotal.hit, 1);
    assert.equal(snapshot.workflow.invocationTotal.completed, 1);
    assert.equal(snapshot.workflow.iterationItemTotal.error, 1);
    const lines = [];
    appendAgentGovernanceMetrics(lines);
    const rendered = lines.join('\n');
    assert.match(rendered, /pivot_workflow_dag_node_total/);
    assert.match(rendered, /pivot_workflow_dag_cache_total/);
    assert.match(rendered, /pivot_workflow_invocation_total/);
    assert.match(rendered, /pivot_workflow_iteration_item_total/);
});
