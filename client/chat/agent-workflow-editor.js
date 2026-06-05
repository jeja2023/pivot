/* eslint-disable no-undef, no-unused-vars */
// Agent 工作流编辑器桥接 Agent workflow editor bridge
// 从 agent-workflows.js 拆分。
// Agent workflow visual editor bridge, split from agent-workflows.js.
let dagEditorInstance = null;

function mountAgentDagEditor() {
    const canvas = document.getElementById('agent-dag-editor-canvas');
    const textarea = document.getElementById('agent-dag-spec');
    const toolbar = document.getElementById('agent-dag-editor-toolbar');
    const inspector = document.getElementById('agent-dag-editor-inspector');
    if (!canvas || !textarea || !window.PivotDagEditor) return;
    if (!canvas.offsetParent && activeAgentConfigSection !== 'advanced') return;
    if (dagEditorInstance) dagEditorInstance.destroy();
    dagEditorInstance = window.PivotDagEditor.mount({
        canvas,
        textarea,
        toolbar,
        inspector,
        getTools: () => agentToolsCache || [],
        onOpenJson: openAgentDagJsonModal,
        onNodeSelectionChange: updateAgentDagNodeDrawer,
        onChange: (result) => {
            if (result && result.error === 'invalid_json') {
                showToast('工作流 JSON 格式不正确', 'error');
            } else {
                updateAgentWorkflowRunUi();
                // 同步刷新运行时输入面板
                refreshAgentDagInputsPanel();
            }
        }
    });
}

window.refreshAgentDagEditor = () => dagEditorInstance?.refresh();

function refreshAgentDagInputsPanel() {
    const workflowWorkbench = document.getElementById('agent-dag-workbench-modal');
    const workflowWorkbenchOpen = Boolean(workflowWorkbench && !workflowWorkbench.classList.contains('hidden'));
    const panel = document.getElementById('agent-dag-inputs-panel');
    const list = document.getElementById('agent-dag-inputs-list');
    if (!panel || !list) return;
    if (!workflowWorkbenchOpen) {
        panel.classList.add('hidden');
        return;
    }
    const scanRefs = (dagText) => {
        const refs = new Set();
        const regex = /\{\{\s*inputs\.([\w.-]+)\s*\}\}/g;
        let match;
        while ((match = regex.exec(dagText || '')) !== null) {
            const key = String(match[1] || '').trim();
            if (key) refs.add(key);
        }
        return refs;
    };
    let dagText = '';
    try { dagText = document.getElementById('agent-dag-spec')?.value || ''; } catch (e) { dagText = ''; }
    const refs = scanRefs(dagText);
    if (!refs.size) {
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');
    const existing = {};
    list.querySelectorAll('.agent-dag-input-item input').forEach(input => {
        existing[input.dataset.dagInputKey || input.name] = input.value;
    });
    list.innerHTML = [...refs].map(key => `
        <label class="agent-dag-input-item">
            <span>${agentEscape(key)}</span>
            <input class="form-input" type="text" data-dag-input-key="${agentEscape(key)}" value="${agentEscape(existing[key] || '')}" placeholder="输入 ${agentEscape(key)} 的值">
        </label>
    `).join('');
}

function collectAgentDagInputs() {
    const result = {};
    document.querySelectorAll('#agent-dag-inputs-list [data-dag-input-key]').forEach(input => {
        const key = String(input.dataset.dagInputKey || '').trim();
        const value = String(input.value || '').trim();
        if (key) result[key] = value;
    });
    return result;
}

window.refreshAgentDagInputs = refreshAgentDagInputsPanel;

window.collectAgentDagInputs = collectAgentDagInputs;

