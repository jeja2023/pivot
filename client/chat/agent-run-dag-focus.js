// 运行详情到工作流快照的节点定位。
/* eslint-disable no-undef */
async function focusAgentDagSnapshotNode(nodeId) {
    const run = currentRunDetailRecord;
    const metadata = typeof agentRunMetadata === 'function' ? agentRunMetadata(run) : {};
    const dagSpec = metadata.dagSpec || metadata.dag || null;
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    if (!nodes.some(node => String(node?.id || '') === String(nodeId || ''))) {
        showToast('当前运行记录未保留可定位的工作流快照。', 'warning');
        return false;
    }
    const confirmed = typeof window.Pivot?.legacy?.showConfirm === 'function'
        ? await window.Pivot.legacy.showConfirm('打开运行快照', '将打开本次运行的独立草稿快照以定位该节点；当前未保存的画布修改可能被替换。')
        : true;
    if (!confirmed) return false;
    const openWorkbench = window.Pivot?.moduleApi?.('workspaces.navigation')?.openAgentDagWorkbench;
    if (typeof openWorkbench !== 'function') {
        showToast('工作流编排器尚未就绪。', 'error');
        return false;
    }
    await openWorkbench({
        draft: {
            name: `运行快照：${run?.title || run?.id || '工作流'}`.slice(0, 100),
            description: '从运行详情打开的快照，仅用于定位和修复配置。',
            dagSpec
        }
    });
    const focused = window.Pivot?.moduleApi?.('agent.workflowEditor')?.focusAgentDagNode?.(nodeId);
    if (!focused) showToast('工作流快照已打开，但未找到对应节点。', 'warning');
    return Boolean(focused);
}
