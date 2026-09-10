const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentWorkbenchSandbox } = require('./security-helpers');

test('工作流执行步骤详情与结果详情保持展开状态（不自动折叠）', async (_t) => {
    const sandbox = createAgentWorkbenchSandbox();
    const runId = 'test-run-workflow-123';

    // 1. 验证 agentDagNodeMarkup 为运行中或异常节点默认展开，且包含 data-disclosure-key
    const runningNodeHtml = sandbox.agentDagNodeMarkup({
        node_key: 'step_fetch',
        title: '获取订单数据',
        tool_name: 'db.run_readonly_query',
        status: 'running',
        depends_on: [],
        condition: 'success',
        attempt_count: 1,
        duration_ms: 120,
        input: { query: 'SELECT * FROM orders' }
    }, 0, runId);

    assert.match(runningNodeHtml, /data-dag-node-key="step_fetch"/);
    assert.match(runningNodeHtml, /data-disclosure-key="dag-node-step_fetch"/);
    assert.match(runningNodeHtml, /<details class="agent-dag-node-details"[^>]*\sopen>/);
    assert.match(runningNodeHtml, /data-disclosure-key="dag-tech-step_fetch"/);
    assert.match(runningNodeHtml, /data-disclosure-key="dag-input-step_fetch"/);

    // 2. 模拟用户或运行过程中记录展开状态
    sandbox.Pivot.legacy.setAgentRunDisclosureOpen(runId, 'dag-node-step_fetch', true);
    sandbox.Pivot.legacy.setAgentRunDisclosureOpen(runId, 'dag-tech-step_fetch', true);
    sandbox.Pivot.legacy.setAgentRunDisclosureOpen(runId, 'dag-input-step_fetch', true);
    sandbox.Pivot.legacy.setAgentRunDisclosureOpen(runId, 'dag-output-step_fetch', true);

    // 3. 核心契约：当节点从 running 变为 completed 后，重新生成 HTML 绝不自动折叠！
    const completedNodeHtml = sandbox.agentDagNodeMarkup({
        node_key: 'step_fetch',
        title: '获取订单数据',
        tool_name: 'db.run_readonly_query',
        status: 'completed',
        depends_on: [],
        condition: 'success',
        attempt_count: 1,
        duration_ms: 450,
        input: { query: 'SELECT * FROM orders' },
        output: { rows: [{ id: 1, amount: 100 }] }
    }, 0, runId);

    // 节点本身必须保持 open
    assert.match(completedNodeHtml, /<details class="agent-dag-node-details"[^>]*\sopen>/);
    // 技术信息必须保持 open
    assert.match(completedNodeHtml, /<details class="agent-dag-node-technical"[^>]*\sopen>/);
    // 输入数据必须保持 open
    assert.match(completedNodeHtml, /<details[^>]*data-disclosure-key="dag-input-step_fetch"[^>]*\sopen>/);
    // 节点输出必须保持 open
    assert.match(completedNodeHtml, /<details[^>]*data-disclosure-key="dag-output-step_fetch"[^>]*\sopen>/);

    // 4. 用户若主动折叠某节点，记录为 false，则应尊重用户意愿保持折叠
    sandbox.Pivot.legacy.setAgentRunDisclosureOpen(runId, 'dag-node-step_fetch', false);
    const userClosedNodeHtml = sandbox.agentDagNodeMarkup({
        node_key: 'step_fetch',
        title: '获取订单数据',
        tool_name: 'db.run_readonly_query',
        status: 'completed',
        depends_on: [],
        condition: 'success',
        attempt_count: 1,
        duration_ms: 450
    }, 0, runId);
    assert.doesNotMatch(userClosedNodeHtml, /<details class="agent-dag-node-details"[^>]*\sopen>/);

    // 5. 步骤详情原始数据与追踪信息保持展开状态
    sandbox.Pivot.legacy.setAgentRunDisclosureOpen(runId, 'step-raw-1', true);
    const stepHtml = sandbox.agentStepMarkup({
        step_index: 1,
        status: 'completed',
        tool_name: 'custom.fetch',
        output: '{"raw":"payload"}'
    }, runId);
    assert.match(stepHtml, /data-disclosure-key="step-raw-1"/);
    assert.match(stepHtml, /<details class="agent-step-raw"[^>]*\sopen>/);

    // 6. 任务最终结果原始数据保持展开状态
    sandbox.Pivot.legacy.setAgentRunDisclosureOpen(runId, 'final-result-raw', true);
    const finalHtml = sandbox.renderAgentFinalAnswer({
        summary: '任务完成',
        details: '详细记录'
    }, runId);
    assert.match(finalHtml, /data-disclosure-key="final-result-raw"/);
    assert.match(finalHtml, /<details class="agent-result-raw"[^>]*\sopen>/);
});

test('captureAgentRunDisclosureState 与 restoreAgentRunDisclosureState 支持完整细节元素', () => {
    const sandbox = createAgentWorkbenchSandbox();
    const runId = 'test-run-dom-456';

    const mockDetails = [
        { tagName: 'DETAILS', dataset: { disclosureKey: 'dag-node-1' }, open: true, classList: { contains: () => false }, querySelector: () => null },
        { tagName: 'DETAILS', dataset: { disclosureKey: 'dag-tech-1' }, open: true, classList: { contains: () => false }, querySelector: () => null },
        { tagName: 'DETAILS', dataset: { disclosureKey: 'dag-input-1' }, open: false, classList: { contains: () => false }, querySelector: () => null }
    ];

    const mockContainer = {
        querySelector(_sel) {
            return null;
        },
        querySelectorAll(sel) {
            if (sel === 'details') return mockDetails;
            return [];
        }
    };

    sandbox.captureAgentRunDisclosureState(mockContainer, runId);
    assert.strictEqual(sandbox.isAgentRunDisclosureOpen(runId, 'dag-node-1'), true);
    assert.strictEqual(sandbox.isAgentRunDisclosureOpen(runId, 'dag-tech-1'), true);
    assert.strictEqual(sandbox.isAgentRunDisclosureOpen(runId, 'dag-input-1'), false);

    // 恢复到另一个容器
    const newDetails = [
        { tagName: 'DETAILS', dataset: { disclosureKey: 'dag-node-1' }, open: false, classList: { contains: () => false }, querySelector: () => null },
        { tagName: 'DETAILS', dataset: { disclosureKey: 'dag-tech-1' }, open: false, classList: { contains: () => false }, querySelector: () => null }
    ];
    const newContainer = {
        querySelector: () => null,
        querySelectorAll: (sel) => sel === 'details' ? newDetails : []
    };

    sandbox.restoreAgentRunDisclosureState(newContainer, runId);
    assert.strictEqual(newDetails[0].open, true);
    assert.strictEqual(newDetails[1].open, true);
});
