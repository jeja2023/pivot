/* global activeAgentRunId */
/* DAG 检查器运行时状态感知与断点续跑、行内变量补全动作 */
(function () {
    function canRerunNode(node, { getRunStates } = {}) {
        const runStates = typeof getRunStates === 'function' ? getRunStates() : new Map();
        const nodeRunState = runStates?.get?.(String(node?.id));
        const currentRunId = (typeof activeAgentRunId !== 'undefined' ? activeAgentRunId : '') || window.Pivot?.legacy?.currentAgentRunId || '';
        return Boolean(nodeRunState && ['error', 'cancelled', 'continued_error'].includes(nodeRunState.status) && currentRunId);
    }

    function renderNodeRerunButton(node, { getRunStates, dagEscapeAttr } = {}) {
        if (!canRerunNode(node, { getRunStates })) return '';
        const escape = typeof dagEscapeAttr === 'function' ? dagEscapeAttr : s => String(s || '').replace(/"/g, '&quot;');
        return `<button type="button" class="btn-secondary pivot-dag-rerun-node-btn" data-pivot-dag-rerun-node="${escape(node.id)}" title="保留上游已成功节点的快取，从本节点开始断点续跑">从本节点断点续跑</button>`;
    }

    function bindNodeRerunAction(inspector, { node } = {}) {
        inspector?.querySelector?.('[data-pivot-dag-rerun-node]')?.addEventListener('click', () => {
            const runId = (typeof activeAgentRunId !== 'undefined' ? activeAgentRunId : '') || window.Pivot?.legacy?.currentAgentRunId || '';
            if (runId && typeof window.Pivot?.legacy?.rerunAgentDagNode === 'function') {
                window.Pivot.legacy.rerunAgentDagNode(runId, node.id);
            }
        });
    }

    function checkVariableAutocompleteTrigger(input, { nodeId, getNodes, getTools, showVariablePicker } = {}) {
        if (typeof input?.value === 'string' && typeof input?.selectionStart === 'number') {
            const cursor = input.selectionStart;
            const textBefore = input.value.slice(0, cursor);
            if (textBefore.endsWith('{{') && typeof showVariablePicker === 'function') {
                showVariablePicker({
                    anchorEl: input,
                    targetInput: input,
                    nodeId,
                    nodes: typeof getNodes === 'function' ? getNodes() : [],
                    tools: typeof getTools === 'function' ? getTools() : []
                });
            }
        }
    }

    if (typeof window !== 'undefined' && window.Pivot?.registerModule) {
        window.Pivot.registerModule('agent.dagInspectorRuntimeActions', {
            canRerunNode,
            renderNodeRerunButton,
            bindNodeRerunAction,
            checkVariableAutocompleteTrigger
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            canRerunNode,
            renderNodeRerunButton,
            bindNodeRerunAction,
            checkVariableAutocompleteTrigger
        };
    }
})();
