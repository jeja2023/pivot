// Agent 工作流编辑器桥接
// 从 agent-workflows.js 拆分。
// Agent 可视化工作流编辑器桥接，拆自 agent-workflows.js。
/* eslint-disable no-undef */
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
    let dag = { nodes: [] };
    try {
        dagText = document.getElementById('agent-dag-spec')?.value || '';
        dag = JSON.parse(dagText || '{"nodes":[]}');
    } catch (e) { dag = { nodes: [] }; }
    const definitions = new Map();
    (Array.isArray(dag.nodes) ? dag.nodes : []).filter(node => node?.tool === 'workflow.input').forEach(node => {
        const input = node.input && typeof node.input === 'object' ? node.input : {};
        const key = String(input.name || '').trim();
        if (!key) return;
        definitions.set(key, {
            key,
            label: String(input.label || key),
            type: ['text', 'number', 'boolean', 'object', 'array'].includes(input.type) ? input.type : 'text',
            required: Boolean(input.required),
            defaultValue: input.defaultValue,
            description: String(input.description || '')
        });
    });
    scanRefs(dagText).forEach(key => {
        if (!definitions.has(key)) definitions.set(key, { key, label: key, type: 'text', required: false, defaultValue: '', description: '' });
    });
    if (!definitions.size) {
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');
    const existing = {};
    list.querySelectorAll('[data-dag-input-key]').forEach(input => {
        existing[input.dataset.dagInputKey || input.name] = input.type === 'checkbox' ? input.checked : input.value;
    });
    PivotSafeHtml.setHtml(list, [...definitions.values()].map(definition => {
        const key = definition.key;
        const fallback = definition.defaultValue === undefined || definition.defaultValue === null
            ? ''
            : (typeof definition.defaultValue === 'string' ? definition.defaultValue : JSON.stringify(definition.defaultValue, null, 2));
        const value = existing[key] ?? fallback;
        const control = definition.type === 'boolean'
            ? `<input type="checkbox" data-dag-input-key="${agentEscape(key)}" data-dag-input-type="boolean" ${value === true || String(value).toLowerCase() === 'true' ? 'checked' : ''}>`
            : ['object', 'array'].includes(definition.type)
                ? `<textarea class="form-input" rows="2" data-dag-input-key="${agentEscape(key)}" data-dag-input-type="${definition.type}" placeholder="${definition.type === 'array' ? '[]' : '{}'}">${agentEscape(value)}</textarea>`
                : `<input class="form-input" type="${definition.type === 'number' ? 'number' : 'text'}" data-dag-input-key="${agentEscape(key)}" data-dag-input-type="${definition.type}" value="${agentEscape(value)}" placeholder="输入 ${agentEscape(definition.label)}">`;
        return `
        <label class="agent-dag-input-item">
            <span>${agentEscape(definition.label)}${definition.required ? '<em>必填</em>' : ''}</span>
            ${control}
            ${definition.description ? `<small>${agentEscape(definition.description)}</small>` : ''}
        </label>
    `; }).join(''));
}

function collectAgentDagInputs() {
    const result = {};
    document.querySelectorAll('#agent-dag-inputs-list [data-dag-input-key]').forEach(input => {
        const key = String(input.dataset.dagInputKey || '').trim();
        const type = input.dataset.dagInputType || 'text';
        let value = input.type === 'checkbox' ? input.checked : String(input.value || '').trim();
        if (type === 'number' && value !== '') value = Number(value);
        if (['object', 'array'].includes(type) && value) {
            try { value = JSON.parse(value); } catch (e) { /* 服务端会返回明确的字段校验错误 */ }
        }
        if (key) result[key] = value;
    });
    return result;
}

window.refreshAgentDagInputs = refreshAgentDagInputsPanel;

window.collectAgentDagInputs = collectAgentDagInputs;

