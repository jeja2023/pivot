/* 智能体运行详情中的子工作流调用实例展示。 */
(function () {
function renderAgentWorkflowInvocationList(invocations = []) {
    const rows = Array.isArray(invocations) ? invocations : [];
    if (!rows.length) return '';
    const statusText = status => ({ completed: '已完成', running: '执行中', error: '失败' }[String(status || '').toLowerCase()] || String(status || '未知'));
    return `
        <section class="agent-run-invocations">
            <div class="agent-tool-section-head compact"><strong>子工作流调用</strong><span>${rows.length} 次</span></div>
            <div class="agent-step-list">
                ${rows.map(item => `<details class="agent-step-item"><summary><span><strong>${agentEscape(item.caller_node_key || '子工作流')}</strong><small>工作流 ${agentEscape(item.workflow_id)} · 版本 ${agentEscape(item.workflow_version || '-')}</small></span><em class="agent-step-status ${agentEscape(String(item.status || ''))}">${agentEscape(statusText(item.status))}</em></summary><div class="agent-step-detail"><dl><div><dt>调用路径</dt><dd>${agentEscape(item.invocation_path || '-')}</dd></div>${item.parent_invocation_id ? `<div><dt>父调用</dt><dd>${agentEscape(item.parent_invocation_id)}</dd></div>` : ''}${item.error_message ? `<div><dt>失败原因</dt><dd>${agentEscape(item.error_message)}</dd></div>` : ''}</dl>${item.output_json ? `<pre>${agentEscape(JSON.stringify(item.output_json, null, 2))}</pre>` : ''}</div></details>`).join('')}
            </div>
        </section>
    `;
}
function appendAgentWorkflowInvocationList(container, invocations = []) {
    const markup = renderAgentWorkflowInvocationList(invocations);
    if (!container || !markup) return;
    const host = document.createElement('div');
    PivotSafeHtml.setHtml(host, markup);
    while (host.firstChild) container.appendChild(host.firstChild);
}
window.Pivot.registerModule('agent.runInvocations', { appendAgentWorkflowInvocationList, renderAgentWorkflowInvocationList });
})();
