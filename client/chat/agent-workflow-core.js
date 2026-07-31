// Agent 工作流状态、文本与抽屉辅助函数。
/* eslint-disable no-undef */
function getAgentWorkflowText() {
    return document.getElementById('agent-dag-spec')?.value.trim() || '';
}

function parseAgentWorkflowText(raw = getAgentWorkflowText()) {
    if (raw == null || raw === '') return { nodes: [] };
    if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) return { nodes: [] };
        return JSON.parse(text);
    }
    if (Array.isArray(raw)) return { nodes: raw };
    if (typeof raw === 'object') return raw;
    throw new Error('Invalid workflow JSON payload.');
}

function summarizeAgentDagSpec(raw = getAgentWorkflowText()) {
    try {
        const parsed = parseAgentWorkflowText(raw);
        const spec = Array.isArray(parsed) ? { nodes: parsed } : (parsed && typeof parsed === 'object' ? parsed : { nodes: [] });
        const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
        const executableNodes = nodes.filter(node => String(node?.tool || '').trim());
        return {
            valid: true,
            spec: { ...spec, nodes },
            nodeCount: nodes.length,
            executableNodeCount: executableNodes.length
        };
    } catch (e) {
        return {
            valid: false,
            spec: { nodes: [] },
            nodeCount: 0,
            executableNodeCount: 0,
            error: e
        };
    }
}

function updateAgentWorkflowRunUi() {
    renderAgentWorkflowLifecycle();
    refreshAgentDagInputsPanel();
}

function renderAgentWorkflowLifecycle() {
    const target = document.getElementById('agent-workflow-lifecycle');
    if (!target) return;
    const workflow = selectedAgentWorkflow();
    const draftSummary = summarizeAgentDagSpec();
    const draftMatchesSaved = workflow ? currentWorkflowMatchesSelected(workflow) : false;
    const structureText = draftSummary.valid ? '' : '结构需修正';
    const saveText = workflow
        ? (draftMatchesSaved ? '已保存' : '有未保存修改')
        : '未保存';
    const publishedText = workflow?.published_version
        ? `已发布 v${workflow.published_version}`
        : '未发布';
    const state = !draftSummary.valid
        ? 'is-error'
        : (!draftMatchesSaved ? 'is-draft' : (workflow?.published_version ? 'is-ready' : ''));
    const statusTitle = [structureText, saveText, publishedText].filter(Boolean).join(' · ');
    const primaryText = structureText || saveText;
    const secondarySaveText = structureText ? `<em>${agentEscape(saveText)}</em>` : '';
    PivotSafeHtml.setHtml(target, `
        <span class="agent-workflow-lifecycle-summary ${state}" title="${agentEscapeAttr(statusTitle)}">
            <span class="agent-workflow-status-dot" aria-hidden="true"></span>
            <strong>${agentEscape(primaryText)}</strong>
            ${secondarySaveText}
            <em>${agentEscape(publishedText)}</em>
        </span>
    `);
}

function writeAgentWorkflowText(value) {
    const textarea = document.getElementById('agent-dag-spec');
    if (!textarea) return;
    textarea.value = typeof value === 'string' ? value : JSON.stringify(value || { nodes: [] }, null, 2);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    updateAgentWorkflowRunUi();
}

function openAgentDagJsonModal() {
    const modal = document.getElementById('agent-dag-json-modal');
    const textarea = document.getElementById('agent-dag-spec');
    if (!modal || !textarea) return;
    modal.classList.remove('hidden');
    textarea.focus();
}

function closeAgentDagJsonModal() {
    document.getElementById('agent-dag-json-modal')?.classList.add('hidden');
}

function syncAgentDagJsonToCanvas() {
    if (dagEditorInstance?.syncFromJson?.()) {
        updateAgentWorkflowRunUi();
        showToast('JSON 已同步到画布', 'success');
        closeAgentDagJsonModal();
    }
}

function updateAgentDagNodeDrawer(node) {
    const drawer = document.getElementById('agent-dag-node-drawer');
    const title = document.getElementById('agent-dag-node-drawer-title');
    const subtitle = document.getElementById('agent-dag-node-drawer-subtitle');
    if (!drawer) return;
    const isOpen = Boolean(node);
    drawer.classList.toggle('hidden', !isOpen);
    drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (title) title.textContent = node?.title || node?.id || '节点配置';
    if (subtitle) subtitle.textContent = node
        ? `${node.id}${node.tool ? ` · ${node.tool}` : ''}`
        : '';
}

function closeAgentDagNodeDrawer() {
    dagEditorInstance?.clearSelection?.();
    updateAgentDagNodeDrawer(null);
}

function deleteSelectedAgentDagNode() {
    dagEditorInstance?.deleteSelectedNode?.();
}
